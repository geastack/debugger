import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { connectCDP } from '../src/cdp.mjs'

const endpoint = process.env.GEA_DEBUGGER_DEVICE_TEST_ENDPOINT
const selector = process.env.GEA_DEBUGGER_TEST_SELECTOR
const color = { r: 237, g: 17, b: 223, a: 1 }

function matchingPixels(data) {
  const png = Buffer.from(data, 'base64')
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20)
  assert.equal(png[24], 8)
  assert.ok(png[25] === 2 || png[25] === 6)
  const bytes = png[25] === 2 ? 3 : 4,
    stride = width * bytes,
    chunks = []
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset)
    if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + size))
    offset += 12 + size
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    pixels = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter >= 0 && filter <= 4)
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        a = x >= bytes ? pixels[at - bytes] : 0,
        b = y ? pixels[at - stride] : 0,
        c = y && x >= bytes ? pixels[at - stride - bytes] : 0
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      pixels[at] = raw[y * (stride + 1) + 1 + x] + predictor
    }
  }
  let matches = 0
  for (let at = 0; at < pixels.length; at += bytes)
    if (
      Math.abs(pixels[at] - color.r) < 8 &&
      Math.abs(pixels[at + 1] - color.g) < 8 &&
      Math.abs(pixels[at + 2] - color.b) < 8
    )
      matches++
  return matches
}

test(
  'physical display highlights on hover, preserves styles/tree, and clears on hide/disconnect',
  { skip: !endpoint || !selector, timeout: 45000 },
  async () => {
    let cdp = await connectCDP(endpoint)
    const capture = async () => matchingPixels((await cdp.send('Page.captureScreenshot')).data)
    const wait = async (predicate) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const count = await capture()
        if (predicate(count)) return count
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error('Native highlight pixel assertion timed out')
    }
    try {
      await cdp.send('DOM.getDocument', { depth: -1 })
      const id = (await cdp.send('DOM.querySelector', { nodeId: 1, selector })).nodeId
      assert.ok(id)
      const beforeStyle = (await cdp.send('CSS.getInlineStylesForNode', { nodeId: id })).inlineStyle
        .cssText
      await cdp.send('Overlay.hideHighlight')
      const baseline = await capture()
      await cdp.send('Overlay.highlightNode', {
        nodeId: id,
        highlightConfig: { contentColor: color },
      })
      const highlighted = await wait((count) => count > baseline + 12)
      assert.equal(
        (await cdp.send('CSS.getInlineStylesForNode', { nodeId: id })).inlineStyle.cssText,
        beforeStyle,
      )
      assert.equal((await cdp.send('DOM.querySelector', { nodeId: 1, selector })).nodeId, id)
      await cdp.send('Overlay.hideHighlight')
      await wait((count) => count <= baseline + 8)
      await cdp.send('Overlay.highlightNode', {
        nodeId: id,
        highlightConfig: { contentColor: color },
      })
      await wait((count) => count > baseline + 12)
      cdp.close()
      cdp = await connectCDP(endpoint)
      await wait((count) => count <= baseline + 8)
      console.log(
        `Native overlay pixels: baseline=${baseline}, highlighted=${highlighted}; hide/disconnect restored the display`,
      )
    } finally {
      await cdp.send('Overlay.hideHighlight').catch(() => {})
      cdp.close()
    }
  },
)
