import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function preview() {
  const elements = new Map(), requests = []
  for (const id of ['mode', 'screen', 'picture', 'mirror', 'highlight', 'status', 'note'])
    elements.set('#' + id, {
      value: 'dom', style: {}, listeners: new Map(), clientWidth: 410, clientHeight: 502,
      addEventListener(name, handler) { this.listeners.set(name, handler) },
      getBoundingClientRect() { return { left: 20, top: 30, width: 820, height: 1004 } },
    })
  const document = {
    querySelector: selector => elements.get(selector),
    addEventListener(name, handler) { this[name] = handler },
  }
  const context = vm.createContext({
    document,
    localStorage: { getItem() { return 'dom' }, setItem() {} },
    setTimeout() {}, // Only the initial poll runs; no hardware or browser needed.
    fetch(url, options) {
      if (url === '/preview/snapshot') return Promise.resolve({
        ok: true, json: async () => ({ nodes: [], width: 410, height: 502, inspectToken: 123 }),
      })
      assert.equal(url, '/preview/inspect')
      return new Promise(resolve => requests.push({
        body: JSON.parse(options.body),
        finish: () => resolve({ ok: true }),
      }))
    },
  })
  vm.runInContext(readFileSync(new URL('../src/device-preview.mjs', import.meta.url), 'utf8'), context)
  const event = { clientX: 50, clientY: 60, preventDefault() {} }
  return { context, document, elements, requests, event }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('preview scales native coordinates and coalesces hover without losing the selection click', async () => {
  const p = preview()
  await flush()
  const screen = p.elements.get('#screen')
  screen.listeners.get('pointermove')(p.event)
  for (let i = 0; i < 100; i++) screen.listeners.get('pointermove')({ ...p.event, clientX: i + 50 })
  screen.listeners.get('click')({ ...p.event, clientX: 100, clientY: 110 })
  screen.listeners.get('pointermove')(p.event)
  screen.listeners.get('pointerleave')()
  assert.equal(p.requests.length, 1, 'USB has one request in flight')
  assert.deepEqual(p.requests[0].body, { token: 123, mode: 'hover', x: 15, y: 15 })
  p.requests[0].finish()
  await flush()
  assert.equal(p.requests.length, 2)
  assert.deepEqual(p.requests[1].body, { token: 123, mode: 'select', x: 40, y: 40 })
  p.requests[1].finish()
  await flush()
  screen.listeners.get('click')(p.event)
  assert.equal(p.requests.length, 2, 'ordinary preview clicks never activate the app')
})

test('Escape supersedes pending preview hover and stale-token requests are discarded', async () => {
  const p = preview()
  await flush()
  const screen = p.elements.get('#screen')
  screen.listeners.get('pointermove')(p.event)
  screen.listeners.get('pointermove')({ ...p.event, clientX: 100 })
  p.document.keydown({ key: 'Escape', preventDefault() {} })
  p.requests[0].finish()
  await flush()
  assert.deepEqual(p.requests[1].body, { token: 123, mode: 'cancel' })
  p.requests[1].finish()
  await flush()
  screen.listeners.get('pointermove')(p.event)
  assert.equal(p.requests.length, 2)
})
