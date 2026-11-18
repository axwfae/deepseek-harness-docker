/**
 * 卡片 RPC 注册方式的离线验证（用真实 cordis，不是 mock）。
 *
 * 背景：卡片报 `HTTP 405`，说明 `/youtube-subtitles/*` 前缀路由从未挂到 webServer。
 * 原因是 `connection.rpc.handle()` 内部是：
 *
 *     get rpc() { const owner = this.ctx; return { handle: (ch, h) => this.register(owner, ch, h) } }
 *     register(owner, channel, handler) {
 *       ... owner.effect(() => owner.webServer.register({ kind: 'prefix', path: channel, ... }))
 *     }
 *
 * 而 cordis 的 traceable proxy 对 `ctx` 属性返回的是**调用方**的 ctx
 * （createTraceable: `if (prop === tracker.property) return useSite`）。
 * 所以 `owner` 实际是我的插件 fiber —— `owner.webServer` 要求**我的** ctx 声明了
 * `webServer` 注入，否则抛 `cannot get property "webServer" without inject`。
 *
 * 本脚本用真实 cordis 复现三种情形：
 *   A. 未 inject webServer  → 注册抛错、路由未挂（复现 405 的根因）
 *   B. inject webServer     → 路由挂上、路径/kind 正确（修复后的行为）
 *   C. /api 已被占用时再 intercept → 抛「already has an interceptor」（回滚的理由）
 */
import { existsSync } from 'node:fs'

/** 从 DSH 安装目录解析真实的 @deepseek-ai/cordis。 */
function cordisEntry() {
  const roots = [process.env.DSH_INSTALL, '/usr/local/lib/node_modules/@deepseek-ai/dsh'].filter(Boolean)
  for (const root of roots) {
    const hit = `${root}/node_modules/@deepseek-ai/cordis/lib/index.js`
    if (existsSync(hit)) return hit
  }
  return null
}

const entry = cordisEntry()
if (!entry) {
  console.log('- 略过：本机找不到 @deepseek-ai/cordis')
  process.exit(0)
}
const { Context, Service } = await import(entry)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/** 最小 webServer：只记录 prefix/exact 路由。 */
class FakeWebServer extends Service {
  routes = []
  constructor(ctx) {
    super(ctx, 'webServer')
    this.protocol = 'http:'
  }
  register(route) {
    this.routes.push({ kind: route.kind, path: route.path })
    return () => {}
  }
}

/** 最小 connection：handle/intercept 的语义照抄真实实现。 */
class FakeConnection extends Service {
  interceptors = new Map()
  constructor(ctx) {
    super(ctx, 'connection')
  }
  /** 真实实现：getter 里取 this.ctx 作为 route 的 owner。 */
  get rpc() {
    const owner = this.ctx
    return {
      handle: (channel, handler) => {
        return owner.effect(() => {
          // 关键行：真实代码是 owner.webServer.register(route)
          const ws = owner.webServer
          return ws.register({ kind: 'prefix', path: channel, handler })
        })
      },
      intercept: (channel, matches, handler) => {
        if (channel !== '/api') throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
        return owner.effect(() => {
          if (this.interceptors.has(channel)) {
            throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
          }
          this.interceptors.set(channel, { matches, handler })
          return () => this.interceptors.delete(channel)
        })
      },
    }
  }
}

/**
 * 搭一个最小宿主：webServer + connection 已提供，再按给定 inject 声明挂插件。
 * @param {string[]} injectDeps - 插件声明的依赖
 * @param {function} apply - 插件体
 */
async function boot(injectDeps, apply) {
  const root = new Context()
  const ws = new FakeWebServer(root)
  const conn = new FakeConnection(root)
  // connection 需要 webServer 才能注册路由，模拟真实依赖
  const errors = []
  const fiber = root.plugin({
    inject: injectDeps,
    apply: (ctx) => {
      apply(ctx)
    },
  })
  // fiber 是 thenable：等它真正 apply 完，否则读到的是未执行状态
  try {
    await fiber
  } catch (err) {
    errors.push(err)
  }
  return { root, ws, conn, fiber, errors }
}

/* ---------------- A. 未 inject webServer ---------------- */
{
  const { ws } = await boot(['connection'], (ctx) => {
    const connection = ctx.get('connection')
    ctx.effect(() => {
      try {
        connection.rpc.handle('/youtube-subtitles', async () => ({ ok: true }))
      } catch (err) {
        // 真实宿主里这个错被 fiber 吞掉，路由静默不挂
        ;(globalThis.__aErr ??= []).push(err.message)
      }
    })
  })
  // 注意：本最小复现里 connection 直接由 root 提供，读 webServer 不会触发 cordis 的
  // inject 门槛，因此无法复现真实宿主的 `cannot get property "webServer" without inject`。
  // 这里只记录现象，不作为结论；真实宿主的行为见 README 1.6.2 的排障记录。
  const errs = globalThis.__aErr ?? []
  console.log(`- A 场景（最小复现不等价）：routes=${ws.routes.length}，错误=${errs[0] ?? '无'}`)
}

/* ---------------- B. inject webServer（修复后的写法） ---------------- */
{
  const { ws } = await boot(['connection', 'webServer'], (ctx) => {
    ctx.effect(() => {
      const connection = ctx.get('connection')
      return connection.rpc.handle('/youtube-subtitles', async () => ({ ok: true }))
    })
  })
  check('B inject webServer 后路由挂上', ws.routes.length === 1, JSON.stringify(ws.routes))
  check('B 路径与 kind 正确', ws.routes[0]?.path === '/youtube-subtitles' && ws.routes[0]?.kind === 'prefix', JSON.stringify(ws.routes[0]))
}

/* ---------------- C. /api 已被占用再 intercept ---------------- */
{
  const { root } = await boot(['connection', 'webServer'], () => {})
  const conn = root.get('connection')
  let firstOk = true
  let secondMsg = ''
  try {
    conn.rpc.intercept('/api', () => true, async () => ({ ok: true }))
  } catch (err) {
    firstOk = false
    secondMsg = err.message
  }
  let thirdMsg = ''
  try {
    conn.rpc.intercept('/api', () => true, async () => ({ ok: true }))
  } catch (err) {
    thirdMsg = err.message
  }
  check('C 首个 /api 拦截器可注册（api-gateway 已占用）', firstOk, secondMsg)
  check('C 第二个 /api 拦截器被拒', /already has an interceptor/.test(thirdMsg), thirdMsg)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
