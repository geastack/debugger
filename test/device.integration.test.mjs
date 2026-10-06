import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { connectCDP } from '../src/cdp.mjs'

const endpoint = process.env.GEA_DEBUGGER_DEVICE_TEST_ENDPOINT
const selector = process.env.GEA_DEBUGGER_TEST_SELECTOR
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'connected device: native tree, styles, repaint and host console mutations',
  { skip: !endpoint || !selector, timeout: 90000 },
  async () => {
    const cdp = await connectCDP(endpoint)
    const events = []
    cdp.onEvent((event) => events.push(event))
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result))
      return result.result.value
    }
    const screenshot = async () =>
      createHash('sha256')
        .update((await cdp.send('Page.captureScreenshot')).data)
        .digest('hex')
    let originalAttributes
    try {
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      await cdp.send('Runtime.enable')
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
      assert.equal(root.nodeName, '#document')
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: 1, selector })
      assert.ok(nodeId)
      await cdp.send('DOM.setInspectedNode', { nodeId })
      assert.equal(await evaluate('6*7'), 42)
      originalAttributes = await evaluate(
        '({style:$0.getAttribute("style"),debug:$0.getAttribute("data-debug")})',
      )
      const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
      assert.ok(matched.inlineStyle)
      const before = await screenshot()
      await evaluate('$0.style.backgroundColor="rgb(255, 0, 255)"')
      await delay(250)
      const after = await screenshot()
      assert.notEqual(after, before, 'native display pixels changed after CSS edit')
      assert.equal(await evaluate('getComputedStyle($0).backgroundColor'), 'rgb(255, 0, 255)')
      await evaluate('$0.setAttribute("data-debug","live")')
      assert.equal(await evaluate('$0.getAttribute("data-debug")'), 'live')
      const created = await evaluate(
        '(async()=>{globalThis.created=await document.createElement("div");created.className="debug-created";created.textContent="USB live edit";document.body.appendChild(created);return created.__geaNodeId})()',
      )
      assert.ok(created > nodeId)
      assert.equal(await evaluate('$(".debug-created").textContent'), 'USB live edit')
      await evaluate('created.remove()')
      assert.equal(await evaluate('$(".debug-created")'), null)
      const stale = await cdp.send('Runtime.evaluate', { expression: 'created.textContent' })
      assert.match(stale.exceptionDetails.text, /Stale/)
      const replacement = await evaluate(
        '(async()=>{globalThis.replacement=await document.createElement("div");document.body.appendChild(replacement);return replacement.__geaNodeId})()',
      )
      assert.notEqual(replacement, created)
      await assert.rejects(
        cdp.send('DOM.setAttributeValue', { nodeId: created, name: 'id', value: 'wrong' }),
        /stale/i,
      )
      await evaluate('replacement.remove()')
      assert.equal(await evaluate('42'), 42, 'console survives stale reference errors')
      const object = (
        await cdp.send('Runtime.evaluate', { expression: '({value:42})', objectGroup: 'test' })
      ).result
      assert.equal(
        (
          await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function(){return this.value+1}',
            returnByValue: true,
          })
        ).result.value,
        43,
      )
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'test' })
      await assert.rejects(
        cdp.send('Runtime.getProperties', { objectId: object.objectId }),
        /released/,
      )
      assert.ok(events.some((e) => e.method === 'DOM.documentUpdated'))
      assert.ok(events.some((e) => e.method === 'DOM.attributeModified'))
    } finally {
      try {
        if (originalAttributes) {
          await evaluate(`(()=>{
            const original=${JSON.stringify(originalAttributes)};
            for(const [name,value] of [['style',original.style],['data-debug',original.debug]]) {
              if(value===null)$0.removeAttribute(name);else $0.setAttribute(name,value);
            }
          })()`)
        }
      } finally {
        cdp.close()
      }
    }
  },
)
