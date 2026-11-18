/**
 * 服务端离线集成测试：用假的 cordis 上下文驱动插件。
 *
 * 覆盖：
 *   1. 同步的字段映射、写入路径、增删 diff、幂等；
 *   2. 状态端点的凭据探测；
 *   3. 设置端点：读、写、providerId 重名拒绝、地址校验、Key 落凭据、改名清理；
 *   4. 端点防护与错误处理。
 *
 * 跑法：node test/offline.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MODULE = new URL('../src/index.js', import.meta.url).href
const ENTRY = 'llm-pi-ai'
/** 插件不再预置地址，测试必须显式指定；用环境变量可换成任何可达的 Agent2API 网关。 */
const GATEWAY = process.env.AGENT2SYNC_TEST_GATEWAY ?? 'http://192.168.123.200:3065/v1'
/**
 * 目录请求仍要打到真实网关，但必须摘掉测试用的假 Key：
 * 真实网关对「存在但无效」的 Key 会回 401，匿名反而能读到目录。
 */
function passThroughAnonymously(realFetch, url, init) {
  const headers = { ...(init?.headers ?? {}) }
  delete headers.authorization
  return realFetch(url, { ...init, headers })
}

/** 一把假 Key：让探测路径真的跑起来，又不需要真实凭据。 */
const FAKE_CREDENTIALS = {
  async resolve(ref) { return ref === 'AGENT2SYNC_API_KEY' ? { value: 'sk-fake-for-test' } : undefined },
}

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * 造一个假上下文：settings 维护一份可变的 providers 表，mutate 会真的改它，
 * 于是 describe() 能反映写入结果，diff 与改名逻辑都可验证。
 */
function fakeContext(options = {}) {
  const {
    existingModels = [],
    extraProviders = ['workbuddy-free', 'orcarouter', 'other'],
    credentials,
    dir = mkdtempSync(join(tmpdir(), 'a2s-')),
  } = options

  const routes = []
  const mutations = []
  const providers = {}
  for (const id of extraProviders) providers[id] = { displayName: id, models: [] }
  if (existingModels !== null) {
    providers.agent2sync = { displayName: 'Agent2Sync', models: existingModels.map(id => ({ id })) }
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(service) {
      if (service === 'credentials') return credentials
      return undefined
    },
    settings: {
      get documentPath() { return join(dir, 'cordis.patch.yml') },
      describe() {
        return [{
          ns: ENTRY,
          value: { providers: structuredClone(providers) },
        }]
      },
      async mutate(ns, ops) {
        mutations.push({ ns, ops: structuredClone(ops) })
        for (const op of ops) {
          if (op.path.length === 2 && op.path[0] === 'providers') {
            const id = op.path[1]
            if (op.op === 'set') providers[id] = structuredClone(op.value)
            else delete providers[id]
          }
        }
      },
    },
    inject(names, callback) {
      if (!names.includes('webServer')) return
      callback({
        webServer: { register(route) { routes.push(route); return () => {} } },
        effect(fn) { return fn() },
      })
    },
    effect(fn) { return fn() },
  }
  return { ctx, routes, mutations, providers, dir }
}

/** 造一个假 req；handler 用 for-await 读 body，所以要有 async iterator。 */
function makeReq({ method = 'GET', url = '/agent2sync/sync', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/** 调一次路由处理器并取回 JSON。 */
async function callRoute(route, options = {}) {
  const req = makeReq(options)
  let status
  let text
  const res = { writeHead(code) { status = code }, end(chunk) { text = chunk } }
  await route.handler(req, res)
  return { status, json: text === undefined ? undefined : JSON.parse(text) }
}

async function main() {
  const mod = await import(MODULE)
  console.log('模块导出检查')
  check('name 正确', mod.name === 'dsh-agent2sync', mod.name)
  check('inject 含 settings', Array.isArray(mod.inject) && mod.inject.includes('settings'))
  check('apply 是函数', typeof mod.apply === 'function')

  // ── 场景一：全新安装，无凭据 ──────────────────────────────────────────
  console.log('\n场景一：全新安装 + 无凭据')
  let firstSync
  {
    const { ctx, routes, dir } = fakeContext({ existingModels: null })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
    check('注册了一个路由', routes.length === 1)
    check('路由是 exact', routes[0]?.kind === 'exact')
    check('路由路径正确', routes[0]?.path === '/agent2sync/sync', routes[0]?.path)

    const status = await callRoute(routes[0], { url: '/agent2sync/sync?status=1' })
    check('status 返回 200', status.status === 200)
    check('providerId 正确', status.json?.providerId === 'agent2sync')
    check('模型数为 0', status.json?.modelCount === 0)
    check('如实报告 Key 未配置', status.json?.hasApiKey === false)
    check('列出了已有提供商', Array.isArray(status.json?.providers) && status.json.providers.includes('other'))

    const settings = await callRoute(routes[0], { url: '/agent2sync/sync?settings=1' })
    check('settings 读取返回 200', settings.status === 200)
    check('settings 带 baseURL', typeof settings.json?.baseURL === 'string' && settings.json.baseURL.startsWith('http'))
    check('settings 回传 apiKeyEnv', settings.json?.apiKeyEnv === 'AGENT2SYNC_API_KEY')

    const result = await callRoute(routes[0], { method: 'POST' })
    check('同步返回 200', result.status === 200, JSON.stringify(result.json)?.slice(0, 160))
    firstSync = result.json
    check('排除图像模型', firstSync?.excluded === 2, String(firstSync?.excluded))
    check('网关报告 18 个', firstSync?.fetched === 18, String(firstSync?.fetched))
    check('首次全是新增', firstSync?.added?.length === firstSync?.total)
    check('没配 Key 时测试被跳过', firstSync?.verification?.skipped === true,
      JSON.stringify(firstSync?.verification))
    check('设置文件目录存在', existsSync(dir))
  }

  // ── 场景二：增量同步 ──────────────────────────────────────────────────
  console.log('\n场景二：增量同步（删掉已消失的，补回被误删的）')
  if (firstSync !== undefined) {
    const stale = [...firstSync.added.slice(1), 'fake-model-should-be-removed']
    const { ctx, routes } = fakeContext({ existingModels: stale })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
    const result = await callRoute(routes[0], { method: 'POST' })
    check('假模型被删除',
      JSON.stringify(result.json?.removed) === JSON.stringify(['fake-model-should-be-removed']),
      JSON.stringify(result.json?.removed))
    check('被删的真实模型补回',
      JSON.stringify(result.json?.added) === JSON.stringify([firstSync.added[0]]),
      JSON.stringify(result.json?.added))
    check('总数不变', result.json?.total === firstSync.total)

    const again = await callRoute(routes[0], { method: 'POST' })
    check('再同步一次完全幂等',
      again.json?.added?.length === 0 && again.json?.removed?.length === 0,
      JSON.stringify({ added: again.json?.added, removed: again.json?.removed }))
  }

  // ── 场景三：设置写入 ──────────────────────────────────────────────────
  console.log('\n场景三：保存服务器地址与 Key')
  {
    const credentialWrites = []
    const credentials = {
      async resolve(ref) { return credentialWrites.some(w => w.ref === ref) ? { value: 'sk-test' } : undefined },
      async set(ref, value) { credentialWrites.push({ ref, value }) },
      async unset(ref) { credentialWrites.push({ ref, value: null }) },
    }
    const { ctx, routes, dir } = fakeContext({ credentials, existingModels: [] })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })

    const saved = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: JSON.stringify({
        baseURL: 'http://10.0.0.5:8080/v1/',
        apiKey: 'sk-secret-value',
      }),
    })
    check('保存返回 200', saved.status === 200, JSON.stringify(saved.json)?.slice(0, 200))
    check('尾部斜杠被规范化', saved.json?.baseURL === 'http://10.0.0.5:8080/v1', saved.json?.baseURL)
    check('Key 写进凭据服务',
      credentialWrites.length === 1 && credentialWrites[0].ref === 'AGENT2SYNC_API_KEY'
        && credentialWrites[0].value === 'sk-secret-value',
      JSON.stringify(credentialWrites.map(w => w.ref)))
    check('保存后 hasApiKey 变 true', saved.json?.hasApiKey === true)

    const file = join(dir, 'agent2sync.json')
    check('设置落到 agent2sync.json', existsSync(file))
    if (existsSync(file)) {
      const onDisk = JSON.parse(readFileSync(file, 'utf8'))
      check('文件里存了 baseURL', onDisk.baseURL === 'http://10.0.0.5:8080/v1', onDisk.baseURL)
      check('文件里没有明文 Key', JSON.stringify(onDisk).includes('sk-secret-value') === false)
    }

    // 新实例应能读回保存的设置
    const reloaded = fakeContext({ credentials, existingModels: [], dir })
    mod.apply(reloaded.ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
    const status = await callRoute(reloaded.routes[0], { url: '/agent2sync/sync?settings=1' })
    check('重启后能读回保存的地址', status.json?.baseURL === 'http://10.0.0.5:8080/v1', status.json?.baseURL)
  }

  // ── 场景四：供应商重名校验 ────────────────────────────────────────────
  console.log('\n场景四：供应商名称重名拒绝')
  {
    const { ctx, routes } = fakeContext({ existingModels: [] })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })

    const conflict = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: JSON.stringify({ providerId: 'other' }),
    })
    check('重名被拒 400', conflict.status === 400, String(conflict.status))
    check('带字段名', conflict.json?.field === 'providerId', conflict.json?.field)
    check('提示已被占用', typeof conflict.json?.error === 'string' && conflict.json.error.includes('已被现有提供商占用'),
      conflict.json?.error)

    const badShape = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: JSON.stringify({ providerId: 'Bad Name' }),
    })
    check('非法形状被拒 400', badShape.status === 400)
    check('提示字符规则', badShape.json?.error?.includes('只能用小写字母'), badShape.json?.error)

    const badUrl = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: JSON.stringify({ baseURL: 'ftp://nope' }),
    })
    check('非 http(s) 地址被拒 400', badUrl.status === 400)
    check('带 baseURL 字段名', badUrl.json?.field === 'baseURL', badUrl.json?.field)

    const badJson = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: '{not json',
    })
    check('坏 JSON 被拒 500', badJson.status === 500, String(badJson.status))
  }

  // ── 场景五：改名会清掉旧 provider 并重建 ──────────────────────────────
  console.log('\n场景五：改供应商名')
  {
    const { ctx, routes, providers } = fakeContext({ existingModels: ['old-model-a'] })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
    check('改名之前存在 agent2sync', providers.agent2sync !== undefined)

    const renamed = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: JSON.stringify({ providerId: 'my-gateway' }),
    })
    check('改名返回 200', renamed.status === 200, JSON.stringify(renamed.json)?.slice(0, 200))
    check('响应里新 id 生效', renamed.json?.providerId === 'my-gateway', renamed.json?.providerId)
    check('改名被标记', renamed.json?.renamed === true)
    check('旧 provider 被清除', providers.agent2sync === undefined, JSON.stringify(Object.keys(providers)))
    check('新 provider 已建', providers['my-gateway'] !== undefined, JSON.stringify(Object.keys(providers)))
    check('新 provider 已有模型', (providers['my-gateway']?.models?.length ?? 0) > 0,
      String(providers['my-gateway']?.models?.length))
  }

  // ── 场景六：端点防护 ──────────────────────────────────────────────────
  console.log('\n场景六：端点防护')
  {
    const { ctx, routes } = fakeContext({ existingModels: [] })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })

    const del = await callRoute(routes[0], { method: 'DELETE' })
    check('非 GET/POST 同步被拒 405', del.status === 405, String(del.status))

    const cross = await callRoute(routes[0], {
      headers: { origin: 'http://evil.example', host: '127.0.0.1:3079' },
    })
    check('跨站请求被拒 403', cross.status === 403, String(cross.status))

    const same = await callRoute(routes[0], {
      url: '/agent2sync/sync?status=1',
      headers: { origin: 'http://127.0.0.1:3079', host: '127.0.0.1:3079' },
    })
    check('同源请求放行', same.status === 200, String(same.status))
  }

  // ── 场景七：网关不可达 ────────────────────────────────────────────────
  console.log('\n场景七：网关不可达')
  {
    const { ctx, routes } = fakeContext({ existingModels: [] })
    mod.apply(ctx, { baseURL: 'http://127.0.0.1:59999/v1', bootstrapOnLoad: false, requestTimeoutMs: 3000 })
    const result = await callRoute(routes[0], { method: 'POST' })
    check('返回 500 不崩溃', result.status === 500, String(result.status))
    check('带可读错误', typeof result.json?.error === 'string' && result.json.error.length > 0)
  }

  // ── 场景八：启动自动初始化 ────────────────────────────────────────────
  // 插件常比 llm-pi-ai 先装配，所以 bootstrap 会重试；这里真等它跑完。
  console.log('\n场景八：启动自动初始化（bootstrapOnLoad）')
  {
    // 该 provider 还不存在 → 应自动建好并写入模型
    const { ctx, providers } = fakeContext({ existingModels: null })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: true })
    await new Promise(resolve => setTimeout(resolve, 3500))
    check('首次启动自动创建了 provider', providers.agent2sync !== undefined, JSON.stringify(Object.keys(providers)))
    check('自动写入的模型非空', (providers.agent2sync?.models?.length ?? 0) > 0,
      String(providers.agent2sync?.models?.length))
    check('自动写入的显示名是 Agent2Sync', providers.agent2sync?.displayName === 'Agent2Sync',
      providers.agent2sync?.displayName)
  }
  {
    // 该 provider 已存在 → 重启后不该重复拉取、不该改写配置
    const { ctx, providers, mutations } = fakeContext({ existingModels: ['already-there'] })
    const before = mutations.length
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: true })
    await new Promise(resolve => setTimeout(resolve, 2200))
    check('已存在时不再写配置', mutations.length === before, String(mutations.length - before))
    check('已存在时模型未被覆盖',
      JSON.stringify(providers.agent2sync?.models) === JSON.stringify([{ id: 'already-there' }]),
      JSON.stringify(providers.agent2sync?.models))
  }
  {
    // 关掉开关就完全不碰网络
    const { ctx, providers, mutations } = fakeContext({ existingModels: null })
    mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
    await new Promise(resolve => setTimeout(resolve, 1800))
    check('关闭开关时不自动创建', providers.agent2sync === undefined)
    check('关闭开关时不写配置', mutations.length === 0, String(mutations.length))
  }

  // ── 场景九：地址默认空白 ──────────────────────────────────────────────
  console.log('\n场景九：服务器地址默认空白（不预置任何地址）')
  {
    const { ctx, routes } = fakeContext({ existingModels: null })
    // 不传 baseURL：模拟全新安装
    mod.apply(ctx, { bootstrapOnLoad: false })

    const status = await callRoute(routes[0], { url: '/agent2sync/sync?status=1' })
    check('status 里 baseURL 是空字符串', status.json?.baseURL === '', JSON.stringify(status.json?.baseURL))
    check('不是 null 也不是占位地址', status.json?.baseURL !== null && !String(status.json?.baseURL).includes('3065'))

    const settings = await callRoute(routes[0], { url: '/agent2sync/sync?settings=1' })
    check('settings 里 baseURL 同样是空', settings.json?.baseURL === '', JSON.stringify(settings.json?.baseURL))

    const sync = await callRoute(routes[0], { method: 'POST' })
    check('空地址同步返回 500', sync.status === 500, String(sync.status))
    check('提示去卡片里填地址',
      typeof sync.json?.error === 'string' && sync.json.error.includes('尚未设置服务器地址'),
      sync.json?.error)
  }
  {
    // 空地址时启动初始化应该直接放弃，不做无谓重试
    const { ctx, mutations, providers } = fakeContext({ existingModels: null })
    mod.apply(ctx, { bootstrapOnLoad: true })
    await new Promise(resolve => setTimeout(resolve, 2400))
    check('空地址时不自动创建 provider', providers.agent2sync === undefined)
    check('空地址时不写配置（也不重试）', mutations.length === 0, String(mutations.length))
  }
  {
    // 填了地址再保存，就该立刻建好
    const { ctx, routes, providers } = fakeContext({ existingModels: null })
    mod.apply(ctx, { bootstrapOnLoad: false })
    const saved = await callRoute(routes[0], {
      method: 'POST',
      url: '/agent2sync/sync?settings=1',
      body: JSON.stringify({ baseURL: GATEWAY }),
    })
    check('填写地址后保存返回 200', saved.status === 200, JSON.stringify(saved.json)?.slice(0, 160))
    check('保存后 baseURL 生效', saved.json?.baseURL === GATEWAY, saved.json?.baseURL)
    check('保存地址后立即建好 provider', providers.agent2sync !== undefined,
      JSON.stringify(Object.keys(providers)))
    check('并写入了模型', (providers.agent2sync?.models?.length ?? 0) > 0,
      String(providers.agent2sync?.models?.length))
  }

  // ── 场景十：地址未保存但 provider 已存在 ──────────────────────────────
  console.log('\n场景十：地址未保存时回退到 provider 里已写入的地址')
  {
    const { ctx, routes, providers } = fakeContext({ existingModels: ['m1'] })
    providers.agent2sync.baseURL = GATEWAY
    // 不传 baseURL：模拟 patch 里留空、但上次已经建好过 provider
    mod.apply(ctx, { bootstrapOnLoad: false })

    const status = await callRoute(routes[0], { url: '/agent2sync/sync?status=1' })
    check('状态回填了 provider 的地址', status.json?.baseURL === GATEWAY, status.json?.baseURL)

    const sync = await callRoute(routes[0], { method: 'POST' })
    check('沿用该地址仍能同步', sync.status === 200, JSON.stringify(sync.json)?.slice(0, 160))
    check('provider 的地址没被抹空', providers.agent2sync.baseURL === GATEWAY, providers.agent2sync.baseURL)
    check('模型保持有效', (providers.agent2sync.models?.length ?? 0) > 0,
      String(providers.agent2sync.models?.length))
  }

  // ── 场景十一：同步时测试模型 ──────────────────────────────────────────
  console.log('\n场景十一：同步时测试模型，跑不通的不进清单')
  {
    const realFetch = globalThis.fetch
    const probed = []
    // 只拦 chat/completions：目录仍走真的网关，探测结果完全可控。
    globalThis.fetch = async (url, init) => {
      const target = String(url)
      if (!target.includes('/chat/completions')) {
        return passThroughAnonymously(realFetch, url, init)
      }
      const body = JSON.parse(init.body)
      const question = (body.messages || []).find(m => m.role === 'user')?.content || ''
      probed.push({ model: body.model, maxTokens: body.max_tokens, stream: body.stream, question })
      // 坏模型：网关直接 503
      if (body.model === 'solar-mini4') {
        return new Response(JSON.stringify({ error: { message: 'model is down' } }), { status: 503 })
      }
      // 好模型：按题目给出正确答案（8 / 60 / 3）
      const answer = question.includes('3 + 5') ? 8 : question.includes('一小时') ? 60 : 3
      return new Response(JSON.stringify({ choices: [{ message: { content: String(answer) } }] }), { status: 200 })
    }
    try {
      const { ctx, routes, providers } = fakeContext({ existingModels: [], credentials: FAKE_CREDENTIALS })
      mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
      const result = await callRoute(routes[0], { method: 'POST', body: JSON.stringify({ verify: true }) })

      check('同步返回 200', result.status === 200, JSON.stringify(result.json)?.slice(0, 200))
      check('每个候选模型都被探测', result.json?.verification?.tested === 16,
        String(result.json?.verification?.tested))
      check('16 个模型都发过探测', new Set(probed.map(p => p.model)).size === 16,
        String(new Set(probed.map(p => p.model)).size))
      check('失败的那个被复判了一次', probed.filter(p => p.model === 'solar-mini4').length === 2,
        String(probed.filter(p => p.model === 'solar-mini4').length))
      check('成功的没有多打请求', probed.filter(p => p.model === 'deepseek-v4.1-flash').length === 1,
        String(probed.filter(p => p.model === 'deepseek-v4.1-flash').length))
      check('汇总里报告了复判数', result.json?.verification?.retried === 1,
        String(result.json?.verification?.retried))
      check('探测请求带题目且非流式',
        probed.every(p => p.stream === false && typeof p.question === 'string' && p.question.length > 0),
        JSON.stringify(probed[0]))
      check('默认预算 1024（思考模型够用）',
        probed.filter(p => p.model !== 'solar-mini4').every(p => p.maxTokens === 1024),
        JSON.stringify(probed[0]))
      check('复判时预算翻倍',
        probed.filter(p => p.model === 'solar-mini4').some(p => p.maxTokens === 2048),
        JSON.stringify(probed.filter(p => p.model === 'solar-mini4').map(p => p.maxTokens)))
      check('三种题型都被用到',
        new Set(probed.map(p => p.question)).size === 3,
        String(new Set(probed.map(p => p.question)).size))
      check('通过 15 个', result.json?.verification?.passed === 15, String(result.json?.verification?.passed))
      check('失败清单只列出坏模型',
        JSON.stringify((result.json?.verification?.failed || []).map(f => f.id)) === JSON.stringify(['solar-mini4']),
        JSON.stringify(result.json?.verification?.failed))
      check('失败原因被记录', String(result.json?.verification?.failed?.[0]?.error).includes('503'),
        JSON.stringify(result.json?.verification?.failed?.[0]))
      check('最终写入 15 个', result.json?.total === 15, String(result.json?.total))
      check('坏模型没进 provider',
        !providers.agent2sync.models.some(model => model.id === 'solar-mini4'))
      check('好模型都还在',
        providers.agent2sync.models.some(model => model.id === 'deepseek-v4.1-flash'))
    } finally {
      globalThis.fetch = realFetch
    }
  }
  {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('/chat/completions')) {
        return passThroughAnonymously(realFetch, url, init)
      }
      return new Response(JSON.stringify({ choices: [] }), { status: 200 })
    }
    try {
      const { ctx, routes, providers } = fakeContext({ existingModels: ['keep-me'], credentials: FAKE_CREDENTIALS })
      mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
      const before = JSON.stringify(providers.agent2sync?.models)
      const result = await callRoute(routes[0], { method: 'POST', body: JSON.stringify({ verify: true }) })
      check('全部失败时返回 500', result.status === 500, String(result.status))
      check('提示已保留原列表',
        typeof result.json?.error === 'string' && result.json.error.includes('已保留原有模型列表'),
        result.json?.error)
      check('原配置确实没被改动',
        JSON.stringify(providers.agent2sync?.models) === before, JSON.stringify(providers.agent2sync?.models))
      check('choices 为空也算失败',
        typeof result.json?.error === 'string' && result.json.error.includes('都没通过测试'))
    } finally {
      globalThis.fetch = realFetch
    }
  }
  {
    // 能回话但答错：这才是不发题目测不出来的那种坏
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('/chat/completions')) return passThroughAnonymously(realFetch, url, init)
      return new Response(JSON.stringify({ choices: [{ message: { content: '七' } }] }), { status: 200 })
    }
    try {
      const { ctx, routes, providers } = fakeContext({ existingModels: [], credentials: FAKE_CREDENTIALS })
      mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
      const result = await callRoute(routes[0], { method: 'POST', body: JSON.stringify({ verify: true }) })
      check('答错的模型全被判失败', result.status === 500, String(result.status))
      check('原 provider 未被清空', providers.agent2sync === undefined || providers.agent2sync.models?.length === 0)
    } finally {
      globalThis.fetch = realFetch
    }
  }
  {
    // 答错但只有部分答错时，只排除错的那个
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('/chat/completions')) return passThroughAnonymously(realFetch, url, init)
      const body = JSON.parse(init.body)
      const question = (body.messages || []).find(m => m.role === 'user')?.content || ''
      const answer = question.includes('3 + 5') ? 8 : question.includes('一小时') ? 60 : 3
      // 让 deepseek-v4.1-flash 故意答错
      const content = body.model === 'deepseek-v4.1-flash' ? String(answer + 1) : String(answer)
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    }
    try {
      const { ctx, routes, providers } = fakeContext({ existingModels: [], credentials: FAKE_CREDENTIALS })
      mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
      const result = await callRoute(routes[0], { method: 'POST', body: JSON.stringify({ verify: true }) })
      check('答错的个别模型被排除', result.json?.total === 15, String(result.json?.total))
      check('失败原因写明答案错误',
        result.json?.verification?.failed?.[0]?.error === '答案错误',
        JSON.stringify(result.json?.verification?.failed?.[0]))
      check('失败项带题目与期望值',
        typeof result.json?.verification?.failed?.[0]?.expected === 'number'
        && typeof result.json?.verification?.failed?.[0]?.prompt === 'string',
        JSON.stringify(result.json?.verification?.failed?.[0]))
      check('答错的模型没进 provider',
        !providers.agent2sync.models.some(model => model.id === 'deepseek-v4.1-flash'))
    } finally {
      globalThis.fetch = realFetch
    }
  }
  {
    // 没有 Key 就没必要探测，直接说清楚
    const { ctx, routes } = fakeContext({ existingModels: [] })
    mod.apply(ctx, { baseURL: GATEWAY, apiKeyEnv: 'AGENT2SYNC_TEST_MISSING_KEY', bootstrapOnLoad: false })
    const result = await callRoute(routes[0], { method: 'POST', body: JSON.stringify({ verify: true }) })
    check('无 Key 时同步照常成功', result.status === 200, String(result.status))
    check('但测试被跳过', result.json?.verification?.skipped === true,
      JSON.stringify(result.json?.verification))
    check('并说明跳过原因',
      String(result.json?.verification?.reason).includes('网关 Key'),
      result.json?.verification?.reason)
    check('跳过时仍写入全部模型', result.json?.total === 16, String(result.json?.total))
  }
  {
    // 不勾选时不发任何探测请求
    const realFetch = globalThis.fetch
    let probed = 0
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions')) probed += 1
      return realFetch(url, init)
    }
    try {
      const { ctx, routes } = fakeContext({ existingModels: [] })
      mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })
      const result = await callRoute(routes[0], { method: 'POST', body: JSON.stringify({ verify: false }) })
      check('不勾选时同步照常成功', result.status === 200, String(result.status))
      check('不勾选时一次探测都不发', probed === 0, String(probed))
      check('不勾选时结果里没有 verification', result.json?.verification === undefined)
      check('模型数仍是 16', result.json?.total === 16, String(result.json?.total))
    } finally {
      globalThis.fetch = realFetch
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
