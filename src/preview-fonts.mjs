import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import postcss from 'postcss'

const types = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
const urlPattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi
function localAsset(value, source) {
  if (!value || /^(?:[a-z]+:|\/\/)/i.test(value)) return null
  try {
    return path.resolve(path.dirname(source), decodeURIComponent(value.split(/[?#]/, 1)[0]))
  } catch {
    return null
  }
}
// Only explicit local @font-face files become HTTP assets; clients cannot pass paths.
export function previewFonts(appRoot) {
  const assets = new Map(),
    visited = new Set(),
    faces = postcss.root()
  function css(file) {
    if (visited.has(file) || !existsSync(file)) return
    visited.add(file)
    let root
    try {
      root = postcss.parse(readFileSync(file, 'utf8'), { from: file })
    } catch {
      return
    }
    root.walkAtRules('import', (rule) => {
      const match = [...rule.params.matchAll(urlPattern)][0]
      const value = match
        ? (match[1] ?? match[2] ?? match[3])
        : /^["']([^"']+)["']/.exec(rule.params)?.[1]
      const imported = localAsset(value, file)
      if (imported && path.extname(imported) === '.css') css(imported)
    })
    root.walkAtRules('font-face', (rule) => {
      const declarations = Object.fromEntries(
        (rule.nodes || [])
          .filter((node) => node.type === 'decl')
          .map((node) => [node.prop.toLowerCase(), node.value]),
      )
      if (!declarations['font-family'] || !declarations.src) return
      let source
      for (const match of declarations.src.matchAll(urlPattern)) {
        const candidate = localAsset(match[1] ?? match[2] ?? match[3], file)
        if (candidate && types[path.extname(candidate).toLowerCase()] && existsSync(candidate)) {
          source = candidate
          break
        }
      }
      if (!source) return
      const data = readFileSync(source),
        id = createHash('sha256').update(data).digest('hex'),
        extension = path.extname(source).toLowerCase()
      assets.set(id, { data, type: types[extension] })
      const face = postcss.atRule({ name: 'font-face' })
      for (const name of [
        'font-family',
        'font-weight',
        'font-style',
        'font-stretch',
        'unicode-range',
        'font-feature-settings',
        'font-variation-settings',
        'ascent-override',
        'descent-override',
        'line-gap-override',
        'size-adjust',
      ])
        if (declarations[name]) face.append(postcss.decl({ prop: name, value: declarations[name] }))
      face.append(postcss.decl({ prop: 'src', value: `url("/preview/fonts/${id}")` }))
      face.append(postcss.decl({ prop: 'font-display', value: 'swap' }))
      faces.append(face)
    })
  }
  function directory(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !['node_modules', '.gea', 'dist', '.git'].includes(entry.name))
        directory(path.join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.css')) css(path.join(dir, entry.name))
    }
  }
  if (appRoot && existsSync(appRoot)) directory(appRoot)
  return { css: faces.toString(), assets }
}
