import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function portNumber(value, name) {
  if (typeof value === 'boolean' || String(value).trim() === '')
    throw new Error(`${name} requires a port number.`)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be an integer between 1 and 65535.`)
  return port
}

export function chromeExecutable(env = process.env, platform = process.platform) {
  if (env.GEA_CHROME_PATH) {
    if (!existsSync(env.GEA_CHROME_PATH))
      throw new Error(`Chrome executable not found: ${env.GEA_CHROME_PATH}`)
    return env.GEA_CHROME_PATH
  }
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : platform === 'win32'
        ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
            .filter(Boolean)
            .map((root) => path.join(root, 'Google/Chrome/Application/chrome.exe'))
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]
  const executable = candidates.find(existsSync)
  if (!executable)
    throw new Error('Chrome not found. Set GEA_CHROME_PATH to the Chrome or Chromium executable.')
  return executable
}

export function chromeArgs({ appRoot, url, debugPort = 9222, headless = false }) {
  const args = [
    `--remote-debugging-port=${portNumber(debugPort, '--debug-port')}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${path.join(appRoot, '.gea/build/web/chrome-debug-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : ['--auto-open-devtools-for-tabs']),
    url,
  ]
  return args
}

export async function waitFor(url, { timeout = 30000, alive = () => true } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!alive()) throw new Error(`Process exited before ${url} became available.`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return response
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

// Own both processes so Ctrl-C, Chrome exit and dev-server failure release the
// session. No app source, manifest or target declarations are rewritten.
export async function launchDebugger({
  appRoot,
  script,
  env = process.env,
  port = 5181,
  debugPort = 9222,
  stdout = console.log,
  headless = false,
}) {
  port = portNumber(port, '--port')
  debugPort = portNumber(debugPort, '--debug-port')
  if (port === debugPort) throw new Error('--port and --debug-port must differ.')
  const chrome = chromeExecutable(env)
  for (const endpoint of [
    `http://127.0.0.1:${port}/`,
    `http://127.0.0.1:${debugPort}/json/version`,
  ]) {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(500) })
    } catch {
      continue
    }
    throw new Error(`Debug session port already in use: ${endpoint}`)
  }
  const children = []
  const completions = []
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  }
  const interrupted = () => stop()
  process.on('SIGINT', interrupted)
  process.on('SIGTERM', interrupted)
  const start = (command, args) => {
    const child = spawn(command, args, { cwd: appRoot, env, stdio: 'inherit' })
    children.push(child)
    let running = true
    const done = new Promise((resolve) => {
      child.once('error', (error) => {
        running = false
        stdout(error.message)
        resolve(1)
      })
      child.once('exit', (code) => {
        running = false
        resolve(code ?? 1)
      })
    })
    completions.push(done)
    return { child, done, alive: () => running }
  }
  try {
    const server = start(process.execPath, [
      script,
      '--app-dir',
      appRoot,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
    ])
    const url = `http://127.0.0.1:${port}/`
    await waitFor(url, { alive: () => !stopping && server.alive() })
    const browser = start(chrome, chromeArgs({ appRoot, url, debugPort, headless }))
    await waitFor(`http://127.0.0.1:${debugPort}/json/version`, {
      alive: () => !stopping && browser.alive() && server.alive(),
    })
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    const target = targets.find((target) => target.type === 'page' && target.url.startsWith(url))
    if (!target) throw new Error('Chrome did not expose the Gea app target.')
    stdout(`Gea debugger: ${url}`)
    stdout(`CDP: ${target.webSocketDebuggerUrl}`)
    stdout(`Discovery: http://127.0.0.1:${debugPort}/json/list`)
    stdout(
      'Chrome DevTools Elements shows the live DOM and CSS. Edits apply immediately; source edits use Vite HMR.',
    )
    return await Promise.race([server.done, browser.done])
  } finally {
    stop()
    let timer
    await Promise.race([
      Promise.all(completions),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000)
      }),
    ])
    clearTimeout(timer)
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(completions)
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
}
