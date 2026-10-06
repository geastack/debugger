import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

const q = JSON.stringify
export function parseMI(text) {
  let i = 0
  const word = () => {
    const start = i
    while (i < text.length && !['=', ',', ']', '}'].includes(text[i])) i++
    return text.slice(start, i)
  }
  const value = () => {
    if (text[i] === '"') {
      let raw = ''
      i++
      while (i < text.length) {
        const c = text[i++]
        if (c === '"') break
        if (c === '\\') {
          const e = text[i++]
          if (/[0-7]/.test(e)) {
            let n = e
            while (n.length < 3 && /[0-7]/.test(text[i] || '')) n += text[i++]
            raw += String.fromCharCode(parseInt(n, 8))
          } else raw += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] ?? e
        } else raw += c
      }
      return raw
    }
    if (text[i] === '{') {
      i++
      const out = {}
      while (i < text.length && text[i] !== '}') {
        const key = word()
        if (text[i++] !== '=') throw new Error('Invalid MI tuple')
        out[key] = value()
        if (text[i] === ',') i++
      }
      i++
      return out
    }
    if (text[i] === '[') {
      i++
      const out = []
      while (i < text.length && text[i] !== ']') {
        if (text[i] === '"' || text[i] === '{' || text[i] === '[') out.push(value())
        else {
          const key = word()
          if (text[i] === '=') {
            i++
            out.push({ [key]: value() })
          } else out.push(key)
        }
        if (text[i] === ',') i++
      }
      i++
      return out
    }
    return word()
  }
  const out = {}
  while (i < text.length) {
    const key = word()
    if (text[i++] !== '=') throw new Error('Invalid MI result')
    out[key] = value()
    if (text[i] === ',') i++
  }
  return out
}
export class GdbMI {
  constructor(executable, elf, { env = process.env } = {}) {
    this.sequence = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.logs = []
    this.process = spawn(executable, ['--quiet', '--nx', '--interpreter=mi2', elf], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let tail = ''
    this.process.stdout.on('data', (chunk) => {
      tail += chunk
      let nl
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl).replace(/\r$/, '')
        tail = tail.slice(nl + 1)
        this.line(line)
      }
    })
    this.process.stderr.on('data', (chunk) => this.log(String(chunk)))
    this.process.stdin.on('error', (e) => this.fail(e))
    this.process.on('error', (e) => this.fail(e))
    this.process.on('exit', () => this.fail(new Error('GDB exited')))
  }
  log(message) {
    this.logs.push(message)
    if (this.logs.length > 200) this.logs.shift()
  }
  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    for (const listener of this.listeners) listener({ kind: 'closed', error })
  }
  line(line) {
    const m = /^(\d*)([\^*=])([^,]+)(?:,(.*))?$/.exec(line)
    if (!m) {
      if (line.startsWith('~') || line.startsWith('&')) this.log(line)
      return
    }
    let data
    try {
      data = parseMI(m[4] || '')
    } catch (e) {
      this.fail(e)
      return
    }
    if (m[2] === '^') {
      const p = this.pending.get(Number(m[1]))
      if (p) {
        this.pending.delete(Number(m[1]))
        clearTimeout(p.timer)
        if (m[3] === 'error') p.reject(new Error(data.msg || 'GDB error'))
        else p.resolve(data)
      }
    } else for (const listener of this.listeners) listener({ kind: m[3], ...data })
  }
  command(command, timeout = 20000) {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('GDB timeout: ' + command))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(id + command + '\n')
    })
  }
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async close() {
    try {
      await this.command('-target-detach', 3000)
    } catch {}
    try {
      await this.command('-gdb-exit', 3000)
    } catch {}
    if (this.process.exitCode === null) this.process.kill('SIGTERM')
  }
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function vlq(n) {
  let v = n < 0 ? -n * 2 + 1 : n * 2,
    s = ''
  do {
    let d = v & 31
    v = Math.floor(v / 32)
    if (v) d |= 32
    s += alphabet[d]
  } while (v)
  return s
}
export function nativeSources(info) {
  const rows = new Map(),
    sources = [],
    contents = [],
    sourceIndex = new Map(),
    sidecars = new Map()
  for (const location of info.locations) {
    let file = location.file,
      line = location.line,
      column = location.column - 1,
      content
    if (!sidecars.has(file)) {
      let sidecar = null
      try {
        sidecar = JSON.parse(readFileSync(file + '.gea-source.json', 'utf8'))
      } catch {}
      sidecars.set(file, sidecar)
    }
    const sidecar = sidecars.get(file)
    if (sidecar && !sidecar.unmappedTransforms) {
      if (sidecar.map) {
        const position = originalPositionFor(new TraceMap(sidecar.map), {
          line,
          column,
        })
        if (!position.source || position.line === null) continue
        line = position.line
        column = position.column
      }
      file = sidecar.source
      content = sidecar.original
    } else if (sidecar) content = sidecar.staged
    if (content === undefined) {
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
    }
    const url = pathToFileURL(file).href
    let index = sourceIndex.get(url)
    if (index === undefined) {
      index = sources.length
      sourceIndex.set(url, index)
      sources.push(url)
      contents.push(content)
    }
    rows.set(location.nativeLine - 1, {
      source: index,
      line: line - 1,
      column,
      file: url,
    })
  }
  let count = 17
  for (const line of rows.keys()) count = Math.max(count, line + 17)
  const lines = Array(count).fill(''),
    segments = Array(count).fill('')
  let previousSource = 0,
    previousLine = 0,
    previousColumn = 0
  for (const [generated, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    lines[generated] = '; // Compiled native operation'
    segments[generated] =
      vlq(0) +
      vlq(row.source - previousSource) +
      vlq(row.line - previousLine) +
      vlq(row.column - previousColumn)
    previousSource = row.source
    previousLine = row.line
    previousColumn = row.column
  }
  return {
    rows,
    sources,
    source: lines.join('\n'),
    map: {
      version: 3,
      file: info.file,
      sources,
      sourcesContent: contents,
      names: [],
      mappings: segments.join(';'),
    },
  }
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
export async function launchOpenOCD({ executable, serial, env = process.env }) {
  if (serial && !/^[A-Za-z0-9:_-]+$/.test(serial))
    throw new Error('Invalid JTAG USB serial identity')
  const port = await freePort()
  const args = [
    '-c',
    'set ESP_FLASH_SIZE 0',
    '-f',
    'board/esp32s3-builtin.cfg',
    '-c',
    'bindto 127.0.0.1',
    '-c',
    `gdb port ${port}`,
    '-c',
    'tcl port disabled',
    '-c',
    'telnet port disabled',
  ]
  if (serial) args.push('-c', `adapter serial ${serial}`)
  const child = spawn(executable, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('OpenOCD startup timeout: ' + output.slice(-1200)))
    }, 15000)
    const read = (chunk) => {
      output = (output + chunk).slice(-16384)
      if (output.includes(`Listening on port ${port}`)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`OpenOCD exited (${code}): ${output.slice(-1200)}`))
    })
  })
  return {
    port,
    process: child,
    close() {
      if (child.exitCode === null) child.kill('SIGTERM')
    },
  }
}
const list = (entries, key) => (Array.isArray(entries) ? entries.map((e) => e[key] || e) : [])
export class NativeDebugger {
  constructor(mi, info) {
    this.mi = mi
    this.info = info
    this.sources = nativeSources(info)
    this.clients = new Map()
    this.breakpoints = new Map()
    this.breakpointsActive = true
    this.extraScripts = new Map()
    this.paused = false
    this.epoch = 0
    this.thread = '1'
    this.initializing = true
    this.control = Promise.resolve()
    this.stateWaiters = new Set()
    this.eventQueue = Promise.resolve()
    mi.onEvent((event) => {
      this.eventQueue = this.eventQueue
        .then(() => this.event(event))
        .catch((error) =>
          this.broadcast('Log.entryAdded', {
            entry: {
              source: 'other',
              level: 'error',
              text: error.message,
              timestamp: Date.now(),
            },
          }),
        )
    })
  }
  waitState(kind) {
    const pending = new Promise((resolve, reject) => {
      const waiter = {
        kind,
        resolve: () => {
          clearTimeout(timer)
          this.stateWaiters.delete(waiter)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          this.stateWaiters.delete(waiter)
          reject(error)
        },
      }
      const timer = setTimeout(
        () => waiter.reject(new Error('Native debugger state timeout: ' + kind)),
        15000,
      )
      this.stateWaiters.add(waiter)
    })
    pending.catch(() => {})
    return pending
  }
  state(kind) {
    for (const waiter of [...this.stateWaiters]) if (waiter.kind === kind) waiter.resolve()
  }
  async halted(action) {
    const running = !this.paused
    this.userPauseDuringControl = false
    if (running) {
      this.internalInterrupt = true
      const stopped = this.waitState('stopped')
      await this.mi.command('-exec-interrupt --all')
      await stopped
    }
    try {
      return await action()
    } finally {
      if (running && !this.userPauseDuringControl && this.paused) {
        this.internalResume = true
        await this.mi.command('-exec-continue')
      }
    }
  }
  broadcast(method, params) {
    for (const emit of this.clients.values()) emit(method, params)
  }
  async start(port) {
    await this.mi.command('-symbol-list-lines ' + q(this.info.file))
    await this.mi.command('-gdb-set pagination off')
    await this.mi.command('-gdb-set mi-async on')
    await this.mi.command('-target-select remote 127.0.0.1:' + port)
    await this.mi.command('-exec-continue')
    await this.eventQueue
    this.initializing = false
    this.paused = false
  }
  script() {
    return {
      scriptId: 'native-app',
      url: 'gea://native/' + this.info.file,
      startLine: 0,
      startColumn: 0,
      endLine: this.sources.source.split('\n').length - 1,
      endColumn: 0,
      executionContextId: 1,
      hash: createHash('sha256').update(this.sources.source).digest('hex'),
      sourceMapURL:
        'data:application/json;base64,' +
        Buffer.from(JSON.stringify(this.sources.map)).toString('base64'),
      hasSourceURL: true,
      isLiveEdit: false,
      scriptLanguage: 'JavaScript',
      length: this.sources.source.length,
    }
  }
  attach(owner, emit) {
    this.clients.set(owner, emit)
    emit('Debugger.scriptParsed', this.script())
    for (const { data } of this.extraScripts.values()) emit('Debugger.scriptParsed', data)
    if (this.paused && this.lastPaused) emit('Debugger.paused', this.lastPaused)
  }
  detach(owner) {
    this.clients.delete(owner)
  }
  async stepSource(mode) {
    this.stepMode = {
      mode,
      count: 0,
      origin: this.sources.rows.get(this.lastPaused?.callFrames[0]?.location.lineNumber),
    }
    if (this.breakpoints.size)
      await this.mi.command('-break-disable ' + [...this.breakpoints.values()].join(' '))
    try {
      if (mode === 'out') await this.finishSourceFrame()
      else await this.nextSourceInstruction(mode)
    } catch (error) {
      this.stepMode = null
      await this.clearTemporaryBreakpoint()
      if (this.breakpointsActive && this.breakpoints.size)
        await this.mi.command('-break-enable ' + [...this.breakpoints.values()].join(' '))
      throw error
    }
  }
  async nextSourceInstruction(mode) {
    const result = await this.mi.command('-data-disassemble -s "$pc" -e "$pc+8" -- 0')
    const instructions = result.asm_insns || [],
      instruction = instructions[0]?.inst || ''
    if (/^call(?:x)?(?:0|4|8|12)\s/.test(instruction) && instructions[1]?.address) {
      let enter = false
      if (mode === 'into') {
        const target = instruction.match(/\b0x[0-9a-f]+\b/i)?.[0]
        if (target) {
          const callee = await this.mi.command(
            `-data-disassemble -s "${target}" -e "${target}+64" -- 1`,
          )
          enter = (callee.asm_insns || []).some(
            (entry) => path.basename(entry.src_and_asm_line?.file || '') === this.info.file,
          )
        }
      }
      if (!enter) {
        await this.continueToAddress(instructions[1].address)
        return
      }
    }
    await this.mi.command('-exec-step-instruction --thread ' + this.thread)
  }
  async continueToAddress(address) {
    const breakpoint = await this.mi.command('-break-insert -h -t *' + address)
    this.temporaryBreakpoint = breakpoint.bkpt?.number
    await this.mi.command('-exec-continue --thread ' + this.thread)
  }
  async clearTemporaryBreakpoint() {
    if (this.temporaryBreakpoint) {
      await this.mi.command('-break-delete ' + this.temporaryBreakpoint)
      this.temporaryBreakpoint = null
    }
  }
  async finishSourceFrame() {
    const stack = await this.mi.command('-stack-list-frames --thread ' + this.thread + ' 0 1')
    const caller = list(stack.stack, 'frame')[1]
    if (!caller?.addr) throw new Error('No native caller available for Step Out')
    await this.continueToAddress(caller.addr)
  }
  async continueSourceStep(event) {
    if (event.bkptno?.split('.')[0] === this.temporaryBreakpoint) this.temporaryBreakpoint = null
    const step = this.stepMode
    if (!step) return false
    if (event.reason === 'signal-received') {
      this.stepMode = null
      return false
    }
    if (++step.count > 500) {
      this.stepMode = null
      this.broadcast('Log.entryAdded', {
        entry: {
          source: 'other',
          level: 'warning',
          text: 'Native source step reached the instruction limit; paused at the actual native frame',
          timestamp: Date.now(),
        },
      })
      return false
    }
    const frame = event.frame || {}
    const row =
      path.basename(frame.file || '') === this.info.file
        ? this.sources.rows.get(Number(frame.line) - 1)
        : undefined
    const atNewSource =
      row &&
      (!step.origin ||
        row.file !== step.origin.file ||
        row.line !== step.origin.line ||
        row.column !== step.origin.column)
    if (atNewSource) {
      this.stepMode = null
      return false
    }
    if (step.mode === 'out') step.mode = 'over'
    this.internalResume = true
    await this.nextSourceInstruction(step.mode)
    return true
  }
  scriptForFrame(frame) {
    if (path.basename(frame.file || '') === this.info.file)
      return {
        scriptId: 'native-app',
        lineNumber: Math.max(0, Number(frame.line || 1) - 1),
        columnNumber: 0,
      }
    const file = frame.fullname || frame.file || ''
    const scriptId = 'native-' + createHash('sha256').update(file).digest('hex').slice(0, 16)
    if (!this.extraScripts.has(scriptId)) {
      let source = '// Native frame: ' + (frame.func || frame.addr || 'unknown')
      try {
        source = readFileSync(file, 'utf8')
      } catch {}
      const data = {
        scriptId,
        url: file ? pathToFileURL(path.resolve(file)).href : 'gea://native/runtime',
        startLine: 0,
        startColumn: 0,
        endLine: source.split('\n').length - 1,
        endColumn: 0,
        executionContextId: 1,
        hash: createHash('sha256').update(source).digest('hex'),
        length: source.length,
        hasSourceURL: true,
        isLiveEdit: false,
        scriptLanguage: 'JavaScript',
      }
      this.extraScripts.set(scriptId, { source, data })
      this.broadcast('Debugger.scriptParsed', data)
    }
    const source = this.extraScripts.get(scriptId).source
    return {
      scriptId,
      lineNumber: Math.max(0, Math.min(Number(frame.line || 1) - 1, source.split('\n').length - 1)),
      columnNumber: 0,
    }
  }
  async event(event) {
    if (event.kind === 'running') {
      this.paused = false
      this.onStateChange?.(false)
      this.state('running')
      if (this.internalResume) {
        this.internalResume = false
        return
      }
      if (!this.initializing) this.broadcast('Debugger.resumed', {})
      return
    }
    if (event.kind === 'closed') {
      for (const waiter of [...this.stateWaiters]) waiter.reject(event.error)
      this.broadcast('Inspector.detached', { reason: event.error.message })
      return
    }
    if (event.kind !== 'stopped') return
    this.paused = true
    this.onStateChange?.(true)
    this.thread = event['thread-id'] || this.thread
    this.state('stopped')
    if (this.internalInterrupt) {
      this.internalInterrupt = false
      if (event.reason !== 'breakpoint-hit') return
      this.userPauseDuringControl = true
    }
    if (this.initializing || this.closing) return
    const wasStepping = !!this.stepMode
    try {
      if (await this.continueSourceStep(event)) return
    } catch (error) {
      this.stepMode = null
      this.broadcast('Log.entryAdded', {
        entry: {
          source: 'other',
          level: 'warning',
          text: 'Native step stopped: ' + error.message,
          timestamp: Date.now(),
        },
      })
    }
    await this.clearTemporaryBreakpoint()
    if (this.breakpointsActive && this.breakpoints.size)
      await this.mi.command('-break-enable ' + [...this.breakpoints.values()].join(' '))
    this.epoch++
    const stack = await this.mi.command('-stack-list-frames --thread ' + this.thread + ' 0 30')
    const callFrames = list(stack.stack, 'frame').map((frame) => ({
      callFrameId: `gdb-frame-${this.epoch}-${frame.level}`,
      functionName: frame.func || '(native)',
      location: this.scriptForFrame(frame),
      url:
        frame.file === this.info.file
          ? 'gea://native/' + this.info.file
          : frame.fullname || frame.file || '',
      scopeChain: [
        {
          type: 'local',
          name: 'Native C++ locals',
          object: {
            type: 'object',
            objectId: `gdb-scope-${this.epoch}-${frame.level}`,
            description: 'Native C++ locals',
          },
        },
      ],
      this: { type: 'undefined' },
    }))
    this.lastPaused = {
      callFrames,
      data: {
        nativeReason: event.reason,
        nativeFrame: event.frame,
        thread: this.thread,
        signal: event['signal-name'],
      },
      reason: wasStepping
        ? 'step'
        : event.reason === 'breakpoint-hit'
          ? 'other'
          : event.reason === 'signal-received'
            ? 'debugCommand'
            : 'step',
      hitBreakpoints:
        event.bkptno && this.breakpoints.has(`gdb-${event.bkptno.split('.')[0]}`)
          ? [`gdb-${event.bkptno.split('.')[0]}`]
          : [],
    }
    this.broadcast('Debugger.paused', this.lastPaused)
  }
  frame(id, prefix = 'gdb-frame-') {
    if (!this.paused || this.stepMode || !id?.startsWith(prefix))
      throw new Error('The native app is not paused')
    if (!/^\d+-\d+$/.test(id.slice(prefix.length))) throw new Error('Invalid native call frame')
    const [epoch, level] = id.slice(prefix.length).split('-')
    if (Number(epoch) !== this.epoch) throw new Error('Stale native call frame')
    return level
  }
  async properties(id) {
    const level = this.frame(id, 'gdb-scope-')
    const r = await this.mi.command(
      `-stack-list-variables --thread ${this.thread} --frame ${level} --simple-values`,
    )
    return {
      result: (r.variables || []).map((v) => ({
        name: v.name,
        isOwn: true,
        enumerable: true,
        configurable: false,
        value: {
          type: 'string',
          value: v.value ?? '<native aggregate>',
          description: `${v.type || 'native'}: ${v.value ?? '<expand using a native expression>'}`,
        },
      })),
    }
  }
  handle(owner, emit, method, p = {}) {
    if (this.closing) return Promise.reject(new Error('Native debugger is closing'))
    const result = this.control.then(() => this.handleCommand(owner, emit, method, p))
    this.control = result.catch(() => {})
    return result
  }
  async handleCommand(owner, emit, method, p = {}) {
    if (method === 'Debugger.enable') {
      this.attach(owner, emit)
      return { debuggerId: 'gea-native-jtag' }
    }
    if (method === 'Debugger.disable') {
      this.detach(owner)
      return {}
    }
    if (method === 'Debugger.getScriptSource') {
      if (p.scriptId !== 'native-app') {
        const extra = this.extraScripts.get(p.scriptId)
        if (!extra) throw new Error('Unknown native script')
        return { scriptSource: extra.source }
      }
      return { scriptSource: this.sources.source }
    }
    if (method === 'Debugger.getPossibleBreakpoints') {
      if (p.start.scriptId !== 'native-app') return { locations: [] }
      const r = await this.mi.command('-symbol-list-lines ' + q(this.info.file))
      const lines = [
        ...new Set(
          (r.lines || [])
            .filter((e) => this.sources.rows.has(Number(e.line) - 1) && parseInt(e.pc, 16) > 0)
            .map((e) => Number(e.line) - 1),
        ),
      ].sort((a, b) => a - b)
      return {
        locations: lines
          .filter(
            (line) =>
              (line > p.start.lineNumber ||
                (line === p.start.lineNumber && !(p.start.columnNumber > 0))) &&
              (!p.end ||
                line < p.end.lineNumber ||
                (line === p.end.lineNumber && p.end.columnNumber > 0)),
          )
          .map((line) => ({
            scriptId: 'native-app',
            lineNumber: line,
            columnNumber: 0,
          })),
      }
    }
    if (method === 'Debugger.setBreakpoint' || method === 'Debugger.setBreakpointByUrl') {
      if (p.location && p.location.scriptId !== 'native-app')
        throw new Error('Breakpoints are available only in mapped app source')
      if (p.urlRegex) throw new Error('Native breakpoint URLs must be explicit')
      let line = p.location?.lineNumber ?? p.lineNumber
      if (p.url && p.url !== 'gea://native/' + this.info.file) {
        const rows = [...this.sources.rows].filter(
          ([, r]) =>
            r.file === p.url &&
            (r.line > p.lineNumber ||
              (r.line === p.lineNumber && r.column >= (p.columnNumber || 0))),
        )
        rows.sort((a, b) => a[1].line - b[1].line || a[1].column - b[1].column || a[0] - b[0])
        if (!rows.length) throw new Error('No native source location for this breakpoint')
        line = rows[0][0]
      }
      if (!Number.isInteger(line) || !this.sources.rows.has(line))
        throw new Error('This source position has no emitted native operation')
      if (p.condition)
        throw new Error('JavaScript breakpoint conditions are unavailable on native firmware')
      return this.halted(async () => {
        if (this.breakpoints.size >= 2)
          throw new Error('ESP32-S3 has two hardware breakpoint slots; remove a breakpoint first')
        const r = await this.mi.command('-break-insert -h ' + q(this.info.file + ':' + (line + 1)))
        const b = r.bkpt
        const id = 'gdb-' + b.number
        this.breakpoints.set(id, b.number)
        const location = {
          scriptId: 'native-app',
          lineNumber: Number(b.line || line + 1) - 1,
          columnNumber: 0,
        }
        return method === 'Debugger.setBreakpoint'
          ? { breakpointId: id, actualLocation: location }
          : { breakpointId: id, locations: [location] }
      })
    }
    if (method === 'Debugger.removeBreakpoint') {
      const number = this.breakpoints.get(p.breakpointId)
      if (number)
        await this.halted(async () => {
          await this.mi.command('-break-delete ' + number)
          this.breakpoints.delete(p.breakpointId)
        })
      return {}
    }
    if (method === 'Debugger.setBreakpointsActive') {
      this.breakpointsActive = p.active
      if (this.breakpoints.size)
        await this.halted(() =>
          this.mi.command(
            (p.active ? '-break-enable ' : '-break-disable ') +
              [...this.breakpoints.values()].join(' '),
          ),
        )
      return {}
    }
    if (method === 'Debugger.pause') {
      this.stepMode = null
      if (!this.paused) await this.mi.command('-exec-interrupt --all')
      return {}
    }
    if (
      ['Debugger.resume', 'Debugger.stepOver', 'Debugger.stepInto', 'Debugger.stepOut'].includes(
        method,
      )
    ) {
      if (method === 'Debugger.resume' && !this.paused) {
        this.stepMode = null
        return {}
      }
      if (!this.paused) throw new Error('The native app is not paused')
      if (method === 'Debugger.resume') {
        this.stepMode = null
        await this.clearTemporaryBreakpoint()
        if (this.breakpointsActive && this.breakpoints.size)
          await this.mi.command('-break-enable ' + [...this.breakpoints.values()].join(' '))
        await this.mi.command('-exec-continue')
      } else
        await this.stepSource(
          {
            'Debugger.stepOver': 'over',
            'Debugger.stepInto': 'into',
            'Debugger.stepOut': 'out',
          }[method],
        )
      return {}
    }
    if (method === 'Debugger.evaluateOnCallFrame') {
      const level = this.frame(p.callFrameId)
      const r = await this.mi.command(
        `-data-evaluate-expression --thread ${this.thread} --frame ${level} ${q(p.expression)}`,
      )
      const value = Number(r.value)
      return {
        result: Number.isFinite(value)
          ? { type: 'number', value }
          : {
              type: 'string',
              value: r.value,
              description: 'Native C++ expression: ' + r.value,
            },
      }
    }
    if (
      [
        'Debugger.setAsyncCallStackDepth',
        'Debugger.setBlackboxPatterns',
        'Debugger.setBlackboxedRanges',
        'Debugger.setPauseOnExceptions',
        'Debugger.setSkipAllPauses',
      ].includes(method)
    )
      return {}
    return undefined
  }
  async close() {
    this.closing = true
    this.stepMode = null
    this.clients.clear()
    await this.control.catch(() => {})
    await this.eventQueue
    try {
      await this.halted(async () => {
        await this.mi.command('-break-delete')
        this.breakpoints.clear()
        this.temporaryBreakpoint = null
      })
      await this.eventQueue
      if (this.paused) {
        const running = this.waitState('running')
        await this.mi.command('-exec-continue')
        await running
      }
    } catch {}
    await this.mi.close()
  }
}
export function selectNativeDebugBuild(builds, firmwareElfHash, readFile = readFileSync) {
  if (firmwareElfHash) {
    for (const build of builds) {
      if (createHash('sha256').update(readFile(build.elf)).digest('hex') === firmwareElfHash)
        return build
    }
  }
  throw new Error(
    'Native ELF does not match running firmware in any local debug build; rebuild without --attach before debugging source',
  )
}

export async function createNativeDebugger({
  elf,
  metadata,
  builds,
  gdbExecutable,
  openocdExecutable,
  serial,
  env = process.env,
  firmwareElfHash,
}) {
  const build = selectNativeDebugBuild(builds || [{ elf, metadata }], firmwareElfHash)
  elf = build.elf
  metadata = build.metadata
  if (!existsSync(metadata))
    throw new Error('Native source metadata is missing; rebuild without --attach')
  const info = JSON.parse(readFileSync(metadata, 'utf8'))
  const openocd = await launchOpenOCD({
    executable: openocdExecutable,
    serial,
    env,
  })
  const mi = new GdbMI(gdbExecutable, elf, { env })
  const debuggerState = new NativeDebugger(mi, info)
  try {
    await debuggerState.start(openocd.port)
  } catch (error) {
    await debuggerState.close()
    openocd.close()
    throw error
  }
  const close = debuggerState.close.bind(debuggerState)
  debuggerState.close = async () => {
    await close()
    openocd.close()
  }
  return debuggerState
}
