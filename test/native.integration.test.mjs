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
      const { cssLayoutViewport } = await cdp.send('Page.getLayoutMetrics')
      assert.ok(cssLayoutViewport.clientWidth > 0 && cssLayoutViewport.clientHeight > 0,
        'native viewport is available even when the window is inactive')
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
      const shallow = await connectCDP(discovery[0].webSocketDebuggerUrl)
      try {
        const expanded = []
        shallow.onEvent(event => expanded.push(event))
        await shallow.send('DOM.enable')
        await shallow.send('DOM.getDocument', { depth: 1 })
        assert.deepEqual((await shallow.send('DOM.pushNodesByBackendIdsToFrontend', {
          backendNodeIds: [nodeId],
        })).nodeIds, [nodeId])
        assert.ok(expanded.some(event => event.method === 'DOM.setChildNodes' &&
          event.params.nodes.some(node => node.nodeId === nodeId)),
          'backend selection publishes the path through a collapsed frontend tree')
        await shallow.send('Overlay.enable')
        await shallow.send('Overlay.setInspectMode', { mode: 'searchForNode' })
        await shallow.send('Overlay.setInspectMode', { mode: 'none' })
        await shallow.send('Overlay.setInspectMode', { mode: 'searchForNode' })
      } finally { shallow.close() }
      await delay(100)
      const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
      assert.ok(matched.matchedCSSRules.length > 0, 'authored class CSS is exported')
      const authored = (matched.matchedCSSRules.find(({ rule }) =>
        rule.origin === 'regular' && rule.style.cssProperties.some(p => p.name === 'color'),
      ) ?? matched.matchedCSSRules.find(({ rule }) => rule.origin === 'regular'))?.rule
      assert.ok(authored, 'selected element has an editable author rule')
      assert.equal(authored.styleSheetId, authored.style.styleSheetId)
      assert.equal(authored.style.range.endColumn, authored.style.cssText.length)
      assert.ok(authored.style.cssProperties.every(p => p.range))
      assert.ok(events.some(e => e.method === 'CSS.styleSheetAdded' &&
        e.params.header.styleSheetId === authored.styleSheetId && e.params.header.isMutable))
      const colorDeclaration = authored.style.cssProperties.find(p => p.name === 'color')
      const ruleEdit = await cdp.send('CSS.setStyleTexts', { edits: [{
        styleSheetId: authored.styleSheetId,
        range: colorDeclaration?.range ?? authored.style.range,
        text: colorDeclaration ? 'color: rgb(255, 0, 255);'
          : `${authored.style.cssText} color: rgb(255, 0, 255);`,
      }] })
      assert.equal(ruleEdit.styles[0].cssProperties.find(p => p.name === 'color').value, 'rgb(255, 0, 255)')
      if (!matched.inlineStyle.cssProperties.some(p => p.name === 'color')) {
        assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`), 'rgb(255, 0, 255)')
      }
      assert.equal((await cdp.send('CSS.getInlineStylesForNode', { nodeId })).inlineStyle.cssText,
        matched.inlineStyle.cssText, 'class editing does not create an inline override')
      let authorStyle = ruleEdit.styles[0]
      if (colorDeclaration) {
        for (let attempt = 0; attempt < 3; attempt++) {
          let declaration = authorStyle.cssProperties.find(p => p.name === 'color')
          authorStyle = (await cdp.send('CSS.setStyleTexts', { edits: [{
            styleSheetId: authorStyle.styleSheetId, range: declaration.range,
            text: '/* color: rgb(255, 0, 255); */',
          }] })).styles[0]
          await delay(100)
          const fetched = (await cdp.send('CSS.getMatchedStylesForNode', { nodeId }))
            .matchedCSSRules.find(({ rule }) => rule.styleSheetId === authored.styleSheetId).rule.style
          assert.equal(fetched.cssProperties.find(p => p.name === 'color').disabled, true)
          if (!matched.inlineStyle.cssProperties.some(p => p.name === 'color'))
            assert.notEqual(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`), 'rgb(255, 0, 255)')
          declaration = authorStyle.cssProperties.find(p => p.name === 'color')
          authorStyle = (await cdp.send('CSS.setStyleTexts', { edits: [{
            styleSheetId: authorStyle.styleSheetId, range: declaration.range,
            text: 'color: rgb(255, 0, 255);',
          }] })).styles[0]
          assert.equal(authorStyle.cssProperties.find(p => p.name === 'color').disabled, false)
        }
      }
      await cdp.send('CSS.setStyleTexts', { edits: [{
        styleSheetId: authored.styleSheetId, range: authorStyle.range,
        text: authored.style.cssText,
      }] })
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
      let editable = (await cdp.send('CSS.getInlineStylesForNode', { nodeId })).inlineStyle
      editable = (await cdp.send('CSS.setStyleTexts', { edits: [{
        styleSheetId: editable.styleSheetId, range: editable.range,
        text: 'background: indianred;\ncolor: lime; opacity: .5;',
      }] })).styles[0]
      await delay(150)
      const nativeIndianRed = await evaluate('getComputedStyle($0).backgroundColor')
      assert.match(nativeIndianRed, /^rgb\(205, 9[23], 9[02]\)$/, 'native color quantization preserves indianred')
      assert.deepEqual((await cdp.send('CSS.getInlineStylesForNode', { nodeId }))
        .inlineStyle.cssProperties.map(p => p.name), ['background', 'color', 'opacity'],
        'compiled background-color is never fabricated as an authored inline declaration')
      const toggle = async (name, disabled) => {
        const property = editable.cssProperties.find(p => p.name === name)
        editable = (await cdp.send('CSS.setStyleTexts', { edits: [{
          styleSheetId: editable.styleSheetId, range: property.range,
          text: disabled ? `/* ${name}: ${property.value}; */` : `${name}: ${property.value};`,
        }] })).styles[0]
        assert.equal(editable.cssProperties.find(p => p.name === name).disabled, disabled)
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        await toggle('background', true)
        await delay(100)
        assert.notEqual(await evaluate('getComputedStyle($0).backgroundColor'), nativeIndianRed)
        assert.equal(await evaluate('getComputedStyle($0).color'), 'rgb(0, 255, 0)')
        await toggle('color', true)
        await delay(100)
        assert.notEqual(await evaluate('getComputedStyle($0).color'), 'rgb(0, 255, 0)')
        assert.equal(editable.cssProperties.find(p => p.name === 'background').disabled, true)
        await toggle('background', false)
        await toggle('color', false)
        await delay(100)
        assert.equal(await evaluate('getComputedStyle($0).backgroundColor'), nativeIndianRed)
        assert.equal(await evaluate('getComputedStyle($0).color'), 'rgb(0, 255, 0)')
      }
      await toggle('opacity', true)
      cdp.close()
      cdp = await connectCDP(discovery[0].webSocketDebuggerUrl)
      cdp.onEvent((event) => events.push(event))
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      await cdp.send('Runtime.enable')
      await cdp.send('DOM.getDocument', { depth: -1 })
      await cdp.send('DOM.setInspectedNode', { nodeId })
      editable = (await cdp.send('CSS.getInlineStylesForNode', { nodeId })).inlineStyle
      assert.equal(editable.cssProperties.find(p => p.name === 'opacity').disabled, true,
        'disabled declarations survive inspector reconnection')
      assert.equal((await cdp.send('CSS.getStyleSheetText', { styleSheetId: editable.styleSheetId })).text,
        editable.cssText)
      await evaluate('$0.style.background = "blue"')
      editable = (await cdp.send('CSS.getInlineStylesForNode', { nodeId })).inlineStyle
      assert.deepEqual(editable.cssProperties.map(p => p.name), ['background', 'color', 'opacity'])
      assert.equal(editable.cssProperties.find(p => p.name === 'opacity').disabled, true)
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
      assert.equal(await evaluate(`debugCreated.style.backgroundColor='red';
        debugCreated.style.removeProperty('background-color'); getComputedStyle(debugCreated).backgroundColor`),
        'rgba(0, 0, 0, 0)', 'removing the last longhand restores native transparency')
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
