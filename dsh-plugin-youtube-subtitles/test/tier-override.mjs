/**
 * 档位覆盖（对话式切换）回归：
 *   1. resolveTier 的优先级与失效规则；
 *   2. youtube_subs_status 的 setTier 真的生效、可清除；
 *   3. 配置档位变化后覆盖自动失效（不会「界面改了没反应」）；
 *   4. 卡片 RPC 能清除覆盖。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mod = await import(new URL('../src/index.js', import.meta.url).href)
const settings = await import(new URL('../src/settings.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/* ---------------- 1. 纯函数规则 ---------------- */
check(
  '无覆盖时用配置值',
  JSON.stringify(settings.resolveTier('small', null, 'small')) ===
    JSON.stringify({ tier: 'small', source: 'config', stale: false }),
)
check(
  '覆盖匹配配置时生效',
  JSON.stringify(settings.resolveTier('small', { tier: 'full', configTier: 'small' }, 'small')) ===
    JSON.stringify({ tier: 'full', source: 'override', stale: false }),
)
check(
  '配置改动后覆盖失效',
  JSON.stringify(settings.resolveTier('full', { tier: 'full', configTier: 'small' }, 'small')) ===
    JSON.stringify({ tier: 'full', source: 'config', stale: true }),
)
check(
  '配置非法时回默认档',
  settings.resolveTier('bogus', null, 'small').tier === 'small',
)
check(
  '手写覆盖缺 configTier 不生效',
  settings.resolveTier('small', { tier: 'full', configTier: '' }, 'small').source === 'config',
)

/* ---------------- 2. 工具集成 ---------------- */
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-tier-'))

function makeTools(configOverrides) {
  const tools = new Map()
  let cardRoute = null
  let rpcChannel = null
  const injectCalls = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (n) => (n === 'tools' ? { register: (d) => { tools.set(d.name, d); return () => {} } } : undefined),
    effect: (fn) => { fn() },
    inject: (names, cb) => {
      if (!Array.isArray(names)) return
      injectCalls.push([...names])
      if (names.includes('tools')) {
        const service = { register: (d) => { tools.set(d.name, d); return () => {} } }
        cb({ get: (n) => (n === 'tools' ? service : undefined), effect: (fn) => { fn() } })
      }
      if (names.includes('webServer')) {
        const webServer = {
          register(route) {
            cardRoute = route
            rpcChannel = route.path
            return () => {}
          },
        }
        cb({ get: (n) => (n === 'webServer' ? webServer : undefined), effect: (fn) => { fn() } })
      }
    },
  }
  const config = mod.Config['~standard'].validate({ dataRoot, ...configOverrides }).value
  mod.apply(ctx, config)
  return { tools, getRoute: () => cardRoute, getChannel: () => rpcChannel, injectCalls }
}

try {
  const { tools, getRpc } = makeTools({ tier: 'small' })
  const status = tools.get('youtube_subs_status')
  check('注册了 youtube_subs_status', Boolean(status))
  check('setTier 参数存在', status?.parameters?.properties?.setTier?.type === 'string')

  const before = await status.execute({}, {})
  check('初始档位来自配置', before.model.currentTier === 'small' && before.model.tierSource === 'config')
  check('初始无覆盖', before.model.tierOverride === null)

  const switched = await status.execute({ setTier: 'full' }, {})
  check('切换写入成功', switched.switchedNow?.[0]?.action === 'set', switched.switchedNow?.[0]?.note)
  check('切换后立即生效', switched.model.currentTier === 'full' && switched.model.tierSource === 'override')
  check('切换记录落盘', (await fs.stat(path.join(dataRoot, 'tier-override.json')).catch(() => null)) !== null)
  check('回传切换指引', typeof switched.changeTierHint === 'string' && switched.changeTierHint.includes('setTier'))

  const again = await status.execute({}, {})
  check('后续调用仍是覆盖档位', again.model.currentTier === 'full' && again.model.tierSource === 'override')

  const cleared = await status.execute({ setTier: 'config' }, {})
  check('清除覆盖', cleared.switchedNow?.[0]?.action === 'clear' && cleared.switchedNow?.[0]?.cleared === true)
  check('清除后回到配置值', cleared.model.currentTier === 'small' && cleared.model.tierSource === 'config')
  check('覆盖文件已删除', (await fs.stat(path.join(dataRoot, 'tier-override.json')).catch(() => null)) === null)

  /* ---------------- 3. 配置变更使覆盖失效 ---------------- */
  await settings.writeTierOverride(dataRoot, 'full', 'small')
  const stale = makeTools({ tier: 'full' })
  const staleStatus = await stale.tools.get('youtube_subs_status').execute({}, {})
  check('配置变更后覆盖失效', staleStatus.model.tierSource === 'config' && staleStatus.model.currentTier === 'full')
  check('回传 stale 标记', staleStatus.model.staleOverride === true)

  /* ---------------- 4. 卡片 RPC 清除 ---------------- */
  await settings.writeTierOverride(dataRoot, 'full', 'small')
  const cardHost = makeTools({ tier: 'small' })
  const route = cardHost.getRoute()
  check('路由已注册', Boolean(route))
  check(
    '注册自建 prefix 路由',
    route?.kind === 'prefix' && route?.path === '/youtube-subtitles',
    JSON.stringify({ kind: route?.kind, path: route?.path }),
  )
  // 关键回归：只注入 webServer，不碰 connection.rpc
  // （`/api` 被 api-gateway 独占，`rpc.handle` 的 owner 语义在真实宿主上让路由挂不上）
  check(
    'inject 声明 webServer',
    cardHost.injectCalls.some((names) => names.includes('webServer')),
    JSON.stringify(cardHost.injectCalls),
  )

  /** 用假 req/res 走一遍真实 HTTP handler。 */
  const httpPost = async (endpoint, body) => {
    const chunks = [Buffer.from(JSON.stringify(body ?? {}))]
    const req = {
      method: 'POST',
      url: `/youtube-subtitles/${endpoint}`,
      [Symbol.asyncIterator]: () => chunks[Symbol.iterator](),
    }
    let status = 0
    let payload = ''
    const res = {
      writeHead: (code) => { status = code },
      end: (text) => { payload = text },
    }
    await route.handler(req, res)
    return { status, body: JSON.parse(payload) }
  }

  const got = await httpPost('status')
  check('HTTP 200', got.status === 200, String(got.status))
  check('状态含覆盖信息', got.body.ok === true && got.body.value.tierSource === 'override')
  const clearResult = (await httpPost('clearTierOverride')).body
  check('清除成功', clearResult.ok === true && clearResult.value.cleared === true)
  const after = (await httpPost('status')).body
  check('清除后回到配置', after.value.tierSource === 'config' && after.value.currentTier === 'small')

  // GET 必须被拒（405），避免被当成可缓存查询
  const reqGet = { method: 'GET', url: '/youtube-subtitles/status', [Symbol.asyncIterator]: () => [][Symbol.iterator]() }
  let getStatus = 0
  const resGet = { writeHead: (c) => { getStatus = c }, end: () => {} }
  await route.handler(reqGet, resGet)
  check('GET 被拒 405', getStatus === 405, String(getStatus))
} finally {
  await fs.rm(dataRoot, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
