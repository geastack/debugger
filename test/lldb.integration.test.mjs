import test from 'node:test'
import assert from 'node:assert/strict'
import { connectCDP } from '../src/cdp.mjs'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { spawn } from 'node:child_process'

const url = process.env.GEA_DEBUGGER_MAC_SOURCE_URL
const line = Number(process.env.GEA_DEBUGGER_MAC_SOURCE_LINE)
const trigger = process.env.GEA_DEBUGGER_MAC_SOURCE_TRIGGER
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'terminal interruption detaches LLDB and reaps the owned Mac application',
  {
    skip:
      !process.env.GEA_DEBUGGER_NATIVE_TEST_EXECUTABLE ||
      !process.env.GEA_DEBUGGER_MAC_SOURCE_METADATA,
    timeout: 90000,
  },
  async () => {
    const module = new URL('../src/native.mjs', import.meta.url).href
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const {launchNativeDebugger}=await import(${JSON.stringify(module)});
    process.exitCode=await launchNativeDebugger({
      executable:process.env.GEA_DEBUGGER_NATIVE_TEST_EXECUTABLE,
      appRoot:process.env.GEA_DEBUGGER_NATIVE_TEST_APP,
      nativeDebug:{metadata:process.env.GEA_DEBUGGER_MAC_SOURCE_METADATA},
      debugPort:15993,open:false,
    });
  `,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = '',
      errors = ''
    child.stderr.on('data', (data) => {
      errors += data
    })
    const exited = new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error('Mac source launcher startup timed out: ' + errors),
            ),
          65000,
        )
        child.stdout.on('data', (data) => {
          output += data
          if (output.includes('Native Sources:')) {
            clearTimeout(timer)
            resolve()
          }
        })
        exited.then(() => {
          clearTimeout(timer)
          reject(new Error('Source launcher exited before ready: ' + errors))
        }, reject)
      })
      process.kill(-child.pid, 'SIGINT')
      assert.equal(await exited, 1, errors)
      assert.doesNotMatch(errors, /unsettled top-level await/)
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
      await exited
    }
  },
)

test(
  'native macOS original-source breakpoints, scopes, source steps and resume',
  { skip: !url || !line || !trigger, timeout: 60000 },
  async () => {
    const c = await connectCDP(
      process.env.GEA_DEBUGGER_TEST_ENDPOINT ||
        'ws://127.0.0.1:9222/devtools/page/gea',
    )
    const events = []
    c.onEvent((event) => events.push(event))
    let breakpoint, action
    const paused = async (start) => {
      for (let i = 0; i < 300; i++) {
        const event = events
          .slice(start)
          .find((e) => e.method === 'Debugger.paused')
        if (event) return event.params
        await delay(50)
      }
      throw new Error('Native pause timed out')
    }
    try {
      await c.send('DOM.enable')
      const document = await c.send('DOM.getDocument', { depth: -1 })
      await c.send('Debugger.enable')
      const script = events.find(
        (e) =>
          e.method === 'Debugger.scriptParsed' &&
          e.params.scriptId === 'native-app',
      ).params
      const trace = new TraceMap(
        JSON.parse(Buffer.from(script.sourceMapURL.split(',')[1], 'base64')),
      )
      breakpoint = await c.send('Debugger.setBreakpointByUrl', {
        url,
        lineNumber: line - 1,
      })
      let start = events.length
      action = c.send(
        'Runtime.evaluate',
        { expression: trigger, returnByValue: true },
        55000,
      )
      action.catch(() => {})
      let pause = await paused(start)
      const original = originalPositionFor(trace, {
        line: pause.callFrames[0].location.lineNumber + 1,
        column: 0,
      })
      assert.equal(original.source, url)
      assert.equal(original.line, line)
      assert.ok(pause.hitBreakpoints.includes(breakpoint.breakpointId))
      assert.deepEqual(await c.send('DOM.getDocument', { depth: -1 }), document)
      await assert.rejects(
        c.send('Runtime.evaluate', { expression: 'document.title' }),
        /app is paused/,
      )
      assert.equal(
        (
          await c.send('Debugger.evaluateOnCallFrame', {
            callFrameId: pause.callFrames[0].callFrameId,
            expression: '6 * 7',
          })
        ).result.value,
        42,
      )
      const scope = pause.callFrames[0].scopeChain[0].object.objectId
      const properties = await c.send('Runtime.getProperties', {
        objectId: scope,
      })
      assert.ok(properties.result.length)
      const aggregate = properties.result.find(
        (property) => property.value.objectId,
      )
      if (aggregate)
        assert.ok(
          (
            await c.send('Runtime.getProperties', {
              objectId: aggregate.value.objectId,
            })
          ).result.length,
        )
      for (const method of [
        'Debugger.stepOver',
        'Debugger.stepInto',
        'Debugger.stepOut',
      ]) {
        start = events.length
        await c.send(method)
        pause = await paused(start)
        assert.ok(pause.callFrames.length)
        assert.equal(pause.reason, 'step')
        await assert.rejects(
          c.send('Runtime.getProperties', { objectId: scope }),
          /Stale/,
        )
      }
      await c.send('Debugger.removeBreakpoint', {
        breakpointId: breakpoint.breakpointId,
      })
      breakpoint = null
      await c.send('Debugger.resume')
      await action
      action = null
      assert.ok((await c.send('DOM.getDocument', { depth: -1 })).root)
    } finally {
      if (breakpoint)
        await c
          .send('Debugger.removeBreakpoint', {
            breakpointId: breakpoint.breakpointId,
          })
          .catch(() => {})
      await c.send('Debugger.resume').catch(() => {})
      if (action) await action.catch(() => {})
      if (process.env.GEA_DEBUGGER_MAC_SOURCE_CLEANUP) {
        const cleanup = await c.send('Runtime.evaluate', {
          expression: process.env.GEA_DEBUGGER_MAC_SOURCE_CLEANUP,
        })
        assert.equal(cleanup.exceptionDetails, undefined, 'native app resumes for cleanup')
      }
      await c.send('Debugger.disable').catch(() => {})
      c.close()
    }
  },
)
