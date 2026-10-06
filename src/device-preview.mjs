const mode = document.querySelector('#mode'),
  screen = document.querySelector('#screen'),
  picture = document.querySelector('#picture'),
  mirror = document.querySelector('#mirror'),
  highlight = document.querySelector('#highlight'),
  status = document.querySelector('#status'),
  note = document.querySelector('#note')
mode.value = localStorage.getItem('gea-preview-mode') === 'dom' ? 'dom' : 'screen'
let lastImage = '',
  lastCapture = 0,
  revision = 0
const elements = new Map()
const properties = [
  'background-color',
  'color',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-feature-settings',
  'font-variation-settings',
  'line-height',
  'letter-spacing',
  'text-align',
  'border-radius',
  'border-color',
  'border-width',
  'border-style',
  'opacity',
  'z-index',
  'overflow',
  'visibility',
  'display',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
]
function render(snapshot) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node])),
    alive = new Set()
  for (const node of snapshot.nodes)
    if (!elements.has(node.id)) {
      const element = document.createElement('div')
      element.className = 'native'
      element.dataset.nativeId = node.id
      elements.set(node.id, element)
    }
  for (const node of snapshot.nodes) {
    alive.add(node.id)
    const element = elements.get(node.id)
    const parent = nodes.get(node.parent),
      container = elements.get(node.parent) || mirror
    if (element.parentNode !== container) container.appendChild(element)
    element.style.cssText = ''
    const authored = Object.fromEntries(
      (node.rules || []).map((rule) => [rule.property, rule.value]),
    )
    for (const name of properties) {
      let value = node.computed?.[name] ?? node.inline?.[name] ?? authored[name]
      if (value !== undefined) {
        if (
          /^(?:border-radius|border-width|font-size)$/.test(name) &&
          /^-?\d+(?:\.\d+)?$/.test(value)
        )
          value += 'px'
        element.style.setProperty(name, value)
      }
    }
    Object.assign(element.style, {
      position: 'absolute',
      left: `${node.x - (parent?.x || 0)}px`,
      top: `${node.y - (parent?.y || 0)}px`,
      width: `${node.width}px`,
      height: `${node.height}px`,
    })
    // A separate text child keeps native descendants intact across text changes.
    let text = element.querySelector(':scope > [data-native-text]')
    if (!text) {
      text = document.createElement('span')
      text.dataset.nativeText = ''
      element.prepend(text)
    }
    text.textContent = node.text || ''
    let raster = element.querySelector(':scope > .canvas-crop')
    if (node.tag === 'canvas' && lastImage) {
      if (!raster) {
        raster = document.createElement('div')
        raster.className = 'canvas-crop'
        element.appendChild(raster)
      }
      Object.assign(raster.style, {
        inset: '0',
        backgroundImage: `url(${lastImage})`,
        backgroundSize: `${snapshot.width}px ${snapshot.height}px`,
        backgroundPosition: `-${node.x}px -${node.y}px`,
      })
    } else raster?.remove()
  }
  for (const [id, element] of elements)
    if (!alive.has(id)) {
      element.remove()
      elements.delete(id)
    }
  const selected = nodes.get(snapshot.highlight)
  highlight.style.display = selected ? 'block' : 'none'
  if (selected)
    Object.assign(highlight.style, {
      left: `${selected.x}px`,
      top: `${selected.y}px`,
      width: `${selected.width}px`,
      height: `${selected.height}px`,
    })
}
function updateMode() {
  revision++
  localStorage.setItem('gea-preview-mode', mode.value)
  picture.hidden = mode.value !== 'screen'
  mirror.hidden = mode.value !== 'dom'
  note.textContent =
    mode.value === 'screen'
      ? 'Actual device pixels, refreshed at a modest rate over USB. The last captured frame stays visible while paused.'
      : 'Structured native tree using measured device bounds. App font files are shared with this mirror. Native rasterization, clipping and unsupported styles may differ; canvas regions use device pixels.'
}
mode.addEventListener('change', updateMode)
updateMode()
async function refresh() {
  const current = revision
  try {
    const response = await fetch('/preview/snapshot', { cache: 'no-store' })
    if (!response.ok) throw Error(await response.text())
    const snapshot = await response.json()
    screen.style.width = `${snapshot.width}px`
    screen.style.height = `${snapshot.height}px`
    const needsPixels =
      mode.value === 'screen' || snapshot.nodes.some((node) => node.tag === 'canvas')
    if (needsPixels && !snapshot.paused && Date.now() - lastCapture > 1800) {
      const capture = await fetch('/preview/frame', { cache: 'no-store' })
      if (!capture.ok) throw Error(await capture.text())
      const data = await capture.json()
      if (data.data) {
        lastImage = 'data:image/png;base64,' + data.data
        picture.src = lastImage
      }
      lastCapture = Date.now()
    }
    if (current !== revision) return
    render(snapshot)
    status.textContent = snapshot.paused
      ? 'Paused · last captured state'
      : `${mode.value === 'screen' ? 'Device display' : 'DOM mirror'} · connected`
  } catch (error) {
    status.textContent = error.message
  } finally {
    setTimeout(refresh, mode.value === 'dom' ? 750 : 2000)
  }
}
refresh()
