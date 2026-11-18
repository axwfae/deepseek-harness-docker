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
  // 输出 schema 必须落在 DSH 强制的 JSON Schema 子集内（type/oneOf/properties/…）。
  // `{ type: 'json' }` 不是合法类型，会让插件在激活时抛 JsonSchemaError，
  // 表现为「1 entry did not activate」。工具结果都是对象，这里用 object 根。
  const outputSchema = output.schema ?? { type: 'object' }

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
      // exec 可能缺省（某些调用方只传参数）：统一补空对象，避免 exec.signal 抛错
      return execute(rawArgs ?? {}, exec ?? {})
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
