import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { connectCDP } from '../src/cdp.mjs'
const selector = process.env.GEA_DEBUGGER_TEST_SELECTOR || 'body'
const endpoint = process.env.GEA_DEBUGGER_PREVIEW_TEST_ENDPOINT,
  app = process.env.GEA_DEBUGGER_PREVIEW_TEST_APP

test(
  'real board preview switches pixels/tree, follows selection and retains its image while paused',
  { skip: !endpoint || !app, timeout: 120000 },
  async () => {
    const [port] = readFileSync(
        path.join(app, '.gea/build/web/chrome-debug-profile/DevToolsActivePort'),
        'utf8',
      ).split('\n'),
      tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const preview = await connectCDP(
        tabs.find((tab) => tab.url.endsWith('/preview')).webSocketDebuggerUrl,
      ),
      device = await connectCDP(endpoint),
      events = []
    device.onEvent((event) => events.push(event))
    const ui = async (expression) => {
      const r = await preview.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        30000,
      )
      assert.equal(r.exceptionDetails, undefined, JSON.stringify(r))
      return r.result.value
    }
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await ui(expression)) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw Error('Preview update timed out: ' + expression)
    }
    try {
      await preview.send('Page.reload')
      await wait(`!!document.querySelector('#mode')`)
      await ui(
        `document.querySelector('#mode').value='dom';document.querySelector('#mode').dispatchEvent(new Event('change'))`,
      )
      await wait(`document.querySelectorAll('.native').length>0`)
      await device.send('DOM.getDocument', { depth: -1 })
      const id = (await device.send('DOM.querySelector', { nodeId: 1, selector })).nodeId
      await device.send('DOM.setInspectedNode', { nodeId: id })
      await wait(`document.querySelector('#highlight').style.display==='block'`)
      await ui(
        `document.querySelector('#mode').value='screen';document.querySelector('#mode').dispatchEvent(new Event('change'))`,
      )
      await wait(
        `document.querySelector('#picture').naturalWidth>0&&!document.querySelector('#picture').hidden`,
      )
      await device.send('Debugger.enable')
      await device.send('Debugger.pause')
      for (let i = 0; i < 100 && !events.some((event) => event.method === 'Debugger.paused'); i++)
        await new Promise((resolve) => setTimeout(resolve, 50))
      assert.ok(events.some((event) => event.method === 'Debugger.paused'))
      await wait(`document.querySelector('#status').textContent.includes('Paused')`)
      const image = await ui(`document.querySelector('#picture').src`)
      await new Promise((resolve) => setTimeout(resolve, 2200))
      assert.equal(await ui(`document.querySelector('#picture').src`), image)
      await device.send('Debugger.resume')
      await wait(`document.querySelector('#status').textContent.includes('connected')`)
      const measured = await ui(
        `(async()=>{await new Promise(r=>setTimeout(r,1900));const start=performance.now();const r=await fetch('/preview/frame');const frame=await r.json();return {ms:Math.round(performance.now()-start),bytes:frame.data?.length}})()`,
      )
      assert.ok(measured.bytes > 0)
      console.log('Screenshot endpoint elapsed (capture may be shared with the preview):', measured)
    } finally {
      await device.send('Debugger.resume').catch(() => {})
      await device.send('Overlay.hideHighlight').catch(() => {})
      preview.close()
      device.close()
    }
  },
)
