import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromeExecutable, chromeArgs, waitFor, launchDebugger } from '../src/launch.mjs'
import { connectCDP } from '../src/cdp.mjs'

const appRoot = process.env.GEA_DEBUGGER_TEST_APP
const script = process.env.GEA_DEBUGGER_TEST_SCRIPT

test(
  'real Gea DOM, live CSS edits and mutation events over Chrome CDP',
  { skip: !appRoot || !script, timeout: 60000 },
  async () => {
    const port = 15981
    const debugPort = 15982
    const children = []
    let cdp
    const start = (command, args) => {
      const child = spawn(command, args, { cwd: appRoot, env: process.env, stdio: 'inherit' })
      children.push(child)
      return child
    }
    try {
      const server = start(process.execPath, [
        script,
        '--app-dir',
        appRoot,
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
      ])
      const url = `http://127.0.0.1:${port}/`
      await waitFor(url, { alive: () => server.exitCode === null })
      const browser = start(
        chromeExecutable(),
        chromeArgs({ appRoot, url, debugPort, headless: true }),
      )
      await waitFor(`http://127.0.0.1:${debugPort}/json/version`, {
        alive: () => browser.exitCode === null,
      })
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      cdp = await connectCDP(
        targets.find((target) => target.type === 'page' && target.url.startsWith(url))
          .webSocketDebuggerUrl,
      )
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      await cdp.send('Runtime.enable')
      let rendered = false
      for (let i = 0; i < 100; i++) {
        const result = await cdp.send('Runtime.evaluate', {
          expression: '!!document.querySelector("#app > *")',
          returnByValue: true,
        })
        if (result.result.value) {
          rendered = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(rendered, 'Gea app rendered into #app')
      const fonts = await cdp.send('Runtime.evaluate', {
        expression: '(async()=>{await Promise.all([...document.fonts].map(font=>font.load())); return [...document.fonts].map(font=>font.status)})()',
        awaitPromise: true,
        returnByValue: true,
      })
      assert.equal(fonts.exceptionDetails, undefined, 'the real app font resources load')
      assert.ok(fonts.result.value.every((status) => status === 'loaded'))
      if (process.env.GEA_DEBUGGER_TEST_DENIED_FILE) {
        const file = process.env.GEA_DEBUGGER_TEST_DENIED_FILE.replaceAll('\\', '/').replace(/^\/+/, '')
        const denied = await fetch(new URL(`/@fs/${file}`, url))
        assert.equal(denied.status, 403, 'files outside the app workspace are not exposed')
      }
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '#app > *',
      })
      assert.ok(nodeId)
      const events = []
      cdp.onEvent((event) => events.push(event))
      await cdp.send('DOM.setAttributeValue', { nodeId, name: 'data-debug-test', value: 'live' })
      await cdp.send('CSS.setEffectivePropertyValueForNode', {
        nodeId,
        propertyName: 'color',
        value: 'rgb(1, 2, 3)',
      })
      const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId })
      assert.equal(
        computedStyle.find((property) => property.name === 'color').value,
        'rgb(1, 2, 3)',
      )
      const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
      assert.ok(attributes.includes('live'))
      assert.ok(
        events.some(
          (event) =>
            event.method === 'DOM.attributeModified' && event.params.name === 'data-debug-test',
        ),
      )
      await cdp.send('Runtime.evaluate', {
        expression: 'document.querySelector("#app > *").setAttribute("data-app-update", "changed")',
      })
      assert.ok(
        events.some(
          (event) =>
            event.method === 'DOM.attributeModified' && event.params.name === 'data-app-update',
        ),
      )
    } finally {
      cdp?.close()
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once('exit', resolve)),
        ),
      )
    }
  },
)

test(
  'launcher owns Chrome and Vite and cleans up on browser exit',
  { skip: !appRoot || !script, timeout: 60000 },
  async () => {
    const port = 15983
    const debugPort = 15984
    const messages = []
    const run = launchDebugger({
      appRoot,
      script,
      port,
      debugPort,
      headless: true,
      stdout: (text) => messages.push(text),
    })
    let failure
    run.catch((error) => {
      failure = error
    })
    let cdp
    try {
      for (let i = 0; i < 300 && !messages.some((text) => text.startsWith('CDP: ')); i++) {
        if (failure) throw failure
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const endpoint = messages.find((text) => text.startsWith('CDP: '))?.slice(5)
      assert.ok(endpoint, 'launcher reports the Gea target CDP endpoint')
      cdp = await connectCDP(endpoint)
      await cdp.send('Browser.close')
      assert.equal(await run, 0)
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }),
      )
      await assert.rejects(
        fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }),
      )
    } finally {
      cdp?.close()
    }
  },
)
