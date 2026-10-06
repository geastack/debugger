import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { chromeExecutable, portNumber } from './launch.mjs'
import path from 'node:path'
import { connectCDP } from './cdp.mjs'
import { acceptsOrigin } from './transport.mjs'

export async function createNativeRelay({
  nativePort,
  debugPort = 9222,
  title = 'Gea native app',
}) {
  nativePort = portNumber(nativePort, 'native port')
  debugPort = portNumber(debugPort, '--debug-port')
  const host = `127.0.0.1:${debugPort}`
  const endpoint = `ws://${host}/devtools/page/gea`
  // inspector.html replaces protocol hover with a local screencast painter.
  const frontend = `devtools://devtools/bundled/devtools_app.html?ws=${host}/devtools/page/gea`
  const target = {
    id: 'gea',
    type: 'page',
    title,
    url: 'gea://native/',
    description: 'Native Gea retained tree',
    webSocketDebuggerUrl: endpoint,
    devtoolsFrontendUrl: frontend,
  }
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    const route = request.url?.split('?')[0]
    response.setHeader('Content-Type', 'application/json')
    if (route === '/json' || route === '/json/list') response.end(JSON.stringify([target]))
    else if (route === '/json/version')
      response.end(
        JSON.stringify({
          Browser: 'Gea/native-macos',
          'Protocol-Version': '1.3',
          'User-Agent': 'Gea',
          'V8-Version': 'JavaScriptCore inspector',
          webSocketDebuggerUrl: endpoint,
        }),
      )
    else {
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'Unknown debugger endpoint' }))
    }
  })
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/devtools/page/gea' || !acceptsOrigin(request.headers.origin, debugPort)) {
      socket.destroy()
      return
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit('connection', client))
  })
  websocket.on('connection', (client) => {
    const native = net.connect({ host: '127.0.0.1', port: nativePort })
    sockets.add(native)
    let input = ''
    let queued = []
    let connected = false
    native.on('connect', () => {
      connected = true
      for (const message of queued) native.write(message)
      queued = []
    })
    client.on('message', (data, binary) => {
      if (binary) {
        client.close(1003, 'CDP requires JSON text')
        return
      }
      let request
      try {
        request = JSON.parse(data.toString())
      } catch {
        client.close(1007, 'Invalid JSON')
        return
      }
      if (!Number.isInteger(request.id) || typeof request.method !== 'string') {
        client.close(1007, 'Invalid CDP request')
        return
      }
      const message = JSON.stringify(request) + '\n'
      if (connected) {
        if (native.writableLength > 1024 * 1024) {
          client.close(1009, 'Native request queue exceeded')
          return
        }
        native.write(message)
      } else {
        queued.push(message)
        if (queued.length > 64) client.close(1009, 'Native connection queue exceeded')
      }
    })
    native.setEncoding('utf8')
    native.on('data', (data) => {
      input += data
      if (input.length > 16 * 1024 * 1024) {
        client.close(1009, 'Native response exceeded')
        native.destroy()
        return
      }
      let newline
      while ((newline = input.indexOf('\n')) !== -1) {
        const message = input.slice(0, newline)
        input = input.slice(newline + 1)
        if (client.readyState === 1) {
          if (client.bufferedAmount > 16 * 1024 * 1024) {
            client.close(1009, 'Client response queue exceeded')
            native.destroy()
            return
          }
          client.send(message)
        }
      }
    })
    native.on('error', () => client.close(1011, 'Native debugger disconnected'))
    native.on('close', () => {
      sockets.delete(native)
      client.close(1001, 'Native app disconnected')
    })
    client.on('close', () => native.destroy())
    client.on('error', () => native.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(debugPort, '127.0.0.1', resolve)
  })
  return {
    endpoint,
    frontend,
    async close() {
      for (const client of websocket.clients) client.terminate()
      for (const socket of sockets) socket.destroy()
      websocket.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export async function launchNativeDebugger({
  executable,
  appRoot,
  title,
  env = process.env,
  debugPort = 9222,
  stdout = console.log,
  open = true,
}) {
  debugPort = portNumber(debugPort, '--debug-port')
  // Chrome is just the frontend; the native app owns the inspected tree.
  const chrome = open ? chromeExecutable(env) : null
  const children = []
  const finished = []
  let stopping = false
  let relay
  const stop = () => {
    stopping = true
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const start = (command, args, options) => {
    const child = spawn(command, args, options)
    children.push(child)
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    // Keep startup failures observed while awaiting the native ready line.
    done.catch(() => {})
    finished.push(done)
    return { child, done }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const app = start(executable, [], {
      cwd: appRoot,
      env: { ...env, GEA_DEBUGGER_NATIVE_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const ready = new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              'Native app did not start its debugger within 30 seconds. Rebuild with GEA_NATIVE_DEBUGGER=1.',
            ),
          ),
        30000,
      )
      app.child.stdout.setEncoding('utf8')
      app.child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk)
        buffer += chunk
        const match = /GEA_DEBUGGER_READY=(\d+)/.exec(buffer)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
        if (buffer.length > 65536) buffer = buffer.slice(-65536)
      })
      app.done.then(
        () => {
          clearTimeout(timer)
          reject(new Error('Native app exited before the debugger was ready.'))
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    const nativePort = await ready
    if (stopping) return 1
    relay = await createNativeRelay({ nativePort, debugPort, title })
    stdout(`Native Gea CDP: ${relay.endpoint}`)
    stdout(`Discovery: http://127.0.0.1:${debugPort}/json/list`)
    stdout(
      'Console scripts run in the native inspector context. document, $0 and getComputedStyle access the actual retained tree.',
    )
    if (open) {
      // Chrome ignores devtools:// URLs on its startup command line. Open the
      // inspector via Chrome's protocol after starting a dedicated window.
      const browser = start(
        chrome,
        [
          `--user-data-dir=${path.join(appRoot, '.gea/build/web/chrome-debug-profile')}`,
          '--remote-debugging-port=0',
          '--remote-debugging-address=127.0.0.1',
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ],
        { cwd: appRoot, env, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      const browserEndpoint = await new Promise((resolve, reject) => {
        let text = ''
        const timer = setTimeout(
          () => reject(new Error('Chrome frontend startup timed out.')),
          15000,
        )
        browser.child.stderr.on('data', (chunk) => {
          text += chunk.toString()
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
          if (match) {
            clearTimeout(timer)
            resolve(match[1])
          }
          if (text.length > 65536) text = text.slice(-65536)
        })
        browser.done.then(
          () => {
            clearTimeout(timer)
            reject(new Error('Chrome exited before its frontend was ready.'))
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
      const connection = await connectCDP(browserEndpoint)
      try {
        await connection.send('Target.createTarget', { url: relay.frontend })
      } finally {
        connection.close()
      }
    }
    return await Promise.race(finished)
  } finally {
    stop()
    if (relay) await relay.close()
    let timer
    await Promise.race([
      Promise.allSettled(finished),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000)
      }),
    ])
    clearTimeout(timer)
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.allSettled(finished)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
