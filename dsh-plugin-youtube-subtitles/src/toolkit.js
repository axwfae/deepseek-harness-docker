/**
 * 工具定义的极简构造器。
 *
 * 为什么不用 `@deepseek-ai/dsh-tools` 的 defineTool：
 *   插件的代码可以位于工作区任意目录（bundle 通过 link 安装），此时 Node 的
 *   模块解析链找不到 DSH 安装目录里的 `@deepseek-ai/dsh-tools`，插件会在
 *   `failed to import` 时无法激活。实测已装插件（如 dsh-agent-lang）同样不 import
 *   任何 DSH 包，只通过 ctx 拿服务。
 *
 *   defineTool 本身只是薄壳：把 author-facing 的 schema DSL 编译成 JSON Schema，
 *   再做参数校验与结果投影。这里直接产出 registry 期望的 ToolDefinition 形状，
 *   零依赖、可在任意目录运行。
 *
 * 生成的对象形状与 `ToolDefinition` 契约一致：
 *   { name, description, parameters: <JSON Schema>, output: { schema, render }, execute }
 */

/** 把属性映射形式（{ required: true } 标注）编译成标准 JSON Schema。 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/** 参数校验：返回违规描述数组，空数组表示通过。 */
export function validateArgs(schema, args) {
  const violations = []
  const value = args ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [`参数必须是对象，收到 ${Array.isArray(value) ? 'array' : typeof value}`]
  }
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) violations.push(`缺少必填参数「${key}」`)
  }
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const v = value[key]
    if (v === undefined || v === null) continue
    const expect = node.type
    const actual = Array.isArray(v) ? 'array' : typeof v
    if (expect === 'integer') {
      if (!Number.isInteger(v)) violations.push(`参数「${key}」应为整数，收到 ${actual}`)
    } else if (expect === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) violations.push(`参数「${key}」应为数字，收到 ${actual}`)
    } else if (expect === 'array') {
      if (!Array.isArray(v)) violations.push(`参数「${key}」应为数组，收到 ${actual}`)
    } else if (expect && actual !== expect) {
      violations.push(`参数「${key}」应为 ${expect}，收到 ${actual}`)
    }
    if (Array.isArray(node.enum) && !node.enum.includes(v)) {
      violations.push(`参数「${key}」取值必须是 ${node.enum.join(' / ')} 之一，收到 ${JSON.stringify(v)}`)
    }
  }
  return violations
}

/**
 * 定义一个工具。
 * @param {object} options - { name, description, parameters, output, execute, presentCall?, presentResult? }
 * @returns registry 可直接 register 的 ToolDefinition
 */
export function defineTool(options) {
  const { name, description, parameters = {}, output, execute } = options
  if (!name) throw new Error('defineTool: name 必填')
  if (!description) throw new Error(`defineTool(${name}): description 必填`)
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute 必须是函数`)
  if (!output || !output.render) throw new Error(`defineTool(${name}): output.render 必填`)

  const compiled = compileParameters(parameters)
  const outputSchema = output.schema ?? { type: 'json' }

  const tool = {
    name,
    description,
    parameters: compiled,
    output: {
      schema: outputSchema,
      render: output.render,
      ...(output.presentationMeta ? { presentationMeta: output.presentationMeta } : {}),
    },
    async execute(rawArgs, exec) {
      const violations = validateArgs(compiled, rawArgs)
      if (violations.length > 0) {
        throw new Error(`参数校验失败：${violations.join('；')}`)
      }
      return execute(rawArgs ?? {}, exec)
    },
  }
  if (options.presentCall) tool.presentCall = options.presentCall
  if (options.presentResult) tool.presentResult = options.presentResult
  if (options.isConcurrencySafe) tool.isConcurrencySafe = options.isConcurrencySafe
  if (options.timeoutMs) tool.timeoutMs = options.timeoutMs
  return tool
}

/** 默认的 JSON 渲染器：把返回值序列化后作为文本内容。 */
export function jsonRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/* ---------------------------------------------------------------- 配置校验 */

/**
 * 构造一个符合 Standard Schema 的配置校验器（零依赖）。
 *
 * 为什么需要：cordis 的 resolveConfig 会调用 `Plugin.Config['~standard'].validate(config)`。
 * 如果 `Config` 是普通对象（没有 `~standard`），启动时直接抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 表现为「1 entry did not activate」。
 *
 * 接口形状（实测 @deepseek-ai/schemastery 的产物）：
 *   { '~standard': { version: 1, vendor: '<name>', validate(input) } }
 *   validate 同步返回 { value } 或 { issues: [{ message, path }] }
 *
 * 这里只做保守的轻量校验：类型不符或取值非法即报 issue，未声明的字段原样透传，
 * 未提供的字段保持缺失（由插件代码自己填默认值）。这样既不 import 任何包，
 * 也不会因校验过严而在用户写配置时误报。
 *
 * @param {string} vendor - 校验器来源标识
 * @param {Record<string, {type?:string, enum?:string[]}>} spec - 字段规则
 */
export function defineConfig(vendor, spec) {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate(input) {
        const raw = input ?? {}
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          return { issues: [{ message: `配置必须是对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}` }] }
        }
        const issues = []
        for (const [key, rule] of Object.entries(spec ?? {})) {
          const v = raw[key]
          if (v === undefined || v === null) continue
          if (rule.type === 'number') {
            // 允许配置写成字符串数字（YAML 环境变量替换常见）
            const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
            if (typeof n !== 'number' || !Number.isFinite(n)) {
              issues.push({ message: `$.${key} 应为数字，收到 ${JSON.stringify(v)}`, path: [key] })
            }
          } else if (rule.type === 'string') {
            if (typeof v !== 'string') {
              issues.push({ message: `$.${key} 应为字符串，收到 ${typeof v}`, path: [key] })
            } else if (Array.isArray(rule.enum) && rule.enum.length > 0 && !rule.enum.includes(v)) {
              issues.push({ message: `$.${key} 取值必须是 ${rule.enum.join(' / ')} 之一，收到 ${JSON.stringify(v)}`, path: [key] })
            }
          }
        }
        if (issues.length > 0) return { issues }
        return { value: raw }
      },
    },
  }
}
