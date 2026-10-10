import http from 'node:http'
import { randomInt } from 'node:crypto'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { chromeExecutable, portNumber } from './launch.mjs'
import { connectCDP } from './cdp.mjs'
import { acceptsOrigin } from './transport.mjs'
import { createNativeDebugger, ElfLines, StaticSources, selectNativeDebugBuild } from './gdb.mjs'
import { previewFonts } from './preview-fonts.mjs'
import { compatResult } from './compat.mjs'
import {
  Changes,
  RECORDED_METHODS,
  loadOverridesFile,
  saveOverridesFile,
  serveChanges,
} from './changes.mjs'
import { bundledFrontend, frontendManifest, serveFrontend } from './frontend.mjs'
import { outerHTML } from './html.mjs'
import {
  cssStyle as authoredCssStyle, cssValues, serializeCss, reconcileCss,
  replaceCssRange, setCssProperty, cssMutations, cssRange,
} from './css.mjs'

// One queue owns USB. Polling and every inspector share it, so replies cannot
// cross request boundaries. The device never evaluates JavaScript.
export function snapshotChecksum(lines) {
  let checksum = 2166136261
  for (const line of lines)
    for (const byte of Buffer.from(line + '\n'))
      checksum = Math.imul(checksum ^ byte, 16777619) >>> 0
  return checksum
}
export class DeviceTransport {
  constructor(serial) {
    this.serial = serial
    this.tail = Promise.resolve()
    this.boot = null
    this.nextSequence = randomInt(1, 0x7fffffff)
    this.cached = null
    this.pendingSnapshot = null
    this.highlight = 0
    this.highlightRevision = 0
    this.highlightWritten = 0
  }
  enqueue(action) {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }
  snapshot({ fresh = false } = {}) {
    if (this.debuggerState?.paused && this.lastGood) return Promise.resolve(this.lastGood)
    if (!fresh && this.cached && Date.now() - this.cachedAt < 200)
      return Promise.resolve(this.cached)
    if (this.pendingSnapshot) return this.pendingSnapshot
    const pending = this.enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (this.debuggerState?.paused && this.lastGood) return this.lastGood
          this.abort = new AbortController()
          const sequence = this.nextSequence++
          const { lines, end, begin } = await this.serial.collect(
            `GEADEV DEBUG SNAPSHOT ${sequence}`,
            {
              begin: (frame) => frame === `GEADEV:DEBUG BEGIN sequence=${sequence}`,
              data: '\0',
              end: 'GEADEV:DEBUG END',
              timeoutMs: 15000,
              signal: this.abort.signal,
            },
          )
          const meta = Object.fromEntries(
            end
              .split(' ')
              .slice(2)
              .map((s) => s.split('=')),
          )
          const payload = lines
            .filter((l) => l.startsWith('GEADEV:DEBUG NODE '))
            .map((l) => l.slice(18))
          if (!begin?.includes(`sequence=${sequence}`) || Number(meta.sequence) !== sequence)
            throw new Error('Snapshot sequence mismatch')
          if (
            Number(meta.count) !== payload.length ||
            Number(meta.checksum) !== snapshotChecksum(payload)
          )
            throw new Error('Snapshot integrity check failed')
          const nodes = new Map(
            payload.map((line) => {
              const n = JSON.parse(line)
              return [n.id, n]
            }),
          )
          if (!meta.boot) {
            const error = new Error('Firmware lacks debugger framing; rebuild without --attach')
            error.fatal = true
            throw error
          }
          if (this.boot !== null && this.boot !== meta.boot) {
            const error = new Error('Device rebooted; reconnect to invalidate old node references')
            error.fatal = true
            throw error
          }
          this.boot = meta.boot
          const snapshot = {
            nodes,
            root: Number(meta.root),
            width: Number(meta.width),
            height: Number(meta.height),
            debugFps: Number(meta.fps || 0),
            elf: meta.elf,
            nativeHighlight: meta.overlay === '1',
            nativePicker: meta.picker === '1',
            nativeListeners: meta.listeners === '1',
            inspect: {
              token: Number(meta.inspectToken || 0),
              active: meta.inspectActive === '1',
              hover: Number(meta.inspectHover || 0),
              node: Number(meta.inspectNode || 0),
              revision: Number(meta.inspectRevision || 0),
            },
          }
          if (nodes.size !== payload.length || !nodes.has(snapshot.root))
            throw new Error('Snapshot has duplicate identities or no mounted root')
          this.cached = snapshot
          this.lastGood = snapshot
          this.cachedAt = Date.now()
          return snapshot
        } catch (error) {
          if (this.debuggerState?.paused && this.lastGood) return this.lastGood
          if (error.message === 'GEADEV:ERR unknown-command command=DEBUG') {
            const disabled = new Error(
              '--attach requires debug-enabled firmware; this firmware has no debugger support. Build and flash with gea run --debug --board <board> (without --attach).',
              { cause: error },
            )
            disabled.fatal = true
            throw disabled
          }
          if (error.fatal || this.serial.closed || this.serial.error) {
            error.fatal = true
            throw error
          }
          if (attempt === 2) throw error
          if (this.serial.drainInput) await this.serial.drainInput()
        }
      }
    })
    this.pendingSnapshot = pending
    pending
      .finally(() => {
        if (this.pendingSnapshot === pending) this.pendingSnapshot = null
      })
      .catch(() => {})
    return pending
  }
  mutate(request) {
    return this.enqueue(() => this.writeMutation(request))
  }
  // JSX listeners of the given element identities, with the firmware call
  // sites that registered them. Lists are chunked to fit the command line.
  listeners(ids) {
    return this.enqueue(async () => {
      const records = []
      for (let start = 0; start < ids.length; ) {
        const chunk = []
        while (start < ids.length && chunk.length < 64 && (chunk.join(',') + ',' + ids[start]).length < 400)
          chunk.push(ids[start++])
        const sequence = this.nextSequence++
        const { lines, end } = await this.serial.collect(
          `GEADEV DEBUG LISTENERS ${sequence} ${chunk.join(',')}`,
          {
            begin: (frame) => frame === `GEADEV:DEBUG LISTENERS BEGIN sequence=${sequence}`,
            data: '\0',
            end: 'GEADEV:DEBUG LISTENERS END',
            timeoutMs: 8000,
          },
        )
        const meta = Object.fromEntries(
          end
            .split(' ')
            .slice(3)
            .map((pair) => pair.split('=')),
        )
        const payload = lines.filter((line) => line.startsWith('GEADEV:DEBUG LISTENER '))
        if (Number(meta.sequence) !== sequence || Number(meta.count) !== payload.length)
          throw new Error('Listener reply integrity check failed')
        if (this.boot !== null && meta.boot !== this.boot)
          throw new Error('Device rebooted; reconnect to invalidate old node references')
        for (const line of payload) records.push(JSON.parse(line.slice(22)))
      }
      return records
    })
  }
  async writeMutation(request) {
    if (this.debuggerState?.paused)
      throw new Error('Resume the native app before changing its tree or styles')
    const encoded = Buffer.from(JSON.stringify({ ...request, boot: this.boot })).toString('base64')
    if (encoded.length > 480)
      throw new Error('Device operation exceeds the 480-byte USB request limit')
    try {
      const result = await this.serial.command(`GEADEV DEBUG ${encoded}`, ['GEADEV:DEBUG OK'], 8000)
      return Number(/id=(\d+)/.exec(result)?.[1] || 0)
    } finally {
      if (request.op !== 'highlight' && !(request.op === 'inspect' && request.mode === 'keepAlive'))
        this.cached = null
    }
  }
  async setInspectMode(mode, owner) {
    if (mode === 'none') return this.cancelInspect(owner)
    if (!['searchForNode', 'searchForUAShadowDOM'].includes(mode))
      throw new Error(`Unsupported inspect mode: ${mode}`)
    if (!(await this.snapshot()).nativePicker)
      throw new Error('Element picking needs a fresh debug firmware build; run without --attach')
    if (this.debuggerState?.paused) throw new Error('Resume the native app before picking an element')
    const previous = this.inspection
    let token
    do { token = randomInt(1, 0x7fffffff) }
    while (token === previous?.token || token === this.lastGood?.inspect?.token)
    const inspection = { token, owner, hover: 0 }
    this.inspection = inspection
    if (previous && previous.owner !== owner)
      previous.owner.emit('Overlay.inspectModeCanceled', {})
    try {
      await this.mutate({ op: 'inspect', token: inspection.token, mode })
    } catch (error) {
      if (this.inspection === inspection) this.inspection = null
      throw error
    }
  }
  async cancelInspect(owner) {
    const inspection = this.inspection
    if (!inspection || (owner && inspection.owner !== owner)) return
    this.inspection = null
    // A halted native app cannot answer USB. Its lease restores input on resume.
    if (!this.debuggerState?.paused)
      await this.mutate({ op: 'inspect', token: inspection.token, mode: 'none' })
  }
  keepInspectAlive() {
    if (!this.inspection || this.debuggerState?.paused || this.inspectRenewal) return
    const { token } = this.inspection
    const pending = this.mutate({ op: 'inspect', token, mode: 'keepAlive' })
    this.inspectRenewal = pending
    pending.finally(() => {
      if (this.inspectRenewal === pending) this.inspectRenewal = null
    }).catch(() => {})
    return pending
  }
  async inspectPoint({ token, mode, x, y }) {
    const inspection = this.inspection
    if (!inspection || token !== inspection.token) throw new Error('Element picker is no longer active')
    if (!['hover', 'select', 'leave'].includes(mode) ||
        (mode !== 'leave' && (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
         x < 0 || y < 0 || x >= this.lastGood.width || y >= this.lastGood.height)))
      throw new Error('Invalid picker coordinates or mode')
    // One preview request at a time; coalescing in the client keeps USB bounded.
    if (this.inspectPointPending) throw new Error('Picker request already in progress')
    this.inspectPointPending = true
    try {
      await this.mutate({ op: 'inspectPoint', token, mode, ...(mode === 'leave' ? {} : { x, y }) })
      if (!inspection.owner.closed) await inspection.owner.refresh(true)
    } finally { this.inspectPointPending = false }
  }
  setHighlight(id, color = { r: 0, g: 200, b: 255 }, owner = null) {
    this.highlight = id
    this.highlightOwner = id ? owner : null
    this.highlightColor = color
    this.highlightRevision++
    return this.flushHighlight()
  }
  clearHighlight(owner) {
    if (owner && this.highlightOwner !== owner) return Promise.resolve()
    return this.setHighlight(0)
  }
  flushHighlight() {
    if (!this.lastGood?.nativeHighlight || this.debuggerState?.paused || this.inspection) return Promise.resolve()
    if (!this.highlightWrite) {
      const pending = this.enqueue(async () => {
        while (this.highlightWritten !== this.highlightRevision && !this.debuggerState?.paused && !this.inspection) {
          const revision = this.highlightRevision
          const color = this.highlightColor || { r: 0, g: 200, b: 255 }
          await this.writeMutation({
            op: 'highlight',
            id: this.highlight,
            red: color.r,
            green: color.g,
            blue: color.b,
          })
          this.highlightWritten = revision
        }
      })
      this.highlightWrite = pending
      pending
        .finally(() => {
          if (this.highlightWrite === pending) this.highlightWrite = null
        })
        .catch(() => {})
    }
    return this.highlightWrite
  }
}

function cssStyle(id, text, styleSheetId = `inline-${id}`) {
  return authoredCssStyle(text, styleSheetId)
}
const styleDocuments = new WeakMap()

function ruleSheets(nodes) {
  const sheets = new Map()
  for (const node of nodes.values())
    for (const rule of node.rules || []) {
      const id =
        'rule-' +
        Buffer.from(JSON.stringify([rule.selector, rule.media || '', !!rule.userAgent])).toString(
          'base64url',
        )
      const sheet = sheets.get(id) || {
        id,
        selector: rule.selector,
        media: rule.media || '',
        userAgent: !!rule.userAgent,
        values: {},
      }
      if (rule.property) sheet.values[rule.property] = rule.value
      sheets.set(id, sheet)
    }
  return sheets
}
function sheetHeader(id, text = '', ownerNode) {
  const { endLine, endColumn } = cssRange(text)
  return {
    styleSheetId: id,
    frameId: 'gea',
    sourceURL: '',
    origin: 'regular',
    title: '',
    disabled: false,
    isInline: true,
    isMutable: true,
    startLine: 0,
    startColumn: 0,
    length: text.length,
    endLine,
    endColumn,
    ...(ownerNode ? { ownerNode } : {}),
  }
}

export class DeviceSession {
  constructor(transport, emit = () => {}) {
    this.transport = transport
    if (!styleDocuments.has(transport)) styleDocuments.set(transport, { inline: new Map(), rules: new Map() })
    this.styleDocuments = styleDocuments.get(transport)
    this.emit = emit
    this.nodes = new Map()
    this.publishedChildren = new Set()
    this.styles = new Map()
    this.objects = new Map()
    this.nextObject = 1
    this.pending = []
    this.selected = null
    const session = this
    const read = (id) => {
      const n = session.nodes.get(id)
      if (!n) throw new Error('Stale native node reference')
      return n
    }
    const wrappers = new Map()
    const wrap = (id) => {
      if (!id || id < 4) return null
      if (wrappers.has(id)) return wrappers.get(id)
      const node = {
        __geaNodeId: id,
        get nodeType() {
          read(id)
          return 1
        },
        get nodeName() {
          const n = read(id)
          return (n.tag || (n.type === 3 ? 'span' : 'div')).toUpperCase()
        },
        get tagName() {
          return this.nodeName
        },
        get id() {
          return read(id).attributes.id || ''
        },
        set id(v) {
          this.setAttribute('id', v)
        },
        get className() {
          return read(id).attributes.class || ''
        },
        set className(v) {
          this.setAttribute('class', v)
        },
        get textContent() {
          const n = read(id)
          return n.text + n.children.map((c) => wrap(c).textContent).join('')
        },
        set textContent(v) {
          const n = read(id)
          session.queue({ op: 'text', id, value: String(v) })
          n.text = String(v)
          n.children = []
        },
        get children() {
          return read(id).children.map(wrap)
        },
        get childNodes() {
          return this.children
        },
        get firstChild() {
          return this.children[0] || null
        },
        get parentNode() {
          return wrap(read(id).parent)
        },
        getAttribute(key) {
          read(id)
          return key === 'style' ? this.style.cssText || null : (read(id).attributes[key] ?? null)
        },
        setAttribute(key, value) {
          if (key === 'style') {
            this.style.cssText = String(value)
            return
          }
          read(id).attributes[key] = String(value)
          session.queue({ op: 'attribute', id, key, value: String(value) })
        },
        removeAttribute(key) {
          if (key === 'style') {
            this.style.cssText = ''
            return
          }
          delete read(id).attributes[key]
          session.queue({ op: 'removeAttribute', id, key })
        },
        querySelector(selector) {
          return this.querySelectorAll(selector)[0] || null
        },
        querySelectorAll(selector) {
          return session
            .query(selector, id)
            .filter((i) => i !== id)
            .map(wrap)
        },
        getBoundingClientRect() {
          const n = read(id)
          return {
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            top: n.y,
            left: n.x,
            right: n.x + n.width,
            bottom: n.y + n.height,
          }
        },
        click() {
          read(id)
          session.queue({ op: 'click', id })
        },
        scrollIntoView() {
          read(id)
          session.queue({ op: 'scroll', id })
        },
        remove() {
          read(id)
          session.queue({ op: 'remove', id })
        },
        appendChild(child) {
          read(id)
          read(child.__geaNodeId)
          session.queue({ op: 'append', id: child.__geaNodeId, parent: id })
          return child
        },
      }
      node.style = new Proxy(
        {
          setProperty(key, value) {
            read(id)
            const document = session.styleDocuments.inline.get(id) || reconcileCss(null, {})
            const text = setCssProperty(document.text, key, String(value))
            session.queue({ op: 'styleText', id, value: text, previous: document.text })
            session.styleDocuments.inline.set(id, { ...document, text, editing: true })
            session.styles.set(id, cssValues(text))
          },
          removeProperty(key) {
            this.setProperty(key, '')
          },
          getPropertyValue(key) {
            read(id)
            return session.styles.get(id)?.[key] || ''
          },
        },
        {
          get(target, key) {
            if (key === 'cssText') return session.styleText(id)
            return key in target
              ? target[key]
              : target.getPropertyValue(String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))
          },
          set(target, key, value) {
            if (key === 'cssText') {
              read(id)
              const document = session.styleDocuments.inline.get(id) || reconcileCss(null, {})
              session.queue({ op: 'styleText', id, value: String(value), previous: document.text })
              session.styleDocuments.inline.set(id, { ...document, text: String(value), editing: true })
              session.styles.set(id, cssValues(String(value)))
              return true
            }
            target.setProperty(
              String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
              value,
            )
            return true
          },
        },
      )
      node.classList = {
        add(...tokens) {
          node.className = [...new Set([...node.className.split(/\s+/), ...tokens])]
            .filter(Boolean)
            .join(' ')
        },
        remove(...tokens) {
          node.className = node.className
            .split(/\s+/)
            .filter((t) => !tokens.includes(t))
            .join(' ')
        },
        contains(token) {
          return node.className.split(/\s+/).includes(token)
        },
      }
      wrappers.set(id, node)
      return node
    }
    this.wrap = wrap
    const document = {
      get body() {
        return wrap(session.root)
      },
      get documentElement() {
        return wrap(session.root)
      },
      querySelector: (s) => wrap(session.query(s)[0]),
      querySelectorAll: (s) => session.query(s).map(wrap),
      getElementById: (s) => wrap(session.query('#' + s)[0]),
      // Creating a native node needs a USB round trip, so console callers await it.
      createElement: async (tag) => {
        const id = await transport.mutate({ op: 'create', key: String(tag) })
        session.nodes.set(id, {
          id,
          tag: String(tag),
          type: 1,
          text: '',
          attributes: {},
          children: [],
          parent: 2,
          computed: {},
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        })
        return wrap(id)
      },
    }
    const getComputedStyle = (node) =>
      new Proxy(
        { getPropertyValue: (key) => read(node.__geaNodeId).computed[key] || '' },
        {
          get: (target, key) =>
            key in target
              ? target[key]
              : read(node.__geaNodeId).computed[
                  String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
                ] || '',
        },
      )
    this.context = vm.createContext(
      {
        document,
        $: document.querySelector,
        $$: document.querySelectorAll,
        getComputedStyle,
        // Reveals the node in Elements, as in Chrome.
        inspect: (node) => {
          this.emit('Runtime.inspectRequested', { object: this.remote(node), hints: {}, executionContextId: 1 })
        },
        console: Object.fromEntries(
          ['log', 'warn', 'error', 'info', 'debug'].map((type) => [
            type,
            (...args) =>
              this.emit('Runtime.consoleAPICalled', {
                type,
                args: args.map((v) => this.remote(v)),
                executionContextId: 1,
                timestamp: Date.now(),
              }),
          ]),
        ),
      },
      { codeGeneration: { strings: true, wasm: false } },
    )
    this.context.window = this.context
    Object.defineProperty(this.context, '$0', { get: () => wrap(this.selected) })
  }
  queue(request) {
    if (this.pending.length >= 64) throw new Error('Console mutation limit exceeded')
    this.pending.push(request)
  }
  query(selector, root = this.root) {
    const out = []
    const visit = (id) => {
      const n = this.nodes.get(id)
      if (!n) return
      if (
        selector === '*' ||
        (selector === 'body' && id === this.root) ||
        (selector.startsWith('.')
          ? (n.attributes.class || '').split(/\s+/).includes(selector.slice(1))
          : selector.startsWith('#')
            ? n.attributes.id === selector.slice(1)
            : n.tag === selector)
      )
        out.push(id)
      n.children.forEach(visit)
    }
    visit(root)
    return out
  }
  async refresh(notify = false) {
    const snapshot = structuredClone(await this.transport.snapshot())
    for (const node of snapshot.nodes.values()) {
      const document = reconcileCss(this.styleDocuments.inline.get(node.id), node.inline || {})
      this.styleDocuments.inline.set(node.id, document)
      const text = document.text
      if (text) node.attributes.style = text
      else delete node.attributes.style
    }
    const old = this.authoritative || this.nodes
    this.nodes = snapshot.nodes
    this.authoritative = structuredClone(snapshot.nodes)
    for (const id of this.styleDocuments.inline.keys())
      if (!this.nodes.has(id)) this.styleDocuments.inline.delete(id)
    this.styles = new Map([...this.nodes].map(([id]) => [id, cssValues(this.styleText(id))]))
    this.root = snapshot.root
    this.width = snapshot.width
    this.height = snapshot.height
    this.debugFps = snapshot.debugFps || 0
    this.ruleSheets = ruleSheets(this.nodes)
    for (const [id, sheet] of this.ruleSheets) {
      const document = reconcileCss(this.styleDocuments.rules.get(id), sheet.values)
      this.styleDocuments.rules.set(id, document)
      sheet.text = document.text
    }
    if (notify && this.cssEnabled) {
      const before = ruleSheets(old)
      for (const [id, sheet] of this.ruleSheets) {
        if (!before.has(id))
          this.emit('CSS.styleSheetAdded', {
            header: sheetHeader(id, sheet.text),
          })
        else if (JSON.stringify(before.get(id).values) !== JSON.stringify(sheet.values))
          this.emit('CSS.styleSheetChanged', { styleSheetId: id })
      }
      for (const id of before.keys())
        if (!this.ruleSheets.has(id)) this.emit('CSS.styleSheetRemoved', { styleSheetId: id })
      for (const id of this.nodes.keys())
        if (!old.has(id))
          this.emit('CSS.styleSheetAdded', {
            header: {
              styleSheetId: `inline-${id}`,
              frameId: 'gea',
              sourceURL: '',
              origin: 'regular',
              title: '',
              disabled: false,
              isInline: true,
              isMutable: true,
              startLine: 0,
              startColumn: 0,
              length: 0,
              endLine: 0,
              endColumn: 0,
              ownerNode: id,
            },
          })
      for (const id of old.keys())
        if (!this.nodes.has(id))
          this.emit('CSS.styleSheetRemoved', { styleSheetId: `inline-${id}` })
    }
    if (notify && this.domEnabled) {
      const structure = (map) =>
        JSON.stringify([...map].map(([id, n]) => [id, n.children, n.tag, !!n.text]))
      if (structure(old) !== structure(this.nodes)) {
        this.publishedChildren.clear()
        this.emit('DOM.documentUpdated', {})
      } else
        for (const [id, n] of this.nodes) {
          const before = old.get(id)
          for (const name of Object.keys(before.attributes))
            if (!(name in n.attributes)) this.emit('DOM.attributeRemoved', { nodeId: id, name })
          for (const [name, value] of Object.entries(n.attributes))
            if (before.attributes[name] !== value)
              this.emit('DOM.attributeModified', { nodeId: id, name, value })
          if (n.text !== before.text)
            this.emit('DOM.characterDataModified', { nodeId: id + 1, characterData: n.text })
        }
      if (this.cssEnabled) {
        const changed = [...this.nodes]
          .filter(
            ([id, n]) =>
              JSON.stringify([n.computed, n.inline]) !==
              JSON.stringify([old.get(id)?.computed, old.get(id)?.inline]),
          )
          .map(([id]) => id)
        if (changed.length) this.emit('DOM.inlineStyleInvalidated', { nodeIds: changed })
      }
    }
    this.updateInspection(snapshot.inspect)
  }
  updateInspection(status) {
    const inspection = this.transport.inspection
    if (!inspection || inspection.owner !== this || this.closed || !status ||
        status.token !== inspection.token) return
    if (status.hover && status.hover !== inspection.hover && this.nodes.has(status.hover)) {
      this.publishPath(status.hover)
      this.emit('Overlay.nodeHighlightRequested', { nodeId: status.hover })
    }
    inspection.hover = status.hover
    if (status.active) return
    this.transport.inspection = null
    if (status.node && this.nodes.has(status.node)) {
      this.selected = status.node
      this.publishPath(status.node)
      this.transport.highlight = status.node
      this.transport.highlightOwner = this
      this.emit('Overlay.inspectNodeRequested', { backendNodeId: status.node })
    } else this.emit('Overlay.inspectModeCanceled', {})
  }
  async flush() {
    const pending = this.pending.splice(0)
    const styles = new Set(pending.filter(op => op.op === 'styleText').map(op => op.id))
    this.consoleEditing = true
    try {
      for (const operation of pending) {
        if (operation.op === 'styleText')
          await this.applyStyleText(operation.id, operation.value, null, operation.previous)
        else await this.transport.mutate(operation)
      }
    } finally {
      this.consoleEditing = false
      for (const id of styles) {
        const document = this.styleDocuments.inline.get(id)
        if (document) this.styleDocuments.inline.set(id, {
          text: document.text, projection: document.projection,
        })
      }
      await this.refresh(true)
    }
  }
  remote(value, group = '', byValue = false) {
    if (value === null) return { type: 'object', subtype: 'null', value: null }
    const type = typeof value
    if (type === 'undefined') return { type }
    if (['string', 'boolean'].includes(type)) return { type, value }
    if (type === 'number')
      return Number.isFinite(value) ? { type, value } : { type, unserializableValue: String(value) }
    if (type === 'bigint') return { type, unserializableValue: String(value) + 'n' }
    if (byValue) return { type, value: JSON.parse(JSON.stringify(value)) }
    if (this.objects.size >= 10000)
      throw new Error('Remote object limit exceeded; release objects or reconnect')
    const objectId = String(this.nextObject++)
    this.objects.set(objectId, { value, group })
    return {
      type,
      objectId,
      ...(value?.__geaNodeId
        ? { subtype: 'node', className: 'NativeElement', description: this.describe(value.__geaNodeId) }
        : Array.isArray(value)
          ? { subtype: 'array', className: 'Array', description: `Array(${value.length})` }
          : {
              className: type === 'function' ? 'Function' : 'Object',
              description: type === 'function' ? String(value) : 'Object',
            }),
    }
  }
  // Chrome-style node label: tag#id.class
  describe(id) {
    const node = this.nodes.get(id & ~1)
    if (!node) return 'node'
    const classes = String(node.attributes?.class || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => '.' + name)
      .join('')
    return node.tag + (node.attributes?.id ? '#' + node.attributes.id : '') + classes
  }
  // DOMDebugger.getEventListeners: JSX handlers on a node and, with depth,
  // its descendants. Handler values are metadata, not invocable callbacks.
  async eventListeners(p) {
    const value = this.object(p.objectId)
    if (!value?.__geaNodeId) throw new Error('Object is not a native node')
    const depth = p.depth ?? 1
    if (!Number.isInteger(depth) || depth < -1) throw new Error('Invalid event listener depth')
    await this.refresh()
    if (!this.transport.lastGood?.nativeListeners)
      throw new Error('This debug firmware cannot report event listeners; rebuild without --attach')
    const ids = []
    const pending = [[value.__geaNodeId & ~1, depth]]
    while (pending.length && ids.length < 512) {
      const [id, remaining] = pending.pop()
      const node = this.nodes.get(id)
      if (!node) continue
      ids.push(id)
      if (remaining === -1 || remaining > 1)
        for (const child of node.children.toReversed())
          pending.push([child, remaining === -1 ? -1 : remaining - 1])
    }
    const records = await this.transport.listeners(ids)
    const locations = this.transport.elfLines
      ? await this.transport.elfLines.locations(records.flatMap((record) => record.sites))
      : {}
    const group = p.objectGroup || 'event-listeners'
    return {
      listeners: records.map((record) => {
        const tag = this.nodes.get(record.id)?.tag || 'div'
        const resolved = record.sites.map((site) => locations[site]).filter(Boolean)
        // Registration passes through runtime helpers; prefer the first
        // caller in the app's own mapped source.
        const found = resolved.find((location) => location.scriptId === 'native-app')
        const unmapped = resolved.find((location) => location.functionName)?.functionName
        const objectId = 'gea-listener-' + this.nextObject++
        this.objects.set(objectId, {
          value: Object.freeze({ type: record.type, node: tag, callers: record.sites.map((site) => '0x' + site.toString(16)).join(' ← ') }),
          group,
        })
        const handler = {
          type: 'function',
          className: 'GeaListener',
          description: `${record.type} listener on <${tag}>${!found && unmapped ? ' · ' + unmapped : ''}`,
          objectId,
        }
        return {
          type: record.type,
          useCapture: false,
          passive: false,
          once: false,
          scriptId: found?.scriptId || '',
          lineNumber: found?.lineNumber || 0,
          columnNumber: found?.columnNumber || 0,
          handler,
          originalHandler: handler,
          backendNodeId: record.id,
        }
      }),
    }
  }
  object(id) {
    const entry = this.objects.get(id)
    if (!entry) throw new Error('Unknown or released remote object')
    return entry.value
  }
  node(id, depth = 0) {
    if (id === 1 || id === 2)
      return {
        nodeId: id,
        backendNodeId: id,
        nodeType: id === 1 ? 9 : 1,
        nodeName: id === 1 ? '#document' : 'HTML',
        localName: id === 1 ? '' : 'html',
        nodeValue: '',
        childNodeCount: 1,
        ...(depth !== 0
          ? { children: [this.node(id === 1 ? 2 : this.root, depth < 0 ? -1 : depth - 1)] }
          : {}),
        ...(id === 1
          ? { documentURL: 'gea://device/', baseURL: 'gea://device/', xmlVersion: '' }
          : {}),
      }
    if (id % 2) {
      const n = this.nodes.get(id - 1)
      if (!n) throw new Error('Stale text node')
      return {
        nodeId: id,
        backendNodeId: id,
        nodeType: 3,
        nodeName: '#text',
        localName: '',
        nodeValue: n.text,
      }
    }
    const n = this.nodes.get(id)
    if (!n) throw new Error('Stale native node')
    const children = [...(n.text ? [id + 1] : []), ...n.children]
    return {
      nodeId: id,
      backendNodeId: id,
      nodeType: 1,
      nodeName: (n.tag || (n.type === 3 ? 'span' : 'div')).toUpperCase(),
      localName: n.tag || (n.type === 3 ? 'span' : 'div'),
      nodeValue: '',
      attributes: Object.entries(n.attributes).flat(),
      childNodeCount: children.length,
      ...(depth !== 0
        ? { children: children.map((c) => this.node(c, depth < 0 ? -1 : depth - 1)) }
        : {}),
    }
  }
  publishNode(node) {
    if (node.children) {
      this.publishedChildren.add(node.nodeId)
      for (const child of node.children) this.publishNode(child)
    }
    return node
  }
  publishChildren(id, depth) {
    const node = this.node(id, 1)
    if (!node.children) return
    if (!this.publishedChildren.has(id)) {
      this.publishNode(node)
      this.emit('DOM.setChildNodes', { parentId: id, nodes: node.children })
    }
    if (depth !== 1)
      for (const child of node.children)
        this.publishChildren(child.nodeId, depth < 0 ? -1 : depth - 1)
  }
  publishPath(id) {
    const path = [], seen = new Set()
    for (let node = id; this.nodes.has(node) && !seen.has(node); node = this.nodes.get(node).parent) {
      seen.add(node)
      path.push(node)
    }
    this.publishChildren(1, 1)
    this.publishChildren(2, 1)
    for (const node of path.reverse()) this.publishChildren(node, 1)
  }
  styleText(id) {
    return this.styleDocuments.inline.get(id)?.text || ''
  }
  async applyStyleText(id, text, sheet = null, previous = null) {
    const documents = sheet ? this.styleDocuments.rules : this.styleDocuments.inline
    const key = sheet ? sheet.id : id
    const document = documents.get(key) || reconcileCss(null, {})
    documents.set(key, { ...document, editing: true })
    try {
      const current = await this.transport.snapshot()
      const before = sheet ? ruleSheets(current.nodes).get(key)?.values || {}
        : current.nodes.get(id)?.inline || {}
      for (const operation of cssMutations(previous ?? document.text, before, text))
        await this.transport.mutate(sheet
          ? { op: 'rule', selector: sheet.selector, media: sheet.media, ...operation }
          : { op: 'style', id, ...operation })
      const snapshot = await this.transport.snapshot({ fresh: true })
      const projection = sheet ? ruleSheets(snapshot.nodes).get(key)?.values || {}
        : snapshot.nodes.get(id)?.inline || {}
      documents.set(key, { text, projection, ...(this.consoleEditing ? { editing: true } : {}) })
    } catch (error) {
      documents.set(key, { text: document.text, projection: document.projection })
      throw error
    }
  }
  async setInlineAttribute(id, text) {
    await this.applyStyleText(id, text)
  }
  async highlightNode(nodeId, config) {
    if (this.closed) throw new Error('Inspector session closed')
    const id =
      nodeId < 4 ? this.root : this.nodes.has(nodeId) ? nodeId : nodeId % 2 ? nodeId - 1 : nodeId
    if (!this.nodes.has(id)) throw new Error('Stale highlight node')
    const input = config?.contentColor || config?.borderColor || { r: 0, g: 200, b: 255 }
    const color = Object.fromEntries(
      ['r', 'g', 'b'].map((key) => {
        const value = input[key] ?? 0
        if (!Number.isFinite(value) || value < 0 || value > 255)
          throw new Error('Invalid highlight color')
        return [key, Math.round(value)]
      }),
    )
    if (this.transport.setHighlight) await this.transport.setHighlight(id, color, this)
    else this.transport.highlight = id
    if (!this.transport.lastGood?.nativeHighlight && !this.highlightWarning) {
      this.highlightWarning = true
      this.emit('Log.entryAdded', {
        entry: {
          source: 'other',
          level: 'warning',
          text: 'Physical element highlights need newer debug firmware; rebuild without --attach. Preview highlights remain available.',
          timestamp: Date.now(),
        },
      })
    }
  }
  async handle(method, p = {}) {
    if (this.transport.debuggerState) {
      const result = await this.transport.debuggerState.handle(this, this.emit, method, p)
      if (result !== undefined) return result
      if (method === 'Runtime.getProperties' && p.objectId?.startsWith('gdb-scope-'))
        return this.transport.debuggerState.properties(p.objectId)
    }
    if (method === 'Runtime.enable') {
      this.emit('Runtime.executionContextCreated', {
        context: {
          id: 1,
          origin: 'gea://device',
          name: 'Gea device · host console',
          uniqueId: 'gea-device-host',
          auxData: { isDefault: true, type: 'default', frameId: 'gea' },
        },
      })
      return {}
    }
    if (method === 'Gea.getDebugFrameRate') return { fps: this.debugFps }
    if (method === 'Gea.setDebugFrameRate') {
      if (!Number.isInteger(p.fps) || p.fps < 0 || p.fps > 120)
        throw new Error('Invalid debug FPS cap')
      await this.transport.mutate({ op: 'fps', fps: p.fps })
      await this.refresh()
      return { fps: this.debugFps }
    }
    if (method === 'DOM.enable') {
      this.domEnabled = true
      return {}
    }
    if (method === 'CSS.enable') {
      this.cssEnabled = true
      for (const id of this.nodes.keys())
        this.emit('CSS.styleSheetAdded', {
          header: sheetHeader(
            `inline-${id}`,
            this.styleText(id),
            id,
          ),
        })
      for (const [id, sheet] of this.ruleSheets)
        this.emit('CSS.styleSheetAdded', {
          header: sheetHeader(id, sheet.text),
        })
      return {}
    }
    if (method === 'DOM.disable') {
      this.domEnabled = false
      return {}
    }
    if (method === 'CSS.disable') {
      this.cssEnabled = false
      return {}
    }
    if (method === 'DOM.getDocument') {
      await this.refresh()
      this.publishedChildren.clear()
      return { root: this.publishNode(this.node(1, p.depth ?? 2)) }
    }
    if (method === 'DOM.describeNode')
      return {
        node: this.node(
          p.nodeId || p.backendNodeId || this.object(p.objectId).__geaNodeId,
          p.depth ?? 0,
        ),
      }
    if (method === 'DOM.requestChildNodes') {
      this.publishChildren(p.nodeId, p.depth ?? 1)
      return {}
    }
    if (method === 'DOM.querySelector' || method === 'DOM.querySelectorAll') {
      const ids = this.query(p.selector, p.nodeId < 4 ? this.root : p.nodeId)
      return method.endsWith('All') ? { nodeIds: ids } : { nodeId: ids[0] || 0 }
    }
    if (method === 'DOM.getAttributes') return { attributes: this.node(p.nodeId).attributes || [] }
    if (method === 'DOM.setInspectedNode') {
      this.selected = p.nodeId
      await this.highlightNode(p.nodeId)
      return {}
    }
    if (method === 'Overlay.setInspectMode') {
      await this.transport.setInspectMode(p.mode, this)
      return {}
    }
    if (method === 'Overlay.highlightNode' || method === 'DOM.highlightNode') {
      await this.highlightNode(
        p.nodeId || p.backendNodeId || (p.objectId ? this.object(p.objectId).__geaNodeId : 0),
        p.highlightConfig,
      )
      return {}
    }
    if (
      method === 'Overlay.hideHighlight' ||
      method === 'DOM.hideHighlight' ||
      method === 'Overlay.disable'
    ) {
      if (method === 'Overlay.disable') await this.transport.cancelInspect?.(this)
      if (this.transport.clearHighlight) await this.transport.clearHighlight(this)
      else this.transport.highlight = 0
      return {}
    }
    if (method === 'DOM.resolveNode')
      return { object: this.remote(this.wrap(p.nodeId || p.backendNodeId), p.objectGroup) }
    if (method === 'DOM.requestNode') return { nodeId: this.object(p.objectId).__geaNodeId }
    if (method === 'DOM.pushNodesByBackendIdsToFrontend')
      return { nodeIds: p.backendNodeIds.map((id) => {
        if (!this.nodes.has(id)) return 0
        this.publishPath(id)
        return id
      }) }
    if (method === 'DOM.getBoxModel' || method === 'DOM.getContentQuads') {
      const n = this.nodes.get(p.nodeId || p.backendNodeId || this.object(p.objectId).__geaNodeId)
      if (!n) throw new Error('Stale node')
      const q = [n.x, n.y, n.x + n.width, n.y, n.x + n.width, n.y + n.height, n.x, n.y + n.height]
      return method.endsWith('Quads')
        ? { quads: [q] }
        : {
            model: {
              content: q,
              padding: q,
              border: q,
              margin: q,
              width: n.width,
              height: n.height,
            },
          }
    }
    const mutations = {
      'DOM.setAttributeValue': { op: 'attribute', id: p.nodeId, key: p.name, value: p.value },
      'DOM.removeAttribute': { op: 'removeAttribute', id: p.nodeId, key: p.name },
      'DOM.setNodeValue': {
        op: 'text',
        id: p.nodeId % 2 ? p.nodeId - 1 : p.nodeId,
        value: p.value,
      },
      'DOM.removeNode': { op: 'remove', id: p.nodeId },
      'DOM.scrollIntoViewIfNeeded': { op: 'scroll', id: p.nodeId },
    }
    if (
      (method === 'DOM.setAttributeValue' && p.name === 'style') ||
      (method === 'DOM.removeAttribute' && p.name === 'style')
    ) {
      await this.setInlineAttribute(p.nodeId, method === 'DOM.removeAttribute' ? '' : p.value)
      await this.refresh(true)
      return {}
    }
    if (mutations[method]) {
      await this.transport.mutate(mutations[method])
      await this.refresh(true)
      return {}
    }
    if (method === 'DOM.setAttributesAsText') {
      const regex = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
      for (const match of p.text.matchAll(regex)) {
        if (match[1] === 'style') await this.setInlineAttribute(p.nodeId, match[2] ?? match[3])
        else
          await this.transport.mutate({
            op: 'attribute',
            id: p.nodeId,
            key: match[1],
            value: match[2] ?? match[3],
          })
      }
      await this.refresh(true)
      return {}
    }
    if (method === 'CSS.getComputedStyleForNode') {
      await this.refresh()
      return {
        computedStyle: Object.entries(this.nodes.get(p.nodeId)?.computed || {}).map(
          ([name, value]) => ({ name, value }),
        ),
      }
    }
    if (method === 'CSS.getInlineStylesForNode')
      return {
        inlineStyle: cssStyle(p.nodeId, this.styleText(p.nodeId)),
        attributesStyle: { cssProperties: [], shorthandEntries: [] },
      }
    if (method === 'CSS.getMatchedStylesForNode') {
      const matched = ruleSheets(new Map([[p.nodeId, this.nodes.get(p.nodeId) || {}]]))
      return {
        inlineStyle: cssStyle(p.nodeId, this.styleText(p.nodeId)),
        attributesStyle: { cssProperties: [], shorthandEntries: [] },
        matchedCSSRules: [...matched].map(([id, sheet]) => ({
          matchingSelectors: [0],
          rule: {
            styleSheetId: id,
            origin: sheet.userAgent ? 'user-agent' : 'regular',
            selectorList: { text: sheet.selector, selectors: [{ text: sheet.selector }] },
            style: cssStyle(0, this.styleDocuments.rules.get(id)?.text || serializeCss(sheet.values), id),
          },
        })),
        inherited: [],
        pseudoElements: [],
        cssKeyframesRules: [],
      }
    }
    if (method === 'CSS.getStyleSheetText') {
      const sheet = this.ruleSheets.get(p.styleSheetId)
      if (!sheet && !p.styleSheetId?.startsWith('inline-')) throw new Error('Unknown native stylesheet')
      return { text: sheet ? this.styleDocuments.rules.get(sheet.id).text
        : this.styleText(Number(p.styleSheetId.slice(7))) }
    }
    if (method === 'CSS.setStyleTexts') {
      const edited = []
      for (const edit of p.edits) {
        const sheet = this.ruleSheets.get(edit.styleSheetId)
        if (!sheet && !edit.styleSheetId?.startsWith('inline-'))
          throw new Error('Unknown native stylesheet')
        if (sheet?.userAgent) throw new Error('User agent stylesheet is read-only')
        const id = sheet ? 0 : Number(edit.styleSheetId.slice(7))
        if (!sheet && !this.nodes.has(id)) throw new Error('Stale native node')
        const current = sheet ? this.styleDocuments.rules.get(sheet.id).text : this.styleText(id)
        const next = replaceCssRange(current, edit.range, edit.text)
        await this.applyStyleText(id, next, sheet)
        await this.refresh(false)
        edited.push(cssStyle(id, next, edit.styleSheetId))
      }
      // Chrome commits the returned ranges before it reloads the sidebar.
      setTimeout(() => {
        for (const style of edited)
          this.emit('CSS.styleSheetChanged', { styleSheetId: style.styleSheetId })
      }, 0)
      return { styles: edited }
    }
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
      await this.refresh()
      this.pending = []
      try {
        let value
        if (method === 'Runtime.evaluate')
          value = vm.runInContext(p.expression, this.context, { timeout: 1000 })
        else {
          this.context.__receiver = p.objectId ? this.object(p.objectId) : this.context
          this.context.__arguments = (p.arguments || []).map((a) =>
            a.objectId
              ? this.object(a.objectId)
              : a.unserializableValue
                ? Number(a.unserializableValue)
                : a.value,
          )
          value = vm.runInContext(
            `(${p.functionDeclaration}).apply(__receiver,__arguments)`,
            this.context,
            { timeout: 1000 },
          )
          delete this.context.__receiver
          delete this.context.__arguments
        }
        // Device allocations are asynchronous; wait for their continuation so
        // queued native edits are flushed even when Chrome omits awaitPromise.
        if (value?.then)
          value = await Promise.race([
            value,
            new Promise((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Host console promise timeout')),
                8000,
              )
              timer.unref()
            }),
          ])
        await this.flush()
        return { result: this.remote(value, p.objectGroup, p.returnByValue) }
      } catch (error) {
        await this.flush()
        return {
          result: { type: 'object', subtype: 'error', description: String(error) },
          exceptionDetails: {
            exceptionId: 1,
            text: String(error),
            lineNumber: 0,
            columnNumber: 0,
            executionContextId: 1,
          },
        }
      }
    }
    if (method === 'Runtime.getProperties') {
      const descriptors = Object.getOwnPropertyDescriptors(this.object(p.objectId))
      const group = this.objects.get(p.objectId).group
      return {
        result: Object.entries(descriptors).map(([name, d]) => ({
          name,
          configurable: !!d.configurable,
          enumerable: !!d.enumerable,
          isOwn: true,
          ...('value' in d
            ? { value: this.remote(d.value, group), writable: !!d.writable }
            : { get: this.remote(d.get, group), set: this.remote(d.set, group) }),
        })),
        internalProperties: [],
      }
    }
    if (method === 'Runtime.releaseObject') {
      this.objects.delete(p.objectId)
      return {}
    }
    if (method === 'DOMDebugger.getEventListeners') return this.eventListeners(p)
    if (method === 'Runtime.releaseObjectGroup') {
      for (const [id, object] of this.objects)
        if (object.group === p.objectGroup) this.objects.delete(id)
      return {}
    }
    if (method === 'Page.captureScreenshot') {
      if (!this.transport.screenshot) throw new Error('Device screenshot transport unavailable')
      return { data: await this.transport.screenshot() }
    }
    if (method === 'Page.getResourceTree' || method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: {
            id: 'gea',
            loaderId: 'gea',
            url: 'gea://device/',
            domainAndRegistry: '',
            securityOrigin: 'gea://device',
            mimeType: 'text/html',
            name: 'Gea device',
          },
          resources: [],
        },
      }
    if (method === 'Page.getLayoutMetrics') {
      const rect = { x: 0, y: 0, width: this.width, height: this.height }
      const viewport = {
        pageX: 0,
        pageY: 0,
        clientWidth: this.width,
        clientHeight: this.height,
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        zoom: 1,
      }
      return {
        contentSize: rect,
        cssContentSize: rect,
        layoutViewport: viewport,
        cssLayoutViewport: viewport,
        visualViewport: viewport,
        cssVisualViewport: viewport,
      }
    }
    if (method === 'CSS.getMediaQueries') return { medias: [] }
    if (method === 'CSS.getPlatformFontsForNode') return { fonts: [] }
    if (method === 'Browser.getVersion')
      return {
        protocolVersion: '1.3',
        product: 'Gea/ESP32',
        revision: '',
        userAgent: 'Gea',
        jsVersion: 'Host console',
      }
    if (
      [
        'Page.enable',
        'Page.disable',
        'Page.setLifecycleEventsEnabled',
        'Runtime.disable',
        'Runtime.runIfWaitingForDebugger',
        'Runtime.discardConsoleEntries',
        'Runtime.setCustomObjectFormatterEnabled',
        'Log.enable',
        'Log.disable',
        'Inspector.enable',
        'Inspector.disable',
        'DOMDebugger.setBreakOnCSPViolation',
        'DOM.markUndoableState',
        'Overlay.enable',
        'Overlay.disable',
        'Overlay.hideHighlight',
        'Overlay.setShowViewportSizeOnResize',
        'Overlay.setShowGridOverlays',
        'Overlay.setShowFlexOverlays',
        'Emulation.setEmulatedMedia',
      ].includes(method)
    )
      return {}
    throw new Error(`Unsupported device protocol method: ${method}`)
  }
}

export async function createDeviceRelay({
  serial,
  screenshot,
  debugPort = 9222,
  title = 'Gea ESP32',
  pollMs = 750,
  debugFps = 0,
  nativeDebug,
  listenerSources,
  appRoot,
  frontend: manifest,
}) {
  debugPort = portNumber(debugPort, '--debug-port')
  if (manifest === undefined) manifest = await frontendManifest().catch(() => null)
  const transport = new DeviceTransport(serial)
  if (screenshot)
    transport.screenshot = () => {
      if (transport.debuggerState?.paused)
        throw new Error('Resume the native app before capturing its display')
      return transport.enqueue(screenshot)
    }
  // Flashing can enumerate USB before the application's tree is mounted.
  // Wait for a complete initial frame rather than opening a broken target.
  const startupDeadline = Date.now() + 15000
  while (true) {
    try {
      await transport.snapshot({ fresh: true })
      break
    } catch (error) {
      if (error.fatal || Date.now() >= startupDeadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  if (debugFps) {
    await transport.mutate({ op: 'fps', fps: debugFps })
    await transport.snapshot({ fresh: true })
  }
  if (nativeDebug) {
    transport.debuggerState = await createNativeDebugger({
      ...nativeDebug,
      firmwareElfHash: transport.cached?.elf,
    })
    transport.debuggerState.onStateChange = (paused) => {
      if (paused) transport.abort?.abort(new Error('Native app paused'))
      else {
        transport.cached = null
        transport.flushHighlight().catch(() => {})
      }
    }
    // JTAG setup happens before clients receive any lifetime identities.
    transport.cached = null
    try {
      await transport.snapshot({ fresh: true })
    } catch (error) {
      await transport.debuggerState.close()
      throw error
    }
  }
  // Listener source links read the firmware's ELF without touching JTAG.
  // Without --debug-sources, a read-only Sources view supplies the script.
  const sources = nativeDebug || listenerSources
  if (sources?.builds?.length && transport.cached?.nativeListeners) {
    try {
      const build = selectNativeDebugBuild(sources.builds, transport.cached.elf)
      const info = JSON.parse(readFileSync(build.metadata, 'utf8'))
      transport.elfLines = new ElfLines(sources.gdbExecutable, build.elf, info, { env: sources.env })
      transport.debuggerState ||= new StaticSources(info)
    } catch {}
  }
  await transport.clearHighlight()
  const endpoint = `ws://127.0.0.1:${debugPort}/devtools/page/gea`
  // The bundled frontend adds Gea Changes and zoom. Chrome's own frontend
  // remains the fallback; inspector.html would replace protocol hover.
  const frontend = manifest
    ? `http://127.0.0.1:${debugPort}/devtools/devtools_app.html?ws=127.0.0.1:${debugPort}/devtools/page/gea`
    : `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${debugPort}/devtools/page/gea`
  const sessions = new Set()
  // A private host session reads and replays edits for the shared history.
  const host = new DeviceSession(transport)
  const changes = new Changes(
    {
      sync: () => host.refresh(),
      async call(method, params) {
        if (/^(DOM\.(getAttributes|describeNode)|CSS\.getStyleSheetText)$/.test(method))
          await host.refresh()
        return host.handle(method, params)
      },
      broadcast(method, params) {
        for (const session of sessions) session.emit(method, params)
      },
    },
    { app: title },
  )
  const target = {
    id: 'gea',
    type: 'page',
    title,
    url: 'gea://device/',
    webSocketDebuggerUrl: endpoint,
    devtoolsFrontendUrl: frontend,
  }
  const fonts = previewFonts(appRoot)
  let lastFrame = null,
    framePending = null,
    lastFrameAt = 0
  const previewFrame = async () => {
    if (transport.debuggerState?.paused) return { data: lastFrame, paused: true }
    if (lastFrame && Date.now() - lastFrameAt < 1800) return { data: lastFrame, paused: false }
    if (!framePending)
      framePending = (async () => {
        try {
          if (!transport.screenshot) throw new Error('Device screenshot transport unavailable')
          lastFrame = await transport.screenshot()
          lastFrameAt = Date.now()
          return { data: lastFrame, paused: false }
        } finally {
          framePending = null
        }
      })()
    return framePending
  }
  const preview = `http://127.0.0.1:${debugPort}/preview`
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (
        ![`127.0.0.1:${debugPort}`, `localhost:${debugPort}`].includes(req.headers.host) ||
        !(req.method === 'GET' ||
          (req.method === 'POST' && ['/preview/inspect', '/gea/changes'].includes(req.url))) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${debugPort}`)
      ) {
        res.statusCode = 403
        res.end('Local preview access only')
        return
      }
      if (await serveChanges(req, res, changes)) return
      if (await serveFrontend(req, res, manifest)) return
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new Error('Picker requests require JSON')
        let body = ''
        for await (const chunk of req) {
          body += chunk.toString()
          if (Buffer.byteLength(body) > 1024) throw new Error('Picker request exceeds limit')
        }
        const request = JSON.parse(body)
        if (request.mode === 'cancel') {
          const inspection = transport.inspection
          if (!inspection || request.token !== inspection.token)
            throw new Error('Element picker is no longer active')
          await transport.cancelInspect(inspection.owner)
          inspection.owner.emit('Overlay.inspectModeCanceled', {})
        } else await transport.inspectPoint(request)
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
        return
      }
      if (req.url === '/preview/fonts.css') {
        res.setHeader('Content-Type', 'text/css; charset=utf-8')
        res.end(fonts.css)
        return
      }
      if (req.url.startsWith('/preview/fonts/')) {
        const font = fonts.assets.get(req.url.slice('/preview/fonts/'.length))
        if (!font) {
          res.statusCode = 404
          res.end('Unknown font')
          return
        }
        res.setHeader('Content-Type', font.type)
        res.end(font.data)
        return
      }
      if (req.url === '/preview' || req.url === '/preview.mjs') {
        res.setHeader(
          'Content-Type',
          req.url === '/preview' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
        )
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'",
        )
        res.end(
          readFileSync(
            new URL(
              req.url === '/preview' ? './device-preview.html' : './device-preview.mjs',
              import.meta.url,
            ),
          ),
        )
        return
      }
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/preview/snapshot') {
        const snapshot = await transport.snapshot()
        res.end(
          JSON.stringify({
            ...snapshot,
            nodes: [...snapshot.nodes.values()],
            highlight: transport.inspection ? snapshot.inspect?.hover || 0 : transport.highlight || 0,
            inspectToken: !transport.debuggerState?.paused && transport.inspection &&
              snapshot.inspect?.active && snapshot.inspect.token === transport.inspection.token
                ? transport.inspection.token : 0,
            paused: !!transport.debuggerState?.paused,
          }),
        )
        return
      }
      if (req.url === '/preview/frame') {
        res.end(JSON.stringify(await previewFrame()))
        return
      }
      if (['/json', '/json/list'].includes(req.url)) res.end(JSON.stringify([target]))
      else if (req.url === '/json/version')
        res.end(
          JSON.stringify({
            Browser: 'Gea/ESP32',
            'Protocol-Version': '1.3',
            webSocketDebuggerUrl: endpoint,
          }),
        )
      else {
        res.statusCode = 404
        res.end('{}')
      }
    } catch (error) {
      res.statusCode = 503
      res.end(JSON.stringify({ error: error.message }))
    }
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })
  server.on('upgrade', (req, socket, head) => {
    if (
      req.url !== '/devtools/page/gea' ||
      sessions.size >= 4 ||
      !acceptsOrigin(req.headers.origin, debugPort)
    ) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })
  wss.on('connection', (ws) => {
    const send = (data) => {
      if (ws.readyState === 1) {
        if (ws.bufferedAmount > 4 * 1024 * 1024) ws.close(1009)
        else ws.send(JSON.stringify(data))
      }
    }
    const session = new DeviceSession(transport, (method, params) => send({ method, params }))
    sessions.add(session)
    let queue = session.refresh().catch((error) => {
      send({ method: 'Inspector.detached', params: { reason: error.message } })
      ws.close(1011)
    })
    let queued = 0
    ws.on('message', (data, binary) => {
      if (binary) {
        ws.close(1003)
        return
      }
      let request
      try {
        request = JSON.parse(data.toString())
      } catch {
        ws.close(1007)
        return
      }
      if (!Number.isInteger(request.id) || typeof request.method !== 'string') {
        ws.close(1007)
        return
      }
      if (request.method.startsWith('Debugger.') && transport.debuggerState) {
        session.handle(request.method, request.params).then(
          (result) => send({ id: request.id, result }),
          (error) => send({ id: request.id, error: { code: -32000, message: error.message } }),
        )
        return
      }
      if (
        [
          'Overlay.highlightNode',
          'Overlay.hideHighlight',
          'Overlay.disable',
          'DOM.highlightNode',
          'DOM.hideHighlight',
        ].includes(request.method)
      ) {
        session.handle(request.method, request.params).then(
          (result) => send({ id: request.id, result }),
          (error) => send({ id: request.id, error: { code: -32000, message: error.message } }),
        )
        return
      }
      if (queued >= 256) {
        send({
          id: request.id,
          error: { code: -32000, message: 'Debugger busy; retry the request' },
        })
        return
      }
      queued++
      queue = queue
        .then(async () => {
          try {
            send({ id: request.id, result: await route(session, request.method, request.params || {}) })
          } catch (e) {
            if (process.env.GEA_DEBUGGER_TRACE === '1')
              console.error('CDP request error', request.method, e.message)
            send({
              id: request.id,
              error: {
                code: e.message.startsWith('Unsupported device protocol method') ? -32601 : -32000,
                message: e.message,
              },
            })
          } finally {
            queued--
          }
        })
        .catch((e) => {
          send({ method: 'Inspector.detached', params: { reason: e.message } })
          ws.close(1011)
        })
    })
    const timer = setInterval(() => {
      if (!queued) {
        queued++
        queue = queue
          .then(() => session.refresh(true))
          .catch((error) => {
            if (process.env.GEA_DEBUGGER_TRACE === '1')
              console.error('Device polling failed', error.message)
            if (error.fatal) ws.close(1011, 'Device disconnected')
            else
              session.emit('Log.entryAdded', {
                entry: {
                  source: 'other',
                  level: 'warning',
                  text: 'Device snapshot failed; retrying: ' + error.message,
                  timestamp: Date.now(),
                },
              })
          })
          .finally(() => queued--)
      }
    }, pollMs)
    timer.unref()
    ws.on('close', (code, reason) => {
      session.closed = true
      if (process.env.GEA_DEBUGGER_TRACE === '1')
        console.error('CDP disconnected', code, reason.toString())
      clearInterval(timer)
      transport.debuggerState?.detach(session)
      transport.clearHighlight(session).catch(() => {})
      transport.cancelInspect(session).catch(() => {})
      sessions.delete(session)
      session.objects.clear()
    })
    ws.on('error', () => ws.close())
  })
  // History, outerHTML and undo are host features layered over the session.
  const historyCommands = new Set(['getChanges', 'undo', 'redo', 'revert', 'exportOverrides', 'exportCss', 'applyOverrides'])
  const route = async (session, method, params) => {
    const compat = compatResult(method)
    if (compat) return compat
    if (method.startsWith('Gea.') && historyCommands.has(method.slice(4)))
      return changes.command(method.slice(4), params)
    if (method === 'DOM.undo' || method === 'DOM.redo') {
      await changes[method === 'DOM.undo' ? 'undo' : 'redo']()
      return {}
    }
    if (method === 'DOM.getOuterHTML') {
      await session.refresh()
      return { outerHTML: outerHTML(session.node(params.nodeId || params.backendNodeId, -1)) }
    }
    if (RECORDED_METHODS.has(method) && !transport.debuggerState?.paused)
      return changes.record(method, params, () => session.handle(method, params))
    return session.handle(method, params)
  }
  const highlightHeartbeat = setInterval(() => {
    transport.keepInspectAlive()?.catch(() => {})
    if (transport.highlight)
      transport
        .setHighlight(transport.highlight, transport.highlightColor, transport.highlightOwner)
        .catch(() => {})
  }, 1000)
  highlightHeartbeat.unref()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(debugPort, '127.0.0.1', resolve)
  })
  return {
    endpoint,
    frontend,
    preview,
    transport,
    changes,
    async close() {
      clearInterval(highlightHeartbeat)
      await transport.debuggerState?.close()
      await transport.elfLines?.close()
      await transport.cancelInspect().catch(() => {})
      await transport.clearHighlight().catch(() => {})
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await transport.tail
    },
  }
}

export async function launchDeviceDebugger({
  serial,
  screenshot,
  appRoot,
  title,
  env = process.env,
  debugPort = 9222,
  debugFps = 0,
  nativeDebug,
  listenerSources,
  stdout = console.log,
  open = true,
  overrides,
  saveOverrides,
}) {
  const frontend = open ? await bundledFrontend({ env, stdout }) : undefined
  const relay = await createDeviceRelay({
    serial,
    screenshot,
    debugPort,
    title,
    debugFps,
    nativeDebug,
    listenerSources,
    appRoot,
    frontend,
  })
  let browser
  let stopped = false
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const stop = () => {
    if (!stopped) {
      stopped = true
      finish()
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    if (overrides) await loadOverridesFile(relay.changes, overrides, stdout)
    stdout(`Device CDP: ${relay.endpoint}`)
    stdout(`Device preview: ${relay.preview}`)
    stdout('Console JavaScript runs on the host; tree/style mutations run on the device.')
    if (nativeDebug) stdout('Native Sources: source maps, breakpoints and stepping over USB JTAG.')
    if (debugFps) stdout(`Device debug FPS cap: ${debugFps}`)
    if (open) {
      const profile = path.join(appRoot, '.gea/build/web/chrome-debug-profile')
      mkdirSync(profile, { recursive: true })
      browser = spawn(
        chromeExecutable(env),
        [
          `--user-data-dir=${profile}`,
          '--remote-debugging-port=0',
          '--remote-debugging-address=127.0.0.1',
          '--no-first-run',
          '--no-default-browser-check',
          relay.preview,
        ],
        { env, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      browser.once('exit', stop)
      browser.once('error', stop)
      const url = await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(
          () => reject(new Error('Chrome did not start its debugger endpoint')),
          15000,
        )
        browser.stderr.on('data', (chunk) => {
          output += chunk
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)
          if (match) {
            clearTimeout(timer)
            resolve(match[1])
          }
        })
        browser.once('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        browser.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('Chrome exited before startup'))
        })
      })
      const client = await connectCDP(url)
      try {
        await client.send('Target.createTarget', { url: relay.frontend, newWindow: true })
      } finally {
        client.close()
      }
    }
    serial.port.once('close', stop)
    serial.port.once('error', stop)
    await done
    return 0
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    serial.port.removeListener('close', stop)
    serial.port.removeListener('error', stop)
    if (browser && browser.exitCode === null) browser.kill('SIGTERM')
    if (saveOverrides)
      await saveOverridesFile(relay.changes, saveOverrides, stdout).catch((error) =>
        stdout(`Cannot save overrides: ${error.message}`),
      )
    await relay.close()
    await serial.close()
  }
}
