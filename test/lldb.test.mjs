import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MacSourceDebugger } from '../src/lldb.mjs'

const file = fileURLToPath(
  new URL('./fixtures/native-source.ts', import.meta.url),
)
const info = {
  file: 'gea-native-debug.js',
  locations: [
    { nativeLine: 1, file, line: 2, column: 3 },
    { nativeLine: 20, file, line: 3, column: 10 },
  ],
}

function setup() {
  const calls = [],
    events = []
  let receive,
    next = 0
  const transport = {
    onEvent(fn) {
      receive = fn
    },
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'attach') return { lines: [1, 20, 21] }
      if (method === 'breakpoint') return { id: ++next, line: params.line }
      if (method === 'variables')
        return {
          values: [
            { name: 'n', type: 'int', value: '42' },
            { name: 'item', type: 'Record', handle: 1 },
          ],
        }
      if (method === 'children')
        return { values: [{ name: 'enabled', type: 'bool', value: 'true' }] }
      if (method === 'evaluate') return { type: 'int', value: '42' }
      return {}
    },
    async close() {
      calls.push({ method: 'close' })
    },
  }
  const state = new MacSourceDebugger(transport, info)
  const emit = (method, params) => events.push({ method, params })
  const stop = (line, reason = 'step', frames) =>
    receive({
      event: 'stopped',
      thread: '7',
      reason,
      breakpoints: [],
      frames: frames || [
        { level: 0, function: 'advance', file: info.file, line },
      ],
    })
  return {
    state,
    calls,
    events,
    emit,
    stop,
    receive: (event) => receive(event),
  }
}

test('LLDB binds original source columns without a hardware breakpoint limit and inspects paused values', async () => {
  const { state, calls, events, emit, stop } = setup()
  await state.start({ executable: '/app', pid: 123 })
  await state.handle('client', emit, 'Debugger.enable')
  assert.ok(
    events.find((e) => e.method === 'Debugger.scriptParsed').params
      .sourceMapURL,
  )
  assert.deepEqual(
    (
      await state.handle('client', emit, 'Debugger.getPossibleBreakpoints', {
        start: { scriptId: 'native-app', lineNumber: 0 },
      })
    ).locations.map((l) => l.lineNumber),
    [0, 19],
  )
  for (let i = 0; i < 4; i++)
    await state.handle('client', emit, 'Debugger.setBreakpointByUrl', {
      url: pathToFileURL(file).href,
      lineNumber: 2,
      columnNumber: 9,
    })
  assert.equal(calls.filter((c) => c.method === 'breakpoint').length, 4)
  assert.equal(calls.at(-1).params.line, 20)
  stop(20, 'breakpoint')
  await state.events
  const paused = events.find((e) => e.method === 'Debugger.paused').params
  const properties = await state.properties(
    paused.callFrames[0].scopeChain[0].object.objectId,
  )
  assert.equal(properties.result[0].value.value, 42)
  assert.equal(
    (await state.properties(properties.result[1].value.objectId)).result[0]
      .value.value,
    true,
  )
  assert.equal(
    (
      await state.handle('client', emit, 'Debugger.evaluateOnCallFrame', {
        callFrameId: paused.callFrames[0].callFrameId,
        expression: '6 * 7',
      })
    ).result.value,
    42,
  )
  await state.detach('client')
  assert.equal(calls.filter((c) => c.method === 'remove').length, 4)
  assert.equal(calls.at(-1).method, 'resume')
  await state.close()
})

test('source steps skip helpers, invalidate old scopes, and stop at a native caller when leaving app code', async () => {
  const { state, calls, events, emit, stop, receive } = setup()
  await state.start({ executable: '/app', pid: 123 })
  await state.handle('client', emit, 'Debugger.enable')
  stop(1)
  await state.events
  const oldScope =
    events.at(-1).params.callFrames[0].scopeChain[0].object.objectId
  await state.handle('client', emit, 'Debugger.stepInto')
  receive({ event: 'running' })
  await state.events
  await assert.rejects(state.properties(oldScope), /not paused/)
  stop(8, 'step', [
    { level: 0, function: 'helper', file: '', line: 0 },
    { level: 1, function: 'advance', file: info.file, line: 1 },
  ])
  await state.events
  assert.equal(calls.at(-1).params.mode, 'out')
  stop(20)
  await state.events
  assert.equal(events.at(-1).method, 'Debugger.paused')
  assert.equal(events.at(-1).params.callFrames[0].location.lineNumber, 19)
  await assert.rejects(state.properties(oldScope), /Stale/)
  await state.handle('client', emit, 'Debugger.stepOut')
  stop(0, 'step', [{ level: 0, function: 'nativeCaller', file: '', line: 0 }])
  await state.events
  assert.equal(events.at(-1).method, 'Debugger.paused')
  assert.equal(events.at(-1).params.callFrames[0].functionName, 'nativeCaller')
  await state.handle('client', emit, 'Debugger.pause')
  assert.equal(state.step, null)
  await state.close()
})

test('source debugging fails closed when symbols are missing or a breakpoint has no mapped position', async () => {
  const { state, emit } = setup()
  state.transport.request = async () => ({ lines: [] })
  await assert.rejects(
    state.start({ executable: '/app', pid: 123 }),
    /symbols are missing/,
  )
  state.lines = new Set([0])
  await assert.rejects(
    state.handle('client', emit, 'Debugger.setBreakpoint', {
      location: { scriptId: 'native-app', lineNumber: 19 },
    }),
    /no executable/,
  )
  await assert.rejects(
    state.handle('client', emit, 'Debugger.setBreakpoint', {
      location: { scriptId: 'native-app', lineNumber: 0 },
      condition: 'n > 1',
    }),
    /JavaScript conditions/,
  )
  await state.close()
})
