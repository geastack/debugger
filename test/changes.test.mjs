import test from 'node:test'
import assert from 'node:assert/strict'
import { Changes, OVERRIDES_FORMAT, describeTarget, ruleOfSheet, ruleSheetId } from '../src/changes.mjs'
import { outerHTML } from '../src/html.mjs'
import { compatResult } from '../src/compat.mjs'
import { FakeNativeDom } from './fixtures/fake-native-dom.mjs'

const attribute = (dom, node, name) => {
  const attributes = dom.find(node.nodeId).attributes
  const index = attributes.indexOf(name)
  return index % 2 === 0 ? attributes[index + 1] : undefined
}

// The client's own connection performs the edit; Changes only observes it.
const edit = (changes, dom, method, params) =>
  changes.record(method, params, async () => dom.call(method, params))

test('rule sheet ids round-trip selector and media', () => {
  const id = ruleSheetId('.tic-status', '(min-width: 400px)')
  assert.deepEqual(ruleOfSheet(id), { selector: '.tic-status', media: '(min-width: 400px)', userAgent: false })
  assert.equal(ruleOfSheet('inline-4'), null)
  assert.equal(ruleOfSheet('rule-%%%'), null)
})

test('targets read as selectors, ids or classed child paths', () => {
  assert.equal(describeTarget({ rule: { selector: '.a', media: '' } }), '.a')
  assert.equal(describeTarget({ rule: { selector: '.a', media: 'print' } }), '@media print { .a }')
  assert.equal(describeTarget({ node: { tag: 'h1', id: 'title' } }), 'h1#title')
  assert.equal(describeTarget({ node: { tag: 'div', classes: ['a', 'b'], path: [0, 2] } }), 'div.a.b at [0, 2]')
  assert.equal(describeTarget({ node: { tag: '#text', path: [0, 1, 0] } }), '#text at [0, 1, 0]')
})

test('edits from any client undo, redo and revert as transactions', async () => {
  const dom = new FakeNativeDom()
  const backend = dom.backend()
  const changes = new Changes(backend, { app: 'Tic Tac Toe' })
  await edit(changes, dom, 'DOM.setAttributeValue', { nodeId: dom.cell.nodeId, name: 'data-note', value: 'edited' })
  await edit(changes, dom, 'CSS.setStyleTexts', {
    edits: [{ styleSheetId: ruleSheetId('.tic-status'), range: {}, text: 'color: red;' }],
  })
  await edit(changes, dom, 'DOM.setNodeValue', { nodeId: dom.status.nodeId, value: 'Turn: O' })
  // An edit that changes nothing is not history.
  await edit(changes, dom, 'DOM.setNodeValue', { nodeId: dom.status.nodeId, value: 'Turn: O' })

  let list = changes.list()
  assert.equal(list.entries.length, 3)
  assert.equal(list.overrides, 3)
  assert.deepEqual(
    list.entries.map((entry) => [entry.kind, entry.ops[0].target]),
    [
      ['attribute', 'div.tic-cell.tic-cell-x at [0, 0, 2]'],
      ['style', '.tic-status'],
      ['text', '#text at [0, 0, 1, 0]'],
    ],
  )

  await changes.undo()
  assert.equal(dom.status.nodeValue, 'Turn: X')
  await changes.undo()
  assert.equal(dom.rules.get('.tic-status'), 'color: #FFFFFF;')
  assert.ok(backend.events.some(([method]) => method === 'CSS.styleSheetChanged'))
  await changes.redo()
  assert.equal(dom.rules.get('.tic-status'), 'color: red;')
  list = changes.list()
  assert.equal(list.canRedo, true)
  assert.equal(list.overrides, 2)

  // Out-of-order revert keeps later history intact.
  await changes.revert(list.entries[0].id)
  assert.equal(attribute(dom, dom.cell, 'data-note'), undefined)
  assert.equal(dom.rules.get('.tic-status'), 'color: red;')
  list = changes.list()
  assert.equal(list.entries.at(-1).kind, 'revert')
  assert.equal(list.canRedo, false)
  assert.equal(list.overrides, 1)
  await assert.rejects(changes.revert(list.entries[0].id), /not applied/)
})

test('undo refuses to clobber a value changed outside the history', async () => {
  const dom = new FakeNativeDom()
  const changes = new Changes(dom.backend())
  await edit(changes, dom, 'DOM.setAttributeValue', { nodeId: dom.title.nodeId, name: 'data-x', value: '1' })
  dom.setAttribute(dom.title, 'data-x', '2')
  await assert.rejects(changes.undo(), /h1#title changed after this edit; undo newer changes first/)
  assert.equal(attribute(dom, dom.title, 'data-x'), '2')
})

test('failed edits record nothing', async () => {
  const dom = new FakeNativeDom()
  const changes = new Changes(dom.backend())
  await assert.rejects(
    changes.record('DOM.setAttributeValue', { nodeId: dom.title.nodeId, name: 'x', value: '1' }, async () => {
      throw new Error('refused')
    }),
    /refused/,
  )
  assert.equal(changes.list().entries.length, 0)
})

test('inline style edits through the style attribute record as style', async () => {
  const dom = new FakeNativeDom()
  const changes = new Changes(dom.backend())
  await edit(changes, dom, 'DOM.setAttributeValue', { nodeId: dom.title.nodeId, name: 'style', value: 'color: blue;' })
  const [entry] = changes.list().entries
  assert.equal(entry.ops[0].type, 'style')
  assert.equal(entry.ops[0].after, 'color: blue;')
  assert.equal(changes.exportCss().source, '#title {\n  color: blue;\n}\n')
})

test('overrides export, survive a class edit and replay into a fresh tree', async () => {
  const dom = new FakeNativeDom()
  const changes = new Changes(dom.backend(), { app: 'Tic Tac Toe' })
  await edit(changes, dom, 'DOM.setAttributeValue', { nodeId: dom.cell.nodeId, name: 'class', value: 'tic-cell won' })
  await edit(changes, dom, 'DOM.setAttributeValue', { nodeId: dom.cell.nodeId, name: 'class', value: 'tic-cell lost' })
  await edit(changes, dom, 'CSS.setStyleTexts', {
    edits: [{ styleSheetId: ruleSheetId('.tic-status'), range: {}, text: 'color: red;' }],
  })
  const document = changes.overrides()
  assert.equal(document.format, OVERRIDES_FORMAT)
  assert.equal(document.app, 'Tic Tac Toe')
  // The changing class label does not split one attribute into two overrides.
  assert.equal(document.overrides.length, 2)
  assert.deepEqual(document.overrides[0].target.node.path, [0, 0, 2])
  assert.equal(document.overrides[0].value, 'tic-cell lost')
  assert.equal(changes.exportCss().source, '.tic-status {\n  color: red;\n}\n')

  const fresh = new FakeNativeDom()
  const replay = new Changes(fresh.backend())
  assert.deepEqual(await replay.applyOverrides(JSON.parse(JSON.stringify(document))), { applied: 2 })
  assert.equal(attribute(fresh, fresh.cell, 'class'), 'tic-cell lost')
  assert.equal(fresh.rules.get('.tic-status'), 'color: red;')
  await replay.undo()
  assert.equal(attribute(fresh, fresh.cell, 'class'), 'tic-cell tic-cell-x')
  assert.equal(fresh.rules.get('.tic-status'), 'color: #FFFFFF;')
})

test('overrides resolve every target first and roll back a failed write', async () => {
  const dom = new FakeNativeDom()
  const changes = new Changes(dom.backend())
  const document = (overrides) => ({ format: OVERRIDES_FORMAT, version: 1, overrides })
  const rule = { type: 'style', target: { rule: { selector: '.tic-status', media: '' } }, value: 'color: red;' }
  await assert.rejects(changes.applyOverrides({ format: 'other' }), /Not a Gea debugger overrides file/)
  await assert.rejects(
    changes.applyOverrides(document([rule, { type: 'attribute', name: 'x', target: { node: { tag: 'h1', id: 'missing' } }, value: '1' }])),
    /Missing or ambiguous element id: #missing/,
  )
  await assert.rejects(
    changes.applyOverrides(document([{ type: 'attribute', name: 'x', target: { node: { tag: 'span', path: [0, 0, 0] } }, value: '1' }])),
    /changed from <span> to <h1>/,
  )
  assert.equal(dom.rules.get('.tic-status'), 'color: #FFFFFF;')
  dom.fail = (method) => method === 'DOM.setAttributeValue'
  await assert.rejects(
    changes.applyOverrides(document([rule, { type: 'attribute', name: 'x', target: { node: { tag: 'h1', id: 'title' } }, value: '1' }])),
    /setAttributeValue failed/,
  )
  assert.equal(dom.rules.get('.tic-status'), 'color: #FFFFFF;')
  assert.equal(changes.list().entries.length, 0)
})

test('outerHTML serializes a described subtree with escaping and void elements', () => {
  const node = {
    nodeType: 1,
    localName: 'div',
    attributes: ['title', 'a "b" & <c>'],
    children: [
      { nodeType: 3, nodeValue: '1 < 2 & 3' },
      { nodeType: 1, localName: 'img', attributes: ['src', 'x.png'] },
      { nodeType: 1, nodeName: 'SPAN', attributes: [], children: [] },
    ],
  }
  assert.equal(
    outerHTML(node),
    '<div title="a &quot;b&quot; &amp; &lt;c&gt;">1 &lt; 2 &amp; 3<img src="x.png"><span></span></div>',
  )
})

test('compat answers attach-time no-ops but leaves long polls to the backend', () => {
  assert.deepEqual(compatResult('Overlay.setShowPaintRects'), {})
  assert.deepEqual(compatResult('Runtime.addBinding'), {})
  const first = compatResult('Page.addScriptToEvaluateOnNewDocument')
  assert.notEqual(first.identifier, compatResult('Page.addScriptToEvaluateOnNewDocument').identifier)
  assert.equal(compatResult('CSS.takeComputedStyleUpdates'), undefined)
  assert.equal(compatResult('DOM.getDocument'), undefined)
})
