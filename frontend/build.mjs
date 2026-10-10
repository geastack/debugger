// Downloads the pinned Chromium DevTools frontend once, applies the reviewed
// patches and adds the Gea panels. Relays serve the result from loopback.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { init, parse } from 'es-module-lexer'
import { patchFrontend, sha256 } from './patches.mjs'
import { frontendRoot as output } from '../src/frontend.mjs'

await init

const pin = JSON.parse(await readFile(new URL('./pin.json', import.meta.url), 'utf8'))
const base = 'https://chrome-devtools-frontend.appspot.com/serve_file/@' + pin.revision + '/'
const raw = 'https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/' + pin.revision + '/'
const manifest = { revision: pin.revision, patchVersion: pin.patchVersion, files: {} }
const pending = []
const scheduled = new Set()
const seeds = [
  'devtools_app.html',
  'application_tokens.css',
  'design_system_tokens.css',
  'core/i18n/locales/en-US.json',
  'core/i18n/locales/zh.json',
]

async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (response.ok) {
        const data = Buffer.from(await response.arrayBuffer())
        if (data.length > 12 * 1024 * 1024) throw new Error('DevTools asset exceeds limit: ' + url)
        return data
      }
      if (response.status < 500 || attempt === 2) throw new Error(response.status + ' downloading ' + url)
    } catch (error) {
      if (attempt === 2 || /^(?:404|403) /.test(error.message))
        throw new Error('Cannot download pinned DevTools asset ' + url + ': ' + error.message)
    }
  }
}

async function save(file, data) {
  if (file.startsWith('/') || file.includes('..') || file.includes('\\'))
    throw new Error('Invalid DevTools asset path: ' + file)
  await mkdir(path.dirname(path.join(output, file)), { recursive: true })
  await writeFile(path.join(output, file), data)
  manifest.files[file] = { sha256: sha256(data), bytes: data.length }
}

function enqueue(file) {
  if (scheduled.has(file)) return
  scheduled.add(file)
  pending.push(file)
}

function reference(file, relative) {
  if (relative === '*') throw new Error('Wildcard asset dependency in ' + file)
  if (!relative || relative.startsWith('#') || /^(data:|blob:|https?:|devtools:|node:)/.test(relative))
    return
  const url = new URL(relative, base + file)
  if (!url.href.startsWith(base)) throw new Error('DevTools dependency escapes its revision: ' + relative)
  const target = url.href.slice(base.length).split(/[?#]/)[0]
  if (target.includes('*')) throw new Error('Wildcard asset dependency in ' + file + ': ' + relative)
  if (!target || target.includes('${') || target.endsWith('.map')) return
  enqueue(target)
}

function dependencies(file, data) {
  const source = data.toString('utf8')
  if (file.endsWith('.js')) {
    for (const entry of parse(source, file)[0])
      if (
        entry.specifier &&
        !entry.glob &&
        !(entry.type === 'dynamic' && ['puppeteer', 'lighthouse'].includes(entry.specifier))
      )
        reference(file, entry.specifier)
    for (const match of source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g))
      reference(file, match[1])
  }
  if (file.endsWith('.html'))
    for (const match of source.matchAll(/(?:src|href)=["']([^"']+)["']/g)) reference(file, match[1])
  if (file.endsWith('.css'))
    for (const match of source.matchAll(/url\(\s*["']?([^"'\s)]+)["']?\s*\)/g)) reference(file, match[1])
}

let previous
try {
  let text
  try {
    text = await readFile(path.join(output, 'downloads.json'), 'utf8')
  } catch {
    text = await readFile(path.join(output, 'build.json'), 'utf8')
  }
  const value = JSON.parse(text)
  if (value.revision === pin.revision) previous = value
} catch {}

async function resource(file) {
  // Reuse unpatched downloads only after checking their recorded content hash.
  let data
  if (!pin.patches[file] && previous?.files[file]) {
    try {
      const cached = await readFile(path.join(output, file))
      if (sha256(cached) === previous.files[file].sha256) data = cached
    } catch {}
  }
  data ||= await download(
    file.startsWith('Images/') && file.endsWith('.svg')
      ? raw + 'front_end/Images/src/' + file.slice('Images/'.length)
      : base + file,
  )
  dependencies(file, data)
  await save(file, patchFrontend(file, data, pin))
}

console.log('Building pinned DevTools ' + pin.revision.slice(0, 12) + ' for the Gea debugger…')
const treeResponse = await fetch(
  'https://api.github.com/repos/ChromeDevTools/devtools-frontend/git/trees/' +
    pin.revision +
    '?recursive=1',
  { signal: AbortSignal.timeout(30000) },
)
if (!treeResponse.ok) throw new Error('Cannot read pinned DevTools asset inventory: ' + treeResponse.status)
const tree = await treeResponse.json()
if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete DevTools asset inventory')
for (const file of seeds) enqueue(file)
for (const item of tree.tree) {
  if (/^front_end\/Images\/src\/[^/]+\.svg$/.test(item.path))
    enqueue('Images/' + path.basename(item.path))
  // Runtime.loadModule resolves a name dynamically. Include every production
  // namespace entry module from this same revision rather than a wildcard URL.
  if (
    /^front_end\/.+\.ts$/.test(item.path) &&
    /^front_end\/(?:core|models|panels|ui|services|entrypoints|foundation)\//.test(item.path) &&
    !/test_runner|\.test\./.test(item.path) &&
    path.basename(item.path, '.ts') === path.basename(path.dirname(item.path))
  )
    enqueue(item.path.slice('front_end/'.length).replace(/\.ts$/, '.js'))
}
let progress = 0
while (pending.length) {
  const wave = pending.splice(0, 6)
  await Promise.all(wave.map(resource))
  await writeFile(path.join(output, 'downloads.json'), JSON.stringify(manifest))
  if (Object.keys(manifest.files).length - progress >= 200) {
    progress = Object.keys(manifest.files).length
    console.log(progress + ' assets downloaded…')
  }
}
for (const file of Object.keys(pin.patches))
  if (!manifest.files[file]) throw new Error('Frontend graph missed a required patch: ' + file)

// gea/panels.js and gea/css.js are served from this package's sources.
const licenses = tree.tree.filter(
  (item) =>
    item.type === 'blob' &&
    (item.path === 'LICENSE' ||
      /^front_end\/third_party\/.*\/(?:LICENSE|COPYING)(?:\.[^/]*)?$/.test(item.path)),
)
for (let index = 0; index < licenses.length; index += 6)
  await Promise.all(
    licenses.slice(index, index + 6).map(async (item) => {
      await save('licenses/' + item.path.replaceAll('/', '-'), await download(raw + item.path))
    }),
  )
manifest.files = Object.fromEntries(
  Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
)
await writeFile(path.join(output, 'build.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('DevTools ready: ' + Object.keys(manifest.files).length + ' bundled assets.')
