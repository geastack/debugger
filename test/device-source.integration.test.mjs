import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { connectCDP } from '../src/cdp.mjs'
const sourceFile = process.env.GEA_DEBUGGER_SOURCE_TEST_FILE
const sourceLine = Number(process.env.GEA_DEBUGGER_SOURCE_TEST_LINE)
const sourceColumn = Number(process.env.GEA_DEBUGGER_SOURCE_TEST_COLUMN || 1) - 1
const endpoint = process.env.GEA_DEBUGGER_SOURCE_TEST_ENDPOINT
const appRoot = process.env.GEA_DEBUGGER_SOURCE_TEST_APP

test(
  'Native source maps, hardware breakpoints, native evaluation and source stepping',
  { skip: !endpoint || !sourceFile || !sourceLine, timeout: 180000 },
  async () => {
    const device = await connectCDP(endpoint),
      events = []
    device.onEvent((event) => events.push(event))
    let bp
    const pausedAfter = async (start) => {
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        const pause = events.slice(start).find((event) => event.method === 'Debugger.paused')
        if (pause) return pause.params
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('Native source pause timed out')
    }
    try {
      await device.send('Debugger.enable')
      const script = events.find(
        (event) =>
          event.method === 'Debugger.scriptParsed' && event.params.scriptId === 'native-app',
      )?.params
      assert.ok(script)
      const sourceMap = JSON.parse(Buffer.from(script.sourceMapURL.split(',')[1], 'base64'))
      const trace = new TraceMap(sourceMap)
      const original = (location) =>
        originalPositionFor(trace, {
          line: location.lineNumber + 1,
          column: location.columnNumber,
        })
      assert.ok(sourceMap.sourcesContent.some((source) => source.trim().length > 0))
      const possible = await device.send('Debugger.getPossibleBreakpoints', {
        start: { scriptId: 'native-app', lineNumber: 0, columnNumber: 0 },
      })
      const location = possible.locations.find(
        (location) =>
          original(location).source?.endsWith(sourceFile) && original(location).line === sourceLine,
      )
      assert.ok(location)
      let start = events.length
      bp = await device.send('Debugger.setBreakpoint', { location }, 30000)
      let paused = await pausedAfter(start)
      assert.equal(original(paused.callFrames[0].location).line, sourceLine)
      const evaluation = await device.send('Debugger.evaluateOnCallFrame', {
        callFrameId: paused.callFrames[0].callFrameId,
        expression: '6*7',
      })
      assert.equal(evaluation.result.value, 42)
      const locals = await device.send('Runtime.getProperties', {
        objectId: paused.callFrames[0].scopeChain[0].object.objectId,
      })
      assert.ok(locals.result.length)
      const before = Date.now()
      assert.ok((await device.send('DOM.getDocument', { depth: -1 })).root)
      assert.ok(Date.now() - before < 2000, 'paused tree comes from the validated snapshot')
      const positions = []
      for (let i = 0; i < 3; i++) {
        start = events.length
        await device.send('Debugger.stepOver', {}, 30000)
        paused = await pausedAfter(start)
        const position = original(paused.callFrames[0].location)
        assert.ok(position.source, JSON.stringify(paused.data))
        assert.ok(position.line > 0)
        positions.push(position)
      }
      start = events.length
      await device.send('Debugger.stepInto', {}, 30000)
      paused = await pausedAfter(start)
      assert.ok(original(paused.callFrames[0].location).source)
      const callerName = paused.callFrames[1]?.functionName
      assert.ok(callerName)
      start = events.length
      await device.send('Debugger.stepOut', {}, 30000)
      paused = await pausedAfter(start)
      assert.ok(paused.callFrames[0].functionName === callerName, JSON.stringify(paused.data))
      console.log(
        'Native source steps:',
        positions.map((position) => `${position.line}:${position.column}`).join(', '),
      )
      if (appRoot) {
        const [port] = readFileSync(
          path.join(appRoot, '.gea/build/web/chrome-debug-profile/DevToolsActivePort'),
          'utf8',
        ).split('\n')
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const frontend = await connectCDP(
          tabs.find((tab) => tab.url.startsWith('devtools://')).webSocketDebuggerUrl,
        )
        const ui = async (expression) => {
          const result = await frontend.send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            30000,
          )
          assert.equal(result.exceptionDetails, undefined, JSON.stringify(result))
          return result.result.value
        }
        try {
          const mappings = await ui(
            `(async()=>{const W=await import('./models/workspace/workspace.js');const B=await import('./models/bindings/bindings.js');const source=W.Workspace.WorkspaceImpl.instance().uiSourceCodes().find(s=>s.url().endsWith(${JSON.stringify(sourceFile)}));if(!source)throw new Error('Original source missing');const locations=await B.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance().uiLocationToRawLocations(source,${sourceLine - 1},${sourceColumn});return locations.map(l=>({scriptId:l.scriptId,line:l.lineNumber,column:l.columnNumber}))})()`,
          )
          assert.ok(
            mappings.some((location) => location.scriptId === 'native-app'),
            'Chrome maps the original inline column to native code',
          )
          await device.send('Debugger.removeBreakpoint', {
            breakpointId: bp.breakpointId,
          })
          bp = null
          await ui(
            `(async()=>{const W=await import('./models/workspace/workspace.js');const B=await import('./models/breakpoints/breakpoints.js');const source=W.Workspace.WorkspaceImpl.instance().uiSourceCodes().find(s=>s.url().endsWith(${JSON.stringify(sourceFile)}));globalThis.__geaSourceTestBreakpoint=await B.BreakpointManager.BreakpointManager.instance().setBreakpoint(source,${sourceLine - 1},${sourceColumn},'',true,false,B.BreakpointManager.BreakpointOrigin.USER_ACTION);return !!globalThis.__geaSourceTestBreakpoint})()`,
          )
          start = events.length
          await device.send('Debugger.resume')
          paused = await pausedAfter(start)
          assert.equal(
            original(paused.callFrames[0].location).line,
            sourceLine,
            'Chrome original-source breakpoint stops the board',
          )
          console.log('Chrome original-source inline breakpoint bound and hit')
        } finally {
          await ui(
            `(async()=>{await globalThis.__geaSourceTestBreakpoint?.remove(false);delete globalThis.__geaSourceTestBreakpoint;return true})()`,
          ).catch(() => {})
          frontend.close()
        }
      }
    } finally {
      await device.send('Debugger.pause', {}, 30000).catch(() => {})
      if (bp)
        await device
          .send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId }, 30000)
          .catch(() => {})
      await device.send('Debugger.resume', {}, 30000).catch(() => {})
      device.close()
    }
  },
)
