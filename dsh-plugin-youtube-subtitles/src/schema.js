/**
 * 极简 schemastery 兼容层（零依赖）。
 *
 * 为什么需要：
 *   DSH 的「设置 → 插件」只有在插件 `Config` 满足以下条件时才会列出可配置项
 *   （见 dsh-settings/lib/index.js 的 schema() 与 volatileForm()）：
 *     1. `"toJSON" in Config` —— 必须是 schemastery 形状的 schema，能序列化给前端；
 *     2. 至少一个字段的 `meta.volatile === true`（否则表单为空）；
 *     3. `toJSON()` 产物必须能被客户端的 `new Schema(json)` 重建。
 *
 *   插件以 link 方式安装在任意工作区目录，Node 的解析链到不了 DSH 安装目录里的
 *   `@deepseek-ai/schemastery`，直接 import 会让插件加载失败（同 toolkit.js 的
 *   设计理由）。因此这里实现一个只覆盖本项目所需子集的兼容层，产出与真实
 *   schemastery 完全一致的 `{ uid, refs }` JSON 图，并在本地做同步校验。
 *
 * 与真实 schemastery 的差异（有意为之）：
 *   - 不返回 cosmokit volatile ref（`config.x` 就是原始值，不需要 `.get()`）；
 *   - 只实现 string / number / boolean / union / object 与 default / min / max / enum。
 *
 * 真实 schemastery 的 JSON 图（实测，DSH 0.2.1-rc.2）：
 *   { "uid": 19,
 *     "refs": {
 *       "2": { "type": "const", "meta": { "required": true }, "value": "small" },
 *       "7": { "type": "union", "meta": { "default": "small", "volatile": true }, "list": [2, 4] },
 *       "15": { "type": "number", "meta": { "step": 1, "min": 1, "default": 4, "volatile": true } },
 *       "19": { "type": "object", "meta": { "default": {} }, "dict": { "tier": 7, "numThreads": 15 } } } }
 */

/**
 * 每个 schema 节点的公共属性。
 *
 * **每个节点都必须自带 `toJSON()`**，不能只给根节点加。
 * 原因：dsh-settings 的 volatileForm() 会为每个带 `meta.volatile` 的字段单独调用
 * plainSchema(child)，里面第一句就是 `new Schema(schema.toJSON())`。只给根节点加
 * toJSON 时，`tier` / `numThreads` 这些子节点一旦被单独访问就会抛
 * 「schema.toJSON is not a function」，把整个设置页打崩（实测踩过）。
 *
 * @param {string} type - schemastery 节点类型
 * @param {object} [meta] - 节点元信息（default / volatile / min / max …）
 * @param {object} [extra] - 类型专属字段（dict / list）
 */
function node(type, meta, extra) {
  const current = {
    type,
    meta: meta ?? {},
    ...extra,
  }
  // 以自身为根生成 JSON 图：真实 schemastery 的子节点 toJSON() 就是这个语义
  current.toJSON = () => toJSON(current)
  return current
}

export function string(meta) {
  return node('string', meta)
}

export function number(meta) {
  return node('number', meta)
}

export function boolean(meta) {
  return node('boolean', meta)
}

/** 常量节点：真实 schemastery 里 union 的每个成员都是一枚 const schema。 */
export function constNode(value) {
  return node('const', { required: true }, { value })
}

/**
 * 枚举：值必须是 `values` 之一。
 *
 * `list` 里存的是 const 节点而不是原始值——DSH 会把插件 Config 当原生
 * schemastery 遍历（validateVolatilePlacement 等会对每个 list 成员读
 * `node.meta.volatile`），原始字符串没有 meta 会直接抛
 * 「Cannot read properties of undefined (reading 'volatile')」。
 */
export function union(values, meta) {
  return node('union', meta, { list: values.map((value) => constNode(value)) })
}

/** 对象：只声明关心字段，未声明字段原样保留（与真实 schemastery object 行为一致）。 */
export function object(dict, meta) {
  return node('object', meta, { dict: { ...dict } })
}

/* ---------------------------------------------------------------- 序列化 */

/**
 * 把 schema 树序列化成 schemastery 的 `{ uid, refs }` JSON 图。
 * 客户端拿到的就是它，用 `new Schema(json)` 重建后再校验表单值。
 */
export function toJSON(root) {
  const refs = {}
  const uids = new WeakMap()
  let nextUid = 1

  const visit = (current) => {
    const known = uids.get(current)
    if (known !== undefined) return known
    const uid = nextUid++
    uids.set(current, uid)

    const out = { type: current.type }
    // 真实 schemastery 的每个节点都会输出 meta（即使为空对象）。
    // 省略空 meta 会让宿主读 node.meta.volatile 时抛
    // 「Cannot read properties of undefined (reading 'volatile')」。
    out.meta = { ...(current.meta ?? {}) }

    if (current.type === 'object') {
      out.dict = {}
      for (const [key, child] of Object.entries(current.dict)) out.dict[key] = visit(child)
    } else if (current.type === 'union') {
      // union 的成员本身就是 const 节点，逐个子树序列化
      out.list = current.list.map((child) => visit(child))
    } else if (current.type === 'const') {
      out.value = current.value
    }

    refs[uid] = out
    return uid
  }

  // 图里可能包含未被引用的 uid（union 成员先分配、后写入），顶层 uid 以返回值为准
  return { uid: visit(root), refs }
}


/* ---------------------------------------------------------------- 校验 */

/**
 * Standard Schema 的 validate：同步校验并补默认值。
 * @param {object} root - object 类型 schema
 * @param {unknown} input - 原始配置
 */
export function validate(root, input) {
  const issues = []
  const value = input ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ message: `配置必须是对象，收到 ${Array.isArray(value) ? 'array' : typeof value}` }] }
  }
  const out = { ...value }
  for (const [key, child] of Object.entries(root.dict ?? {})) {
    const raw = value[key]
    if (raw === undefined || raw === null) {
      if (child.meta && 'default' in child.meta) out[key] = child.meta.default
      continue
    }
    const checked = checkNode(child, raw, key, issues)
    if (checked !== undefined) out[key] = checked
  }
  return issues.length > 0 ? { issues } : { value: out }
}

function checkNode(schemaNode, raw, key, issues) {
  const meta = schemaNode.meta ?? {}
  switch (schemaNode.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        issues.push({ message: `$.${key} 应为字符串，收到 ${typeof raw}`, path: [key] })
        return undefined
      }
      if (Array.isArray(meta.enum) && meta.enum.length > 0 && !meta.enum.includes(raw)) {
        issues.push({ message: `$.${key} 取值必须是 ${meta.enum.join(' / ')} 之一，收到 ${JSON.stringify(raw)}`, path: [key] })
        return undefined
      }
      return raw
    }
    case 'number': {
      // 允许 YAML / 环境变量写成字符串数字
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        issues.push({ message: `$.${key} 应为数字，收到 ${JSON.stringify(raw)}`, path: [key] })
        return undefined
      }
      if (meta.step === 1 && !Number.isInteger(n)) {
        issues.push({ message: `$.${key} 应为整数，收到 ${n}`, path: [key] })
        return undefined
      }
      if (typeof meta.min === 'number' && n < meta.min) {
        issues.push({ message: `$.${key} 不能小于 ${meta.min}，收到 ${n}`, path: [key] })
        return undefined
      }
      if (typeof meta.max === 'number' && n > meta.max) {
        issues.push({ message: `$.${key} 不能大于 ${meta.max}，收到 ${n}`, path: [key] })
        return undefined
      }
      return n
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        issues.push({ message: `$.${key} 应为布尔值，收到 ${typeof raw}`, path: [key] })
        return undefined
      }
      return raw
    }
    case 'union': {
      // list 成员是 const 节点，取它的 value 比较
      const allowed = (schemaNode.list ?? []).map((item) => (item && typeof item === 'object' ? item.value : item))
      if (!allowed.includes(raw)) {
        issues.push({
          message: `$.${key} 取值必须是 ${allowed.map((v) => JSON.stringify(v)).join(' / ')} 之一，收到 ${JSON.stringify(raw)}`,
          path: [key],
        })
        return undefined
      }
      return raw
    }
    default:
      return raw
  }
}

/**
 * 构造一个可直接作为插件 `Config` 导出的 Standard Schema 对象。
 * 同时带 `type` / `dict` / `meta` / `toJSON()`，满足 DSH 设置面板的三道闸门。
 */
export function createConfig(definition) {
  if (!definition || definition.type !== 'object') throw new Error('createConfig: 根节点必须是 object schema')
  const config = {
    ...definition,
    toJSON() {
      return toJSON(definition)
    },
    '~standard': {
      version: 1,
      vendor: 'dsh-plugin-youtube-subtitles',
      validate(input) {
        return validate(definition, input)
      },
    },
  }
  // DSH 0.2.2 起，插件 Config 会被 isNativeConfigSchema() 判定：
  // 必须同时满足 meta 是对象、type 是字符串、且带 Symbol.for('schemastery') 标记。
  // 缺标记时设置页把该插件视为「Config is not a native Schemastery schema」，
  // 并让条目在激活阶段失败。这里补上标记（non-enumerable，不影响序列化）。
  Object.defineProperty(config, Symbol.for('schemastery'), {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return config
}
