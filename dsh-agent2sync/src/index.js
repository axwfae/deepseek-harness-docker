/**
 * dsh-agent2sync（显示名 Agent2Sync）— host half（纯 JavaScript，无构建步骤）
 *
 * 三件事：
 *   1. 从 Agent2API 网关的 `GET /v1/models` 拉取模型目录；
 *   2. 把每个模型翻译成 DSH `llm-pi-ai` 的模型画像（上下文长度、思考、图片输入）；
 *   3. 用 `ctx.settings.mutate()` 只写 `providers.<providerId>` 这一段。
 *
 * 配置怎么存：
 *   providerId / baseURL 这类可编辑设置存在 profile 目录旁的 `agent2sync.json`，
 *   与 patch 层里的默认值合并后生效；网关 Key 走 DSH 的 credentials 服务
 *   （`credentials.set(ref, value)`），不落进这个 JSON。
 *
 *   为什么不落在 cordis.patch.yml 里：写它需要 schemastery 提供表单 schema，
 *   而 DSH 自带的 schemastery 在 CLI 自己的 node_modules 下、插件从 profile
 *   解析不到，于是这个插件在设置系统里根本没有可写的表单。JSON 文件是同样
 *   可靠又没有这层依赖的做法；provider 本身仍然写进 patch 文档，DSH 照常加载。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULTS = {
  providerId: 'agent2sync',
  providerDisplayName: 'Agent2Sync',
  // 刻意留空：网关地址属于部署差异，不该由插件猜一个出来。
  baseURL: '',
  apiKeyEnv: 'AGENT2SYNC_API_KEY',
  piAiEntry: 'llm-pi-ai',
  routePath: '/agent2sync/sync',
  defaultContextWindow: 128000,
  requestTimeoutMs: 20000,
  bootstrapOnLoad: true,
  /** 同步时默认是否逐个探测模型可用性。 */
  verifyModelsByDefault: true,
  /** 探测的并发数：太低慢，太高容易把网关打满。 */
  verifyConcurrency: 6,
  /**
   * 探测题目的输出预算。实测思考模型解「banana 里有几个 a」要 ~280 tokens，
   * 给 256 会被 finish=length 截断成空正文，那会把好模型误判成坏模型。
   */
  verifyMaxTokens: 1024,
}

/** 用户可编辑并持久化的字段（apiKey 不进这个文件，它走凭据服务）。 */
const EDITABLE_KEYS = ['providerId', 'baseURL', 'apiKeyEnv']

/**
 * 支持 reasoning_effort 的网关使用的思考档位。
 * 已实测：带 `reasoning_effort: "low"` 的请求返回 200 并回传 `reasoning_content`。
 */
const REASONING_EFFORTS = { off: null, low: 'low', medium: 'medium', high: 'high' }

/** providerId 的合法形状：小写字母/数字开头，只含小写字母、数字、点、下划线、连字符。 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = null
}

/** 插件配置。schemastery 不可用时为 undefined，cordis 直接透传原始 config。 */
export const Config = Schema === null ? undefined : Schema.object({
  providerId: Schema.string().default(DEFAULTS.providerId),
  providerDisplayName: Schema.string().default(DEFAULTS.providerDisplayName),
  baseURL: Schema.string().default(DEFAULTS.baseURL),
  apiKeyEnv: Schema.string().default(DEFAULTS.apiKeyEnv),
  piAiEntry: Schema.string().default(DEFAULTS.piAiEntry),
  routePath: Schema.string().default(DEFAULTS.routePath),
  defaultContextWindow: Schema.number().default(DEFAULTS.defaultContextWindow),
  requestTimeoutMs: Schema.number().default(DEFAULTS.requestTimeoutMs),
  bootstrapOnLoad: Schema.boolean().default(DEFAULTS.bootstrapOnLoad),
  verifyModelsByDefault: Schema.boolean().default(DEFAULTS.verifyModelsByDefault),
  verifyConcurrency: Schema.number().default(DEFAULTS.verifyConcurrency),
  verifyMaxTokens: Schema.number().default(DEFAULTS.verifyMaxTokens),
})

export const name = 'dsh-agent2sync'
export const inject = ['settings']

/**
 * 该模型是否是能对话的纯文字模型。
 * Agent2API 的目录里混着图像生成模型（`kind: 'image'`），它们没有上下文长度、
 * 不接工具调用，放进 chat 模型选择器只会换来一堆调用失败。
 * @param entry - `GET /v1/models` 的一个条目。
 * @returns 是否纳入模型列表。
 */
function isTextChatModel(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false
  const kind = typeof entry.kind === 'string' ? entry.kind.toLowerCase() : 'chat'
  if (kind !== 'chat' && kind !== 'text') return false
  const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
  return modalities.length === 0 || modalities.includes('text')
}

/**
 * 把一个网关模型条目翻译成 `PiAiModelProfile`。
 * @param entry - `GET /v1/models` 的一个条目。
 * @returns 只包含有值的字段，避免把 undefined 写进 YAML。
 */
function toModelProfile(entry) {
  const profile = { id: entry.id }

  if (typeof entry.name === 'string' && entry.name.length > 0 && entry.name !== entry.id) {
    profile.name = entry.name
  }

  const contextWindow = Number(entry.max_input_tokens)
  if (Number.isFinite(contextWindow) && contextWindow > 0) profile.contextWindow = contextWindow

  const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
  const supportsImage = entry.supports_images === true || modalities.includes('image')
  profile.input = supportsImage ? ['text', 'image'] : ['text']

  profile.reasoningEfforts = entry.supports_reasoning === true
    ? { ...REASONING_EFFORTS }
    : false

  return profile
}

/**
 * 解析网关 Key：先走凭据服务，再退回进程环境变量。
 * @param ctx - 插件上下文。
 * @param ref - 凭据引用名。
 * @returns 明文 Key，或 undefined。
 */
async function resolveApiKey(ctx, ref) {
  if (typeof ref !== 'string' || ref.length === 0) return undefined
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // 解析失败就继续尝试环境变量。
    }
  }
  const fromEnv = process.env[ref]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

/**
 * 写入网关 Key。
 * @param ctx - 插件上下文。
 * @param ref - 凭据引用名。
 * @param value - 明文 Key；空字符串表示清除。
 */
async function storeApiKey(ctx, ref, value) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.set !== 'function') {
    throw new Error('本部署没有 credentials 服务，无法保存 API Key')
  }
  if (typeof value !== 'string' || value.length === 0) {
    if (typeof credentials.unset === 'function') await credentials.unset(ref)
    return
  }
  await credentials.set(ref, value)
}

/**
 * 设置文件的路径：跟 profile 的 patch 文档放同一目录。
 * @param ctx - 插件上下文。
 * @returns 绝对路径，或 undefined（拿不到 profile 位置时）。
 */
function settingsFilePath(ctx) {
  let documentPath
  try {
    documentPath = ctx.settings?.documentPath
  } catch {
    return undefined
  }
  if (typeof documentPath !== 'string' || documentPath.length === 0) return undefined
  return join(dirname(documentPath), 'agent2sync.json')
}

/**
 * 读取用户保存过的设置。
 * @param ctx - 插件上下文。
 * @returns 只含可编辑字段的对象；读不到就是空对象。
 */
function readSavedSettings(ctx) {
  const file = settingsFilePath(ctx)
  if (file === undefined) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const picked = {}
    for (const key of EDITABLE_KEYS) {
      if (typeof parsed[key] === 'string' && parsed[key].length > 0) picked[key] = parsed[key]
    }
    return picked
  } catch {
    return {}
  }
}

/**
 * 持久化可编辑设置。
 * @param ctx - 插件上下文。
 * @param state - 当前生效配置。
 */
function writeSavedSettings(ctx, state) {
  const file = settingsFilePath(ctx)
  if (file === undefined) throw new Error('拿不到 profile 路径，设置无法保存')
  const payload = {}
  for (const key of EDITABLE_KEYS) payload[key] = state[key]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/**
 * 读出当前所有已配置的 provider id。
 * @param ctx - 插件上下文。
 * @param entry - 承载 provider 的插件条目 id。
 * @returns provider id 列表。
 */
function listProviders(ctx, entry) {
  try {
    const descriptor = ctx.settings.describe().find(row => row.ns === entry)
    const providers = descriptor?.value?.providers
    return providers !== null && typeof providers === 'object' ? Object.keys(providers) : []
  } catch {
    return []
  }
}

/**
 * 读出某个 provider 现有的模型 id。
 * @param ctx - 插件上下文。
 * @param entry - 插件条目 id。
 * @param providerId - provider id。
 * @returns 模型 id 列表。
 */
function readExistingModelIds(ctx, entry, providerId) {
  try {
    const descriptor = ctx.settings.describe().find(row => row.ns === entry)
    const models = descriptor?.value?.providers?.[providerId]?.models
    if (!Array.isArray(models)) return []
    return models.map(model => model?.id).filter(id => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

/**
 * 实际生效的网关地址。
 *
 * 优先级：卡片保存的 → patch 里配的 → **provider 里已经写入的**。
 * 最后一档是为了重启后的连贯性：地址本身没有默认值，但一个已经建好的
 * provider 里就存着它当初用的地址，此时不该反过来要求用户重填一遍。
 * @param ctx - 插件上下文。
 * @param state - 当前生效配置。
 * @returns 规范化后的地址，或空字符串。
 */
function effectiveBaseURL(ctx, state) {
  const saved = String(state.baseURL ?? '').replace(/\/+$/, '')
  if (saved.length > 0) return saved
  try {
    const descriptor = ctx.settings.describe().find(row => row.ns === state.piAiEntry)
    const configured = descriptor?.value?.providers?.[state.providerId]?.baseURL
    if (typeof configured === 'string' && configured.length > 0) return configured.replace(/\/+$/, '')
  } catch {
    // 配置系统还没就绪，当作没有地址
  }
  return ''
}

/**
 * 拉取并过滤网关的模型目录。
 * @param ctx - 插件上下文。
 * @param state - 当前生效配置。
 * @returns 全部条目、纳入了的条目，以及被排除的数量。
 */
async function fetchCatalog(ctx, state) {
  const base = effectiveBaseURL(ctx, state)
  if (base.length === 0) {
    throw new Error('尚未设置服务器地址：请在 Agent2Sync 卡片里填写网关地址并保存')
  }
  const headers = { accept: 'application/json' }
  const apiKey = await resolveApiKey(ctx, state.apiKeyEnv)
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

  const response = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(state.requestTimeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Agent2API 的 /models 返回 HTTP ${response.status}：${text.slice(0, 300)}`)

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('Agent2API 的 /models 返回的不是 JSON')
  }

  const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  if (entries.length === 0) throw new Error('Agent2API 的 /models 没有返回任何模型')
  const chat = entries.filter(isTextChatModel)
  return { entries, chat, excluded: entries.length - chat.length }
}

/**
 * 探测题库。
 *
 * 每道题都只有一个确定答案，且都要求「只输出一个阿拉伯数字」——这样才能
 * 自动判分。题型覆盖算术、时间常识、字母计数：只回得出字却不回对答案的
 * 模型（路由接错、模型被顶替、上下文错乱）会在这里露出来。
 */
const PROBLEM_BANK = [
  { kind: '算术', prompt: '计算 3 + 5 等于多少？', expected: 8 },
  { kind: '时间', prompt: '一小时等于多少分钟？', expected: 60 },
  { kind: '字母', prompt: '英文单词 banana 里一共有几个字母 a？', expected: 3 },
]

/** 按模型序号轮换题目，让一次同步覆盖全部题型。 */
function pickProblem(index) {
  return PROBLEM_BANK[index % PROBLEM_BANK.length]
}

/**
 * 从模型输出里取第一个整数。
 * 模型常写成「8」「答案是 8」「8 分钟」，取第一个数字都能覆盖。
 * @param text - 模型回的 content。
 * @returns 提取到的整数，取不到为 NaN。
 */
function firstInteger(text) {
  const match = String(text ?? '').match(/-?\d+/)
  return match === null ? Number.NaN : Number(match[0])
}

/**
 * 让一个模型解一道有确定答案的题，用它证明模型真的在工作。
 *
 * 只发 `ping` 看有没有回包是不够的：端点活着、`choices` 有值，都可能是
 * 网关套了层壳在敷衍。所以这里出题、判分——答错的模型不进清单。
 * @param state - 当前生效配置。
 * @param base - 规范化后的网关地址。
 * @param apiKey - 网关 Key。
 * @param model - 模型画像（要用它判断是否思考模型）。
 * @param index - 模型序号，用于轮换题目。
 * @returns 结果、题目与模型的实际作答。
 */
async function verifyModel(state, base, apiKey, model, index) {
  const problem = pickProblem(index)
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

  const payload = {
    model: model.id,
    messages: [
      { role: 'system', content: '你在接受连通性测试。只输出一个阿拉伯数字，不要解释、不要标点、不要单位。' },
      { role: 'user', content: problem.prompt },
    ],
    max_tokens: state.verifyMaxTokens,
    stream: false,
  }
  // 思考模型会先把输出预算烧在 reasoning 上，压到最低档才答得出来。
  if (model.reasoningEfforts !== false) payload.reasoning_effort = 'low'

  const base_result = { prompt: problem.prompt, expected: problem.expected, kind: problem.kind }

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(state.requestTimeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = text.slice(0, 200)
      try {
        const parsed = JSON.parse(text)
        detail = parsed?.error?.message ?? parsed?.error ?? detail
      } catch {
        // 非 JSON 错误体就保留原文
      }
      return { ...base_result, ok: false, error: `HTTP ${response.status}`, got: String(detail).slice(0, 160) }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ...base_result, ok: false, error: '响应不是 JSON', got: text.slice(0, 160) }
    }
    if (!Array.isArray(parsed?.choices) || parsed.choices.length === 0) {
      return { ...base_result, ok: false, error: '响应里没有 choices', got: '（空）' }
    }

    const content = parsed.choices[0]?.message?.content
    const reasoning = parsed.choices[0]?.message?.reasoning_content
    const got = firstInteger(content)
    const shown = (typeof content === 'string' && content.trim().length > 0
      ? content.trim()
      : (typeof reasoning === 'string' && reasoning.trim().length > 0 ? `（只有思考，无答案）` : '（空）'))

    if (!Number.isFinite(got)) {
      return { ...base_result, ok: false, error: '没有给出数字答案', got: shown.slice(0, 160) }
    }
    if (got !== problem.expected) {
      return { ...base_result, ok: false, error: '答案错误', got: `${got}（原文：${shown.slice(0, 100)}）` }
    }
    return { ...base_result, ok: true, got: String(got) }
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      ...base_result,
      ok: false,
      error: timeout ? '请求超时' : (error?.message ?? String(error)),
      got: '（无响应）',
    }
  }
}

/**
 * 带上限的并发映射：探测是 I/O 密集，但要防住一次性把网关打满。
 * @param items - 待处理项。
 * @param limit - 最大并发。
 * @param worker - 单项处理函数。
 * @returns 与输入同序的结果。
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 把目录写进 `llm-pi-ai` 的 `providers.<providerId>`。
 * @param ctx - 插件上下文。
 * @param state - 当前生效配置。
 * @param models - 已翻译好的模型列表。
 */
async function writeRoute(ctx, state, models) {
  const route = {
    displayName: state.providerDisplayName,
    api: 'openai-completions',
    // 用生效地址：地址可能来自「provider 里已写入的值」而不是保存项，
    // 直接取 state.baseURL 会在这里把 provider 的地址抹成空。
    baseURL: effectiveBaseURL(ctx, state),
    apiKeyEnv: state.apiKeyEnv,
    defaultInput: ['text'],
    defaultContextWindow: state.defaultContextWindow,
    models,
  }
  await ctx.settings.mutate(state.piAiEntry, [
    { op: 'set', path: ['providers', state.providerId], value: route },
  ])
}

/**
 * 执行一次完整同步。
 * @param ctx - 插件上下文。
 * @param state - 当前生效配置。
 * @returns 可直接序列化的同步结果。
 */
async function syncModels(ctx, state, options = {}) {
  const startedAt = Date.now()
  const previousIds = readExistingModelIds(ctx, state.piAiEntry, state.providerId)
  const { entries, chat, excluded } = await fetchCatalog(ctx, state)
  const candidates = chat.map(toModelProfile)

  // 可选的一步：逐个发最小请求，跑不通的模型不进清单。
  let models = candidates
  let verification
  if (options.verify === true) {
    const base = effectiveBaseURL(ctx, state)
    const apiKey = await resolveApiKey(ctx, state.apiKeyEnv)
    if (apiKey === undefined) {
      // 没有 Key 时探测本身就没意义（模型哪怕通了也调不了），
      // 所以跳过测试而不是把整次同步拦下来，并在结果里说明原因。
      verification = { enabled: false, skipped: true, reason: '未配置网关 Key，已跳过测试' }
    } else {
      const probes = await mapWithConcurrency(
        candidates,
        state.verifyConcurrency,
        async (model, index) => {
          const first = await verifyModel(state, base, apiKey, model, index)
          if (first.ok) return { id: model.id, ...first, attempts: 1 }
          // 一次不成不代表模型坏：并发挤占、思考预算临到边界都会造成偶发空正文。
          // 单独（串行）再判一次、且预算翻倍，两次都不过才下结论。
          const retryState = {
            ...state,
            verifyMaxTokens: Math.max(state.verifyMaxTokens * 2, 2048),
          }
          const second = await verifyModel(retryState, base, apiKey, model, index)
          return { id: model.id, ...second, attempts: 2 }
        },
      )
      const passed = new Set(probes.filter(probe => probe.ok).map(probe => probe.id))
      const failed = probes
        .filter(probe => !probe.ok)
        .map(probe => ({
          id: probe.id,
          error: probe.error,
          kind: probe.kind,
          prompt: probe.prompt,
          expected: probe.expected,
          got: probe.got,
          attempts: probe.attempts,
        }))
      models = candidates.filter(model => passed.has(model.id))
      const retried = probes.filter(probe => probe.attempts > 1).length
      // 每题明细一并返回：用户在命令行或界面上能直接看到「问了什么、答了什么」。
      const results = probes.map(probe => ({
        id: probe.id,
        ok: probe.ok === true,
        kind: probe.kind,
        prompt: probe.prompt,
        expected: probe.expected,
        got: probe.got,
        attempts: probe.attempts,
        ...probe.ok === true ? {} : { error: probe.error },
      }))
      verification = { enabled: true, tested: probes.length, passed: passed.size, failed, retried, results }
      // 全军覆没通常意味着 Key 或网关出了问题，此时宁可不动原配置。
      if (candidates.length > 0 && models.length === 0) {
        throw new Error(`全部 ${candidates.length} 个模型都没通过测试，已保留原有模型列表未改动`)
      }
    }
  }

  await writeRoute(ctx, state, models)

  const previous = new Set(previousIds)
  const current = new Set(models.map(model => model.id))
  const added = models.map(model => model.id).filter(id => !previous.has(id))
  const removed = previousIds.filter(id => !current.has(id))

  return {
    ok: true,
    provider: state.providerId,
    baseURL: effectiveBaseURL(ctx, state),
    fetched: entries.length,
    excluded,
    total: models.length,
    added,
    removed,
    unchanged: models.length - added.length,
    ...verification === undefined ? {} : { verification },
    durationMs: Date.now() - startedAt,
    syncedAt: new Date().toISOString(),
  }
}

/** 判断请求是否来自同源页面，挡掉跨站触发的配置写入。 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 读取请求体并解析成 JSON；空体返回空对象。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed
}

/** 统一的 JSON 应答。 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * 插件主体。
 * @param ctx - cordis 上下文。
 * @param rawConfig - patch 里写的 config（可能缺字段）。
 */
export function apply(ctx, rawConfig) {
  // patch 默认值 < agent2sync.json 里用户保存过的设置
  const state = { ...DEFAULTS, ...(rawConfig ?? {}), ...readSavedSettings(ctx) }

  /** 串行化并发同步，避免两次点击互相覆盖 revision。 */
  let inFlight = null
  const runSync = (options = {}) => {
    // 并发的重复点击复用在跑的那一次；参数以先到的为准。
    if (inFlight !== null) return inFlight
    inFlight = syncModels(ctx, state, options).finally(() => { inFlight = null })
    return inFlight
  }

  /** 组装给设置卡片用的状态快照。 */
  const describeState = async () => {
    const apiKey = await resolveApiKey(ctx, state.apiKeyEnv)
    return {
      ok: true,
      providerId: state.providerId,
      providerDisplayName: state.providerDisplayName,
      baseURL: effectiveBaseURL(ctx, state),
      apiKeyEnv: state.apiKeyEnv,
      hasApiKey: apiKey !== undefined,
      modelCount: readExistingModelIds(ctx, state.piAiEntry, state.providerId).length,
      verifyByDefault: state.verifyModelsByDefault,
      providers: listProviders(ctx, state.piAiEntry),
      routePath: state.routePath,
    }
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: state.routePath,
      handler: async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase()
        const url = new URL(req.url ?? '/', 'http://localhost')
        const isSettings = url.searchParams.get('settings') === '1'
        const isStatus = url.searchParams.get('status') === '1'

        try {
          if (!isSameOrigin(req)) {
            sendJson(res, 403, { ok: false, error: '拒绝跨站请求' })
            return
          }

          // ── 设置读写 ────────────────────────────────────────────────
          if (isSettings) {
            if (method === 'GET') {
              sendJson(res, 200, await describeState())
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)

              // providerId 校验：形状合法 + 不与列表里已有的（除自己）重名
              let nextProviderId = state.providerId
              if (body.providerId !== undefined) {
                const candidate = String(body.providerId).trim()
                if (!PROVIDER_ID_PATTERN.test(candidate)) {
                  sendJson(res, 400, {
                    ok: false,
                    field: 'providerId',
                    error: '供应商名称只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头',
                  })
                  return
                }
                const taken = listProviders(ctx, state.piAiEntry).filter(id => id !== state.providerId)
                if (taken.includes(candidate)) {
                  sendJson(res, 400, {
                    ok: false,
                    field: 'providerId',
                    error: `供应商名称 "${candidate}" 已被现有提供商占用，请换一个`,
                  })
                  return
                }
                nextProviderId = candidate
              }

              let nextBaseURL = state.baseURL
              if (body.baseURL !== undefined) {
                const candidate = String(body.baseURL).trim()
                let parsed
                try {
                  parsed = new URL(candidate)
                } catch {
                  sendJson(res, 400, { ok: false, field: 'baseURL', error: '服务器地址不是合法的 URL' })
                  return
                }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                  sendJson(res, 400, { ok: false, field: 'baseURL', error: '服务器地址只支持 http / https' })
                  return
                }
                nextBaseURL = candidate.replace(/\/+$/, '')
              }

              // 先落 Key，再落其余设置：Key 失败就不该留下半套配置。
              if (body.apiKey !== undefined) await storeApiKey(ctx, state.apiKeyEnv, String(body.apiKey))

              // 改名前先记下旧 id 与旧地址，后面要靠它们判断是否需要重建。
              const previousProviderId = state.providerId
              const previousBaseURL = state.baseURL
              const renamed = nextProviderId !== previousProviderId
              const addressChanged = nextBaseURL !== previousBaseURL

              state.providerId = nextProviderId
              state.baseURL = nextBaseURL
              try {
                writeSavedSettings(ctx, state)
              } catch (error) {
                sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
                return
              }

              // 改名后旧 provider 会变成孤儿，清掉它，再把模型写到新 id 下。
              if (renamed) {
                try {
                  await ctx.settings.mutate(state.piAiEntry, [
                    { op: 'unset', path: ['providers', previousProviderId] },
                  ])
                } catch {
                  // 旧 id 本来就不存在时 unset 会失败，忽略即可。
                }
              }

              // 地址或 id 变了，已写入的 provider 必须跟着对齐，否则对话会连到旧端点。
              const noModelsYet = readExistingModelIds(ctx, state.piAiEntry, state.providerId).length === 0
              // 地址为空时没有可同步的目标，等用户先填地址。
              const hasAddress = String(state.baseURL ?? '').length > 0
              const needsResync = hasAddress && (renamed || addressChanged || noModelsYet)
              let sync = null
              let syncError
              if (needsResync) {
                try {
                  sync = await runSync()
                } catch (error) {
                  syncError = error?.message ?? String(error)
                }
              }

              sendJson(res, 200, {
                ...await describeState(),
                saved: true,
                renamed,
                sync,
                ...syncError === undefined ? {} : { syncError },
              })
              return
            }
            sendJson(res, 405, { ok: false, error: '设置端点只支持 GET / POST' })
            return
          }

          // ── 只读状态 ────────────────────────────────────────────────
          if (isStatus) {
            sendJson(res, 200, await describeState())
            return
          }

          // ── 同步 ────────────────────────────────────────────────────
          if (method !== 'POST' && method !== 'GET') {
            sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
            return
          }
          try {
            // 测试模型是可选的：POST 可以在 body 里明确开关，GET 用配置默认值。
            let verify = state.verifyModelsByDefault
            if (method === 'POST') {
              const body = await readJsonBody(req)
              if (typeof body.verify === 'boolean') verify = body.verify
            }
            sendJson(res, 200, await runSync({ verify }))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-agent2sync: 同步失败：${message}`)
            sendJson(res, 500, { ok: false, error: message })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`dsh-agent2sync: 端点异常：${message}`)
          sendJson(res, 500, { ok: false, error: message })
        }
      },
    }), 'dsh-agent2sync: sync 路由')
  })

  // 首次装配且 provider 还不存在时自动建一次；之后一律手动。
  if (state.bootstrapOnLoad !== false) {
    // 插件常常比 llm-pi-ai 先装配：那一刻设置系统里还没有目标条目，
    // mutate 会以 "No configurable plugin entry" 失败。所以这里不是「试一次」，
    // 而是隔一会儿重试几次，让首次安装真的能自动建好提供商。
    const BOOTSTRAP_ATTEMPTS = 5
    const BOOTSTRAP_DELAY_MS = 1500
    const bootstrap = (attempt) => {
      // 还没配置网关地址，等用户在卡片里填好再说，不必重试。
      if (effectiveBaseURL(ctx, state).length === 0) return
      try {
        // 已经有了就什么都不做（重启后不会重复拉取网关）
        if (readExistingModelIds(ctx, state.piAiEntry, state.providerId).length > 0) return
      } catch {
        // describe 失败同样意味着配置系统还没就绪，继续重试
      }
      runSync().then(
        (result) => ctx.logger?.info?.(`dsh-agent2sync: 已自动创建提供商 ${state.providerId}，写入 ${result.total} 个模型`),
        (error) => {
          if (attempt + 1 < BOOTSTRAP_ATTEMPTS) {
            const timer = setTimeout(() => bootstrap(attempt + 1), BOOTSTRAP_DELAY_MS)
            timer.unref?.()
            return
          }
          ctx.logger?.warn?.(`dsh-agent2sync: 自动初始化失败（可稍后在设置页手动同步）：${error?.message ?? error}`)
        },
      )
    }
    const firstTimer = setTimeout(() => bootstrap(0), BOOTSTRAP_DELAY_MS)
    firstTimer.unref?.()
  }
}
