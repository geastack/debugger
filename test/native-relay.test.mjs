import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createNativeRelay } from '../src/native.mjs'
import { connectCDP } from '../src/cdp.mjs'

test('paused native relay serves inspected state and routes LLDB commands without blocking on the stopped process', async () => {
  const sockets = new Set()
  let reads = 0,
    detached
  const disconnected = new Promise((resolve) => {
    detached = resolve
  })
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk
      let newline
      while ((newline = input.indexOf('\n')) >= 0) {
        const request = JSON.parse(input.slice(0, newline))
        input = input.slice(newline + 1)
        reads++
        socket.write(
          JSON.stringify({
            id: request.id,
            result:
              request.method === 'DOM.getDocument'
                ? { root: { nodeId: 1 } }
                : { result: { type: 'number', value: 42 } },
          }) + '\n',
        )
      }
    })
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const debugPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const backend = {
    paused: false,
    async handle() {
      return { native: true }
    },
    async detach() {
      detached()
    },
  }
  let relay, cdp
  try {
    relay = await createNativeRelay({
      nativePort: server.address().port,
      debugPort,
      debuggerState: backend,
    })
    cdp = await connectCDP(relay.endpoint)
    const document = await cdp.send('DOM.getDocument', { depth: -1 })
    backend.paused = true
    assert.deepEqual(await cdp.send('DOM.getDocument', { depth: -1 }), document)
    assert.equal(reads, 1)
    assert.deepEqual(await cdp.send('Debugger.stepOver'), { native: true })
    assert.deepEqual(
      await cdp.send('Runtime.getProperties', { objectId: 'lldb-scope-1-0' }),
      { native: true },
    )
    await assert.rejects(
      cdp.send('CSS.setEffectivePropertyValueForNode', {
        nodeId: 1,
        propertyName: 'color',
        value: 'red',
      }),
      /app is paused/,
    )
    await assert.rejects(
      cdp.send('Runtime.evaluate', { expression: '6 * 7' }),
      /app is paused/,
    )
    assert.equal(reads, 1)
    backend.paused = false
    assert.equal(
      (await cdp.send('Runtime.evaluate', { expression: '6 * 7' })).result
        .value,
      42,
    )
  } finally {
    cdp?.close()
    if (relay) {
      await relay.close()
      await disconnected
    }
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('native relay layers shared history, outerHTML, compat no-ops and listener sources over the app socket', async () => {
  const { FakeNativeDom } = await import('./fixtures/fake-native-dom.mjs')
  const dom = new FakeNativeDom()
  const native = await dom.listen()
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const debugPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const debuggerState = {
    paused: false,
    async handle() {
      return {}
    },
    detach() {},
    async handlerLocations(addresses) {
      assert.deepEqual(addresses, ['0x10', '0x20'])
      return {
        '0x10': { scriptId: 'runtime', lineNumber: 1, columnNumber: 0, functionName: 'gea::jsx::prop' },
        '0x20': { scriptId: 'native-app', lineNumber: 4, columnNumber: 2, functionName: 'gea_body_fn' },
      }
    },
  }
  let relay, first, second
  try {
    relay = await createNativeRelay({ nativePort: native.port, debugPort, debuggerState, frontend: null })
    assert.match((await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())[0].devtoolsFrontendUrl, /^devtools:/)
    first = await connectCDP(relay.endpoint)
    second = await connectCDP(relay.endpoint)

    assert.deepEqual(await first.send('Overlay.setShowPaintRects', { result: true }), {})
    assert.equal(
      (await first.send('DOM.getOuterHTML', { nodeId: dom.title.nodeId })).outerHTML,
      '<h1 id="title">Tic Tac Toe</h1>',
    )

    // The edit is made by one window and undone from another.
    await first.send('DOM.setAttributeValue', { nodeId: dom.title.nodeId, name: 'data-x', value: '1' })
    assert.equal((await second.send('Gea.getChanges')).entries[0].ops[0].target, 'h1#title')
    await second.send('DOM.undo')
    assert.equal(dom.title.attributes.includes('data-x'), false)
    await second.send('DOM.redo')
    assert.equal(dom.title.attributes.includes('data-x'), true)

    // The Gea Changes panel uses the same history over HTTP.
    const post = (body, headers = {}) =>
      fetch(`http://127.0.0.1:${debugPort}/gea/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    const exported = await (await post({ method: 'exportOverrides' })).json()
    assert.deepEqual(exported.overrides, [
      { type: 'attribute', target: { node: { tag: 'h1', id: 'title' } }, name: 'data-x', value: '1' },
    ])
    assert.equal((await post({ method: 'nope' })).status, 400)
    assert.equal((await post({ method: 'getChanges' }, { Origin: 'https://example.com' })).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${debugPort}/devtools/devtools_app.html`)).status, 404)

    const [listener] = (await first.send('DOMDebugger.getEventListeners', { objectId: 'node-2' })).listeners
    assert.equal(listener.scriptId, 'native-app')
    assert.equal(listener.lineNumber, 4)
    assert.equal(listener.handler.description, 'click listener on <div>')
    assert.equal(listener.nativeAddresses, undefined)

    // While paused, edits and history moves are refused instead of queued.
    debuggerState.paused = true
    await assert.rejects(first.send('DOM.undo'), /paused/)
    debuggerState.paused = false
  } finally {
    first?.close()
    second?.close()
    await relay?.close()
    await native.close()
  }
})
