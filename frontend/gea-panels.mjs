// Loaded into the pinned DevTools frontend by entrypoints/devtools_app.js.
import * as UI from '../ui/legacy/legacy.js'
import { parseCssDeclarations } from './css.js'

async function command(method, params = {}) {
  const response = await fetch('/gea/changes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Gea debugger unavailable')
  return result
}

function element(tag, text, parent) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  parent?.append(node)
  return node
}

function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = element('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function styleDiff(op) {
  const declarations = (text) =>
    new Map(
      parseCssDeclarations(text || '').map((p) => [
        p.name,
        `${p.disabled ? '/* ' : ''}${p.name}: ${p.value};${p.disabled ? ' */' : ''}`,
      ]),
    )
  const before = declarations(op.before)
  const after = declarations(op.after)
  const lines = []
  for (const key of new Set([...before.keys(), ...after.keys()]))
    if (before.get(key) !== after.get(key)) {
      if (before.has(key)) lines.push(['gea-before', '− ' + before.get(key)])
      if (after.has(key)) lines.push(['gea-after', '+ ' + after.get(key)])
    }
  return lines
}

function opLines(op) {
  if (op.type === 'style') return styleDiff(op)
  const label = op.type === 'attribute' ? `${op.name}=` : ''
  const value = (v) => (v === null ? '(removed)' : label + JSON.stringify(v))
  return [
    ['gea-before', '− ' + value(op.before)],
    ['gea-after', '+ ' + value(op.after)],
  ]
}

class ChangesPanel extends UI.Widget.VBox {
  constructor() {
    super()
    element(
      'style',
      `
      .gea-body{padding:12px;font:12px/1.5 system-ui;color:var(--sys-color-on-surface);overflow:auto}
      .gea-body h3{margin:4px 0 10px;font-size:14px}
      .gea-body p{margin:6px 0}
      .gea-body button{font:inherit;color:inherit;background:var(--sys-color-surface);border:1px solid var(--sys-color-outline);border-radius:4px;padding:4px 7px;cursor:pointer}
      .gea-body button:disabled{opacity:.5;cursor:default}
      .gea-body button:hover:not(:disabled){background:var(--sys-color-state-hover-on-subtle)}
      .gea-body :is(button,summary):focus-visible{outline:2px solid var(--sys-color-primary);outline-offset:2px}
      .gea-toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
      .gea-row{border-top:1px solid var(--sys-color-outline-variant);padding:10px 0}
      .gea-row.undone{opacity:.6}
      .gea-target{font-weight:600;overflow-wrap:anywhere}
      .gea-kind{color:var(--sys-color-on-surface-subtle);font-size:11px;margin-left:6px}
      .gea-body pre{font:11px/1.5 monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0}
      .gea-before{color:var(--sys-color-error)}.gea-after{color:var(--sys-color-primary)}
      .gea-muted{opacity:.75}
      .gea-error{color:var(--sys-color-error);white-space:pre-wrap}.gea-error:empty{display:none}
    `,
      this.contentElement,
    )
    this.body = element('div', undefined, this.contentElement)
    this.body.className = 'gea-body'
    this.error = element('p', undefined, this.body)
    this.error.className = 'gea-error'
    this.error.setAttribute('role', 'status')
    this.main = element('div', undefined, this.body)
    this.generation = 0
    this.fingerprint = ''
  }
  async act(action) {
    this.error.textContent = ''
    try {
      await action()
    } catch (error) {
      this.error.textContent = error.message
    }
    await this.refresh(true)
  }
  button(parent, title, action) {
    const button = element('button', title, parent)
    button.addEventListener('click', () => this.act(action))
    return button
  }
  wasShown() {
    this.refresh(true)
    this.timer = setInterval(() => this.refresh(), 1500)
  }
  willHide() {
    clearInterval(this.timer)
    this.generation++
  }
  async refresh(force = false) {
    const generation = ++this.generation
    let changes
    try {
      changes = await command('getChanges')
    } catch (error) {
      if (generation === this.generation) this.error.textContent = error.message
      return
    }
    if (generation !== this.generation) return
    const fingerprint = JSON.stringify(changes)
    if (!force && fingerprint === this.fingerprint) return
    this.fingerprint = fingerprint
    this.main.replaceChildren()
    element('h3', 'Gea Changes', this.main)
    const tools = element('div', undefined, this.main)
    tools.className = 'gea-toolbar'
    this.button(tools, 'Undo', () => command('undo')).disabled = !changes.canUndo
    this.button(tools, 'Redo', () => command('redo')).disabled = !changes.canRedo
    this.button(tools, 'Save overrides', async () =>
      download('gea-overrides.json', JSON.stringify(await command('exportOverrides'), null, 2) + '\n'),
    ).disabled = !changes.overrides
    this.button(tools, 'Export CSS', async () =>
      download('gea-overrides.css', (await command('exportCss')).source, 'text/css'),
    ).disabled = !changes.overrides
    const file = element('input', undefined, tools)
    file.type = 'file'
    file.accept = '.json,application/json'
    file.hidden = true
    file.addEventListener('change', () =>
      this.act(async () => {
        const selected = file.files[0]
        file.value = ''
        if (!selected) return
        if (selected.size > 1024 * 1024) throw new Error('Overrides file exceeds 1 MiB')
        await command('applyOverrides', { document: JSON.parse(await selected.text()) })
      }),
    )
    this.button(tools, 'Load overrides', () => file.click())
    element(
      'p',
      'Styles, attributes and text edited in DevTools share this history across connected windows. Undo also works with ⌘Z in Elements. Overrides locate elements by unique id or child path.',
      this.main,
    ).className = 'gea-muted'
    if (!changes.entries.length)
      element('p', 'No edits yet. Change a style, attribute or text in Elements to start.', this.main)
    for (const entry of changes.entries.toReversed()) {
      const row = element('div', undefined, this.main)
      row.className = `gea-row${entry.current ? '' : ' undone'}`
      for (const op of entry.ops) {
        const heading = element('div', undefined, row)
        element('span', op.target, heading).className = 'gea-target'
        element(
          'span',
          `${op.type}${entry.kind === 'overrides' ? ' · loaded override' : entry.kind === 'revert' ? ' · revert' : ''}${entry.current ? '' : ' · undone'}`,
          heading,
        ).className = 'gea-kind'
        for (const [className, text] of opLines(op)) element('pre', text, row).className = className
      }
      if (entry.current && entry.kind !== 'revert')
        this.button(row, 'Undo this change', () => command('revert', { id: entry.id })).disabled =
          !entry.applied
    }
  }
}

UI.ViewManager.registerViewExtension({
  location: 'panel',
  id: 'gea.changes',
  title: () => 'Gea Changes',
  commandPrompt: () => 'Show Gea Changes',
  order: 11,
  persistence: 'permanent',
  async loadView() {
    return new ChangesPanel()
  },
})
