// Requests the DevTools frontend sends on attach for features neither native
// backend implements. Answering them empty keeps the console free of protocol
// errors without pretending the feature works. CSS.takeComputedStyleUpdates is
// deliberately absent: it long-polls, and an empty answer would spin.
const noops = new Set([
  'CSS.trackComputedStyleUpdates',
  'CSS.trackComputedStyleUpdatesForNode',
  'DOMDebugger.setBreakOnCSPViolation',
  'Emulation.setEmulatedMedia',
  'Emulation.setFocusEmulationEnabled',
  'Network.emulateNetworkConditionsByRule',
  'Network.overrideNetworkState',
  'Network.setBlockedURLs',
  'Overlay.setShowAdHighlights',
  'Overlay.setShowContainerQueryOverlays',
  'Overlay.setShowDebugBorders',
  'Overlay.setShowFPSCounter',
  'Overlay.setShowFlexOverlays',
  'Overlay.setShowGridOverlays',
  'Overlay.setShowHinge',
  'Overlay.setShowIsolatedElements',
  'Overlay.setShowLayoutShiftRegions',
  'Overlay.setShowPaintRects',
  'Overlay.setShowScrollBottleneckRects',
  'Overlay.setShowScrollSnapOverlays',
  'Overlay.setShowViewportSizeOnResize',
  'Overlay.setShowWebVitals',
  'Overlay.setShowWindowControlsOverlay',
  'Page.setAdBlockingEnabled',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Runtime.addBinding',
  'Runtime.removeBinding',
])

let scripts = 0

// Returns the canned result, or undefined when the backend must answer.
export function compatResult(method) {
  if (noops.has(method)) return {}
  // There is no document reload to run the script on; hand back an identifier
  // so the frontend can later remove it.
  if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: String(++scripts) }
}
