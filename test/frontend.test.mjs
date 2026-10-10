import test from 'node:test'
import assert from 'node:assert/strict'
import { patchFrontend, sha256 } from '../frontend/patches.mjs'
import { installHostedZoom } from '../frontend/hosted-zoom.mjs'
import { serveFrontend } from '../src/frontend.mjs'

test('frontend patches apply only to the reviewed upstream bytes', () => {
  const app = Buffer.from('export const app = 1\n')
  const host = Buffer.from('export const host = 1\n')
  const pin = {
    patches: { 'entrypoints/devtools_app/devtools_app.js': sha256(app), 'core/host/host.js': sha256(host) },
  }
  assert.equal(
    patchFrontend('entrypoints/devtools_app/devtools_app.js', app, pin).toString(),
    'import "../../gea/panels.js";\n' + app,
  )
  assert.equal(patchFrontend('ui/legacy/legacy.js', app, pin), app)
  assert.throws(
    () => patchFrontend('entrypoints/devtools_app/devtools_app.js', Buffer.from('changed'), pin),
    /integrity mismatch/,
  )
  // Matching bytes whose patch site moved still fail closed.
  assert.throws(() => patchFrontend('core/host/host.js', host, pin), /patch no longer matches/)
})

test('hosted zoom steps, persists and resets through the host and shortcuts', () => {
  const listeners = []
  const storage = new Map([['gea-debugger-ui-zoom', '1.25']])
  let resized = 0
  const win = {
    document: { documentElement: { style: {} } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    addEventListener: (type, listener) => listeners.push(listener),
    dispatchEvent: () => resized++,
    Event: class {},
  }
  const host = { isHostedMode: () => true, platform: () => 'mac' }
  installHostedZoom(host, win)
  assert.equal(win.document.documentElement.style.zoom, '1.25')
  host.zoomIn()
  assert.equal(host.zoomFactor(), 1.5)
  assert.equal(storage.get('gea-debugger-ui-zoom'), '1.5')
  const key = (init) => {
    const event = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, code: '', ...init, preventDefault() { event.prevented = true }, stopImmediatePropagation() {} }
    listeners[0](event)
    return event
  }
  assert.equal(key({ key: '-' }).prevented, true)
  assert.equal(host.zoomFactor(), 1.25)
  key({ key: '0' })
  assert.equal(host.zoomFactor(), 1)
  assert.equal(key({ key: '=', metaKey: false, ctrlKey: true }).prevented, undefined)
  assert.equal(resized, 3)
  for (let i = 0; i < 20; i++) host.zoomOut()
  assert.equal(host.zoomFactor(), 0.5)
})

function serve(url, manifest) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = String(body)
    },
  }
  return serveFrontend({ url }, res, manifest).then((handled) => ({ handled, ...res }))
}

test('frontend assets are served only from the manifest and the package panels', async () => {
  const manifest = { files: {} }
  assert.equal((await serve('/json/list', manifest)).handled, false)
  assert.equal((await serve('/devtools/devtools_app.html', null)).statusCode, 404)
  assert.equal((await serve('/devtools/../package.json', manifest)).statusCode, 403)
  assert.equal((await serve('/devtools/a/%2e%2e/b.js', manifest)).statusCode, 403)
  assert.equal((await serve('/devtools/%E0%A4%A', manifest)).statusCode, 400)
  assert.equal((await serve('/devtools/unknown.js', manifest)).statusCode, 404)
  const panels = await serve('/devtools/gea/panels.js?v=1', manifest)
  assert.equal(panels.statusCode, 200)
  assert.equal(panels.headers['Content-Type'], 'text/javascript;charset=utf-8')
  assert.match(panels.body, /registerViewExtension/)
  assert.match((await serve('/devtools/gea/css.js', manifest)).body, /export function parseCssDeclarations/)
})
