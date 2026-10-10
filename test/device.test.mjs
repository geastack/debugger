import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { DeviceSession, DeviceTransport, snapshotChecksum } from '../src/device.mjs'

// A fixed port collides with whatever else holds it, such as another suite
// running beside this one; take one the system says is free.
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer().on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

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
        if (operation.value) {
          node.inline[operation.key] = operation.value
          node.computed[operation.key] = operation.value
        } else {
          delete node.inline[operation.key]
          delete node.computed[operation.key]
        }
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

function pickerFirmware() {
  const state = { token: 0, active: false, hover: 0, node: 0, revision: 0 }
  const operations = []
  const nodes = [
    { id: 4, parent: 2, tag: 'div', attributes: {}, children: [6], text: '', inline: {}, computed: {}, x: 0, y: 0, width: 410, height: 502 },
    { id: 6, parent: 4, tag: 'div', attributes: {}, children: [8], text: '', inline: {}, computed: {}, x: 0, y: 0, width: 200, height: 100 },
    { id: 8, parent: 6, tag: 'button', attributes: { id: 'native-button' }, children: [], text: 'Pick me', inline: {}, computed: {}, x: 10, y: 10, width: 100, height: 20 },
  ]
  let capability = true
  const serial = {
    async collect(command) {
      const frame = framed(nodes, Number(command.split(' ').at(-1)))
      frame.end += capability ? ` picker=1 overlay=1 inspectToken=${state.token} inspectActive=${+state.active} inspectHover=${state.hover} inspectNode=${state.node} inspectRevision=${state.revision}` : ''
      return frame
    },
    async command(command) {
      const operation = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64').toString())
      operations.push(operation)
      assert.equal(operation.boot, '1')
      if (operation.op === 'inspect') {
        if (operation.mode.startsWith('search')) {
          Object.assign(state, { token: operation.token, active: true, hover: 0, node: 0 })
        } else if (operation.mode === 'none' && operation.token === state.token)
          Object.assign(state, { active: false, hover: 0, node: 0 })
      }
      if (operation.op === 'inspectPoint' && operation.token === state.token && state.active) {
        state.hover = operation.mode === 'leave' ? 0 : 8
        if (operation.mode === 'select') {
          state.active = false
          state.node = 8
          state.revision++
        }
      }
      return 'GEADEV:DEBUG OK id=0'
    },
  }
  return { serial, state, operations, nodes, legacy() { capability = false } }
}

test('device picker publishes collapsed ancestors before selecting a native lifetime once', async () => {
  const firmware = pickerFirmware(), transport = new DeviceTransport(firmware.serial), events = []
  const session = new DeviceSession(transport, (method, params) => events.push({ method, params }))
  await session.refresh()
  await session.handle('DOM.enable')
  await session.handle('DOM.getDocument', { depth: 1 })
  await session.handle('Overlay.setInspectMode', { mode: 'searchForNode' })
  const token = transport.inspection.token
  await transport.inspectPoint({ token, mode: 'hover', x: 15, y: 15 })
  assert.ok(events.some(event => event.method === 'Overlay.nodeHighlightRequested' && event.params.nodeId === 8))
  await transport.inspectPoint({ token, mode: 'select', x: 15, y: 15 })
  assert.equal(session.selected, 8)
  assert.equal(transport.inspection, null)
  const selected = events.findIndex(event => event.method === 'Overlay.inspectNodeRequested')
  assert.deepEqual(events[selected].params, { backendNodeId: 8 })
  for (const parentId of [2, 4, 6]) {
    const published = events.findIndex(event => event.method === 'DOM.setChildNodes' && event.params.parentId === parentId)
    assert.ok(published >= 0 && published < selected)
  }
  await session.refresh(true)
  assert.equal(events.filter(event => event.method === 'Overlay.inspectNodeRequested').length, 1)
  assert.ok(firmware.operations.every(op => !['click', 'style', 'attribute'].includes(op.op)))
  await assert.rejects(transport.inspectPoint({ token, mode: 'select', x: 15, y: 15 }), /no longer active/)
})

test('inspect ownership isolates cancellation, stale snapshots and recycled nodes', async () => {
  const firmware = pickerFirmware(), transport = new DeviceTransport(firmware.serial), firstEvents = [], secondEvents = []
  const first = new DeviceSession(transport, (method, params) => firstEvents.push({ method, params }))
  const second = new DeviceSession(transport, (method, params) => secondEvents.push({ method, params }))
  await first.refresh(); await second.refresh()
  await first.handle('Overlay.setInspectMode', { mode: 'searchForNode' })
  const stale = transport.inspection.token
  await second.handle('Overlay.setInspectMode', { mode: 'searchForUAShadowDOM' })
  const token = transport.inspection.token
  assert.ok(firstEvents.some(event => event.method === 'Overlay.inspectModeCanceled'))
  await first.handle('Overlay.setInspectMode', { mode: 'none' })
  assert.equal(transport.inspection.token, token)
  first.updateInspection({ token: stale, active: false, node: 8 })
  second.updateInspection({ token: stale, active: false, node: 8 })
  assert.ok(!firstEvents.concat(secondEvents).some(event => event.method === 'Overlay.inspectNodeRequested'))
  firmware.state.active = false
  firmware.state.node = 42 // Removed lifetime, even if its engine slot is reused.
  await transport.snapshot({ fresh: true }); await second.refresh(true)
  assert.ok(secondEvents.some(event => event.method === 'Overlay.inspectModeCanceled'))
  assert.equal(transport.inspection, null)
  await second.handle('Overlay.setInspectMode', { mode: 'searchForNode' })
  await second.handle('Overlay.disable')
  assert.equal(firmware.state.active, false)
})

test('legacy firmware refuses the picker without sending a device mutation', async () => {
  const firmware = pickerFirmware(); firmware.legacy()
  const transport = new DeviceTransport(firmware.serial), session = new DeviceSession(transport)
  await session.refresh()
  await assert.rejects(session.handle('Overlay.setInspectMode', { mode: 'searchForNode' }), /fresh debug firmware/)
  await assert.rejects(session.handle('Overlay.setInspectMode', { mode: 'captureAreaScreenshot' }), /Unsupported inspect/)
  assert.deepEqual(firmware.operations, [])
})

test('both preview modes pick through CDP and disconnect releases the device owner', async () => {
  const { createDeviceRelay } = await import('../src/device.mjs')
  const { connectCDP } = await import('../src/cdp.mjs')
  const firmware = pickerFirmware()
  const port = await freePort()
  const relay = await createDeviceRelay({ serial: firmware.serial, debugPort: port, pollMs: 25 })
  let cdp
  try {
    cdp = await connectCDP(relay.endpoint)
    const selected = []
    cdp.onEvent(event => {
      if (event.method === 'Overlay.inspectNodeRequested') selected.push(event.params.backendNodeId)
    })
    await cdp.send('DOM.enable')
    await cdp.send('DOM.getDocument', { depth: 1 })
    const base = `http://127.0.0.1:${port}`
    for (const mode of ['screen', 'dom']) {
      await cdp.send('Overlay.setInspectMode', { mode: 'searchForNode' })
      const snapshot = await (await fetch(base + '/preview/snapshot')).json()
      assert.ok(snapshot.inspectToken)
      const response = await fetch(base + '/preview/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: snapshot.inspectToken, mode: 'select', x: 15, y: 15 }),
      })
      assert.equal(response.status, 200, mode)
      assert.deepEqual(selected, mode === 'screen' ? [8] : [8, 8])
    }
    await cdp.send('Overlay.setInspectMode', { mode: 'searchForNode' })
    const token = relay.transport.inspection.token
    assert.equal((await fetch(base + '/preview/inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ token, mode: 'select', x: 15, y: 15 }),
    })).status, 403)
    assert.equal((await fetch(base + '/preview/inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, mode: 'hover', x: 10000, y: 15 }),
    })).status, 503)
    await cdp.send('Overlay.setInspectMode', { mode: 'none' })
    assert.equal(firmware.state.active, false)
    await cdp.send('Overlay.setInspectMode', { mode: 'searchForNode' })
    cdp.close()
    for (let attempt = 0; attempt < 100 && firmware.state.active; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(firmware.state.active, false)
    assert.equal(relay.transport.inspection, null)
  } finally { cdp?.close(); await relay.close() }
})

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

test('regular firmware rejects attach immediately before FPS edits or source debugger startup', async () => {
  const { createDeviceRelay } = await import('../src/device.mjs')
  let snapshots = 0,
    mutations = 0,
    sourceStarts = 0
  const serial = {
    collect: async () => {
      snapshots++
      throw new Error('GEADEV:ERR unknown-command command=DEBUG')
    },
    command: async () => {
      mutations++
      throw new Error('Regular firmware must not receive debug mutations')
    },
  }
  await assert.rejects(
    createDeviceRelay({
      serial,
      debugFps: 10,
      nativeDebug: {
        get builds() {
          sourceStarts++
          throw new Error('Source debugger must not initialize against regular firmware')
        },
      },
    }),
    (error) => error.fatal === true && /--attach requires debug-enabled firmware/.test(error.message),
  )
  assert.equal(snapshots, 1)
  assert.equal(mutations, 0)
  assert.equal(sourceStarts, 0)
})

test('firmware without debugger framing requires a rebuild instead of startup retries', async () => {
  let snapshots = 0
  const transport = new DeviceTransport({
    collect: async (line) => {
      snapshots++
      const snapshot = framed([{ id: 4, children: [] }], Number(line.split(' ').at(-1)))
      snapshot.end = snapshot.end.replace(' boot=1', '')
      return snapshot
    },
  })
  await assert.rejects(
    transport.snapshot(),
    (error) => error.fatal === true && /Firmware lacks debugger framing/.test(error.message),
  )
  assert.equal(snapshots, 1)
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
  const relay = await createDeviceRelay({ serial, debugPort: await freePort() })
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

test('CSS shorthand editing keeps authored text and stable ranges after engine expansion', async () => {
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
    assert.equal(style.cssText, 'background: ' + color + ';')
    assert.deepEqual(style.cssProperties.map(p => p.name), ['background'])
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
  assert.ok(ops.every(op => op.op === 'rule'), 'authored edits never write inline styles')
  assert.equal(values['font-size'], '26vmin', 'unmodified declaration survives replacement')
  assert.equal(
    (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle.cssText,
    '',
  )
  assert.equal(
    (await session.handle('CSS.getStyleSheetText', { styleSheetId: rule.styleSheetId })).text,
    result.styles[0].cssText,
  )
  let authored = result.styles[0]
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const disabled of [true, false]) {
      const color = authored.cssProperties.find(p => p.name === 'color')
      authored = (await session.handle('CSS.setStyleTexts', { edits: [{
        styleSheetId: authored.styleSheetId, range: color.range,
        text: disabled ? '/* color: red; */' : 'color: red;',
      }] })).styles[0]
      await session.refresh(true)
      assert.equal(values.color, disabled ? undefined : 'red')
      assert.equal(values.background, 'blue', 'other author declarations remain enabled')
      assert.equal(authored.cssProperties.find(p => p.name === 'color').disabled, disabled)
      const reconnected = new DeviceSession(transport)
      await reconnected.refresh()
      assert.equal((await reconnected.handle('CSS.getMatchedStylesForNode', { nodeId: 6 }))
        .matchedCSSRules[0].rule.style.cssText, authored.cssText)
    }
  }
})

test('console property writes and cssText replacements keep their order without inventing declarations', async () => {
  const transport = fixture(), session = new DeviceSession(transport)
  await session.refresh()
  const result = await session.handle('Runtime.evaluate', { expression: `
    const node = document.querySelector('.status');
    node.style.color = 'red';
    node.style.cssText = 'background: blue; /* opacity: .5; */';
    node.style.color = 'lime';
    node.style.removeProperty('background');
    node.style.cssText;
  `, returnByValue: true })
  assert.equal(result.exceptionDetails, undefined)
  const style = (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle
  assert.equal(style.cssText, result.result.value)
  assert.deepEqual(style.cssProperties.map(p => [p.name, p.disabled]), [['opacity', true], ['color', false]])
  assert.deepEqual((await transport.snapshot()).nodes.get(6).inline, { color: 'lime' })
})

test('independent inline toggles preserve shorthand source across polling, runtime writes and reconnects', async () => {
  const transport = fixture()
  const mutate = transport.mutate
  transport.mutate = operation => mutate({ ...operation,
    key: operation.key === 'background' ? 'background-color' : operation.key })
  let session = new DeviceSession(transport)
  await session.refresh()
  let style = (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle
  style = (await session.handle('CSS.setStyleTexts', { edits: [{
    styleSheetId: style.styleSheetId, range: style.range,
    text: 'background: indianred;\ncolor: lime; opacity: .5;',
  }] })).styles[0]
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const disabled of [true, false]) {
      for (const name of ['background', 'color']) {
        const property = style.cssProperties.find(p => p.name === name)
        style = (await session.handle('CSS.setStyleTexts', { edits: [{
          styleSheetId: style.styleSheetId, range: property.range,
          text: disabled ? `/* ${name}: ${property.value}; */` : `${name}: ${property.value};`,
        }] })).styles[0]
        await session.refresh(true)
        style = (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle
        assert.equal(style.cssProperties.find(p => p.name === name).disabled, disabled)
        assert.deepEqual(style.cssProperties.map(p => p.name), ['background', 'color', 'opacity'])
        const computed = (await session.handle('CSS.getComputedStyleForNode', { nodeId: 6 })).computedStyle
        assert.equal(computed.find(p => p.name === (name === 'background' ? 'background-color' : name))?.value,
          disabled ? undefined : property.value)
      }
    }
  }
  const opacity = style.cssProperties.find(p => p.name === 'opacity')
  style = (await session.handle('CSS.setStyleTexts', { edits: [{
    styleSheetId: style.styleSheetId, range: opacity.range, text: '/* opacity: .5; */',
  }] })).styles[0]
  session = new DeviceSession(transport)
  await session.refresh()
  assert.equal((await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle.cssText,
    style.cssText, 'transport owns authored state across inspector sessions')
  const result = await session.handle('Runtime.evaluate', {
    expression: 'document.querySelector(".status").style.background="blue"',
  })
  assert.equal(result.exceptionDetails, undefined)
  style = (await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 })).inlineStyle
  assert.deepEqual(style.cssProperties.map(p => p.name), ['background', 'color', 'opacity'])
  assert.equal(style.cssProperties.find(p => p.name === 'opacity').disabled, true)
  assert.equal(style.cssProperties.find(p => p.name === 'background').value, 'blue')
  await transport.mutate({ op: 'style', id: 6, key: 'left', value: '42px' })
  await session.refresh()
  assert.equal((await session.handle('CSS.getInlineStylesForNode', { nodeId: 6 }))
    .inlineStyle.cssProperties.find(p => p.name === 'left').value, '42px', 'app-driven updates remain live')
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
    ).inlineStyle.cssProperties.find((property) => property.name === 'left'),
    undefined,
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
    debugPort: await freePort(),
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

test('device relay records edits into the shared history and undoes them on the device', async () => {
  const { createDeviceRelay } = await import('../src/device.mjs')
  const { connectCDP } = await import('../src/cdp.mjs')
  const firmware = pickerFirmware()
  const command = firmware.serial.command
  firmware.serial.command = async (line) => {
    const reply = await command(line)
    const operation = firmware.operations.at(-1)
    const node = firmware.nodes.find((candidate) => candidate.id === operation.id)
    if (operation.op === 'attribute') node.attributes[operation.key] = operation.value
    if (operation.op === 'removeAttribute') delete node.attributes[operation.key]
    return reply
  }
  const port = await freePort()
  const relay = await createDeviceRelay({ serial: firmware.serial, debugPort: port, pollMs: 25, frontend: null })
  let first, second
  try {
    first = await connectCDP(relay.endpoint)
    second = await connectCDP(relay.endpoint)
    await first.send('DOM.getDocument', { depth: -1 })
    assert.deepEqual(await first.send('Overlay.setShowPaintRects', { result: true }), {})
    await first.send('DOM.setAttributeValue', { nodeId: 8, name: 'data-x', value: '1' })
    const { entries } = await second.send('Gea.getChanges')
    assert.equal(entries[0].ops[0].target, 'button#native-button')
    assert.equal(
      (await second.send('DOM.getOuterHTML', { nodeId: 8 })).outerHTML,
      '<button id="native-button" data-x="1">Pick me</button>',
    )
    await second.send('DOM.undo')
    assert.equal(firmware.nodes[2].attributes['data-x'], undefined)
    assert.deepEqual(firmware.operations.filter((o) => o.op.endsWith('ttribute')).map((o) => o.op), ['attribute', 'removeAttribute'])
    const response = await fetch(`http://127.0.0.1:${port}/gea/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'redo' }),
    })
    assert.equal((await response.json()).overrides, 1)
    assert.equal(firmware.nodes[2].attributes['data-x'], '1')
  } finally {
    first?.close()
    second?.close()
    await relay.close()
  }
})

test('console inspect() reveals a board node in Elements', async () => {
  const events = []
  const session = new DeviceSession(fixture(), (method, params) => events.push({ method, params }))
  await session.refresh()
  await session.handle('Runtime.enable')
  await session.handle('Runtime.evaluate', { expression: 'inspect($(".status"))' })
  const request = events.find((event) => event.method === 'Runtime.inspectRequested')
  assert.equal(request.params.object.subtype, 'node')
  assert.deepEqual(await session.handle('DOM.requestNode', { objectId: request.params.object.objectId }), { nodeId: 6 })
})

test('board event listeners come from firmware call sites and link to mapped source', async () => {
  const { StaticSources } = await import('../src/gdb.mjs')
  const firmware = pickerFirmware()
  const collect = firmware.serial.collect
  const requests = []
  firmware.serial.collect = async (command, options) => {
    if (!command.startsWith('GEADEV DEBUG LISTENERS ')) {
      const frame = await collect(command, options)
      frame.end += ' listeners=1'
      return frame
    }
    const [, , , sequence, list] = command.split(' ')
    requests.push(list)
    const lines = list
      .split(',')
      .map(Number)
      .filter((id) => id === 6 || id === 8)
      .map((id) => `GEADEV:DEBUG LISTENER ${JSON.stringify({ id, type: 'click', sites: id === 8 ? [0x4200, 0x4300] : [0x4200] })}`)
    return { lines: [...lines, `GEADEV:DEBUG LISTENERS END sequence=${sequence} count=${lines.length} boot=1`], end: `GEADEV:DEBUG LISTENERS END sequence=${sequence} count=${lines.length} boot=1` }
  }
  const transport = new DeviceTransport(firmware.serial)
  transport.elfLines = {
    async locations(addresses) {
      assert.deepEqual([...new Set(addresses)].sort(), [0x4200, 0x4300])
      return { [0x4200]: { functionName: 'gea::jsx::bindNodeListener' }, [0x4300]: { scriptId: 'native-app', lineNumber: 4, columnNumber: 0, functionName: 'gea_body_fn' } }
    },
  }
  const session = new DeviceSession(transport)
  await session.refresh()
  const object = (await session.handle('Runtime.evaluate', { expression: '$("#native-button")' })).result
  assert.equal(object.description, 'button#native-button')
  const own = (await session.handle('DOMDebugger.getEventListeners', { objectId: object.objectId })).listeners
  assert.equal(requests.at(-1), '8')
  assert.equal(own.length, 1)
  assert.equal(own[0].scriptId, 'native-app')
  assert.equal(own[0].lineNumber, 4)
  assert.equal(own[0].handler.description, 'click listener on <button>')
  assert.match(own[0].handler.objectId, /^gea-listener-/)
  assert.equal(own[0].backendNodeId, 8)

  const root = (await session.handle('Runtime.evaluate', { expression: 'document.body' })).result
  const all = (await session.handle('DOMDebugger.getEventListeners', { objectId: root.objectId, depth: -1 })).listeners
  assert.equal(requests.at(-1), '4,6,8')
  // Only runtime frames: listed, named, but without a source link.
  const unmapped = all.find((listener) => listener.backendNodeId === 6)
  assert.equal(unmapped.scriptId, '')
  assert.equal(unmapped.handler.description, 'click listener on <div> · gea::jsx::bindNodeListener')

  firmware.serial.collect = collect
  transport.cached = null
  await assert.rejects(session.handle('DOMDebugger.getEventListeners', { objectId: object.objectId }), /cannot report event listeners/)

  // Without JTAG, the read-only Sources view still publishes the mapped script.
  const sources = new StaticSources({ file: 'gea-native-debug.js', locations: [] })
  const parsed = []
  assert.deepEqual(await sources.handle(null, (method, params) => parsed.push([method, params]), 'Debugger.enable'), { debuggerId: 'gea-native-sources' })
  assert.equal(parsed[0][1].scriptId, 'native-app')
  await assert.rejects(sources.handle(null, () => {}, 'Debugger.setBreakpointByUrl', {}), /--debug-sources/)
  assert.equal(await sources.handle(null, () => {}, 'Runtime.evaluate', {}), undefined)
})
