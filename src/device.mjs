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
import { createNativeDebugger } from './gdb.mjs'
import { previewFonts } from './preview-fonts.mjs'

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
          if (!meta.boot)
            throw new Error('Firmware lacks debugger framing; rebuild without --attach')
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
          }
          if (nodes.size !== payload.length || !nodes.has(snapshot.root))
            throw new Error('Snapshot has duplicate identities or no mounted root')
          this.cached = snapshot
          this.lastGood = snapshot
          this.cachedAt = Date.now()
          return snapshot
        } catch (error) {
          if (this.debuggerState?.paused && this.lastGood) return this.lastGood
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
      if (request.op !== 'highlight') this.cached = null
    }
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
    if (!this.lastGood?.nativeHighlight || this.debuggerState?.paused) return Promise.resolve()
    if (!this.highlightWrite) {
      const pending = this.enqueue(async () => {
        while (this.highlightWritten !== this.highlightRevision && !this.debuggerState?.paused) {
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

function cssStyle(id, declarations, styleSheetId = `inline-${id}`) {
  let offset = 0
  const cssProperties = Object.entries(declarations).map(([name, value]) => {
    const text = `${name}: ${value};`
    const startColumn = offset
    offset += text.length + 1
    return {
      name,
      value,
      text,
      implicit: false,
      disabled: false,
      parsedOk: true,
      range: { startLine: 0, startColumn, endLine: 0, endColumn: offset - 1 },
    }
  })
  return {
    styleSheetId,
    cssProperties,
    shorthandEntries: [],
    cssText: cssProperties.map((p) => p.text).join(' '),
    range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: Math.max(0, offset - 1) },
  }
}
function declarations(text) {
  const out = {}
  for (const part of text.split(';')) {
    const colon = part.indexOf(':')
    if (colon > 0) out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
  }
  return out
}

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
function sheetHeader(id, length = 0, ownerNode) {
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
    length,
    endLine: 0,
    endColumn: length,
    ...(ownerNode ? { ownerNode } : {}),
  }
}

export class DeviceSession {
  constructor(transport, emit = () => {}) {
    this.transport = transport
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
            session.queue({ op: 'style', id, key, value: String(value) })
            const styles = session.styles.get(id) || {}
            styles[key] = String(value)
            session.styles.set(id, styles)
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
            if (key === 'cssText') return cssStyle(id, session.styles.get(id) || {}).cssText
            return key in target
              ? target[key]
              : target.getPropertyValue(String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))
          },
          set(target, key, value) {
            if (key === 'cssText') {
              const next = declarations(String(value))
              for (const name of new Set([
                ...Object.keys(session.styles.get(id) || {}),
                ...Object.keys(next),
              ]))
                target.setProperty(name, next[name] || '')
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
      const text = cssStyle(node.id, node.inline || {}).cssText
      if (text) node.attributes.style = text
      else delete node.attributes.style
    }
    const old = this.authoritative || this.nodes
    this.nodes = snapshot.nodes
    this.authoritative = structuredClone(snapshot.nodes)
    this.styles = new Map([...this.nodes].map(([id, n]) => [id, n.inline || {}]))
    this.root = snapshot.root
    this.width = snapshot.width
    this.height = snapshot.height
    this.debugFps = snapshot.debugFps || 0
    this.ruleSheets = ruleSheets(this.nodes)
    if (notify && this.cssEnabled) {
      const before = ruleSheets(old)
      for (const [id, sheet] of this.ruleSheets) {
        if (!before.has(id))
          this.emit('CSS.styleSheetAdded', {
            header: sheetHeader(id, cssStyle(0, sheet.values, id).cssText.length),
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
  }
  async flush() {
    const pending = this.pending.splice(0)
    try {
      for (const operation of pending) await this.transport.mutate(operation)
    } finally {
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
        ? { subtype: 'node', className: 'NativeElement', description: value.tagName.toLowerCase() }
        : Array.isArray(value)
          ? { subtype: 'array', className: 'Array', description: `Array(${value.length})` }
          : {
              className: type === 'function' ? 'Function' : 'Object',
              description: type === 'function' ? String(value) : 'Object',
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
  async setInlineAttribute(id, text) {
    const next = declarations(text)
    for (const name of new Set([...Object.keys(this.styles.get(id) || {}), ...Object.keys(next)]))
      await this.transport.mutate({ op: 'style', id, key: name, value: next[name] || '' })
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
            cssStyle(id, this.styles.get(id) || {}).cssText.length,
            id,
          ),
        })
      for (const [id, sheet] of this.ruleSheets)
        this.emit('CSS.styleSheetAdded', {
          header: sheetHeader(id, cssStyle(0, sheet.values, id).cssText.length),
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
      if (this.transport.clearHighlight) await this.transport.clearHighlight(this)
      else this.transport.highlight = 0
      return {}
    }
    if (method === 'DOM.resolveNode')
      return { object: this.remote(this.wrap(p.nodeId || p.backendNodeId), p.objectGroup) }
    if (method === 'DOM.requestNode') return { nodeId: this.object(p.objectId).__geaNodeId }
    if (method === 'DOM.pushNodesByBackendIdsToFrontend')
      return { nodeIds: p.backendNodeIds.map((id) => (this.nodes.has(id) ? id : 0)) }
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
        inlineStyle: cssStyle(p.nodeId, this.styles.get(p.nodeId) || {}),
        attributesStyle: { cssProperties: [], shorthandEntries: [] },
      }
    if (method === 'CSS.getMatchedStylesForNode') {
      const matched = ruleSheets(new Map([[p.nodeId, this.nodes.get(p.nodeId) || {}]]))
      return {
        inlineStyle: cssStyle(p.nodeId, this.styles.get(p.nodeId) || {}),
        attributesStyle: { cssProperties: [], shorthandEntries: [] },
        matchedCSSRules: [...matched].map(([id, sheet]) => ({
          matchingSelectors: [0],
          rule: {
            styleSheetId: id,
            origin: sheet.userAgent ? 'user-agent' : 'regular',
            selectorList: { text: sheet.selector, selectors: [{ text: sheet.selector }] },
            style: cssStyle(0, sheet.values, id),
          },
        })),
        inherited: [],
        pseudoElements: [],
        cssKeyframesRules: [],
      }
    }
    if (method === 'CSS.getStyleSheetText') {
      const sheet = this.ruleSheets.get(p.styleSheetId)
      return {
        text: sheet
          ? cssStyle(0, sheet.values, p.styleSheetId).cssText
          : cssStyle(
              Number(p.styleSheetId.slice(7)),
              this.styles.get(Number(p.styleSheetId.slice(7))) || {},
            ).cssText,
      }
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
        const current = sheet ? sheet.values : this.styles.get(id) || {}
        const old = cssStyle(id, current, edit.styleSheetId).cssText
        const range = edit.range
        if (
          range.startLine !== 0 ||
          range.endLine !== 0 ||
          range.startColumn < 0 ||
          range.endColumn < range.startColumn ||
          range.endColumn > old.length
        )
          throw new Error('Invalid or outdated style range; refresh the style and retry')
        const next = declarations(
          old.slice(0, range.startColumn) + edit.text + old.slice(range.endColumn),
        )
        for (const key of new Set([...Object.keys(current), ...Object.keys(next)]))
          if ((current[key] || '') !== (next[key] || ''))
            await this.transport.mutate(
              sheet
                ? {
                    op: 'rule',
                    selector: sheet.selector,
                    media: sheet.media,
                    key,
                    value: next[key] || '',
                  }
                : { op: 'style', id, key, value: next[key] || '' },
            )
        edited.push({ id, styleSheetId: edit.styleSheetId, sheet })
        await this.refresh(false)
      }
      // Publish after the response so Chrome commits the edited property/ranges
      // before its Styles sidebar reloads the changed authored rule.
      const changedSheets = [...new Set(edited.filter((e) => e.sheet).map((e) => e.styleSheetId))]
      if (changedSheets.length)
        setTimeout(() => {
          for (const styleSheetId of changedSheets)
            this.emit('CSS.styleSheetChanged', { styleSheetId })
        }, 0)
      return {
        styles: edited.map(({ id, styleSheetId, sheet }) =>
          cssStyle(
            id,
            sheet ? this.ruleSheets.get(styleSheetId)?.values || {} : this.styles.get(id) || {},
            styleSheetId,
          ),
        ),
      }
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
        'Overlay.setInspectMode',
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
  appRoot,
}) {
  debugPort = portNumber(debugPort, '--debug-port')
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
  await transport.clearHighlight()
  const endpoint = `ws://127.0.0.1:${debugPort}/devtools/page/gea`
  // inspector.html replaces protocol hover with a local screencast painter.
  const frontend = `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${debugPort}/devtools/page/gea`
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
        req.method !== 'GET' ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${debugPort}`)
      ) {
        res.statusCode = 403
        res.end('Local preview access only')
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
            highlight: transport.highlight || 0,
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
  const sessions = new Set()
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
            send({ id: request.id, result: await session.handle(request.method, request.params) })
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
      sessions.delete(session)
      session.objects.clear()
    })
    ws.on('error', () => ws.close())
  })
  const highlightHeartbeat = setInterval(() => {
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
    async close() {
      clearInterval(highlightHeartbeat)
      await transport.debuggerState?.close()
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
  stdout = console.log,
  open = true,
}) {
  const relay = await createDeviceRelay({
    serial,
    screenshot,
    debugPort,
    title,
    debugFps,
    nativeDebug,
    appRoot,
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
    await relay.close()
    await serial.close()
  }
}
