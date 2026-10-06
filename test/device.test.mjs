import test from 'node:test'
import assert from 'node:assert/strict'
import { DeviceSession, DeviceTransport, snapshotChecksum } from '../src/device.mjs'

function framed(nodes, sequence, boot = 1) {
  const payload = nodes.map((n) => JSON.stringify(n))
  return {
    begin: `GEADEV:DEBUG BEGIN sequence=${sequence}`,
    lines: payload.map((line) => 'GEADEV:DEBUG NODE ' + line),
    end: `GEADEV:DEBUG END root=4 width=410 height=502 boot=${boot} sequence=${sequence} count=${payload.length} checksum=${snapshotChecksum(payload)}`,
  }
}

function fixture() {
  const nodes = new Map([
    [
      4,
      {
        id: 4,
        tag: 'div',
        attributes: { id: 'app' },
        children: [6],
        parent: 2,
        type: 1,
        text: '',
        computed: { 'background-color': 'rgb(0, 0, 0)' },
        inline: {},
        rules: [],
        x: 0,
        y: 0,
        width: 410,
        height: 502,
      },
    ],
    [
      6,
      {
        id: 6,
        tag: 'span',
        attributes: { class: 'status' },
        children: [],
        parent: 4,
        type: 1,
        text: 'Ready',
        computed: { color: 'rgb(255, 255, 255)' },
        inline: {},
        rules: [],
        x: 10,
        y: 10,
        width: 100,
        height: 20,
      },
    ],
  ])
  let next = 8
  const operations = []
  return {
    operations,
    snapshot: async () => ({ nodes: structuredClone(nodes), root: 4, width: 410, height: 502 }),
    mutate: async (operation) => {
      operations.push(operation)
      if (operation.op === 'create') {
        const id = next
        next += 2
        nodes.set(id, {
          ...structuredClone(nodes.get(6)),
          id,
          tag: operation.key,
          text: '',
          attributes: {},
          parent: 2,
        })
        return id
      }
      const node = nodes.get(operation.id)
      if (!node) throw new Error('stale native identity')
      if (operation.op === 'style') {
        node.inline[operation.key] = operation.value
        node.computed[operation.key] = operation.value
      }
      if (operation.op === 'text') node.text = operation.value
      if (operation.op === 'attribute') node.attributes[operation.key] = operation.value
      if (operation.op === 'click') node.text = 'Clicked'
      if (operation.op === 'append') {
        nodes.get(operation.parent).children.push(operation.id)
        node.parent = operation.parent
      }
      if (operation.op === 'remove') {
        nodes.delete(operation.id)
        for (const n of nodes.values()) n.children = n.children.filter((id) => id !== operation.id)
      }
      return 0
    },
  }
}

test('host console reads device snapshot and sends native operations before replying', async () => {
  const transport = fixture()
  const events = []
  const session = new DeviceSession(transport, (method, params) => events.push({ method, params }))
  await session.refresh()
  await session.handle('DOM.enable')
  await session.handle('CSS.enable')
  assert.equal(
    (await session.handle('Runtime.evaluate', { expression: '6*7', returnByValue: true })).result
      .value,
    42,
  )
  await session.handle('DOM.setInspectedNode', { nodeId: 6 })
  assert.equal(
    (
      await session.handle('Runtime.evaluate', {
        expression: '$0.style.color="rgb(255, 0, 255)"; $0.click(); $0.textContent',
        returnByValue: true,
      })
    ).result.value,
    'Ready',
    'expression reads its initial snapshot until native operations are acknowledged',
  )
  assert.equal(
    (
      await session.handle('Runtime.evaluate', {
        expression: '$0.textContent',
        returnByValue: true,
      })
    ).result.value,
    'Clicked',
  )
  assert.deepEqual(
    transport.operations.map((o) => o.op),
    ['style', 'click'],
  )
  assert.ok(events.some((e) => e.method === 'DOM.characterDataModified'))
  assert.equal(
    (await session.handle('CSS.getComputedStyleForNode', { nodeId: 6 })).computedStyle.find(
      (p) => p.name === 'color',
    ).value,
    'rgb(255, 0, 255)',
  )
})

test('async console creation/removal retains lifetime identities and rejects stale handles', async () => {
  const session = new DeviceSession(fixture())
  await session.refresh()
  const created = await session.handle('Runtime.evaluate', {
    expression:
      '(async()=>{globalThis.created=await document.createElement("div");created.textContent="Native";document.body.appendChild(created);return created.__geaNodeId})()',
    returnByValue: true,
  })
  assert.equal(created.exceptionDetails, undefined)
  assert.equal(created.result.value, 8)
  await session.handle('Runtime.evaluate', { expression: 'created.remove()' })
  assert.match(
    (await session.handle('Runtime.evaluate', { expression: 'created.textContent' }))
      .exceptionDetails.text,
    /Stale/,
  )
  const replacement = await session.handle('Runtime.evaluate', {
    expression: 'document.createElement("div").then(n=>n.__geaNodeId)',
    awaitPromise: true,
    returnByValue: true,
  })
  assert.equal(replacement.result.value, 10)
})

test('remote property reflection does not invoke getters and object groups are releasable', async () => {
  const session = new DeviceSession(fixture())
  await session.refresh()
  const object = (
    await session.handle('Runtime.evaluate', {
      expression: 'globalThis.reads=0; ({get value(){reads++;return 42}})',
      objectGroup: 'test',
    })
  ).result
  const properties = await session.handle('Runtime.getProperties', { objectId: object.objectId })
  assert.ok(properties.result.find((p) => p.name === 'value').get.objectId)
  assert.equal(
    (await session.handle('Runtime.evaluate', { expression: 'reads', returnByValue: true })).result
      .value,
    0,
  )
  await session.handle('Runtime.releaseObjectGroup', { objectGroup: 'test' })
  await assert.rejects(
    session.handle('Runtime.getProperties', { objectId: object.objectId }),
    /released/,
  )
})

test('USB transport serializes requests and refuses oversized operations', async () => {
  const writes = []
  let active = 0
  const serial = {
    command: async (line) => {
      assert.equal(active++, 0)
      await new Promise((resolve) => setTimeout(resolve, 10))
      writes.push(line)
      active--
      return 'GEADEV:DEBUG OK id=4'
    },
  }
  const transport = new DeviceTransport(serial)
  transport.boot = '1'
  await Promise.all([
    transport.mutate({ op: 'text', id: 4, value: 'a' }),
    transport.mutate({ op: 'text', id: 4, value: 'b' }),
  ])
  assert.equal(writes.length, 2)
  assert.equal(JSON.parse(Buffer.from(writes[0].slice('GEADEV DEBUG '.length), 'base64')).boot, '1')
  await assert.rejects(transport.mutate({ op: 'text', id: 4, value: 'x'.repeat(1000) }), /limit/)
  assert.equal(writes.length, 2)
})

test('USB snapshot parser rejects a reboot before recycled identities can be used', async () => {
  let boot = 1
  const transport = new DeviceTransport({
    collect: async (line) =>
      framed([{ id: 4, children: [] }], Number(line.split(' ').at(-1)), boot),
  })
  assert.equal((await transport.snapshot()).nodes.get(4).id, 4)
  boot = 2
  await assert.rejects(transport.snapshot({ fresh: true }), /rebooted/)
})

test('device relay accepts Chrome startup request bursts without disconnecting', async () => {
  const { createDeviceRelay } = await import('../src/device.mjs')
  const { connectCDP } = await import('../src/cdp.mjs')
  const node = {
    id: 4,
    parent: 2,
    tag: 'div',
    type: 1,
    text: '',
    attributes: { id: 'app' },
    children: [],
    computed: {},
    inline: {},
    rules: [],
    x: 0,
    y: 0,
    width: 410,
    height: 502,
  }
  const serial = {
    collect: async (line) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return framed([node], Number(line.split(' ').at(-1)))
    },
  }
  const relay = await createDeviceRelay({ serial, debugPort: 15987 })
  let cdp
  try {
    cdp = await connectCDP(relay.endpoint)
    const replies = await Promise.all(Array.from({ length: 100 }, () => cdp.send('Page.enable')))
    assert.equal(replies.length, 100)
    assert.ok((await cdp.send('DOM.getDocument')).root)
  } finally {
    cdp?.close()
    await relay.close()
  }
})

test('corrupt or incomplete snapshots are rejected and retried without returning partial state', async () => {
  let calls = 0,
    drains = 0
  const serial = {
    drainInput: async () => {
      drains++
    },
    collect: async (line) => {
      calls++
      const frame = framed([{ id: 4, children: [] }], Number(line.split(' ').at(-1)))
      if (calls === 1) frame.lines[0] += 'broken'
      if (calls === 2) frame.lines = []
      return frame
    },
  }
  const transport = new DeviceTransport(serial)
  assert.equal((await transport.snapshot()).nodes.size, 1)
  assert.equal(calls, 3)
  assert.equal(drains, 2)
})

test('concurrent inspectors share a snapshot and mutations invalidate the cached frame', async () => {
  let calls = 0
  const transport = new DeviceTransport({
    collect: async (line) => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return framed([{ id: 4, children: [] }], Number(line.split(' ').at(-1)))
    },
    command: async () => 'GEADEV:DEBUG OK id=0',
  })
  await Promise.all([transport.snapshot(), transport.snapshot(), transport.snapshot()])
  assert.equal(calls, 1)
  await transport.mutate({ op: 'style', id: 4, key: 'background', value: 'red' })
  await transport.snapshot()
  assert.equal(calls, 2)
})

test('CSS shorthand editing returns canonical native ranges so subsequent edits stay valid', async () => {
  const transport = fixture()
  const original = transport.mutate
  transport.mutate = async (operation) => {
    await original({
      ...operation,
      key: operation.key === 'background' ? 'background-color' : operation.key,
    })
  }
  const session = new DeviceSession(transport)
  await session.refresh()
  let style = (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle
  for (const color of ['red', 'blue', 'green']) {
    const result = await session.handle('CSS.setStyleTexts', {
      edits: [
        {
          styleSheetId: style.styleSheetId,
          range: style.range,
          text: 'background: ' + color + ';',
        },
      ],
    })
    style = result.styles[0]
    assert.match(style.cssText, new RegExp('background-color: ' + color))
    assert.equal(style.range.endColumn, style.cssText.length)
  }
  await assert.rejects(
    session.handle('CSS.setStyleTexts', {
      edits: [
        {
          styleSheetId: style.styleSheetId,
          range: { startLine: 0, endLine: 0, startColumn: 0, endColumn: 999 },
          text: 'background:red;',
        },
      ],
    }),
    /outdated/,
  )
})

test('authored native rules have editable sheets/ranges and edits update the cascade instead of inline overrides', async () => {
  const transport = fixture()
  const snapshot = transport.snapshot
  const values = { color: '#ffffff', 'font-size': '26vmin' }
  const ops = []
  transport.snapshot = async () => {
    const state = await snapshot()
    state.nodes.get(6).rules = Object.entries(values).map(([property, value]) => ({
      selector: '.status',
      property,
      value,
      media: '',
      userAgent: false,
    }))
    return state
  }
  transport.mutate = async (operation) => {
    ops.push(operation)
    assert.equal(operation.op, 'rule')
    assert.equal(operation.selector, '.status')
    if (operation.value) values[operation.key] = operation.value
    else delete values[operation.key]
  }
  const events = []
  const session = new DeviceSession(transport, (method, params) => events.push({ method, params }))
  await session.refresh()
  await session.handle('CSS.enable')
  let rule = (await session.handle('CSS.getMatchedStylesForNode', { nodeId: 6 })).matchedCSSRules[0]
    .rule
  assert.ok(rule.styleSheetId.startsWith('rule-'))
  assert.equal(rule.styleSheetId, rule.style.styleSheetId)
  assert.equal(rule.style.range.endColumn, rule.style.cssText.length)
  assert.ok(rule.style.cssProperties.every((p) => p.range))
  assert.ok(
    events.some(
      (e) =>
        e.method === 'CSS.styleSheetAdded' && e.params.header.styleSheetId === rule.styleSheetId,
    ),
  )
  const color = rule.style.cssProperties.find((p) => p.name === 'color')
  let result = await session.handle('CSS.setStyleTexts', {
    edits: [{ styleSheetId: rule.styleSheetId, range: color.range, text: 'color: red;' }],
  })
  assert.equal(result.styles[0].cssProperties.find((p) => p.name === 'color').value, 'red')
  assert.equal(values.color, 'red')
  const style = result.styles[0]
  result = await session.handle('CSS.setStyleTexts', {
    edits: [
      {
        styleSheetId: style.styleSheetId,
        range: {
          startLine: 0,
          endLine: 0,
          startColumn: style.cssText.length,
          endColumn: style.cssText.length,
        },
        text: ' background: blue;',
      },
    ],
  })
  assert.equal(values.background, 'blue')
  assert.equal(result.styles[0].cssProperties.find((p) => p.name === 'background').value, 'blue')
  assert.equal(ops.length, 2)
  assert.equal(
    (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle.cssText,
    '',
  )
  assert.equal(
    (await session.handle('CSS.getStyleSheetText', { styleSheetId: rule.styleSheetId })).text,
    result.styles[0].cssText,
  )
})

test('native inline declarations appear as live style attributes and attribute edits use the native style API', async () => {
  const transport = fixture(),
    events = [],
    session = new DeviceSession(transport, (method, params) => events.push({ method, params }))
  await session.refresh()
  await session.handle('DOM.enable')
  await session.handle('DOM.setAttributeValue', {
    nodeId: 6,
    name: 'style',
    value: 'left: 159px; top: 129px; background-color: lime;',
  })
  let attributes = Object.fromEntries(
    (await session.handle('DOM.getAttributes', { nodeId: 6 })).attributes.reduce(
      (pairs, value, index, array) => (index % 2 ? pairs : [...pairs, [value, array[index + 1]]]),
      [],
    ),
  )
  assert.equal(attributes.style, 'left: 159px; top: 129px; background-color: lime;')
  assert.ok(
    events.some(
      (event) => event.method === 'DOM.attributeModified' && event.params.name === 'style',
    ),
  )
  await session.handle('DOM.setAttributesAsText', { nodeId: 6, text: 'style="color: red;"' })
  assert.equal(
    (
      await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })
    ).inlineStyle.cssProperties.find((property) => property.name === 'left')?.value,
    '',
  )
  assert.ok(transport.operations.every((operation) => operation.op === 'style'))
})

test('preview modes share captures, retain paused pixels and reject cross-site requests', async () => {
  const { createDeviceRelay } = await import('../src/device.mjs')
  const node = {
    id: 4,
    parent: 2,
    tag: 'div',
    type: 1,
    text: '',
    attributes: {},
    children: [],
    computed: {},
    inline: {},
    x: 0,
    y: 0,
    width: 410,
    height: 502,
  }
  let captures = 0
  const relay = await createDeviceRelay({
    serial: { collect: async (line) => framed([node], Number(line.split(' ').at(-1))) },
    debugPort: 15988,
    screenshot: async () => {
      captures++
      await new Promise((r) => setTimeout(r, 20))
      return 'pixels'
    },
  })
  try {
    assert.match(await (await fetch(relay.preview)).text(), /DOM mirror/)
    const url = new URL('/preview/frame', relay.preview)
    const frames = await Promise.all([
      fetch(url).then((r) => r.json()),
      fetch(url).then((r) => r.json()),
    ])
    assert.equal(captures, 1)
    assert.equal(frames[0].data, 'pixels')
    assert.equal(frames[1].data, 'pixels')
    relay.transport.debuggerState = { paused: true, close: async () => {} }
    assert.deepEqual(await (await fetch(url)).json(), { data: 'pixels', paused: true })
    assert.equal(captures, 1)
    const snapshot = await (await fetch(new URL('/preview/snapshot', relay.preview))).json()
    assert.equal(snapshot.paused, true)
    assert.equal(snapshot.nodes[0].id, 4)
    assert.equal((await fetch(url, { headers: { Origin: 'https://example.com' } })).status, 403)
  } finally {
    await relay.close()
  }
})

test('deep subtree requests publish only missing children and preserve already-loaded Chrome nodes', async () => {
  const events = [],
    session = new DeviceSession(fixture(), (method, params) => events.push({ method, params }))
  await session.refresh()
  await session.handle('DOM.getDocument', { depth: 2 })
  await session.handle('DOM.requestChildNodes', { nodeId: 2, depth: -1 })
  assert.deepEqual(
    events
      .filter((event) => event.method === 'DOM.setChildNodes')
      .map((event) => event.params.parentId),
    [4, 6],
  )
  const count = events.length
  await session.handle('DOM.requestChildNodes', { nodeId: 2, depth: -1 })
  assert.equal(events.length, count)
  await session.handle('DOM.getDocument', { depth: -1 })
  await session.handle('DOM.requestChildNodes', { nodeId: 2, depth: -1 })
  assert.equal(events.length, count)
})

test('native hover uses lifetime identities and leaves DOM/CSS snapshots untouched', async () => {
  const source = fixture()
  const writes = []
  const serial = {
    collect: async (line) => {
      const snapshot = await source.snapshot()
      const frame = framed([...snapshot.nodes.values()], Number(line.split(' ').at(-1)))
      frame.end += ' overlay=1'
      return frame
    },
    command: async (line) => {
      writes.push(JSON.parse(Buffer.from(line.slice('GEADEV DEBUG '.length), 'base64')))
      return 'GEADEV:DEBUG OK id=0'
    },
  }
  const transport = new DeviceTransport(serial)
  const events = []
  const session = new DeviceSession(transport, (method, params) => events.push({ method, params }))
  await session.refresh()
  const before = structuredClone(session.nodes)
  await session.handle('Overlay.highlightNode', {
    backendNodeId: 6,
    highlightConfig: { contentColor: { r: 237, g: 17, b: 223, a: 0.7 } },
  })
  assert.deepEqual(writes[0], { op: 'highlight', id: 6, red: 237, green: 17, blue: 223, boot: '1' })
  assert.deepEqual(session.nodes, before)
  assert.ok(!events.some((event) => event.method === 'DOM.documentUpdated'))
  await session.handle('Overlay.hideHighlight')
  assert.equal(writes.at(-1).id, 0)
  await assert.rejects(session.handle('Overlay.highlightNode', { nodeId: 900 }), /Stale/)
  assert.equal(writes.length, 2)
})

test('hover bursts coalesce to the latest highlight; paused changes wait for resume', async () => {
  const writes = []
  let unblock, started
  const begun = new Promise((resolve) => (started = resolve))
  const blocked = new Promise((resolve) => (unblock = resolve))
  const transport = new DeviceTransport({
    command: async (line) => {
      const operation = JSON.parse(Buffer.from(line.slice('GEADEV DEBUG '.length), 'base64'))
      writes.push(operation)
      if (writes.length === 1) {
        started()
        await blocked
      }
      return 'GEADEV:DEBUG OK id=0'
    },
  })
  transport.lastGood = { nativeHighlight: true }
  transport.boot = '1'
  const ownerA = {},
    ownerB = {}
  const first = transport.setHighlight(4, undefined, ownerA)
  await begun
  const second = transport.setHighlight(6, undefined, ownerB)
  const third = transport.setHighlight(8, undefined, ownerB)
  await transport.clearHighlight(ownerA)
  unblock()
  await Promise.all([first, second, third])
  assert.deepEqual(
    writes.map((write) => write.id),
    [4, 8],
  )
  transport.debuggerState = { paused: true }
  await transport.clearHighlight(ownerB)
  assert.equal(writes.length, 2)
  transport.debuggerState.paused = false
  await transport.flushHighlight()
  assert.equal(writes.at(-1).id, 0)
})
