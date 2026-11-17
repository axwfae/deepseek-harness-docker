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

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
