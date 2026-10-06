import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createNativeRelay } from '../src/native.mjs'
import { connectCDP } from '../src/cdp.mjs'

const executable = process.env.GEA_DEBUGGER_NATIVE_TEST_EXECUTABLE
const appRoot = process.env.GEA_DEBUGGER_NATIVE_TEST_APP
const selector = process.env.GEA_DEBUGGER_TEST_SELECTOR
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'native Mac app: actual tree, CSS repaint, console scripts and app events through CDP',
  { skip: !executable || !appRoot || !selector, timeout: 45000 },
  async () => {
    const app = spawn(executable, [], {
      cwd: appRoot,
      env: { ...process.env, GEA_DEBUGGER_NATIVE_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let relay, cdp
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native ready timeout')), 15000)
        let text = ''
        app.stdout.on('data', (data) => {
          text += data.toString()
          const match = /GEA_DEBUGGER_READY=(\d+)/.exec(text)
          if (match) {
            clearTimeout(timer)
            resolve(Number(match[1]))
          }
        })
        app.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        app.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`Native app exited (${code})`))
        })
      })
      relay = await createNativeRelay({
        nativePort: port,
        debugPort: 15985,
        title: 'Gea native test',
      })
      const discovery = await (await fetch('http://127.0.0.1:15985/json/list')).json()
      assert.equal(discovery[0].url, 'gea://native/')
      cdp = await connectCDP(discovery[0].webSocketDebuggerUrl)
      const events = []
      cdp.onEvent((event) => events.push(event))
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      await cdp.send('Runtime.enable')
      assert.ok(events.some((event) => event.method === 'Runtime.executionContextCreated'))
      const evaluate = async (expression) => {
        const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
        assert.equal(result.exceptionDetails, undefined, JSON.stringify(result))
        return result.result.value
      }
      assert.equal(await evaluate('6 * 7'), 42)
      const inspectorObject = await cdp.send('Runtime.evaluate', {
        expression: 'globalThis.getterCount=0; ({get probe(){getterCount++; return 42}})',
        objectGroup: 'getter-test',
      })
      const properties = await cdp.send('Runtime.getProperties', {
        objectId: inspectorObject.result.objectId,
        ownProperties: true,
      })
      assert.equal(properties.result.find((p) => p.name === 'probe').get.type, 'function')
      assert.equal(
        await evaluate('getterCount'),
        0,
        'property inspection did not execute a user getter',
      )
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'getter-test' })
      assert.ok((await evaluate('document.querySelectorAll("*").length')) > 2)
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
      const publishedEvents = events.filter((event) => event.method === 'DOM.setChildNodes').length
      await cdp.send('DOM.requestChildNodes', { nodeId: root.nodeId, depth: -1 })
      assert.equal(
        events.filter((event) => event.method === 'DOM.setChildNodes').length,
        publishedEvents,
        'subtree requests preserve nodes already loaded by Chrome',
      )
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      assert.ok(nodeId, `native app contains ${selector}`)
      const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
      assert.ok(matched.matchedCSSRules.length > 0, 'authored class CSS is exported')
      const { object } = await cdp.send('DOM.resolveNode', { nodeId, objectGroup: 'test' })
      assert.equal(object.subtype, 'node')
      const call = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function(){ return this.getBoundingClientRect().width; }',
        returnByValue: true,
      })
      assert.ok(call.result.value > 0)
      await cdp.send('DOM.setInspectedNode', { nodeId })
      assert.equal(
        await evaluate('$0.tagName'),
        (await cdp.send('DOM.describeNode', { nodeId })).node.nodeName,
      )
      const before = (await cdp.send('Page.captureScreenshot')).data
      await cdp.send('CSS.setEffectivePropertyValueForNode', {
        nodeId,
        propertyName: 'background-color',
        value: 'rgb(255, 0, 255)',
      })
      await cdp.send('CSS.setEffectivePropertyValueForNode', {
        nodeId,
        propertyName: 'color',
        value: 'rgb(0, 255, 0)',
      })
      await delay(200)
      const style = await cdp.send('CSS.getComputedStyleForNode', { nodeId })
      assert.equal(
        style.computedStyle.find((p) => p.name === 'background-color').value,
        'rgb(255, 0, 255)',
      )
      assert.equal(await evaluate('getComputedStyle($0).color'), 'rgb(0, 255, 0)')
      const after = (await cdp.send('Page.captureScreenshot')).data
      assert.notEqual(after, before, 'native AppKit pixels changed after CSS edit')
      const inline = (await cdp.send('CSS.getInlineStylesForNode', { nodeId })).inlineStyle
      await cdp.send('CSS.setStyleTexts', {
        edits: [
          {
            styleSheetId: inline.styleSheetId,
            range: inline.range,
            text: 'background-color: rgb(0, 0, 255); color: rgb(255, 255, 255);',
          },
        ],
      })
      assert.equal(await evaluate('getComputedStyle($0).backgroundColor'), 'rgb(0, 0, 255)')
      await cdp.send('DOM.setAttributeValue', { nodeId, name: 'data-native-debug', value: 'live' })
      await delay(150)
      assert.ok(
        events.some(
          (e) => e.method === 'DOM.attributeModified' && e.params.name === 'data-native-debug',
        ),
      )
      assert.equal(await evaluate('$0.getAttribute("data-native-debug")'), 'live')
      await evaluate('console.log("native console works", 42)')
      assert.ok(events.some((e) => e.method === 'Runtime.consoleAPICalled'))
      const thrown = await cdp.send('Runtime.evaluate', {
        expression: 'throw new Error("native-test-error")',
      })
      assert.match(thrown.exceptionDetails.text, /native-test-error/)
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'test' })
      await assert.rejects(
        cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function(){return 1}',
        }),
        /no longer exists/,
      )
      const temporaryId = await evaluate(
        `(()=>{const node=document.createElement('div');node.className='debug-created';node.textContent='created live';document.body.appendChild(node);globalThis.debugCreated=node;return node.__geaNodeId})()`,
      )
      await delay(100)
      assert.equal(
        await evaluate('document.querySelector(".debug-created").textContent'),
        'created live',
      )
      await evaluate('debugCreated.remove()')
      await delay(100)
      assert.equal(await evaluate('document.querySelector(".debug-created")'), null)
      const replacementId = await evaluate(
        `(()=>{const n=document.createElement('div');n.className='debug-replacement';document.body.appendChild(n);return n.__geaNodeId})()`,
      )
      assert.notEqual(
        replacementId,
        temporaryId,
        'recycled native slot gets a fresh protocol identity',
      )
      await assert.rejects(
        cdp.send('DOM.setAttributeValue', { nodeId: temporaryId, name: 'id', value: 'stale' }),
        /no longer exists/,
      )
      const stale = await cdp.send('Runtime.evaluate', { expression: 'debugCreated.textContent' })
      assert.match(stale.exceptionDetails.text, /no longer exists/)
      assert.equal(
        await evaluate('40 + 2'),
        42,
        'invalid native reference did not kill the app or console',
      )
      await evaluate('document.querySelector(".debug-replacement").remove()')
      if (process.env.GEA_DEBUGGER_NATIVE_TEST_SCREENSHOT) {
        const screenshot = (await cdp.send('Page.captureScreenshot')).data
        await writeFile(
          process.env.GEA_DEBUGGER_NATIVE_TEST_SCREENSHOT,
          Buffer.from(screenshot, 'base64'),
        )
      }
      await assert.rejects(cdp.send('Unimplemented.method'), /Unsupported native protocol method/)
    } finally {
      cdp?.close()
      if (relay) await relay.close()
      if (app.exitCode === null && app.signalCode === null) {
        app.kill('SIGTERM')
        await new Promise((resolve) => app.once('exit', resolve))
      }
    }
  },
)
