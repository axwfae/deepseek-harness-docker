/**
 * 回归防线：设置页的三个闸门。
 *
 * 曾经因为只给根节点加 toJSON，导致 volatileForm() 对子节点调用 toJSON() 时抛
 * 「schema.toJSON is not a function」，整个设置页崩溃、连带大量功能不可用。
 *
 * 本脚本只依赖仓库内的源码；DSH 自带 schemastery 找不到时，跨库重建的三项
 * 校验会明确标注「略过」而不是误报失败。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const { Config } = await import(new URL('../src/index.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}
const skip = (name, why) => console.log(`- ${name}（略过：${why}）`)

/** 在本机找 DSH 自带的 schemastery；找不到就跳过跨库校验。 */
function loadSchema() {
  const roots = [
    process.env.DSH_INSTALL,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  ].filter(Boolean)
  for (const root of roots) {
    const anchor = join(root, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
    if (!existsSync(anchor)) continue
    try {
      return createRequire(anchor)('@deepseek-ai/schemastery')
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

const Schema = loadSchema()

// 闸门 1：根节点有 toJSON
check('根节点 toJSON', typeof Config.toJSON === 'function')

// 闸门 2：**每个子节点**都有 toJSON（设置页崩过的根因）
const missing = Object.entries(Config.dict ?? {}).filter(([, v]) => typeof v.toJSON !== 'function')
check('所有子节点都有 toJSON', missing.length === 0, missing.map(([k]) => k).join(',') || '全部具备')

// 闸门 3：每个 volatile 字段单独 toJSON 后能被真实 schemastery 重建
if (Schema) {
  for (const [key, child] of Object.entries(Config.dict ?? {})) {
    if (!child.meta?.volatile) continue
    try {
      const rebuilt = new Schema(child.toJSON())
      check(`volatile 字段 ${key} 可单独重建`, Boolean(rebuilt.toJSON()), `type=${rebuilt.type}`)
    } catch (err) {
      check(`volatile 字段 ${key} 可单独重建`, false, err.message)
    }
  }

  // 闸门 4：volatile 字段 meta 在重建后保留（否则表单不显示）
  for (const [key, child] of Object.entries(Config.dict ?? {})) {
    if (!child.meta?.volatile) continue
    const json = child.toJSON()
    const kept = json.refs[json.uid].meta?.volatile === true
    check(`字段 ${key} 重建后仍 volatile`, kept)
  }
} else {
  for (const key of Object.keys(Config.dict ?? {})) {
    if (Config.dict[key].meta?.volatile) skip(`volatile 字段 ${key} 跨库重建`, '本机找不到 schemastery')
  }
  skip('字段 volatile 保留', '本机找不到 schemastery')
}

// 闸门 5：toJSON 幂等（revision 计算依赖它）
check('toJSON 幂等', JSON.stringify(Config.toJSON()) === JSON.stringify(Config.toJSON()))

// 闸门 6：整体能被真实 schemastery 重建并保留默认值
if (Schema) {
  const root = new Schema(Config.toJSON())
  check('根 schema 可重建', Boolean(root.toJSON()))
  check('默认值保留', root.dict.tier.meta.default === 'small', String(root.dict.tier.meta.default))
} else {
  skip('根 schema 跨库重建', '本机找不到 schemastery')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
