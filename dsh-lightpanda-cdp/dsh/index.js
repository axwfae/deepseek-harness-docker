// DeepSeek Harness plugin: drive a Lightpanda headless browser over CDP.
//
// Design notes that shaped this file:
//   * Tools are plain JSON-Schema definitions registered on `ctx.tools`, with no
//     imports from dsh packages: a profile-installed bundle cannot resolve the
//     dsh package tree, so the plugin validates its own arguments.
//   * Lightpanda links target lifetime to the CDP connection and rejects
//     non-loopback Host headers, so all transport work goes through ./cdp.js,
//     which keeps one warm socket and sets the Host header explicitly.
//   * Lightpanda ships its own LP domain (dump / clickNode / fillNode /
//     waitForSelector / getInteractiveElements / getStructuredData /
//     getPageStatus). Those are preferred over generic CDP because they return
//     agent-sized structures; generic Runtime/Input/Page calls are the fallback.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Bridge, DEFAULTS, EndpointStore, envEndpoint, httpJson, navigate } from './cdp.js'

export const name = 'lightpanda-cdp'
export const inject = ['tools']

const DEFAULT_READ_CHARS = 60_000
const text = (string) => [{ type: 'text', text: string }]
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const renderText = (_args, value) => text(asText(value))
// The enforced JSON Schema subset requires an output schema; every tool here
// returns an object whose keys vary per action, so the schema stays open.
const outputDefinition = {
  schema: { type: 'object', additionalProperties: true },
  render: renderText,
}
const callView = (title, kind = 'fetch') => (args) => ({
  card: 'generic',
  title,
  kind,
  rawInput: args,
})
const resultView = (title) => () => ({ card: 'generic', title })

/** Thrown when the caller passes an argument the schema cannot express. */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

/** Read the page identity of a session: url, title, http status. */
async function pageIdentity(client, sessionId) {
  const evaluate = (expression) => client
    .send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    .then((result) => result?.result?.value)
    .catch(() => null)
  const [url, title] = await Promise.all([evaluate('location.href'), evaluate('document.title')])
  return { url, title }
}

/** Install the tools against the given plugin config. */
export function apply(ctx, config) {
  const settings = config ?? {}
  const store = new EndpointStore(settings)
  const bridge = new Bridge(() => store.resolve())
  const endpointFor = (args) => store.resolve({
    host: args?.host,
    port: args?.port,
    hostHeader: args?.hostHeader,
  })
  const shared = {
    host: { type: 'string', description: 'CDP host override (default: the plugin config host).' },
    port: { type: 'number', description: 'CDP port override (default: the plugin config port).' },
  }

  ctx.effect(() => () => bridge.reset())

  // -- Prompt guidance ------------------------------------------------------
  //
  // The tools exist but nothing tells the model when to prefer them, so a
  // plain fetch tool wins by default. This section states the division of
  // labour and disappears when the tools are not visible to the asking agent.
  const PROMPT_GUIDANCE = [
    'Find URLs with a search tool, then read the body with a plain fetch tool (donsetch_web_fetch, read_page, web_fetch).',
    'Switch to the lp_* tools only when the body needs JavaScript to appear, when reaching it needs clicking, filling or scrolling, when you need a screenshot as evidence, or when you must run JavaScript inside the page.',
    'lp_read output is coarser than a fetch tool markdown extraction: never use it for plain text retrieval.',
    'A Lightpanda tab lives inside one warm CDP connection, so reuse the targetId lp_open returns and call lp_close when done.',
  ].join(' ')

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptScope) => {
      const order = typeof promptScope.systemPrompt.getSectionOrder === 'function'
        ? promptScope.systemPrompt.getSectionOrder('TOOL_WEB_FETCH') + 10
        : 2_150
      promptScope.effect(
        () => promptScope.systemPrompt.section({
          name: 'tool:lightpanda',
          order,
          text: ({ scope, toolSet }) => (ctx.tools.get('lp_open', scope, toolSet) === undefined
            ? ''
            : PROMPT_GUIDANCE),
        }),
        'lightpanda-cdp: prompt section',
      )
    })
  }

  // -- Plugin configuration page (client.js card over this JSON route) ------
  //
  // The Plugins page renders only cards a plugin registers itself, so the host
  // half serves the endpoint over HTTP and client.js draws the form. The route
  // is registered through a scoped inject: reading an undeclared service during
  // apply would abort the whole plugin in hosts without a web server.
  const configRoute = {
    name: 'lightpanda-cdp-config',
    kind: 'exact',
    path: '/lightpanda-cdp/config',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      }

      const snapshot = async () => {
        const endpoint = store.resolve()
        let probe
        try {
          const version = await httpJson(endpoint, '/json/version', {
            timeoutMs: Math.min(endpoint.timeoutMs, 4_000),
          })
          probe = {
            ok: true,
            browser: version.Browser ?? null,
            lightpanda: version['Lightpanda-Version'] ?? null,
          }
        } catch (err) {
          probe = { ok: false, error: String(err?.message ?? err).split('\n')[0] }
        }
        return {
          endpoint: {
            host: endpoint.host,
            port: endpoint.port,
            hostHeader: endpoint.hostHeader,
            timeoutMs: endpoint.timeoutMs,
          },
          sources: endpoint.sources,
          defaults: { ...DEFAULTS },
          env: Object.fromEntries(
            Object.entries(envEndpoint()).filter(([, value]) => value !== undefined),
          ),
          configPath: store.path,
          probe,
          ...(store.warning ? { warning: store.warning } : {}),
        }
      }

      if (req.method === 'GET') {
        try {
          send(200, await snapshot())
        } catch (err) {
          send(500, { error: String(err?.message ?? err) })
        }
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }

      const chunks = []
      let total = 0
      for await (const chunk of req) {
        total += chunk.length
        if (total > 8_192) {
          send(413, { error: 'request body too large' })
          return
        }
        chunks.push(chunk)
      }
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        send(400, { error: 'body must be JSON' })
        return
      }

      try {
        if (payload?.reset === true) {
          store.reset()
        } else {
          const patch = {}
          if (payload?.host !== undefined) {
            const host = String(payload.host).trim()
            if (!host) throw new Error('host must not be empty')
            patch.host = host
          }
          if (payload?.port !== undefined) {
            const port = Number(payload.port)
            if (!Number.isInteger(port) || port < 1 || port > 65_535) {
              throw new Error('port must be an integer between 1 and 65535')
            }
            patch.port = port
          }
          if (payload?.hostHeader !== undefined) {
            const hostHeader = String(payload.hostHeader).trim()
            if (!hostHeader) throw new Error('hostHeader must not be empty')
            patch.hostHeader = hostHeader
          }
          if (payload?.timeoutMs !== undefined) {
            const timeoutMs = Number(payload.timeoutMs)
            if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
              throw new Error('timeoutMs must be at least 1000')
            }
            patch.timeoutMs = timeoutMs
          }
          if (Object.keys(patch).length === 0) throw new Error('nothing to save')
          store.save(patch)
        }
        bridge.reset()
        send(200, await snapshot())
      } catch (err) {
        send(400, { error: String(err?.message ?? err) })
      }
    },
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(
        () => scope.webServer.register(configRoute),
        'lightpanda-cdp: config page route',
      )
    })
  }
  
  const provider = {
    id: 'lightpanda-fetch',
    title: 'Lightpanda（远端 CDP）',
    available() { return true },
    async fetch(request, signal) {
      const { client, sessionId, targetId } = await bridge.createTarget()
      try {
        await navigate(client, sessionId, url, 'load', endpoint.timeoutMs)
        const dump = await client.send('LP.dump', { format: 'markdown', maxBytes: 2_000_000 }, sessionId)
        return { url, statusCode: 200, body: { kind: 'text', content }, truncated }
      } finally { await bridge.closeTarget(targetId).catch(() => {}) }
    },
  }
  scope.effect(() => seam.registerFetchProvider(provider), 'lightpanda-cdp: web fetch provider')
  
  // -- lp_config ------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_config',
    description:
      'Read or change where the Lightpanda CDP endpoint points, without editing files by hand. '
      + 'show reports the resolved host, port, Host header and which layer supplied each one, plus a '
      + 'reachability probe. set writes the change to the plugin settings file and reconnects; reset '
      + 'deletes that file. Changes take effect on the next call and survive DSH restarts. '
      + 'Precedence: per-call arguments, then LIGHTPANDA_CDP_* environment variables, then this file, '
      + 'then the plugin config, then the built-in default lightpanda:9222.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'set', 'reset'],
          description: 'show reads the current endpoint, set saves the given fields, reset deletes the saved file.',
        },
        host: { type: 'string', description: 'CDP host to save, e.g. lightpanda or 127.0.0.1.' },
        port: { type: 'number', description: 'CDP port to save, e.g. 9222.' },
        hostHeader: {
          type: 'string',
          description: 'Host header to save. Keep a loopback form (127.0.0.1) or Lightpanda answers 403.',
        },
        timeoutMs: { type: 'number', description: 'Default CDP request budget in ms to save.' },
      },
      required: ['action'],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    presentCall: callView('lp_config', 'execute'),
    presentResult: resultView('Lightpanda endpoint'),
    output: outputDefinition,
    async execute(args) {
      const action = requireString(args?.action, 'action')
      if (!['show', 'set', 'reset'].includes(action)) {
        throw new Error(`lp_config: unknown action ${action}`)
      }
      let applied = null
      if (action === 'set') {
        const patch = {}
        for (const key of ['host', 'port', 'hostHeader', 'timeoutMs']) {
          if (args?.[key] === undefined || args?.[key] === null) continue
          patch[key] = args[key]
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('lp_config set: pass at least one of host, port, hostHeader, timeoutMs')
        }
        if (patch.port !== undefined && !(Number(patch.port) > 0 && Number(patch.port) <= 65_535)) {
          throw new Error('lp_config set: port must be between 1 and 65535')
        }
        applied = store.save(patch)
        // Drop the warm connection so the next call dials the new endpoint.
        bridge.reset()
      } else if (action === 'reset') {
        const removed = store.reset()
        bridge.reset()
        applied = { removedFile: removed }
      }

      const endpoint = store.resolve()
      let probe
      try {
        const version = await httpJson(endpoint, '/json/version', {
          timeoutMs: Math.min(endpoint.timeoutMs, 5_000),
        })
        probe = {
          ok: true,
          browser: version.Browser ?? null,
          lightpanda: version['Lightpanda-Version'] ?? null,
        }
      } catch (err) {
        probe = { ok: false, error: String(err.message).split('\n')[0] }
      }
      return {
        action,
        endpoint: {
          host: endpoint.host,
          port: endpoint.port,
          hostHeader: endpoint.hostHeader,
          timeoutMs: endpoint.timeoutMs,
        },
        sources: endpoint.sources,
        configPath: store.path,
        probe,
        ...(applied ? { applied } : {}),
        ...(store.warning ? { warning: store.warning } : {}),
      }
    },
  })

  // -- lp_status ------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_status',
    description:
      'Report the Lightpanda CDP endpoint: version plus every open tab (target id, url, title). '
      + 'With targetId, also returns that page\'s load report — HTTP status, script errors, '
      + 'blocked/failed requests and missing browser features.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Tab to report on. Optional.' },
        ...shared,
      },
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: callView('lp_status', 'read'),
    presentResult: resultView('Lightpanda status'),
    output: outputDefinition,
    async execute(args) {
      const ep = endpointFor(args)
      const version = await httpJson(ep, '/json/version', { timeoutMs: ep.timeoutMs })
      const targets = await bridge.targets().catch(() => [])
      const result = {
        browser: version.Browser ?? null,
        lightpanda: version['Lightpanda-Version'] ?? null,
        protocol: version['Protocol-Version'] ?? null,
        endpoint: `${ep.host}:${ep.port}`,
        hostHeader: ep.hostHeader,
        targets: targets.map(({ targetId, url, title }) => ({ targetId, url, title })),
      }
      if (args?.targetId) {
        const { client, sessionId, targetId } = await bridge.session(args.targetId)
        result.targetId = targetId
        result.page = await pageIdentity(client, sessionId)
        result.pageStatus = await client
          .send('LP.getPageStatus', {}, sessionId)
          .catch((error) => ({ unavailable: error.message }))
      }
      return result
    },
  })

  // -- lp_open --------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_open',
    description:
      'Open a URL in Lightpanda and wait for the page to load. Returns the new target id, the final url and '
      + 'the title; pass that target id to the other lp_* tools to keep working on the same tab. Without a '
      + 'targetId this always opens a new tab.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to open.' },
        targetId: {
          type: 'string',
          description: 'Navigate this existing tab instead of opening a new one. Optional.',
        },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'settled', 'none'],
          description: 'Load condition to wait for. Default load; settled also waits for page-started requests to finish.',
        },
        timeoutMs: { type: 'number', description: 'Navigation timeout in ms. Default 30000.' },
        ...shared,
      },
      required: ['url'],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `lp_open ${args?.url ?? ''}`,
      kind: 'fetch',
      rawInput: args,
    }),
    presentResult: resultView('Lightpanda open'),
    output: outputDefinition,
    async execute(args) {
      const url = requireString(args?.url, 'url')
      const timeoutMs = numberOr(args?.timeoutMs, 30_000)
      const { client, sessionId, targetId } = args?.targetId
        ? await bridge.session(args.targetId)
        : await bridge.createTarget()
      await navigate(client, sessionId, url, args?.waitUntil ?? 'load', timeoutMs)
      const page = await pageIdentity(client, sessionId)
      const status = await client
        .send('LP.getPageStatus', {}, sessionId)
        .catch(() => null)
      return {
        targetId,
        url: page.url,
        title: page.title,
        httpStatus: status?.httpStatus ?? null,
        jsErrors: status?.jsErrors ?? null,
        botChallenge: status?.botChallenge || null,
      }
    },
  })

  // -- lp_read --------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_read',
    description:
      'Read the current page of a tab. format markdown (default) returns Lightpanda\'s distilled article '
      + 'content, html returns the serialized DOM, and text returns the rendered innerText. Use selector to '
      + 'scope the read to one CSS subtree, and maxChars to bound the output.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Tab to read. Optional: the last used tab is reused.' },
        format: {
          type: 'string',
          enum: ['markdown', 'html', 'text'],
          description: 'Output format. Default markdown.',
        },
        selector: { type: 'string', description: 'CSS selector limiting the read to one element. Optional.' },
        maxChars: { type: 'number', description: 'Upper bound on returned characters. Default 60000.' },
        ...shared,
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `lp_read ${args?.format ?? 'markdown'}${args?.selector ? ` ${args.selector}` : ''}`,
      kind: 'read',
      rawInput: args,
    }),
    presentResult: resultView('Lightpanda read'),
    output: outputDefinition,
    async execute(args) {
      const format = args?.format ?? 'markdown'
      const maxChars = Math.max(1, numberOr(args?.maxChars, DEFAULT_READ_CHARS))
      const { client, sessionId, targetId } = await bridge.session(args?.targetId)

      if (format === 'text') {
        const expression = args?.selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); return el ? el.innerText : null })()`
          : 'document.body ? document.body.innerText : null'
        const result = await client.send(
          'Runtime.evaluate',
          { expression, returnByValue: true },
          sessionId,
        )
        const raw = result?.result?.value
        if (args?.selector && raw === null) {
          throw new Error(`lp_read: no element matches selector ${args.selector}`)
        }
        const content = String(raw ?? '')
        return {
          targetId,
          format: 'text',
          chars: Math.min(content.length, maxChars),
          totalChars: content.length,
          truncated: content.length > maxChars,
          content: content.slice(0, maxChars),
        }
      }

      const dump = await client.send(
        'LP.dump',
        {
          format: format === 'html' ? 'html' : 'markdown',
          ...(args?.selector ? { selector: args.selector } : {}),
          maxBytes: maxChars,
        },
        sessionId,
      )
      const content = String(dump?.content ?? '')
      const page = await pageIdentity(client, sessionId)
      return {
        targetId,
        format: dump?.format ?? format,
        url: page.url,
        title: page.title,
        chars: content.length,
        truncated: /\[truncated\]\s*$/u.test(content) || content.length >= maxChars,
        content,
      }
    },
  })

  // -- lp_eval --------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_eval',
    description:
      'Evaluate a JavaScript expression in a tab and return the value. Use it for anything the higher-level '
      + 'tools do not cover. Lightpanda has no page-level fetch(), so do not expect network calls inside the '
      + 'expression to resolve.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
        targetId: { type: 'string', description: 'Tab to evaluate in. Optional: the last used tab.' },
        awaitPromise: { type: 'boolean', description: 'Await a returned promise. Default true.' },
        ...shared,
      },
      required: ['expression'],
    },
    timeoutMs: 45_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `lp_eval ${String(args?.expression ?? '').slice(0, 80)}`,
      kind: 'execute',
      rawInput: args,
    }),
    presentResult: resultView('Lightpanda eval'),
    output: outputDefinition,
    async execute(args) {
      const expression = requireString(args?.expression, 'expression')
      const { client, sessionId, targetId } = await bridge.session(args?.targetId)
      const result = await client.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: args?.awaitPromise !== false },
        sessionId,
      )
      if (result?.exceptionDetails) {
        const details = result.exceptionDetails
        throw new Error(`lp_eval: ${details.text}${details.exception?.description ? ` — ${details.exception.description}` : ''}`)
      }
      return {
        targetId,
        type: result?.result?.type ?? 'undefined',
        value: result?.result?.value ?? null,
      }
    },
  })

  // -- lp_elements ----------------------------------------------------------
  ctx.tools.register({
    name: 'lp_elements',
    description:
      'List the visible elements a user can act on in a tab: links, buttons, form controls and interactive '
      + 'ARIA roles, in document order. Each entry carries the backendNodeId used by lp_act.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Tab to inspect. Optional: the last used tab.' },
        max: { type: 'number', description: 'Maximum entries to return. Default 60.' },
        tag: { type: 'string', description: 'Only entries with this tag name, e.g. a or input. Optional.' },
        ...shared,
      },
    },
    timeoutMs: 45_000,
    isConcurrencySafe: () => true,
    presentCall: callView('lp_elements', 'read'),
    presentResult: resultView('Lightpanda elements'),
    output: outputDefinition,
    async execute(args) {
      const max = Math.max(1, numberOr(args?.max, 60))
      const tag = args?.tag ? String(args.tag).toLowerCase() : null
      const { client, sessionId, targetId } = await bridge.session(args?.targetId)
      const { elements } = await client.send('LP.getInteractiveElements', {}, sessionId)
      const all = elements ?? []
      const filtered = tag ? all.filter((entry) => String(entry.tagName ?? '').toLowerCase() === tag) : all
      return {
        targetId,
        total: all.length,
        returned: Math.min(filtered.length, max),
        elements: filtered.slice(0, max).map((entry) => ({
          nodeId: entry.backendNodeId,
          tag: entry.tagName,
          role: entry.role,
          name: entry.name,
          type: entry.type,
          href: entry.href,
        })),
        truncated: filtered.length > max,
      }
    },
  })

  // -- lp_act ---------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_act',
    description:
      'Act on a page the way a user does: click, fill a field, scroll, or wait. Target an element either with '
      + 'nodeId (a backendNodeId from lp_elements, which yields trusted pointer events) or with selector. '
      + 'Returns the url and title after the action settles.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'fill', 'scroll', 'wait'],
          description: 'What to do.',
        },
        selector: { type: 'string', description: 'CSS selector of the target element. Optional with nodeId.' },
        nodeId: { type: 'integer', description: 'backendNodeId from lp_elements. Optional with selector.' },
        text: { type: 'string', description: 'Text to type for action fill.' },
        y: { type: 'number', description: 'Vertical scroll offset for action scroll without a selector.' },
        ms: { type: 'number', description: 'Wait duration for action wait without a selector. Default 1000.' },
        targetId: { type: 'string', description: 'Tab to act on. Optional: the last used tab.' },
        timeoutMs: { type: 'number', description: 'Timeout for the action and its settle wait. Default 15000.' },
        ...shared,
      },
      required: ['action'],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `lp_act ${args?.action ?? ''}${args?.selector ? ` ${args.selector}` : args?.nodeId ? ` #${args.nodeId}` : ''}`,
      kind: 'execute',
      rawInput: args,
    }),
    presentResult: resultView('Lightpanda action'),
    output: outputDefinition,
    async execute(args) {
      const action = requireString(args?.action, 'action')
      const timeoutMs = numberOr(args?.timeoutMs, 15_000)
      const { client, sessionId, targetId } = await bridge.session(args?.targetId)
      const selector = args?.selector ? String(args.selector) : null
      const nodeId = Number.isInteger(args?.nodeId) ? args.nodeId : null
      if (!selector && nodeId === null && action !== 'scroll' && action !== 'wait') {
        throw new Error(`lp_act ${action}: pass selector or nodeId`)
      }

      if (action === 'click') {
        if (nodeId !== null) {
          await client.send('LP.clickNode', { backendNodeId: nodeId }, sessionId, timeoutMs)
        } else {
          const box = await client.send(
            'Runtime.evaluate',
            {
              expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); `
                + 'if (!el) return null; el.scrollIntoView({ block: "center" }); '
                + 'const rect = el.getBoundingClientRect(); '
                + 'return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()',
              returnByValue: true,
            },
            sessionId,
            timeoutMs,
          )
          const point = box?.result?.value
          if (!point) throw new Error(`lp_act click: no element matches selector ${selector}`)
          const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
          await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId)
          await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId)
          await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId)
        }
      } else if (action === 'fill') {
        const value = String(args?.text ?? '')
        if (nodeId !== null) {
          await client.send('LP.fillNode', { backendNodeId: nodeId, text: value }, sessionId, timeoutMs)
        } else {
          const assigned = await client.send(
            'Runtime.evaluate',
            {
              expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); `
                + 'if (!el) return false; el.focus(); '
                + `el.value = ${JSON.stringify(value)}; `
                + 'el.dispatchEvent(new Event("input", { bubbles: true })); '
                + 'el.dispatchEvent(new Event("change", { bubbles: true })); return true })()',
              returnByValue: true,
            },
            sessionId,
            timeoutMs,
          )
          if (assigned?.result?.value !== true) {
            throw new Error(`lp_act fill: no element matches selector ${selector}`)
          }
        }
      } else if (action === 'scroll') {
        const expression = Number.isFinite(Number(args?.y))
          ? `window.scrollTo(0, ${Number(args.y)})`
          : selector
            ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); return true })()`
            : 'window.scrollBy(0, window.innerHeight)'
        const scrolled = await client.send(
          'Runtime.evaluate',
          { expression, returnByValue: true },
          sessionId,
          timeoutMs,
        )
        if (selector && scrolled?.result?.value === false) {
          throw new Error(`lp_act scroll: no element matches selector ${selector}`)
        }
      } else if (action === 'wait') {
        if (selector) {
          await client.send('LP.waitForSelector', { selector, timeout: timeoutMs }, sessionId, timeoutMs + 5_000)
        } else {
          await new Promise((done) => setTimeout(done, Math.max(0, numberOr(args?.ms, 1_000))))
        }
      } else {
        throw new Error(`lp_act: unknown action ${action}`)
      }

      // Let the action's navigation or DOM work finish before reporting state.
      await client
        .send('LP.waitUntil', { until: 'settled', timeout: Math.min(timeoutMs, 5_000) }, sessionId, timeoutMs)
        .catch(() => null)
      const page = await pageIdentity(client, sessionId)
      const readyState = await client
        .send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId)
        .then((result) => result?.result?.value)
        .catch(() => null)
      return {
        targetId,
        action,
        ok: true,
        url: page.url,
        title: page.title,
        readyState,
      }
    },
  })

  // -- lp_shot --------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_shot',
    description:
      'Capture a PNG screenshot of a tab and write it to disk, returning the absolute path. Lightpanda only '
      + 'encodes PNG. Read the saved file to inspect it; this tool returns no pixels of its own.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Tab to capture. Optional: the last used tab.' },
        path: { type: 'string', description: 'Output file path. Default a timestamped file under the temp directory.' },
        width: { type: 'number', description: 'Viewport width for the capture. Optional.' },
        height: { type: 'number', description: 'Viewport height for the capture. Optional.' },
        ...shared,
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `lp_shot${args?.targetId ? ` ${args.targetId}` : ''}`,
      kind: 'read',
      rawInput: args,
    }),
    presentResult: resultView('Lightpanda screenshot'),
    output: outputDefinition,
    async execute(args) {
      const { client, sessionId, targetId } = await bridge.session(args?.targetId)
      const metrics = await client.send('Page.getLayoutMetrics', {}, sessionId).catch(() => null)
      const width = numberOr(args?.width, metrics?.layoutViewport?.clientWidth)
      const height = numberOr(args?.height, metrics?.layoutViewport?.clientHeight)
      if (Number.isFinite(width) && Number.isFinite(height) && (args?.width || args?.height)) {
        await client.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 1, mobile: false },
          sessionId,
        )
      }
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      const bytes = Buffer.from(String(shot?.data ?? ''), 'base64')
      const target = args?.path
        ? (isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path))
        : join(tmpdir(), 'lightpanda-cdp', `shot-${Date.now()}.png`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      const page = await pageIdentity(client, sessionId)
      return {
        targetId,
        path: target,
        bytes: bytes.length,
        width: width ?? null,
        height: height ?? null,
        url: page.url,
        title: page.title,
      }
    },
  })

  // -- lp_close -------------------------------------------------------------
  ctx.tools.register({
    name: 'lp_close',
    description:
      'Close a tab. Without targetId it closes the tab this plugin used last. Closing is not required for '
      + 'correctness, but Lightpanda keeps every open tab in memory.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Tab to close. Optional: the last used tab.' },
        ...shared,
      },
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    presentCall: callView('lp_close', 'execute'),
    presentResult: resultView('Lightpanda close'),
    output: outputDefinition,
    async execute(args) {
      const targetId = args?.targetId ?? bridge.lastTargetId
      if (!targetId) throw new Error('lp_close: no tab to close — pass targetId')
      const result = await bridge.closeTarget(targetId)
      return { targetId, closed: result?.success !== false }
    },
  })
}
