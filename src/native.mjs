import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { chromeExecutable, portNumber } from './launch.mjs'
import path from 'node:path'
import { connectCDP } from './cdp.mjs'
import { acceptsOrigin } from './transport.mjs'
import { createMacSourceDebugger } from './lldb.mjs'
import {
  Changes,
  RECORDED_METHODS,
  loadOverridesFile,
  saveOverridesFile,
  serveChanges,
} from './changes.mjs'
import { bundledFrontend, frontendManifest, serveFrontend } from './frontend.mjs'
import { outerHTML } from './html.mjs'
import { compatResult } from './compat.mjs'

// A private line-delimited CDP connection for host-side features. Events on
// it are ignored; clients receive their own from their own connections.
export function nativeConnection(port) {
  const socket = net.connect({ host: '127.0.0.1', port })
  const pending = new Map()
  let sequence = 0
  let input = ''
  let failure = null
  const fail = (error) => {
    failure ||= error
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(failure)
    }
    pending.clear()
  }
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    input += chunk
    let newline
    while ((newline = input.indexOf('\n')) >= 0) {
      const message = JSON.parse(input.slice(0, newline))
      input = input.slice(newline + 1)
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    }
  })
  socket.on('error', (error) => fail(error))
  socket.on('close', () => fail(new Error('Native debugger disconnected')))
  return {
    call(method, params = {}) {
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Native request timed out: ' + method))
        }, 10000)
        pending.set(id, { resolve, reject, timer })
        socket.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    close() {
      socket.destroy()
    },
  }
}

export async function createNativeRelay({
  nativePort,
  debugPort = 9222,
  title = 'Gea native app',
  debuggerState,
  frontend: manifest,
}) {
  nativePort = portNumber(nativePort, 'native port')
  debugPort = portNumber(debugPort, '--debug-port')
  if (manifest === undefined) manifest = await frontendManifest().catch(() => null)
  const host = `127.0.0.1:${debugPort}`
  const endpoint = `ws://${host}/devtools/page/gea`
  // The bundled frontend adds Gea Changes and zoom. Chrome's own frontend
  // remains the fallback; inspector.html would replace protocol hover.
  const frontend = manifest
    ? `http://${host}/devtools/devtools_app.html?ws=${host}/devtools/page/gea`
    : `devtools://devtools/bundled/devtools_app.html?ws=${host}/devtools/page/gea`
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
  let connection
  const backend = {
    call(method, params) {
      if (debuggerState?.paused)
        return Promise.reject(new Error('The native app is paused. Resume before editing the tree and styles.'))
      connection ||= nativeConnection(nativePort)
      return connection.call(method, params).catch((error) => {
        connection?.close()
        connection = null
        throw error
      })
    },
    broadcast(method, params) {
      for (const client of websocket.clients)
        if (client.readyState === 1) client.send(JSON.stringify({ method, params }))
    },
  }
  const changes = new Changes(backend, { app: title })
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (
      ![host, `localhost:${debugPort}`].includes(request.headers.host) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !acceptsOrigin(request.headers.origin, debugPort))
    ) {
      response.statusCode = 403
      response.end('Local debugger access only')
      return
    }
    try {
      if (await serveChanges(request, response, changes)) return
      if (request.method === 'GET' && (await serveFrontend(request, response, manifest))) return
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ error: error.message }))
      return
    }
    const route = request.url?.split('?')[0]
    response.setHeader('Content-Type', 'application/json')
    if (route === '/json' || route === '/json/list')
      response.end(JSON.stringify([target]))
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
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  })
  server.on('upgrade', (request, socket, head) => {
    if (
      request.url !== '/devtools/page/gea' ||
      !acceptsOrigin(request.headers.origin, debugPort)
    ) {
      socket.destroy()
      return
    }
    websocket.handleUpgrade(request, socket, head, (client) =>
      websocket.emit('connection', client),
    )
  })
  websocket.on('connection', (client) => {
    const native = net.connect({ host: '127.0.0.1', port: nativePort })
    sockets.add(native)
    let input = ''
    let queued = []
    let connected = false
    const pending = new Map()
    const waiting = new Map()
    const cached = new Map()
    let cachedBytes = 0
    // Requests reach the native connection in arrival order, including ones
    // that wait while the edit history captures prior state.
    let order = Promise.resolve()
    const emit = (method, params) => {
      if (client.readyState === 1)
        client.send(JSON.stringify({ method, params }))
    }
    native.on('connect', () => {
      connected = true
      for (const message of queued) native.write(message)
      queued = []
    })
    const write = (request) => {
      const message = JSON.stringify(request) + '\n'
      if (connected) {
        if (native.writableLength > 1024 * 1024) {
          client.close(1009, 'Native request queue exceeded')
          return
        }
        native.write(message)
      } else {
        queued.push(message)
        if (queued.length > 64)
          client.close(1009, 'Native connection queue exceeded')
      }
    }
    // Forward a request and resolve with its native response.
    const exchange = (request) =>
      new Promise((resolve, reject) => {
        waiting.set(request.id, (response) =>
          response.error ? reject(new Error(response.error.message)) : resolve(response.result),
        )
        write(request)
      })
    const reply = (id, result, error) => {
      if (client.readyState === 1)
        client.send(
          JSON.stringify(
            error
              ? { id, error: { code: -32000, message: error.message } }
              : { id, result },
          ),
        )
    }
    const local = async (request, action) => {
      try {
        reply(request.id, await action())
      } catch (error) {
        reply(request.id, null, error)
      }
    }
    const route = (request) => {
      const { id, method, params = {} } = request
      if (
        debuggerState &&
        (method.startsWith('Debugger.') ||
          (method === 'Runtime.getProperties' &&
            /^lldb-(scope|value)-/.test(params.objectId)))
      )
        return void local(request, () => debuggerState.handle(client, emit, method, params))
      const compat = compatResult(method)
      if (compat) return void reply(id, compat)
      if (method.startsWith('Gea.'))
        return void local(request, () => changes.command(method.slice(4), params))
      if (method === 'DOM.undo' || method === 'DOM.redo')
        return void local(request, async () => {
          await changes[method === 'DOM.undo' ? 'undo' : 'redo']()
          return {}
        })
      const key = JSON.stringify([method, params])
      if (debuggerState?.paused) {
        if (cached.has(key)) reply(id, cached.get(key).result)
        else if (method.endsWith('.enable') || method.endsWith('.disable')) reply(id, {})
        else
          reply(
            id,
            null,
            new Error(
              'The native app is paused. Resume before reading new UI state or editing the tree and styles.',
            ),
          )
        return
      }
      if (method === 'DOM.getOuterHTML')
        return void local(request, async () => ({
          outerHTML: outerHTML(
            (await backend.call('DOM.describeNode', {
              ...(params.nodeId ? { nodeId: params.nodeId } : {}),
              ...(params.backendNodeId ? { backendNodeId: params.backendNodeId } : {}),
              depth: -1,
            })).node,
          ),
        }))
      if (method === 'DOMDebugger.getEventListeners')
        return void local(request, async () =>
          listenerLocations(await exchange(request), debuggerState),
        )
      if (RECORDED_METHODS.has(method)) {
        let forwarded
        const written = new Promise((resolve) => {
          forwarded = resolve
        })
        const recorded = changes.record(method, params, () => {
          const result = exchange(request)
          forwarded()
          return result
        })
        recorded.then(
          (result) => reply(id, result),
          (error) => reply(id, null, error),
        )
        return Promise.race([written, recorded.catch(() => {})])
      }
      if (/^(DOM|CSS|Page)\.(get|describe|query|capture)/.test(method))
        pending.set(id, key)
      write(request)
    }
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
      order = order.then(() => route(request)).catch(() => {})
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
        let response
        try {
          response = JSON.parse(message)
          const key = pending.get(response.id)
          if (key) {
            pending.delete(response.id)
            if (response.result) {
              const bytes = Buffer.byteLength(JSON.stringify(response.result))
              if (cached.has(key)) {
                cachedBytes -= cached.get(key).bytes
                cached.delete(key)
              }
              while (
                cached.size &&
                (cached.size >= 128 || cachedBytes + bytes > 16 * 1024 * 1024)
              ) {
                const oldest = cached.keys().next().value
                cachedBytes -= cached.get(oldest).bytes
                cached.delete(oldest)
              }
              if (bytes <= 16 * 1024 * 1024) {
                cached.set(key, { result: response.result, bytes })
                cachedBytes += bytes
              }
            }
          }
        } catch {
          client.close(1011, 'Invalid native response')
          return
        }
        if (response.id !== undefined && waiting.has(response.id)) {
          const resolve = waiting.get(response.id)
          waiting.delete(response.id)
          resolve(response)
          continue
        }
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
      for (const resolve of waiting.values())
        resolve({ error: { message: 'Native app disconnected' } })
      waiting.clear()
      client.close(1001, 'Native app disconnected')
    })
    client.on('close', () => {
      native.destroy()
      debuggerState?.detach(client)?.catch(() => {})
    })
    client.on('error', () => native.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(debugPort, '127.0.0.1', resolve)
  })
  return {
    endpoint,
    frontend,
    changes,
    async close() {
      for (const client of websocket.clients) client.terminate()
      for (const socket of sockets) socket.destroy()
      connection?.close()
      websocket.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// Native listener records carry the address of the code that registered
// them. LLDB maps it to the original source; without LLDB they remain
// metadata with no source link.
async function listenerLocations(result, debuggerState) {
  const listeners = result?.listeners || []
  const addresses = listeners.flatMap((listener) => listener.nativeAddresses || [])
  const locations =
    debuggerState?.handlerLocations && addresses.length
      ? await debuggerState.handlerLocations(addresses).catch(() => ({}))
      : {}
  return {
    listeners: listeners.map(({ nativeAddresses = [], ...listener }) => {
      // Registration passes through runtime helpers; prefer the first caller
      // in the app's own mapped source.
      const resolved = nativeAddresses.map((address) => locations[address]).filter(Boolean)
      const found = resolved.find((location) => location.scriptId === 'native-app') || resolved[0]
      if (!found) return listener
      const { functionName, ...location } = found
      // Generated C++ names say nothing once the site maps to app source.
      const handler = functionName && location.scriptId !== 'native-app'
        ? { ...listener.handler, description: `${listener.handler.description} · ${functionName}` }
        : listener.handler
      return { ...listener, ...location, handler, originalHandler: handler }
    }),
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
  nativeDebug,
  overrides,
  saveOverrides,
}) {
  debugPort = portNumber(debugPort, '--debug-port')
  // Chrome is just the frontend; the native app owns the inspected tree.
  const chrome = open ? chromeExecutable(env) : null
  const frontend = await bundledFrontend({ env, stdout })
  const children = []
  const finished = []
  let stopping = false
  let relay
  let debuggerState
  let stopped
  const interrupted = new Promise((resolve) => {
    stopped = resolve
  })
  const stop = () => {
    stopping = true
    stopped(1)
  }
  const terminateChildren = () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM')
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
      detached: Boolean(nativeDebug),
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
    const nativePort = await Promise.race([ready, interrupted])
    if (stopping) return 1
    if (nativeDebug)
      debuggerState = await createMacSourceDebugger({
        executable,
        pid: app.child.pid,
        metadata: nativeDebug.metadata,
        env,
      })
    relay = await createNativeRelay({
      nativePort,
      debugPort,
      title,
      debuggerState,
      frontend,
    })
    if (overrides) await loadOverridesFile(relay.changes, overrides, stdout)
    stdout(`Native Gea CDP: ${relay.endpoint}`)
    stdout(`Discovery: http://127.0.0.1:${debugPort}/json/list`)
    stdout(
      'Console scripts run in the native inspector context. document, $0 and getComputedStyle access the actual retained tree.',
    )
    if (debuggerState)
      stdout(
        'Native Sources: original TypeScript, breakpoints and Step Over/Into/Out through LLDB.',
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
    return await Promise.race([
      ...finished,
      interrupted,
      ...(debuggerState ? [debuggerState.ended] : []),
    ])
  } finally {
    if (relay && saveOverrides)
      await saveOverridesFile(relay.changes, saveOverrides, stdout).catch((error) =>
        stdout(`Cannot save overrides: ${error.message}`),
      )
    if (relay) await relay.close()
    if (debuggerState) await debuggerState.close()
    // macOS debugserver reparents an attached process. Detach before terminating
    // it so the original parent can observe its exit and reap it normally.
    terminateChildren()
    let timer
    await Promise.race([
      Promise.allSettled(finished),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000)
      }),
    ])
    clearTimeout(timer)
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    await Promise.race([
      Promise.allSettled(finished),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1000)
      }),
    ])
    clearTimeout(timer)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

