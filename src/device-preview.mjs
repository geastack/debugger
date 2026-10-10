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
let inspectToken = 0, picking = false, pendingPoint = null
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
async function sendPoint(request) {
  if (picking) { pendingPoint = request; return }
  picking = true
  try {
    // Replace hover samples while USB is busy. Preserve a click or cancellation
    // through its acknowledgement, rather than enqueueing every pointer move.
    do {
      pendingPoint = null
      const response = await fetch('/preview/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw Error((await response.json()).error)
      if (request.mode === 'select' || request.mode === 'cancel') {
        inspectToken = 0
        pendingPoint = null
      }
      request = pendingPoint
    } while (request && request.token === inspectToken)
  } catch (error) { status.textContent = error.message }
  finally { picking = false }
}
function point(event, kind) {
  if (!inspectToken) return
  event.preventDefault()
  const bounds = screen.getBoundingClientRect()
  sendPoint({ token: inspectToken, mode: kind,
    x: Math.min(screen.clientWidth - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * screen.clientWidth / bounds.width))),
    y: Math.min(screen.clientHeight - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * screen.clientHeight / bounds.height))),
  })
}
screen.addEventListener('pointermove', event => {
  if (!pendingPoint || pendingPoint.mode === 'hover') point(event, 'hover')
})
screen.addEventListener('click', event => point(event, 'select'))
screen.addEventListener('pointerleave', () => {
  if (inspectToken && (!pendingPoint || pendingPoint.mode === 'hover'))
    sendPoint({ token: inspectToken, mode: 'leave' })
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && inspectToken) {
    event.preventDefault()
    sendPoint({ token: inspectToken, mode: 'cancel' })
  }
})
async function refresh() {
  const current = revision
  try {
    const response = await fetch('/preview/snapshot', { cache: 'no-store' })
    if (!response.ok) throw Error(await response.text())
    const snapshot = await response.json()
    inspectToken = snapshot.inspectToken || 0
    screen.style.cursor = inspectToken ? 'crosshair' : ''
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
      : inspectToken ? 'Pick an element · tap the board or click this preview · Escape cancels'
      : `${mode.value === 'screen' ? 'Device display' : 'DOM mirror'} · connected`
  } catch (error) {
    status.textContent = error.message
  } finally {
    setTimeout(refresh, inspectToken ? 250 : 750)
  }
}
refresh()
