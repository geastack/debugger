// A minimal native inspector backend: enough DOM and CSS protocol to exercise
// the edit history and the relay without building an app.
import net from 'node:net'
import { ruleOfSheet } from '../../src/changes.mjs'

const attrs = (node) => {
  const map = {}
  for (let i = 0; i + 1 < node.attributes.length; i += 2) map[node.attributes[i]] = node.attributes[i + 1]
  return map
}

export class FakeNativeDom {
  constructor() {
    let id = 0
    const element = (tag, attributes = {}, children = []) => ({
      nodeId: (id += 2),
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      localName: tag,
      attributes: Object.entries(attributes).flat(),
      children,
    })
    const text = (value) => ({ nodeId: (id += 2) + 1, nodeType: 3, nodeName: '#text', nodeValue: value })
    this.status = text('Turn: X')
    this.cell = element('div', { class: 'tic-cell tic-cell-x' }, [element('span')])
    this.title = element('h1', { id: 'title' }, [text('Tic Tac Toe')])
    this.root = {
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        element('html', {}, [
          element('div', { id: 'app' }, [this.title, element('span', { class: 'tic-status' }, [this.status]), this.cell]),
        ]),
      ],
    }
    this.rules = new Map([['.tic-status', 'color: #FFFFFF;']])
    this.calls = []
    this.fail = null
  }
  find(nodeId, node = this.root) {
    if (node.nodeId === nodeId) return node
    for (const child of node.children || []) {
      const found = this.find(nodeId, child)
      if (found) return found
    }
  }
  node(nodeId) {
    const node = this.find(nodeId)
    if (!node) throw new Error('No node with given id found')
    return node
  }
  setAttribute(node, name, value) {
    const map = attrs(node)
    if (value === null) delete map[name]
    else map[name] = value
    node.attributes = Object.entries(map).flat()
  }
  call(method, params = {}) {
    this.calls.push(method)
    if (this.fail?.(method, params)) throw new Error(`${method} failed`)
    const copy = (value) => structuredClone(value)
    switch (method) {
      case 'DOM.getDocument':
        return { root: copy(this.root) }
      case 'DOM.describeNode':
        return { node: copy(this.node(params.nodeId || params.backendNodeId)) }
      case 'DOM.getAttributes':
        return { attributes: [...this.node(params.nodeId).attributes] }
      case 'DOM.setAttributeValue':
        this.setAttribute(this.node(params.nodeId), params.name, params.value)
        return {}
      case 'DOM.removeAttribute':
        this.setAttribute(this.node(params.nodeId), params.name, null)
        return {}
      case 'DOM.setNodeValue':
        this.node(params.nodeId).nodeValue = params.value
        return {}
      case 'CSS.getStyleSheetText': {
        const rule = ruleOfSheet(params.styleSheetId)
        if (rule) return { text: this.rules.get(rule.selector) ?? '' }
        return { text: attrs(this.node(Number(params.styleSheetId.slice(7)))).style || '' }
      }
      case 'CSS.setStyleTexts':
        for (const { styleSheetId, text } of params.edits) {
          const rule = ruleOfSheet(styleSheetId)
          if (rule) this.rules.set(rule.selector, text)
          else this.setAttribute(this.node(Number(styleSheetId.slice(7))), 'style', text)
        }
        return { styles: [] }
      case 'DOMDebugger.getEventListeners':
        return {
          listeners: [
            {
              type: 'click',
              useCapture: false,
              passive: false,
              once: false,
              scriptId: '0',
              lineNumber: 0,
              columnNumber: 0,
              handler: { type: 'object', className: 'GeaListener', description: 'click listener on <div>' },
              nativeAddresses: ['0x10', '0x20'],
            },
          ],
        }
      case 'Runtime.evaluate':
        return { result: { type: 'number', value: 42 } }
    }
    throw new Error('Unsupported native protocol method: ' + method)
  }
  // Changes backend over this DOM.
  backend() {
    const events = []
    return { events, call: async (method, params) => this.call(method, params), broadcast: (method, params) => events.push([method, params]) }
  }
  // Serve the native app's JSON-line protocol, as macos.mm does.
  async listen() {
    const sockets = new Set()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let input = ''
      socket.on('data', (chunk) => {
        input += chunk
        let newline
        while ((newline = input.indexOf('\n')) >= 0) {
          const request = JSON.parse(input.slice(0, newline))
          input = input.slice(newline + 1)
          let reply
          try {
            reply = { id: request.id, result: this.call(request.method, request.params) }
          } catch (error) {
            reply = { id: request.id, error: { code: -32000, message: error.message } }
          }
          socket.write(JSON.stringify(reply) + '\n')
        }
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: server.address().port,
      close: async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
      },
    }
  }
}
