// Shared edit history for the native relays. Successful Styles, attribute and
// text edits from every connected client become reversible transactions, and
// the net effect can be saved as overrides and replayed on a later launch.
import { cssRange, parseCssDeclarations } from './css.mjs'

export const OVERRIDES_FORMAT = 'gea-debugger-overrides'
const HISTORY_LIMIT = 200

export const RECORDED_METHODS = new Set([
  'CSS.setStyleTexts',
  'DOM.setAttributeValue',
  'DOM.setAttributesAsText',
  'DOM.removeAttribute',
  'DOM.setNodeValue',
])

export function ruleSheetId(selector, media = '') {
  return 'rule-' + Buffer.from(JSON.stringify([selector, media, false])).toString('base64url')
}

export function ruleOfSheet(styleSheetId) {
  if (!styleSheetId?.startsWith('rule-')) return null
  try {
    const [selector, media, userAgent] = JSON.parse(
      Buffer.from(styleSheetId.slice(5), 'base64url').toString('utf8'),
    )
    if (typeof selector !== 'string' || typeof media !== 'string') return null
    return { selector, media, userAgent: !!userAgent }
  } catch {
    return null
  }
}

const attributeMap = (flat = []) => {
  const map = {}
  for (let index = 0; index + 1 < flat.length; index += 2) map[flat[index]] = flat[index + 1]
  return map
}

// Locate a node by a unique id attribute, else by its child-index path from
// the document. Lifetime node IDs are never persisted.
function locate(tree, nodeId) {
  const parents = new Map()
  const nodes = new Map()
  const ids = new Map()
  const visit = (node) => {
    nodes.set(node.nodeId, node)
    const id = attributeMap(node.attributes).id
    if (id) ids.set(id, (ids.get(id) || 0) + 1)
    for (const child of node.children || []) {
      parents.set(child.nodeId, node)
      visit(child)
    }
  }
  visit(tree)
  const node = nodes.get(nodeId)
  if (!node) throw new Error('Node no longer exists')
  const tag = node.nodeName === '#text' ? '#text' : node.localName || node.nodeName.toLowerCase()
  const attributes = attributeMap(node.attributes)
  const id = attributes.id
  if (id && ids.get(id) === 1) return { tag, id }
  // Classes only label the entry; the path alone locates the node.
  const classes = String(attributes.class || '').split(/\s+/).filter(Boolean).slice(0, 3)
  const path = []
  for (let current = node; parents.has(current.nodeId); current = parents.get(current.nodeId)) {
    path.unshift(parents.get(current.nodeId).children.indexOf(current))
    if (path.length > 256) throw new Error('Node path exceeds limit')
  }
  return classes.length ? { tag, classes, path } : { tag, path }
}

function resolve(tree, target) {
  if (!target || typeof target.tag !== 'string') throw new Error('Invalid override target')
  let node
  if (typeof target.id === 'string' && target.id) {
    const matches = []
    const visit = (current) => {
      if (attributeMap(current.attributes).id === target.id) matches.push(current)
      for (const child of current.children || []) visit(child)
    }
    visit(tree)
    if (matches.length !== 1) throw new Error(`Missing or ambiguous element id: #${target.id}`)
    node = matches[0]
  } else if (Array.isArray(target.path) && target.path.length <= 256) {
    node = tree
    for (const index of target.path) {
      if (!Number.isInteger(index) || index < 0) throw new Error('Invalid override path')
      node = node.children?.[index]
      if (!node) throw new Error('Override path no longer exists')
    }
  } else throw new Error('Invalid override locator')
  const tag = node.nodeName === '#text' ? '#text' : node.localName || node.nodeName.toLowerCase()
  if (tag !== target.tag) throw new Error(`Override target changed from <${target.tag}> to <${tag}>`)
  return node.nodeId
}

export function describeTarget(target) {
  if (target.rule)
    return target.rule.media ? `@media ${target.rule.media} { ${target.rule.selector} }` : target.rule.selector
  const node = target.node
  if (node.tag === '#text') return `#text at [${(node.path || []).join(', ')}]`
  if (node.id) return `${node.tag}#${node.id}`
  const classes = Array.isArray(node.classes) ? node.classes.map((name) => '.' + name).join('') : ''
  return `${node.tag}${classes} at [${(node.path || []).join(', ')}]`
}

const locator = (target) =>
  target.rule ? { rule: target.rule } : { node: { tag: target.node.tag, id: target.node.id, path: target.node.path } }
const opKey = (op) => JSON.stringify([op.type, locator(op.target), op.name || ''])

export class Changes {
  // backend.call(method, params) runs a CDP request on a private connection;
  // backend.broadcast(method, params) notifies every connected client.
  constructor(backend, { app = '' } = {}) {
    this.backend = backend
    this.app = app
    this.entries = []
    this.cursor = 0
    this.next = 0
    this.state = new Map()
    this.queue = Promise.resolve()
    this.queued = 0
  }
  run(action) {
    if (this.queued >= 256) return Promise.reject(new Error('Edit queue limit exceeded'))
    this.queued++
    const pending = this.queue.then(action).finally(() => this.queued--)
    this.queue = pending.catch(() => {})
    return pending
  }
  async tree() {
    await this.backend.sync?.()
    return (await this.backend.call('DOM.getDocument', { depth: -1 })).root
  }
  async read(op) {
    if (op.type === 'style')
      return (await this.backend.call('CSS.getStyleSheetText', { styleSheetId: op.sheet })).text
    if (op.type === 'attribute') {
      const { attributes } = await this.backend.call('DOM.getAttributes', { nodeId: op.node })
      return attributeMap(attributes)[op.name] ?? null
    }
    return (await this.backend.call('DOM.describeNode', { nodeId: op.node })).node.nodeValue
  }
  async write(op, value) {
    if (op.type === 'style') {
      const current = await this.read(op)
      await this.backend.call('CSS.setStyleTexts', {
        edits: [{ styleSheetId: op.sheet, range: cssRange(current), text: value }],
      })
      this.backend.broadcast('CSS.styleSheetChanged', { styleSheetId: op.sheet })
      if (op.sheet.startsWith('inline-'))
        this.backend.broadcast('DOM.inlineStyleInvalidated', { nodeIds: [Number(op.sheet.slice(7))] })
    } else if (op.type === 'attribute') {
      if (value === null) await this.backend.call('DOM.removeAttribute', { nodeId: op.node, name: op.name })
      else await this.backend.call('DOM.setAttributeValue', { nodeId: op.node, name: op.name, value })
    } else await this.backend.call('DOM.setNodeValue', { nodeId: op.node, value })
  }
  track(op, value) {
    const key = opKey(op)
    const entry = this.state.get(key) || { op, baseline: op.before }
    entry.op = op
    entry.value = value
    if (value === entry.baseline) this.state.delete(key)
    else this.state.set(key, entry)
  }
  remember(kind, ops, { tracked = false } = {}) {
    ops = ops.filter((op) => op.before !== op.after)
    if (!ops.length) return null
    if (!tracked) for (const op of ops) this.track(op, op.after)
    const entry = { id: ++this.next, kind, ops, applied: true, time: Date.now() }
    this.entries.splice(this.cursor)
    this.entries.push(entry)
    if (this.entries.length > HISTORY_LIMIT) this.entries.shift()
    this.cursor = this.entries.length
    return entry
  }
  async nodeTarget(tree, nodeId) {
    return { node: locate(tree, nodeId) }
  }
  // Capture the affected state, let the client's own connection perform the
  // edit, then capture the result. Failed edits record nothing.
  record(method, params, forward) {
    return this.run(async () => {
      const ops = []
      if (method === 'CSS.setStyleTexts') {
        const sheets = [...new Set((params.edits || []).map((edit) => edit.styleSheetId))]
        let tree
        for (const sheet of sheets) {
          const rule = ruleOfSheet(sheet)
          let target
          if (rule) target = { rule: { selector: rule.selector, media: rule.media } }
          else if (sheet?.startsWith('inline-')) {
            tree ||= await this.tree()
            target = await this.nodeTarget(tree, Number(sheet.slice(7)))
          } else continue
          ops.push({ type: 'style', sheet, target })
        }
      } else {
        const node = params.nodeId
        const tree = await this.tree()
        const target = await this.nodeTarget(tree, node)
        if (method === 'DOM.setNodeValue') ops.push({ type: 'text', node, target })
        else {
          const { attributes } = await this.backend.call('DOM.getAttributes', { nodeId: node })
          const names =
            method === 'DOM.setAttributesAsText'
              ? [...new Set([...Object.keys(attributeMap(attributes)), ...(params.name ? [params.name] : []),
                  ...[...String(params.text).matchAll(/([^\s=/>"']+)\s*=/g)].map((m) => m[1])])]
              : [params.name]
          // Inline style edits through the attribute are recorded as their sheet.
          for (const name of names)
            if (name === 'style') ops.push({ type: 'style', sheet: `inline-${node}`, target })
            else ops.push({ type: 'attribute', node, name, target })
        }
      }
      for (const op of ops) op.before = await this.read(op)
      const result = await forward()
      for (const op of ops) op.after = await this.read(op)
      this.remember(method === 'CSS.setStyleTexts' ? 'style' : ops[0]?.type || 'attribute', ops)
      return result
    })
  }
  async apply(entry, direction) {
    const from = direction === 'undo' ? 'after' : 'before'
    const to = direction === 'undo' ? 'before' : 'after'
    const ops = direction === 'undo' ? entry.ops.toReversed() : entry.ops
    for (const op of ops)
      if ((await this.read(op)) !== op[from])
        throw new Error(
          `${describeTarget(op.target)} changed after this edit; ${direction === 'undo' ? 'undo newer changes first' : 'it can no longer be redone'}`,
        )
    const done = []
    try {
      for (const op of ops) {
        await this.write(op, op[to])
        done.push(op)
      }
    } catch (error) {
      for (const op of done.reverse()) await this.write(op, op[from]).catch(() => {})
      throw error
    }
    for (const op of ops) this.track(op, op[to])
    entry.applied = direction !== 'undo'
  }
  undo() {
    return this.run(async () => {
      if (!this.cursor) throw new Error('Nothing to undo')
      await this.apply(this.entries[this.cursor - 1], 'undo')
      this.cursor--
    })
  }
  redo() {
    return this.run(async () => {
      if (this.cursor >= this.entries.length) throw new Error('Nothing to redo')
      await this.apply(this.entries[this.cursor], 'redo')
      this.cursor++
    })
  }
  // Undo one transaction out of order with a compensating edit.
  revert(id) {
    return this.run(async () => {
      const entry = this.entries.find((candidate) => candidate.id === id)
      if (!entry?.applied) throw new Error('This change is not applied')
      const ops = entry.ops.map((op) => ({ ...op, before: op.after, after: op.before }))
      await this.apply({ ops }, 'redo')
      entry.applied = false
      // apply() already moved the net overrides back.
      this.remember('revert', ops, { tracked: true })
    })
  }
  overrides() {
    return {
      format: OVERRIDES_FORMAT,
      version: 1,
      ...(this.app ? { app: this.app } : {}),
      overrides: [...this.state.values()].map(({ op, value }) => ({
        type: op.type,
        target: op.target,
        ...(op.type === 'attribute' ? { name: op.name } : {}),
        value,
      })),
    }
  }
  exportCss() {
    const blocks = []
    for (const { op, value } of this.state.values()) {
      if (op.type !== 'style') continue
      const body = parseCssDeclarations(value)
        .filter((property) => !property.disabled && property.parsedOk)
        .map((property) => `  ${property.name}: ${property.value};`)
        .join('\n')
      if (op.target.rule) {
        const rule = `${op.target.rule.selector} {\n${body}\n}`
        blocks.push(
          op.target.rule.media
            ? `@media ${op.target.rule.media} {\n${rule.replace(/^/gm, '  ')}\n}`
            : rule,
        )
      } else if (op.target.node.id) blocks.push(`#${op.target.node.id} {\n${body}\n}`)
      else blocks.push(`/* inline style on ${describeTarget(op.target)} */\n/*\n${body}\n*/`)
    }
    return { source: blocks.join('\n\n') + (blocks.length ? '\n' : '') }
  }
  applyOverrides(document) {
    return this.run(async () => {
      if (document?.format !== OVERRIDES_FORMAT || document.version !== 1 || !Array.isArray(document.overrides))
        throw new Error('Not a Gea debugger overrides file')
      if (document.overrides.length > 1024) throw new Error('Overrides file exceeds 1024 edits')
      const tree = await this.tree()
      // Resolve every target before editing anything.
      const ops = document.overrides.map((override) => {
        if (!['style', 'attribute', 'text'].includes(override.type)) throw new Error('Invalid override type')
        if (override.type === 'attribute' ? !(override.value === null || typeof override.value === 'string')
          : typeof override.value !== 'string')
          throw new Error('Invalid override value')
        if (override.type === 'style' && override.target?.rule) {
          const { selector, media = '' } = override.target.rule
          if (typeof selector !== 'string' || typeof media !== 'string') throw new Error('Invalid rule override')
          return { type: 'style', sheet: ruleSheetId(selector, media), target: { rule: { selector, media } }, after: override.value }
        }
        const node = resolve(tree, override.target?.node)
        const { tag, id, path, classes } = override.target.node
        const target = {
          node: {
            tag,
            ...(id ? { id } : { path }),
            ...(Array.isArray(classes) && classes.every((name) => typeof name === 'string')
              ? { classes: classes.slice(0, 3) }
              : {}),
          },
        }
        if (override.type === 'style') return { type: 'style', sheet: `inline-${node}`, target, after: override.value }
        if (override.type === 'attribute') {
          if (typeof override.name !== 'string' || !override.name || override.name === 'style')
            throw new Error('Invalid attribute override')
          return { type: 'attribute', node, name: override.name, target, after: override.value }
        }
        return { type: 'text', node, target, after: override.value }
      })
      for (const op of ops) op.before = await this.read(op)
      const done = []
      try {
        for (const op of ops) {
          await this.write(op, op.after)
          done.push(op)
        }
      } catch (error) {
        for (const op of done.reverse()) await this.write(op, op.before).catch(() => {})
        throw error
      }
      const entry = this.remember('overrides', ops)
      return { applied: entry?.ops.length || 0 }
    })
  }
  list() {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.entries.length,
      overrides: this.state.size,
      entries: this.entries.map((entry, index) => ({
        id: entry.id,
        kind: entry.kind,
        applied: entry.applied,
        current: index < this.cursor,
        time: entry.time,
        ops: entry.ops.map((op) => ({
          type: op.type,
          target: describeTarget(op.target),
          ...(op.name ? { name: op.name } : {}),
          before: op.before,
          after: op.after,
        })),
      })),
    }
  }
  // Commands for the Gea Changes panel and Gea.* protocol methods.
  async command(name, params = {}) {
    if (name === 'getChanges') return this.list()
    if (name === 'undo') return (await this.undo(), this.list())
    if (name === 'redo') return (await this.redo(), this.list())
    if (name === 'revert') return (await this.revert(params.id), this.list())
    if (name === 'exportOverrides') return this.overrides()
    if (name === 'exportCss') return this.exportCss()
    if (name === 'applyOverrides') return this.applyOverrides(params.document)
    throw new Error('Unknown changes command: ' + name)
  }
}

// HTTP endpoint shared by both relays for the bundled Changes panel.
export async function serveChanges(req, res, changes) {
  if (req.url !== '/gea/changes' || req.method !== 'POST') return false
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      throw new Error('Changes requests require JSON')
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1024 * 1024) throw new Error('Changes request exceeds 1 MiB')
      chunks.push(chunk)
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof request.method !== 'string') throw new Error('Invalid changes command')
    if (!changes) throw new Error('Edit history is unavailable for this target')
    res.end(JSON.stringify(await changes.command(request.method, request.params || {})))
  } catch (error) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: error.message }))
  }
  return true
}

// --overrides replays a saved file once the relay is up; --save-overrides
// writes the session's net edits when the debugger closes.
export async function loadOverridesFile(changes, file, stdout = console.log) {
  const { readFile } = await import('node:fs/promises')
  let document
  try {
    document = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read overrides ${file}: ${error.message}`)
  }
  const { applied } = await changes.applyOverrides(document)
  stdout(`Applied ${applied} saved override${applied === 1 ? '' : 's'} from ${file}.`)
}

export async function saveOverridesFile(changes, file, stdout = console.log) {
  const { writeFile } = await import('node:fs/promises')
  const document = changes.overrides()
  await writeFile(file, JSON.stringify(document, null, 2) + '\n')
  stdout(`Saved ${document.overrides.length} override${document.overrides.length === 1 ? '' : 's'} to ${file}.`)
}
