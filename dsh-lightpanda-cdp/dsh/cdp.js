// Lightpanda CDP transport, zero dependencies.
//
// Why this is not just `new WebSocket(url)`:
//   Lightpanda validates the HTTP `Host` header of both its JSON endpoints and
//   its WebSocket upgrade, accepting only loopback forms. Reaching it as
//   `lightpanda:9222` from another container therefore answers `403 Host not
//   allowed`. Node's global WebSocket (undici) cannot override `Host`, so this
//   module drives `node:http` directly and sets the header itself.
//
// Second non-obvious constraint: Lightpanda ties target lifetime to the CDP
// connection. Closing the socket destroys the tabs created on it, so the plugin
// keeps ONE long-lived connection and re-attaches sessions across tool calls.
import http from 'node:http'
import crypto from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Loopback Host value Lightpanda's allow-list accepts. Measured: only the
 * hostname is checked (127.0.0.1, localhost and 0.0.0.0 all pass, any port
 * passes), so the default stays port-independent.
 */
export const defaultHostHeader = () => '127.0.0.1'

export const DEFAULTS = { host: 'lightpanda', port: 9222, hostHeader: '127.0.0.1', timeoutMs: 30_000 }

/** Where the editable endpoint file lives unless the plugin config overrides it. */
export function resolveConfigPath(pluginConfig = {}) {
  if (pluginConfig.configPath) return String(pluginConfig.configPath)
  // The plugin runs in the DSH host process, which does not carry
  // DSH_PROFILE_DIR (that is a shell-tool variable), so anchor on the harness
  // home and keep the per-plugin data directory convention.
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugins-data', 'lightpanda-cdp', 'config.json')
}

/** Endpoint overrides read from the environment, for compose/systemd deployments. */
export function envEndpoint(env = process.env) {
  const endpoint = {}
  if (env.LIGHTPANDA_CDP_URL) {
    try {
      const url = new URL(env.LIGHTPANDA_CDP_URL)
      if (url.hostname) endpoint.host = url.hostname
      if (url.port) endpoint.port = Number(url.port)
    } catch { /* an unparsable URL falls through to the other variables */ }
  }
  if (env.LIGHTPANDA_CDP_HOST) endpoint.host = env.LIGHTPANDA_CDP_HOST
  if (env.LIGHTPANDA_CDP_PORT && Number.isFinite(Number(env.LIGHTPANDA_CDP_PORT))) {
    endpoint.port = Number(env.LIGHTPANDA_CDP_PORT)
  }
  if (env.LIGHTPANDA_CDP_HOST_HEADER) endpoint.hostHeader = env.LIGHTPANDA_CDP_HOST_HEADER
  if (env.LIGHTPANDA_CDP_TIMEOUT_MS && Number.isFinite(Number(env.LIGHTPANDA_CDP_TIMEOUT_MS))) {
    endpoint.timeoutMs = Number(env.LIGHTPANDA_CDP_TIMEOUT_MS)
  }
  return endpoint
}

const ENDPOINT_KEYS = ['host', 'port', 'hostHeader', 'timeoutMs']

/**
 * Layered endpoint settings, most specific first: per-call arguments, then the
 * environment, then the editable JSON file, then the plugin config, then the
 * built-in default. The file is re-read whenever its mtime moves, so editing it
 * takes effect on the next call without restarting anything.
 */
export class EndpointStore {
  constructor(pluginConfig = {}) {
    this.config = pluginConfig ?? {}
    this.path = resolveConfigPath(this.config)
    this.cached = {}
    this.cachedMtime = -1
    this.warning = null
  }

  /** The parsed settings file, cached until its mtime changes. */
  file() {
    let stat
    try {
      stat = statSync(this.path)
    } catch {
      this.cached = {}
      this.cachedMtime = -1
      this.warning = null
      return this.cached
    }
    if (stat.mtimeMs === this.cachedMtime) return this.cached
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      this.cached = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      this.warning = null
    } catch (err) {
      this.cached = {}
      this.warning = `ignoring ${this.path}: ${err.message}`
    }
    this.cachedMtime = stat.mtimeMs
    return this.cached
  }

  /** Resolve one call's endpoint and report which layer supplied each field. */
  resolve(overrides = {}) {
    const env = envEndpoint()
    const file = this.file()
    const pick = (key) => {
      const candidates = [
        ['call', overrides[key]],
        ['env', env[key]],
        ['file', file[key]],
        ['config', this.config[key]],
        ['default', DEFAULTS[key]],
      ]
      const found = candidates.find(([, value]) => value !== undefined && value !== null && value !== '')
      return found ?? ['default', undefined]
    }
    const endpoint = {}
    const sources = {}
    for (const key of ENDPOINT_KEYS) {
      const [layer, value] = pick(key)
      endpoint[key] = key === 'host' || key === 'hostHeader' ? String(value) : Number(value)
      sources[key] = layer
    }
    if (!Number.isFinite(endpoint.port) || endpoint.port <= 0) {
      endpoint.port = DEFAULTS.port
      sources.port = 'default'
    }
    if (!Number.isFinite(endpoint.timeoutMs) || endpoint.timeoutMs <= 0) {
      endpoint.timeoutMs = DEFAULTS.timeoutMs
      sources.timeoutMs = 'default'
    }
    if (!endpoint.hostHeader) {
      endpoint.hostHeader = defaultHostHeader()
      sources.hostHeader = 'default'
    }
    return { ...endpoint, sources }
  }

  /** Merge the given fields into the settings file; returns the saved object. */
  save(patch) {
    const current = { ...this.file() }
    for (const key of ENDPOINT_KEYS) {
      if (patch[key] === undefined || patch[key] === null) continue
      current[key] = key === 'host' || key === 'hostHeader' ? String(patch[key]) : Number(patch[key])
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
    this.cached = current
    this.cachedMtime = statSync(this.path).mtimeMs
    return current
  }

  /** Delete the settings file so the endpoint falls back to env/config/default. */
  reset() {
    try {
      unlinkSync(this.path)
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    } finally {
      this.cached = {}
      this.cachedMtime = -1
    }
  }
}

const describeEndpoint = (ep) => `${ep.host}:${ep.port} (Host: ${ep.hostHeader})`

function connectionHint(ep, cause) {
  return new Error(
    `Cannot reach the Lightpanda CDP endpoint at ${describeEndpoint(ep)}: ${cause}\n`
    + 'Check that the container is running and reachable from the DSH host, and that the port is right. '
    + 'If the server answers 403 "Host not allowed", set the "hostHeader" config to 127.0.0.1:<port>.',
  )
}

/** GET a JSON endpoint on the CDP server with an explicit Host header. */
export function httpJson(ep, path, { method = 'GET', timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: ep.host,
      port: ep.port,
      path,
      method,
      agent: false,
      headers: { Host: ep.hostHeader, Accept: 'application/json' },
    })
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    req.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        clearTimeout(timer)
        if (res.statusCode === 403) {
          reject(new Error(
            `HTTP 403 from ${path} on ${describeEndpoint(ep)} — the Host header was rejected. `
            + 'Set the plugin "hostHeader" config to 127.0.0.1:<port>.',
          ))
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${path}: ${body.slice(0, 300)}`))
          return
        }
        try {
          resolve(body.length === 0 ? null : JSON.parse(body))
        } catch {
          reject(new Error(`Non-JSON response from ${path}: ${body.slice(0, 200)}`))
        }
      })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(connectionHint(ep, err.message))
    })
    req.end()
  })
}

/** Minimal RFC 6455 client: text frames out, masked, fragmentation-aware in. */
class FrameSocket {
  constructor(ep) {
    this.ep = ep
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const req = http.request({
        host: this.ep.host,
        port: this.ep.port,
        path: '/',
        agent: false,
        headers: {
          Host: this.ep.hostHeader,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      })
      req.on('upgrade', (_res, socket) => {
        this.socket = socket
        socket.setNoDelay(true)
        socket.on('data', (chunk) => this.#read(chunk))
        resolve()
      })
      req.on('response', (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode === 403) {
            reject(new Error(
              `HTTP 403 during the WebSocket upgrade to ${describeEndpoint(this.ep)} — the Host header was rejected. `
              + 'Set the plugin "hostHeader" config to 127.0.0.1:<port>.',
            ))
            return
          }
          reject(new Error(`WebSocket upgrade refused: HTTP ${res.statusCode} ${body.slice(0, 200)}`))
        })
      })
      req.on('error', (err) => reject(connectionHint(this.ep, err.message)))
      req.end()
    })
  }

  send(text) {
    if (!this.socket) throw new Error('WebSocket is not open')
    const payload = Buffer.from(text, 'utf8')
    const length = payload.length
    const header = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10)
    header[0] = 0x81 // FIN + text
    if (length < 126) {
      header[1] = 0x80 | length
    } else if (length < 65_536) {
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    const mask = crypto.randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  #read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const shortLength = second & 0x7f
      let offset = 2
      let length = shortLength
      if (shortLength === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (shortLength === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) return
      let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length)
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.from(payload)
        for (let i = 0; i < unmasked.length; i += 1) unmasked[i] ^= mask[i % 4]
        payload = unmasked
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length)

      if (opcode === 0x9) { // ping
        try { this.socket.write(Buffer.from([0x8a, 0x00])) } catch { /* closing */ }
        continue
      }
      if (opcode === 0x8) { // close
        try { this.socket.end() } catch { /* already closed */ }
        this.onClose?.()
        return
      }
      if (opcode === 0x1 || opcode === 0x2) {
        this.fragments = [payload]
        this.fragmentOpcode = opcode
        if (!fin) continue
      } else if (opcode === 0x0) {
        this.fragments.push(payload)
        if (!fin) continue
      } else {
        continue
      }
      const complete = Buffer.concat(this.fragments)
      const isText = this.fragmentOpcode === 0x1
      this.fragments = []
      if (isText) this.onMessage?.(complete.toString('utf8'))
    }
  }

  close() {
    try { this.socket?.end() } catch { /* already closed */ }
  }
}

/** One CDP connection: JSON-RPC over the socket plus an event fan-out. */
export class CdpClient {
  constructor(ep) {
    this.ep = ep
    this.frame = new FrameSocket(ep)
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
  }

  static async connect(ep) {
    const client = new CdpClient(ep)
    await client.frame.open()
    client.frame.onMessage = (text) => client.#dispatch(text)
    client.frame.onClose = () => client.#teardown(new Error('CDP connection closed'))
    return client
  }

  #dispatch(text) {
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(`${message.error.message} (${message.error.code})`)
        error.cdpCode = message.error.code
        entry.reject(error)
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (!message.method) return
    const key = `${message.sessionId ?? ''}|${message.method}`
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener(message.params)
  }

  #teardown(error) {
    if (this.closed) return
    this.closed = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    this.listeners.clear()
  }

  send(method, params = {}, sessionId, timeoutMs = this.ep.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'))
    const id = ++this.nextId
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.frame.send(JSON.stringify(message))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  /** Resolve on the next matching event; rejects on timeout. */
  waitEvent(method, { sessionId, timeoutMs = 15_000 } = {}) {
    const key = `${sessionId ?? ''}|${method}`
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(key) ?? []
      let settled = false
      const listener = (params) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
        resolve(params)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`))
      }, timeoutMs)
      listeners.push(listener)
      this.listeners.set(key, listeners)
    })
  }

  close() {
    this.#teardown(new Error('CDP connection closed by plugin'))
    this.frame.close()
  }
}

const isMissingSession = (message) => /session|target|detached|not found/i.test(message)

/**
 * Long-lived connection plus target bookkeeping. Lightpanda destroys its targets
 * when the CDP connection closes, so the connection is kept warm and the
 * target/session pairs are cached between tool calls.
 */
export class Bridge {
  constructor(getEndpoint) {
    this.getEndpoint = getEndpoint
    this.client = null
    this.sessions = new Map()
    this.lastTargetId = null
  }

  async connection() {
    const ep = this.getEndpoint()
    const same = this.client && this.client.ep.host === ep.host
      && this.client.ep.port === ep.port && this.client.ep.hostHeader === ep.hostHeader
    if (same && !this.client.closed) return this.client
    if (this.client) {
      this.client.close()
      this.client = null
      this.sessions.clear()
      this.lastTargetId = null
    }
    this.client = await CdpClient.connect(ep)
    return this.client
  }

  /** Attach to an existing target, or create one, returning its session id. */
  async attach(targetId) {
    const client = await this.connection()
    const cached = this.sessions.get(targetId)
    if (cached) return { client, sessionId: cached, targetId }
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessions.set(targetId, sessionId)
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    return { client, sessionId, targetId }
  }

  /** Create a blank target (Lightpanda answers 404 on /json/new) and attach. */
  async createTarget() {
    const client = await this.connection()
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const attached = await this.attach(targetId)
    this.lastTargetId = targetId
    return attached
  }

  /**
   * Resolve the session for one call: the given target, else the plugin's last
   * one, else a fresh tab. A stale id (connection restarted, tab closed) falls
   * back to a new tab instead of failing the call.
   */
  async session(targetId) {
    const wanted = targetId ?? this.lastTargetId
    if (wanted) {
      try {
        const attached = await this.attach(wanted)
        this.lastTargetId = wanted
        return attached
      } catch (err) {
        if (!isMissingSession(err.message)) throw err
        this.sessions.delete(wanted)
        if (wanted === this.lastTargetId) this.lastTargetId = null
      }
    }
    return this.createTarget()
  }

  /** All live page targets of the current connection. */
  async targets() {
    const client = await this.connection()
    const { targetInfos } = await client.send('Target.getTargets')
    return targetInfos.filter((info) => !info.type || info.type === 'page')
  }

  async closeTarget(targetId) {
    const client = await this.connection()
    const result = await client.send('Target.closeTarget', { targetId })
    this.sessions.delete(targetId)
    if (this.lastTargetId === targetId) this.lastTargetId = null
    return result
  }

  reset() {
    this.sessions.clear()
    this.lastTargetId = null
    if (this.client) {
      this.client.close()
      this.client = null
    }
  }
}

/** Navigate the given target and wait for the requested load condition. */
export async function navigate(client, sessionId, url, until = 'load', timeoutMs = 20_000) {
  if (until === 'settled') {
    const pending = client.waitEvent('Page.loadEventFired', { sessionId, timeoutMs }).catch(() => null)
    await client.send('Page.navigate', { url }, sessionId, timeoutMs)
    await pending
    await client.send('LP.waitUntil', { until: 'settled', timeout: timeoutMs }, sessionId, timeoutMs)
    return
  }
  if (until === 'none') {
    await client.send('Page.navigate', { url }, sessionId, timeoutMs)
    return
  }
  const event = until === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired'
  // Register before navigating: a cached page can fire the event before
  // Page.navigate resolves on this side.
  const pending = client.waitEvent(event, { sessionId, timeoutMs }).catch(() => null)
  await client.send('Page.navigate', { url }, sessionId, timeoutMs)
  await pending
}
