// DOM.getOuterHTML for native trees, serialized from a DOM.describeNode
// result (depth -1) so both backends share one representation.
const escapeText = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeAttribute = (text) => escapeText(text).replaceAll('"', '&quot;')
const voids = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

export function outerHTML(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue || '')
  if (node.nodeType === 9) return (node.children || []).map(outerHTML).join('')
  const tag = node.localName || String(node.nodeName).toLowerCase()
  const attributes = node.attributes || []
  let html = '<' + tag
  for (let index = 0; index + 1 < attributes.length; index += 2)
    html += ` ${attributes[index]}="${escapeAttribute(attributes[index + 1])}"`
  html += '>'
  if (voids.has(tag) && !node.children?.length) return html
  return html + (node.children || []).map(outerHTML).join('') + `</${tag}>`
}
