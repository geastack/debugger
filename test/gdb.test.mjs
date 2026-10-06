import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import {
  parseMI,
  nativeSources,
  NativeDebugger,
  createNativeDebugger,
  selectNativeDebugBuild,
} from '../src/gdb.mjs'
import { DeviceTransport } from '../src/device.mjs'
const file = fileURLToPath(new URL('./fixtures/native-source.ts', import.meta.url))
const info = {
  file: 'gea-native-debug.js',
  locations: [
    { nativeLine: 1, file, line: 2, column: 3 },
    { nativeLine: 20, file, line: 3, column: 10 },
  ],
}

test('GDB MI preserves structured frames, repeated list entries and escaped text', () => {
  const r = parseMI(
    'stack=[frame={level="0",func="advance",line="20"},frame={level="1",func="loop",line="31"}],reason="breakpoint-hit",value="a\\n\\\"b\\\""',
  )
  assert.equal(r.stack[0].frame.func, 'advance')
  assert.equal(r.stack[1].frame.level, '1')
  assert.equal(r.value, 'a\n"b"')
  assert.deepEqual(parseMI('lines=[{pc="0x42001000",line="20"},{pc="0x0",line="5"}]').lines[0], {
    pc: '0x42001000',
    line: '20',
  })
})
test('native DWARF lines map to exact original source columns and contain the real source', () => {
  const source = nativeSources(info)
  const trace = new TraceMap(source.map)
  assert.deepEqual(originalPositionFor(trace, { line: 20, column: 0 }), {
    source: pathToFileURL(file).href,
    line: 3,
    column: 9,
    name: null,
  })
  assert.equal(source.rows.get(19).column, 9)
  assert.match(source.map.sourcesContent[0], /return next \* 2/)
  assert.equal(source.source.split('\n')[19], '; // Compiled native operation')
})
test('native Debugger commands bind actual GDB locations and read paused native scopes', async () => {
  const commands = []
  let receive
  const events = []
  const mi = {
    onEvent: (fn) => {
      receive = fn
    },
    command: async (cmd) => {
      commands.push(cmd)
      if (cmd === '-exec-interrupt --all')
        receive({
          kind: 'stopped',
          reason: 'signal-received',
          'thread-id': '3',
        })
      if (cmd === '-exec-continue') receive({ kind: 'running' })
      if (cmd.startsWith('-symbol-list-lines'))
        return {
          lines: [
            { pc: '0x42000100', line: '20' },
            { pc: '0x42000100', line: '20' },
          ],
        }
      if (cmd.startsWith('-break-insert')) return { bkpt: { number: '1', line: '20' } }
      if (cmd.startsWith('-stack-list-frames'))
        return {
          stack: [
            {
              frame: {
                level: '0',
                file: info.file,
                line: '20',
                func: 'advance',
              },
            },
          ],
        }
      if (cmd.startsWith('-stack-list-variables'))
        return { variables: [{ name: 'x', type: 'int', value: '41' }] }
      return {}
    },
    close: async () => {},
  }
  const debuggerState = new NativeDebugger(mi, info)
  debuggerState.initializing = false
  assert.equal(
    (
      await debuggerState.handle(
        'client',
        (method, params) => events.push({ method, params }),
        'Debugger.enable',
      )
    ).debuggerId,
    'gea-native-jtag',
  )
  const possible = await debuggerState.handle(
    'client',
    () => {},
    'Debugger.getPossibleBreakpoints',
    { start: { scriptId: 'native-app', lineNumber: 0 } },
  )
  assert.deepEqual(possible.locations, [
    { scriptId: 'native-app', lineNumber: 19, columnNumber: 0 },
  ])
  const bp = await debuggerState.handle('client', () => {}, 'Debugger.setBreakpoint', {
    location: { scriptId: 'native-app', lineNumber: 19 },
  })
  assert.equal(bp.breakpointId, 'gdb-1')
  assert.match(
    commands.find((cmd) => cmd.startsWith('-break-insert')),
    /gea-native-debug.js:20/,
  )
  receive({
    kind: 'stopped',
    reason: 'breakpoint-hit',
    'thread-id': '3',
    bkptno: '1.2',
  })
  await debuggerState.eventQueue
  const paused = events.find((e) => e.method === 'Debugger.paused').params
  assert.equal(paused.callFrames[0].location.lineNumber, 19)
  assert.deepEqual(paused.hitBreakpoints, ['gdb-1'])
  const properties = await debuggerState.properties('gdb-scope-1-0')
  assert.equal(properties.result[0].name, 'x')
  assert.equal(properties.result[0].value.value, '41')
  await debuggerState.handle('client', () => {}, 'Debugger.stepOver')
  assert.equal(commands.at(-1), '-exec-step-instruction --thread 3')
  receive({ kind: 'running' })
  await debuggerState.eventQueue
  assert.equal(debuggerState.paused, false)
  assert.ok(events.some((e) => e.method === 'Debugger.resumed'))
  await assert.rejects(debuggerState.properties('gdb-scope-1-0'), /not paused/)
})
test('paused native CPU serves the last validated tree without waiting on USB', async () => {
  let reads = 0
  const transport = new DeviceTransport({
    collect: async () => {
      reads++
      throw new Error('USB should not be read while paused')
    },
  })
  const cached = { nodes: new Map([[4, { id: 4 }]]), root: 4 }
  transport.lastGood = cached
  transport.debuggerState = { paused: true }
  assert.equal(await transport.snapshot({ fresh: true }), cached)
  assert.equal(reads, 0)
  await assert.rejects(
    transport.mutate({ op: 'style', id: 4, key: 'color', value: 'red' }),
    /Resume/,
  )
})

test('an ELF mismatch fails before starting any JTAG tools', async () => {
  await assert.rejects(
    createNativeDebugger({
      elf: file,
      metadata: file,
      firmwareElfHash: '0'.repeat(64),
      gdbExecutable: 'must-not-start',
      openocdExecutable: 'must-not-start',
    }),
    /ELF does not match running firmware/,
  )
})

test('attach selects the firmware-matching ELF and metadata despite a newer app-local build', () => {
  const local = { elf: '/app/build/app.elf', metadata: '/app/build/source.json' }
  const workspace = { elf: '/workspace/build/app.elf', metadata: '/workspace/build/source.json' }
  const binaries = new Map([
    [local.elf, Buffer.from('newer firmware')],
    [workspace.elf, Buffer.from('running firmware')],
  ])
  const firmwareHash = createHash('sha256').update(binaries.get(workspace.elf)).digest('hex')
  assert.equal(
    selectNativeDebugBuild([local, workspace], firmwareHash, (name) => binaries.get(name)),
    workspace,
  )
  assert.throws(
    () => selectNativeDebugBuild([local], firmwareHash, (name) => binaries.get(name)),
    /does not match running firmware/,
  )
  assert.throws(
    () => selectNativeDebugBuild([workspace], undefined, (name) => binaries.get(name)),
    /does not match running firmware/,
  )
})

test('source Step Over skips a ROM call with a temporary hardware breakpoint and restores persistent breakpoints', async () => {
  const commands = [],
    events = []
  let receive
  const mi = {
    onEvent: (fn) => {
      receive = fn
    },
    command: async (command) => {
      commands.push(command)
      if (command.startsWith('-data-disassemble'))
        return {
          asm_insns: [
            { address: '0x42001000', inst: 'call8 0x400024fc' },
            { address: '0x42001003', inst: 'mov.n a2, a3' },
          ],
        }
      if (command.startsWith('-break-insert')) return { bkpt: { number: '2' } }
      if (command.startsWith('-stack-list-frames'))
        return {
          stack: [
            {
              frame: {
                level: '0',
                file: info.file,
                line: '20',
                func: 'advance',
              },
            },
          ],
        }
      return {}
    },
    close: async () => {},
  }
  const native = new NativeDebugger(mi, info)
  native.initializing = false
  native.paused = true
  native.thread = '3'
  native.breakpoints.set('gdb-1', '1')
  native.lastPaused = {
    callFrames: [{ location: { lineNumber: 0 }, functionName: 'advance' }],
  }
  native.attach('client', (method, params) => events.push({ method, params }))
  await native.stepSource('over')
  assert.ok(commands.includes('-break-disable 1'))
  assert.ok(commands.includes('-break-insert -h -t *0x42001003'))
  assert.ok(commands.includes('-exec-continue --thread 3'))
  receive({ kind: 'running' })
  receive({
    kind: 'stopped',
    reason: 'breakpoint-hit',
    bkptno: '2',
    'thread-id': '3',
    frame: { file: info.file, line: '20' },
  })
  await native.eventQueue
  const pause = events.filter((event) => event.method === 'Debugger.paused').at(-1).params
  assert.equal(pause.reason, 'step')
  assert.deepEqual(pause.hitBreakpoints, [])
  assert.equal(native.temporaryBreakpoint, null)
  assert.ok(commands.includes('-break-enable 1'))
  assert.equal(pause.callFrames[0].location.lineNumber, 19)
})

test('native shutdown drains control events, removes breakpoints and resumes before detaching', async () => {
  const commands = []
  let receive
  const mi = {
    onEvent: (fn) => {
      receive = fn
    },
    command: async (command) => {
      commands.push(command)
      if (command === '-exec-interrupt --all')
        receive({ kind: 'stopped', reason: 'signal-received', 'thread-id': '3' })
      if (command === '-exec-continue') receive({ kind: 'running' })
      return {}
    },
    close: async () => commands.push('detach'),
  }
  const native = new NativeDebugger(mi, info)
  native.initializing = false
  native.breakpoints.set('gdb-1', '1')
  await native.close()
  assert.deepEqual(commands, ['-exec-interrupt --all', '-break-delete', '-exec-continue', 'detach'])
  assert.equal(native.paused, false)
  assert.equal(native.breakpoints.size, 0)
  assert.equal(native.stateWaiters.size, 0)
  await assert.rejects(
    native.handle('client', () => {}, 'Debugger.pause'),
    /closing/,
  )
})
