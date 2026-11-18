/**
 * 工具注册顺序回归。
 *
 * 真实故障：插件 fiber `active`，但四个工具全部 `unknown tool`——冷启动时本插件的行
 * 先于 `tools` 行解析，`ctx.get('tools')` 返回 undefined，apply 直接 return。
 * 重载一次（此时 tools 已存在）就恢复，所以只在「重启后第一次」出现。
 *
 * 修法：用 `ctx.inject(['tools'])` 等依赖就绪；本测试覆盖「服务先到」与「服务后到」
 * 两种顺序，确保都不会漏注册。
 */
const mod = await import(new URL('../src/index.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/**
 * 造一个假 ctx。
 * @param {boolean} toolsFirst - true 表示 tools 服务在 apply 时已存在
 */
function makeCtx(toolsFirst) {
  const tools = new Map()
  const service = {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  }
  const disposers = []
  let toolsInject = null
  const scopeFor = (svc) => ({
    get: (n) => (n === 'tools' ? svc : undefined),
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
  })
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (n) => (n === 'tools' && toolsFirst ? service : undefined),
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    inject: (names, cb) => {
      if (!Array.isArray(names)) return
      if (names.includes('tools')) {
        if (toolsFirst) cb(scopeFor(service))
        else toolsInject = cb
      }
      // connection 等其它服务：本测试不提供，也不回调（模拟非 Web 载体）
    },
  }
  return {
    ctx,
    tools,
    /** 服务后到时手动投递，返回注册后的工具表。 */
    deliverTools() {
      toolsInject?.(scopeFor(service))
      return tools
    },
  }
}

/* ---------------- 场景 1：tools 服务后到（冷启动顺序问题） ---------------- */
const late = makeCtx(false)
mod.apply(late.ctx, mod.Config['~standard'].validate({}).value)
check('服务未到时 apply 不抛错', true)
check('服务未到时不注册（队列等待）', late.tools.size === 0)
const afterDelivery = late.deliverTools()
check('服务到达后补齐 4 个工具', afterDelivery.size === 4, [...afterDelivery.keys()].join(', '))
check(
  '工具名完整',
  ['youtube_transcript', 'youtube_transcribe', 'youtube_subs_status', 'youtube_subs_purge'].every((n) =>
    afterDelivery.has(n),
  ),
)

/* ---------------- 场景 2：tools 服务先到（热重载 / 后置加载） ---------------- */
const early = makeCtx(true)
mod.apply(early.ctx, mod.Config['~standard'].validate({}).value)
check('服务先到则立即注册', early.tools.size === 4, [...early.tools.keys()].join(', '))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
