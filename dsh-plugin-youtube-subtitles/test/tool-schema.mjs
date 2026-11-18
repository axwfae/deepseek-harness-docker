/**
 * 工具 schema 回归：参数与输出都必须落在 DSH 强制的 JSON Schema 子集内。
 *
 * 这条测试来自一次真实的安装失败：`output.schema = { type: 'json' }` 在
 * 插件激活时抛 `JsonSchemaError: unsupported JSON schema: schema.type must be
 * one of …`，表现为「1 entry did not activate」，而本地单测全绿——因为没人
 * 用宿主的校验器验过。
 *
 * 找不到 DSH 安装目录时明确略过（不误报）。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const mod = await import(new URL('../src/index.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/** 用假 ctx 收集工具定义。 */
function collectTools() {
  const tools = new Map()
  const service = { register: (d) => { tools.set(d.name, d); return () => {} } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (n) => (n === 'tools' ? service : undefined),
    effect: (fn) => { fn() },
    // 工具注册走 ctx.inject(['tools'])：这里模拟服务已就绪
    inject: (names, cb) => {
      if (Array.isArray(names) && names.includes('tools')) {
        cb({ get: (n) => (n === 'tools' ? service : undefined), effect: (fn) => { fn() } })
      }
    },
  }
  mod.apply(ctx, mod.Config['~standard'].validate({}).value)
  return tools
}

/** 从 DSH 安装目录取真实校验器。 */
function loadValidator() {
  const roots = [process.env.DSH_INSTALL, '/usr/local/lib/node_modules/@deepseek-ai/dsh'].filter(Boolean)
  for (const root of roots) {
    const anchor = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    if (!existsSync(anchor)) continue
    try {
      const dshTools = createRequire(anchor)('@deepseek-ai/dsh-tools')
      if (typeof dshTools.assertSupportedJsonSchema === 'function') return dshTools
    } catch {
      /* 继续找 */
    }
  }
  return null
}

const tools = collectTools()
check('注册了 4 个工具', tools.size === 4, [...tools.keys()].join(', '))

const dshTools = loadValidator()
if (!dshTools) {
  console.log('- schema 子集合规（略过：本机找不到 dsh-tools）')
} else {
  for (const [name, tool] of tools) {
    let paramsOk = true
    let outOk = true
    let detail = ''
    try {
      dshTools.assertObjectJsonSchema(tool.parameters)
    } catch (err) {
      paramsOk = false
      detail = err.message
    }
    try {
      dshTools.assertSupportedJsonSchema(tool.output.schema)
    } catch (err) {
      outOk = false
      detail = err.message
    }
    check(`${name} 参数 schema 合规`, paramsOk, paramsOk ? '' : detail)
    check(`${name} 输出 schema 合规`, outOk, outOk ? `type=${tool.output.schema.type}` : detail)
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
