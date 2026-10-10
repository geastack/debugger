// Pinned DevTools frontend served by the relays from loopback. The built-in
// devtools:// frontend cannot load the Gea panels or the hosted zoom patch.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const frontendRoot = fileURLToPath(new URL('../.build/devtools/', import.meta.url))

// Package modules the bundled panels import, served from source so they stay
// in step with the relay that answers their commands.
const sources = {
  'gea/panels.js': new URL('../frontend/gea-panels.mjs', import.meta.url),
  'gea/css.js': new URL('./css.mjs', import.meta.url),
}

export async function frontendManifest() {
  const pin = JSON.parse(await readFile(new URL('../frontend/pin.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(await readFile(path.join(frontendRoot, 'build.json'), 'utf8'))
  if (
    manifest.revision !== pin.revision ||
    manifest.patchVersion !== pin.patchVersion ||
    !manifest.files['devtools_app.html']
  )
    throw new Error('Pinned DevTools assets are stale; run npm run build:frontend')
  return manifest
}

// Build on first use from a source checkout. Packed releases ship the assets.
export async function ensureFrontend({ stdout = console.log } = {}) {
  try {
    return await frontendManifest()
  } catch {}
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../frontend/build.mjs', import.meta.url))],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let errors = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) stdout(line)
    })
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-4000)
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('Pinned DevTools build failed: ' + (errors.trim().split('\n').at(-1) || code))),
    )
  })
  return frontendManifest()
}

// Build the pinned frontend on first use. Without it, Chrome's own frontend
// still inspects the app; the Gea Changes panel and zoom are unavailable.
export async function bundledFrontend({ env = process.env, stdout = console.log } = {}) {
  if (env.GEA_DEBUGGER_FRONTEND === 'builtin') return null
  try {
    return await ensureFrontend({ stdout })
  } catch (error) {
    stdout(`Bundled DevTools unavailable (${error.message}); opening Chrome's built-in frontend without Gea Changes.`)
    return null
  }
}

const mime = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain;charset=utf-8',
}

export async function serveFrontend(req, res, manifest) {
  const pathname = req.url.split('?')[0]
  if (!pathname.startsWith('/devtools/')) return false
  if (!manifest) {
    res.statusCode = 404
    res.end('Bundled DevTools is not built')
    return true
  }
  let file
  try {
    file = decodeURIComponent(pathname.slice('/devtools/'.length))
  } catch {
    res.statusCode = 400
    res.end('Invalid asset path')
    return true
  }
  if (file.startsWith('/') || file.includes('\\') || file.split('/').some((p) => p === '..' || p === '.')) {
    res.statusCode = 403
    res.end('Invalid asset path')
    return true
  }
  if (!file) file = 'devtools_app.html'
  const source = Object.hasOwn(sources, file) ? sources[file] : null
  if (!source && !Object.hasOwn(manifest.files, file)) {
    res.statusCode = 404
    res.end('Unknown bundled DevTools asset')
    return true
  }
  const data = await readFile(source || path.join(frontendRoot, file))
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(data)
  return true
}
