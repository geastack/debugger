import test from 'node:test'
import assert from 'node:assert/strict'
import { cssStyle, cssValues, cssMutations, reconcileCss, replaceCssRange, setCssProperty } from '../src/css.mjs'

test('authored shorthand and independent disabled properties retain text and editable ranges', () => {
  const text = 'background: indianred;\n/* color: white; */ opacity: .5;'
  const style = cssStyle(text, 'inline-4')
  assert.deepEqual(style.cssProperties.map(p => [p.name, p.disabled]),
    [['background', false], ['color', true], ['opacity', false]])
  assert.equal(style.cssText, text)
  const enabled = replaceCssRange(text, style.cssProperties[1].range, 'color: white;')
  assert.deepEqual(cssValues(enabled), { background: 'indianred', color: 'white', opacity: '.5' })
  assert.equal(cssStyle(enabled).cssProperties[2].range.startLine, 1)
  assert.equal(setCssProperty(text, 'opacity', ''), 'background: indianred;\n/* color: white; */ ')
})

test('quoted semicolons, URLs, important and duplicate declarations are preserved in order', () => {
  const text = '--label: "a;b"; background: url("data:image/svg+xml;a:b"); color: red; color: blue !important;'
  assert.deepEqual(cssStyle(text).cssProperties.map(p => p.value),
    ['"a;b"', 'url("data:image/svg+xml;a:b")', 'red', 'blue !important'])
  assert.equal(cssStyle(text).cssProperties.at(-1).important, true)
  assert.equal(cssValues('/* not a declaration */ color: red;').color, 'red')
  assert.deepEqual(cssMutations('background: red;', { 'background-color': 'rgb(255, 0, 0)' },
    '/* background: red; */ color: white;'), [
    { key: 'background-color', value: '' }, { key: 'background', value: '' },
    { key: 'color', value: 'white' },
  ])
})

test('engine expansion never adds declarations, while actual runtime updates remain visible', () => {
  const document = { text: 'background: red; /* opacity: .5; */ left: 10px;',
    projection: { 'background-color': 'rgb(255, 0, 0)', left: '10px' } }
  assert.equal(reconcileCss(document, document.projection).text, document.text)
  const moved = reconcileCss(document, { ...document.projection, left: '20px' })
  assert.equal(moved.text, 'background: red; /* opacity: .5; */ left: 20px;')
  assert.equal(cssStyle(moved.text).cssProperties.some(p => p.name === 'background-color'), false)
  const disabled = { text: '/* background: red; */', projection: {} }
  assert.equal(reconcileCss(disabled, {}).text, disabled.text)
  assert.deepEqual(cssMutations('color: red;', { color: 'red' }, '/* opacity: .5; */ color: red;'), [],
    'source-only edits do not rewrite native properties')
  assert.throws(() => replaceCssRange(document.text,
    { startLine: 0, startColumn: 0, endLine: 1, endColumn: 0 }, ''), /range/)
})
