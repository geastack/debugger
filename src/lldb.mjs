import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { nativeSources } from './gdb.mjs'

export class LldbTransport {
  constructor({ env = process.env } = {}) {
    const pythonPath = execFileSync('xcrun', ['lldb', '-P'], {
      env,
      encoding: 'utf8',
    }).trim()
    const python = execFileSync('xcrun', ['--find', 'python3'], {
      env,
      encoding: 'utf8',
    }).trim()
    this.process = spawn(
      python,
      [fileURLToPath(new URL('../native/lldb_worker.py', import.meta.url))],
      {
        // The CLI owns shutdown. Terminal Ctrl-C must not tear down LLDB before
        // it has resumed and detached its target.
        detached: true,
        env: {
          ...env,
          PYTHONPATH: [pythonPath, env.PYTHONPATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.pending = new Map()
    this.listeners = new Set()
    this.sequence = 0
    this.stderr = ''
    let input = ''
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk) => {
      input += chunk
      if (input.length > 16 * 1024 * 1024)
        return this.fail(new Error('LLDB response exceeded limit'))
      let newline
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        try {
          const message = JSON.parse(line)
          if (message.event) {
            for (const listener of this.listeners) listener(message)
          } else {
            const request = this.pending.get(message.id)
            if (!request) continue
            clearTimeout(request.timer)
            this.pending.delete(message.id)
            if (message.error) request.reject(new Error(message.error))
            else request.resolve(message.result)
          }
        } catch (error) {
          this.fail(error)
        }
      }
    })
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    this.process.on('error', (error) => this.fail(error))
    this.process.stdin.on('error', (error) => this.fail(error))
    this.process.on('exit', (code) =>
      this.fail(new Error(`LLDB exited (${code}): ${this.stderr}`)),
    )
  }
  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const listener of this.listeners) listener({ event: 'closed', error })
  }
  request(method, params = {}, timeout = 15000) {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('LLDB timeout: ' + method))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async close() {
    try {
      await this.request('close', {}, 3000)
    } catch {}
    this.process.stdin.end()
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(terminate)
        clearTimeout(force)
        resolve()
      }
      const terminate = setTimeout(() => {
        if (!this.process.kill('SIGTERM')) finish()
      }, 1000)
      const force = setTimeout(() => {
        this.process.kill('SIGKILL')
        finish()
      }, 2000)
      this.process.once('exit', finish)
    })
  }
}

export class MacSourceDebugger {
  constructor(transport, info) {
    this.transport = transport
    this.info = info
    this.sources = nativeSources(info)
    this.clients = new Map()
    this.breakpoints = new Map()
    this.breakpointOwners = new Map()
    this.extraScripts = new Map()
    this.paused = false
    this.active = true
    this.epoch = 0
    this.control = Promise.resolve()
    this.events = Promise.resolve()
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve
    })
    transport.onEvent((event) => {
      this.events = this.events
        .then(() => this.event(event))
        .catch((error) => {
          this.step = null
          this.broadcast('Log.entryAdded', {
            entry: {
              source: 'other',
              level: 'error',
              text: error.message,
              timestamp: Date.now(),
            },
          })
        })
    })
  }
  async start({ executable, pid }) {
    // Loading native symbols can take longer than an ordinary debugger command.
    const { lines } = await this.transport.request(
      'attach',
      { executable, pid, file: this.info.file },
      60000,
    )
    this.lines = new Set(
      lines
        .map((line) => line - 1)
        .filter((line) => this.sources.rows.has(line)),
    )
    if (!this.lines.size)
      throw new Error(
        'Native source symbols are missing. Rebuild with full debug symbols and no optimization.',
      )
    await this.events
  }
  script() {
    const source = this.sources.source
    return {
      scriptId: 'native-app',
      url: 'gea://native/' + this.info.file,
      startLine: 0,
      startColumn: 0,
      endLine: source.split('\n').length - 1,
      endColumn: 0,
      executionContextId: 1,
      hash: createHash('sha256').update(source).digest('hex'),
      sourceMapURL:
        'data:application/json;base64,' +
        Buffer.from(JSON.stringify(this.sources.map)).toString('base64'),
      hasSourceURL: true,
      isLiveEdit: false,
      scriptLanguage: 'JavaScript',
      length: source.length,
    }
  }
  broadcast(method, params) {
    for (const emit of this.clients.values()) emit(method, params)
  }
  detach(owner) {
    this.clients.delete(owner)
    return this.handle(owner, () => {}, 'Debugger.disable')
  }
  row(frame) {
    return path.basename(frame?.file || '') === this.info.file
      ? this.sources.rows.get(frame.line - 1)
      : undefined
  }
  location(frame) {
    if (path.basename(frame.file) === this.info.file)
      return {
        scriptId: 'native-app',
        lineNumber: Math.max(0, frame.line - 1),
        columnNumber: 0,
      }
    const id =
      'native-' +
      createHash('sha256')
        .update(frame.file || frame.function)
        .digest('hex')
        .slice(0, 16)
    if (!this.extraScripts.has(id)) {
      let source = '// Native frame: ' + frame.function
      try {
        source = readFileSync(frame.file, 'utf8')
      } catch {}
      const script = {
        scriptId: id,
        url: frame.file
          ? pathToFileURL(path.resolve(frame.file)).href
          : 'gea://native/runtime',
        startLine: 0,
        startColumn: 0,
        endLine: source.split('\n').length - 1,
        endColumn: 0,
        executionContextId: 1,
        hash: createHash('sha256').update(source).digest('hex'),
        hasSourceURL: true,
        isLiveEdit: false,
        scriptLanguage: 'JavaScript',
        length: source.length,
      }
      this.extraScripts.set(id, { source, script })
      this.broadcast('Debugger.scriptParsed', script)
    }
    return {
      scriptId: id,
      lineNumber: Math.max(
        0,
        Math.min(frame.line - 1, this.extraScripts.get(id).script.endLine),
      ),
      columnNumber: 0,
    }
  }
  // Source locations for native listener registration sites. Sites inside
  // mapped app code resolve to the original TypeScript through the source map.
  async handlerLocations(addresses) {
    const { locations } = await this.transport.request('locations', {
      addresses: [...new Set(addresses)].slice(0, 256),
    })
    return Object.fromEntries(
      Object.entries(locations).map(([address, frame]) => [
        address,
        { ...this.location(frame), functionName: frame.function },
      ]),
    )
  }
  async event(event) {
    if (this.closing) return
    if (event.event === 'closed' || event.event === 'exited') {
      this.broadcast('Inspector.detached', {
        reason: event.error?.message || 'Native app exited',
      })
      this.resolveEnded(event.event === 'exited' ? 0 : 1)
      return
    }
    if (event.event === 'running') {
      this.paused = false
      if (!this.step) this.broadcast('Debugger.resumed', {})
      return
    }
    if (event.event !== 'stopped') return
    this.paused = true
    this.thread = event.thread
    const row = this.row(event.frames[0])
    const stepping = !!this.step
    if (
      this.step &&
      this.step.mode !== 'out' &&
      event.reason !== 'breakpoint'
    ) {
      const origin = this.step.origin
      const mappedCaller = event.frames.some((frame) => this.row(frame))
      if (
        mappedCaller &&
        (!row ||
          (origin &&
            row.file === origin.file &&
            row.line === origin.line &&
            row.column === origin.column)) &&
        ++this.step.count < 200
      ) {
        // Step out of C++ helpers that have no original source mapping.
        await this.transport.request('step', {
          thread: this.thread,
          mode: row ? 'over' : 'out',
        })
        return
      }
    }
    this.step = null
    this.epoch++
    this.frames = event.frames
    const callFrames = event.frames.map((frame) => ({
      callFrameId: `lldb-frame-${this.epoch}-${frame.level}`,
      functionName: frame.function,
      location: this.location(frame),
      url: frame.file,
      scopeChain: [
        {
          type: 'local',
          name: 'Native C++ locals',
          object: {
            type: 'object',
            objectId: `lldb-scope-${this.epoch}-${frame.level}`,
            description: 'Native C++ locals',
          },
        },
      ],
      this: { type: 'undefined' },
    }))
    this.lastPaused = {
      callFrames,
      reason: stepping
        ? 'step'
        : event.reason === 'pause'
          ? 'debugCommand'
          : 'other',
      hitBreakpoints: event.breakpoints
        .map((id) => 'lldb-' + id)
        .filter((id) => this.breakpoints.has(id)),
      data: { nativeReason: event.reason, thread: this.thread },
    }
    this.broadcast('Debugger.paused', this.lastPaused)
  }
  frame(id, prefix = 'lldb-frame-') {
    if (!this.paused || this.step)
      throw new Error('The native app is not paused')
    if (!id?.startsWith(prefix) || !/^\d+-\d+$/.test(id.slice(prefix.length)))
      throw new Error('Invalid native frame or value')
    const [epoch, level] = id.slice(prefix.length).split('-').map(Number)
    if (epoch !== this.epoch) throw new Error('Stale native frame or value')
    return level
  }
  remote(value) {
    if (value.handle)
      return {
        type: 'object',
        objectId: `lldb-value-${this.epoch}-${value.handle}`,
        description: value.summary || value.type,
      }
    if (value.type === 'bool')
      return { type: 'boolean', value: value.value === 'true' }
    if (
      value.value !== null &&
      value.value !== '' &&
      Number.isFinite(Number(value.value))
    )
      return { type: 'number', value: Number(value.value) }
    return {
      type: 'string',
      value: value.summary || value.value || '<unavailable>',
      description:
        value.type + ': ' + (value.summary || value.value || '<unavailable>'),
    }
  }
  async properties(id) {
    const child = id.startsWith('lldb-value-')
    const level = this.frame(id, child ? 'lldb-value-' : 'lldb-scope-')
    const { values } = await this.transport.request(
      child ? 'children' : 'variables',
      child ? { handle: level } : { thread: this.thread, frame: level },
    )
    return {
      result: values.map((value) => ({
        name: value.name,
        isOwn: true,
        enumerable: true,
        configurable: false,
        value: this.remote(value),
      })),
    }
  }
  handle(owner, emit, method, params = {}) {
    const result = this.control.then(() =>
      this.command(owner, emit, method, params),
    )
    this.control = result.catch(() => {})
    return result
  }
  async command(owner, emit, method, p) {
    if (this.closing) throw new Error('Native debugger is closing')
    if (method === 'Debugger.enable') {
      this.clients.set(owner, emit)
      emit('Debugger.scriptParsed', this.script())
      for (const { script } of this.extraScripts.values())
        emit('Debugger.scriptParsed', script)
      if (this.paused && this.lastPaused)
        emit('Debugger.paused', this.lastPaused)
      return { debuggerId: 'gea-native-lldb' }
    }
    if (method === 'Debugger.disable') {
      this.clients.delete(owner)
      for (const [id, breakpointOwner] of this.breakpointOwners) {
        if (breakpointOwner !== owner) continue
        await this.transport.request('remove', {
          id: this.breakpoints.get(id),
        })
        this.breakpoints.delete(id)
        this.breakpointOwners.delete(id)
      }
      if (!this.clients.size && this.paused) {
        this.step = null
        await this.transport.request('resume')
      }
      return {}
    }
    if (method === 'Debugger.getScriptSource') {
      const source =
        p.scriptId === 'native-app'
          ? this.sources.source
          : this.extraScripts.get(p.scriptId)?.source
      if (source === undefined) throw new Error('Unknown native script')
      return { scriptSource: source }
    }
    if (method === 'Debugger.getPossibleBreakpoints')
      return {
        locations:
          p.start.scriptId !== 'native-app'
            ? []
            : [...this.lines]
                .sort((a, b) => a - b)
                .filter(
                  (line) =>
                    (line > p.start.lineNumber ||
                      (line === p.start.lineNumber &&
                        !(p.start.columnNumber > 0))) &&
                    (!p.end ||
                      line < p.end.lineNumber ||
                      (line === p.end.lineNumber && p.end.columnNumber > 0)),
                )
                .map((lineNumber) => ({
                  scriptId: 'native-app',
                  lineNumber,
                  columnNumber: 0,
                })),
      }
    if (
      method === 'Debugger.setBreakpoint' ||
      method === 'Debugger.setBreakpointByUrl' ||
      method === 'Debugger.continueToLocation'
    ) {
      if (p.condition)
        throw new Error(
          'Native breakpoints do not support JavaScript conditions',
        )
      if (p.urlRegex || (p.location && p.location.scriptId !== 'native-app'))
        throw new Error('Choose a mapped app source position')
      let line = p.location?.lineNumber ?? p.lineNumber
      if (p.url && p.url !== this.script().url) {
        const rows = [...this.sources.rows]
          .filter(
            ([native, row]) =>
              this.lines.has(native) &&
              row.file === p.url &&
              (row.line > p.lineNumber ||
                (row.line === p.lineNumber &&
                  row.column >= (p.columnNumber || 0))),
          )
          .sort(
            (a, b) =>
              a[1].line - b[1].line || a[1].column - b[1].column || a[0] - b[0],
          )
        line = rows[0]?.[0]
      }
      if (!this.lines.has(line))
        throw new Error(
          'This source position has no executable native operation',
        )
      const temporary = method === 'Debugger.continueToLocation'
      if (temporary && !this.paused)
        throw new Error('The native app is not paused')
      const breakpoint = await this.transport.request('breakpoint', {
        file: this.info.file,
        line: line + 1,
        enabled: temporary || this.active,
        temporary,
      })
      const id = 'lldb-' + breakpoint.id
      this.breakpoints.set(id, breakpoint.id)
      this.breakpointOwners.set(id, owner)
      const location = {
        scriptId: 'native-app',
        lineNumber: breakpoint.line - 1,
        columnNumber: 0,
      }
      if (temporary) {
        await this.transport.request('resume')
        return {}
      }
      return method === 'Debugger.setBreakpoint'
        ? { breakpointId: id, actualLocation: location }
        : { breakpointId: id, locations: [location] }
    }
    if (method === 'Debugger.removeBreakpoint') {
      const id = this.breakpoints.get(p.breakpointId)
      if (id !== undefined) {
        await this.transport.request('remove', { id })
        this.breakpoints.delete(p.breakpointId)
        this.breakpointOwners.delete(p.breakpointId)
      }
      return {}
    }
    if (
      method === 'Debugger.setBreakpointsActive' ||
      method === 'Debugger.setSkipAllPauses'
    ) {
      this.active =
        method === 'Debugger.setBreakpointsActive' ? p.active : !p.skip
      await this.transport.request('active', { active: this.active })
      return {}
    }
    if (method === 'Debugger.pause') {
      this.step = null
      if (!this.paused) await this.transport.request('pause')
      return {}
    }
    if (method === 'Debugger.resume') {
      this.step = null
      if (this.paused) await this.transport.request('resume')
      return {}
    }
    if (
      ['Debugger.stepOver', 'Debugger.stepInto', 'Debugger.stepOut'].includes(
        method,
      )
    ) {
      if (!this.paused || this.step)
        throw new Error('The native app is not paused')
      const mode = {
        'Debugger.stepOver': 'over',
        'Debugger.stepInto': 'into',
        'Debugger.stepOut': 'out',
      }[method]
      this.step = { origin: this.row(this.frames[0]), count: 0, mode }
      // DevTools must discard the old frame immediately, including during helper skips.
      this.broadcast('Debugger.resumed', {})
      try {
        await this.transport.request('step', { thread: this.thread, mode })
      } catch (error) {
        this.step = null
        throw error
      }
      return {}
    }
    if (method === 'Debugger.evaluateOnCallFrame') {
      const frame = this.frame(p.callFrameId)
      try {
        const value = await this.transport.request('evaluate', {
          thread: this.thread,
          frame,
          expression: p.expression,
        })
        return { result: this.remote(value) }
      } catch (error) {
        return {
          result: { type: 'undefined' },
          exceptionDetails: {
            text: error.message,
            exceptionId: 1,
            lineNumber: 0,
            columnNumber: 0,
          },
        }
      }
    }
    if (method === 'Runtime.getProperties') return this.properties(p.objectId)
    if (method === 'Debugger.setPauseOnExceptions') {
      if (p.state !== 'none')
        throw new Error(
          'JavaScript exception pausing is unavailable in compiled apps',
        )
      return {}
    }
    if (
      [
        'Debugger.setAsyncCallStackDepth',
        'Debugger.setBlackboxPatterns',
        'Debugger.setBlackboxedRanges',
      ].includes(method)
    )
      return {}
    throw new Error('Unsupported native source debugger method: ' + method)
  }
  async close() {
    this.closing = true
    this.clients.clear()
    await this.control.catch(() => {})
    await this.events.catch(() => {})
    await this.transport.close()
  }
}

export async function createMacSourceDebugger({
  executable,
  pid,
  metadata,
  env,
}) {
  const info = JSON.parse(readFileSync(metadata, 'utf8'))
  if (info.file !== 'gea-native-debug.js' || !Array.isArray(info.locations))
    throw new Error('Invalid native source metadata')
  const transport = new LldbTransport({ env })
  const debuggerState = new MacSourceDebugger(transport, info)
  try {
    await debuggerState.start({ executable, pid })
    return debuggerState
  } catch (error) {
    await debuggerState.close()
    throw error
  }
}
