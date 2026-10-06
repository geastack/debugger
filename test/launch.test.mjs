import test from 'node:test'
import assert from 'node:assert/strict'
import { chromeArgs, portNumber, waitFor } from '../src/launch.mjs'
import { createServer } from 'node:http'

test('Chrome uses an isolated app build profile and local CDP endpoint', () => {
  const args = chromeArgs({ appRoot: '/apps/demo', url: 'http://127.0.0.1:5181/', debugPort: 9230 })
  assert.ok(args.includes('--remote-debugging-port=9230'))
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'))
  assert.ok(args.includes('--user-data-dir=/apps/demo/.gea/build/web/chrome-debug-profile'))
  assert.ok(args.includes('--auto-open-devtools-for-tabs'))
})

test('ports reject malformed, fractional and out of range values', () => {
  for (const value of [true, '', 0, -1, 65536, 'x', 12.5])
    assert.throws(() => portNumber(value, 'port'))
  assert.equal(portNumber('9222', 'port'), 9222)
})

test('readiness checks HTTP status and detects process exit', async () => {
  const server = createServer((req, res) => res.end('ready'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    assert.equal((await waitFor(url)).status, 200)
    await assert.rejects(waitFor(url, { alive: () => false }), /Process exited/)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('browser origins are limited to DevTools and the loopback relay', async () => {
  const { acceptsOrigin } = await import('../src/transport.mjs')
  for (const origin of [
    undefined,
    'devtools://devtools',
    'http://127.0.0.1:9222',
    'http://localhost:9222',
  ])
    assert.equal(acceptsOrigin(origin, 9222), true)
  for (const origin of [
    'https://example.com',
    'null',
    'http://127.0.0.1:1234',
    'http://127.0.0.1:9222.example.com',
  ])
    assert.equal(acceptsOrigin(origin, 9222), false)
})
