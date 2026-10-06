import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { chromeExecutable, chromeArgs, waitFor } from '../src/launch.mjs'
import { connectCDP } from '../src/cdp.mjs'

const selector = process.env.GEA_DEBUGGER_TEST_SELECTOR
const endpoint = process.env.GEA_DEBUGGER_FRONTEND_TEST_ENDPOINT
const appRoot = process.env.GEA_DEBUGGER_FRONTEND_TEST_APP
const consoleName = process.env.GEA_DEBUGGER_FRONTEND_TEST_CONSOLE || 'Gea native inspector'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const visibleText = `(()=>{let out=[];function walk(n){if(n.nodeType===1&&['STYLE','SCRIPT'].includes(n.tagName))return;if(n.nodeType===3&&n.textContent.trim())out.push(n.textContent.trim());if(n.shadowRoot)walk(n.shadowRoot);for(let c of n.childNodes||[])walk(c)}walk(document.body);return out.join(' ')})()`

test(
  'real Chrome DevTools frontend displays native tree/CSS and evaluates console scripts',
  { skip: !endpoint || !appRoot || !selector, timeout: 45000 },
  async () => {
    const url = new URL(endpoint)
    const frontend = `devtools://devtools/bundled/inspector.html?ws=${url.host}${url.pathname}`
    const browser = spawn(
      chromeExecutable(),
      chromeArgs({ appRoot, url: 'about:blank', debugPort: 15986, headless: true }),
      { stdio: 'ignore' },
    )
    let cdp
    try {
      await waitFor('http://127.0.0.1:15986/json/version', {
        alive: () => browser.exitCode === null,
      })
      const version = await (await fetch('http://127.0.0.1:15986/json/version')).json()
      const connection = await connectCDP(version.webSocketDebuggerUrl)
      try {
        await connection.send('Target.createTarget', { url: frontend })
      } finally {
        connection.close()
      }
      let target
      for (let i = 0; i < 100; i++) {
        const targets = await (await fetch('http://127.0.0.1:15986/json/list')).json()
        target = targets.find((t) => t.url === frontend)
        if (target) break
        await delay(100)
      }
      assert.ok(target, 'Chrome opened its actual DevTools frontend')
      cdp = await connectCDP(target.webSocketDebuggerUrl)
      const evaluate = async (expression) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        assert.equal(result.exceptionDetails, undefined, JSON.stringify(result))
        return result.result.value
      }
      let text
      for (let i = 0; i < 100; i++) {
        text = await evaluate(visibleText)
        if (text.includes('app')) break
        await delay(100)
      }
      assert.match(text, /Elements/)
      assert.match(text, /app/)
      // Use the frontend's own DOM model to select a loaded native node, just as
      // an Elements tree click does; assertions inspect rendered frontend UI.
      const selected = await evaluate(`(async()=>{
      const SDK = await import('./core/sdk/sdk.js');
      const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget();
      const model = target.model(SDK.DOMModel.DOMModel);
      const doc = await model.requestDocument();
      await doc.documentElement.getSubtree(-1, true);
      const id = await model.querySelector(doc.id, ${JSON.stringify(selector)});
      UI.panels.elements.selectDOMNode(model.nodeForId(id), false);
      return id;
    })()`)
      assert.ok(selected)
      for (let i = 0; i < 100; i++) {
        text = await evaluate(visibleText)
        if (/font-size|color/.test(text)) break
        await delay(100)
      }
      assert.ok(selected)
      assert.match(text, /font-size|color/)
      const edited = await evaluate(`(async()=>{
      const SDK = await import('./core/sdk/sdk.js');
      const target = SDK.TargetManager.TargetManager.instance().primaryPageTarget();
      const model = target.model(SDK.DOMModel.DOMModel);
      const css = target.model(SDK.CSSModel.CSSModel);
      const styles = await css.getInlineStyles(${selected});
      await styles.inlineStyle.appendProperty('background-color', 'rgb(255, 0, 255)');
      await new Promise(resolve => setTimeout(resolve, 200));
      const computed = await css.getComputedStyle(${selected});
      return computed.get('background-color');
    })()`)
      assert.equal(
        edited,
        'rgb(255, 0, 255)',
        'DevTools style editor changed the actual native style',
      )
      if (!(await evaluate(visibleText)).includes(consoleName)) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        })
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        })
      }
      await delay(300)
      assert.ok((await evaluate(visibleText)).includes(consoleName))
      const focused = await evaluate(`(()=>{
      function find(root){const p=root.querySelector('[aria-label="Console prompt"]');if(p)return p;for(const e of root.querySelectorAll('*'))if(e.shadowRoot){const p=find(e.shadowRoot);if(p)return p;}}
      const prompt=find(document);if(!prompt)return false;prompt.focus();return true;
    })()`)
      assert.ok(focused, 'native console prompt is available')
      await cdp.send('Input.insertText', { text: '6 * 7' })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      for (let i = 0; i < 100; i++) {
        text = await evaluate(visibleText)
        if (/42/.test(text)) break
        await delay(100)
      }
      assert.match(text, /42/)
      console.log('Chrome frontend: native Elements, CSS and console 6 * 7 = 42')
      if (process.env.GEA_DEBUGGER_FRONTEND_TEST_SCREENSHOT) {
        const { data } = await cdp.send('Page.captureScreenshot')
        await writeFile(
          process.env.GEA_DEBUGGER_FRONTEND_TEST_SCREENSHOT,
          Buffer.from(data, 'base64'),
        )
      }
    } finally {
      cdp?.close()
      if (browser.exitCode === null && browser.signalCode === null) {
        browser.kill('SIGTERM')
        await new Promise((resolve) => browser.once('exit', resolve))
      }
    }
  },
)
