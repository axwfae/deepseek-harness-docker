/**
 * 客户端 bundle 的契约与渲染测试。
 *
 * 浏览器里的 ModuleLoader 拿不到，这里用最小模拟器把 client.js 真正执行一遍：
 *   - `window.__ModuleLoader__.load` 的 id 必须是包名；
 *   - factory 只允许 require("react")；
 *   - 导出的 name / inject / apply 形状正确；
 *   - apply 之后设置卡片被注册到 plugins.bundle.config 槽位；
 *   - 卡片在三块设置项 + 各种校验分支下都能渲染出正确内容；
 *   - 供应商名称与已有提供商重名时，保存按钮必须是禁用的。
 *
 * 跑法：node test/client.mjs
 */
import { readFile } from 'node:fs/promises'

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

/** 造一个够用的 React stub；useState 按调用顺序从预设值里取值。 */
function makeReact(stateSeed) {
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      // 与 React 一致：children 同时挂到 props.children 上，class 组件靠它取子节点。
      const merged = props === null || props === undefined ? {} : { ...props }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const value = stateSeed !== undefined && index < stateSeed.length
        ? stateSeed[index]
        : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    Component: class Component {
      constructor(props) { this.props = props; this.state = {} }
      setState() {}
    },
  }
  // hooks 游标随每次组件调用前进；展开前必须重置，否则第二遍会读到预设值之外。
  return { React, reset() { cursor = 0 } }
}

/**
 * 生成卡片的 useState 初始值序列。顺序必须与组件里的声明顺序一致：
 * busy / status / result / error / reload / baseDraft / providerDraft / keyDraft / saving / fieldError
 */
function seeds(overrides = {}) {
  return [
    overrides.busy ?? false,
    overrides.status ?? null,
    overrides.result ?? null,
    overrides.error ?? null,
    overrides.reload ?? 0,
    overrides.baseDraft ?? '',
    overrides.providerDraft ?? '',
    overrides.keyDraft ?? '',
    overrides.saving ?? false,
    overrides.fieldError ?? null,
  ]
}

/**
 * 把函数组件全部展开成纯宿主元素树。
 * 只在这一步调用组件，这样 hooks 游标只前进一轮，renderText / collect 复用同一棵树。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  const { type, props, children } = node
  if (typeof type === 'function') {
    const rendered = type.prototype !== undefined && type.prototype.render !== undefined
      ? new type(props).render()
      : type(props)
    return expand(rendered)
  }
  return { type, props, children: children.map(expand) }
}

/** 把展开后的树收集成纯文本，用来断言渲染内容。 */
function renderText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderText).join('')
  if (typeof node !== 'object') return ''
  return renderText(node.children)
}

/** 在已展开的树里找出所有指定标签的元素。 */
function collect(node, tag, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, tag, found)
    return found
  }
  if (node.type === tag) found.push(node)
  collect(node.children, tag, found)
  return found
}

/** 装载 client.js，返回它交给 ModuleLoader 的那份定义。 */
async function loadClient(stateSeed) {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const { React, reset } = makeReact(stateSeed)
  let captured
  const window = { __ModuleLoader__: { load(definition) { captured = definition } } }
  const document = {
    querySelector() { return null },
    createElement() { return { dataset: {}, remove() {} } },
    head: { appendChild() {} },
  }
  const require = (specifier) => {
    if (specifier !== 'react') throw new Error(`bundle 只允许 require("react")，实际请求了 ${specifier}`)
    return React
  }
  new Function('window', 'document', 'require', `${source}\n`)(window, document, require)
  if (captured === undefined) throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
  return { definition: captured, exports: captured.factory(require), reset }
}

/** 跑一遍 apply，取回注册到 slots 的卡片组件。 */
function mountCard(clientExports) {
  const registrations = []
  const injected = []
  const ctx = {
    effect(fn) { return fn() },
    slots: {
      inject(name, callback) { injected.push(name); callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  clientExports.apply(ctx)
  return { registrations, injected }
}

/** 用指定状态渲染一次卡片，返回渲染文本与可查询的元素集合。 */
async function renderCard(overrides = {}) {
  const client = await loadClient(seeds(overrides))
  const registration = mountCard(client.exports).registrations[0]
  // 组件只在这里调用一次；后续断言都复用这棵已展开的树。
  client.reset()
  const tree = expand(registration.component({ routePath: '/agent2sync/sync' }))
  return {
    text: renderText(tree),
    tree,
    inputs: collect(tree, 'input'),
    buttons: collect(tree, 'button'),
  }
}

const OK_STATUS = {
  ok: true,
  providerId: 'agent2sync',
  providerDisplayName: 'Agent2Sync',
  baseURL: 'http://gateway.test/v1',
  apiKeyEnv: 'AGENT2SYNC_API_KEY',
  hasApiKey: true,
  modelCount: 16,
  providers: ['workbuddy-free', 'orcarouter', 'other', 'agent2sync'],
  routePath: '/agent2sync/sync',
}

async function main() {
  console.log('bundle 装载')
  let loaded
  try {
    loaded = await loadClient()
    check('load 被调用一次且 id 等于包名', loaded.definition.id === 'dsh-agent2sync', loaded.definition.id)
    check('id 是包名而不是 Loader 条目 id', loaded.definition.id !== 'agent2sync')
    check('factory 是函数', typeof loaded.definition.factory === 'function')
  } catch (error) {
    failed += 1
    console.log(`  ✗ 装载失败：${error.message}`)
    console.log(`\n结果：${passed} 通过，${failed} 失败`)
    process.exitCode = 1
    return
  }

  console.log('\n导出形状')
  const exp = loaded.exports
  check('name 是 dsh-agent2sync/client', exp.name === 'dsh-agent2sync/client', exp.name)
  check('inject 只含 slots', JSON.stringify(exp.inject) === JSON.stringify(['slots']), JSON.stringify(exp.inject))
  check('apply 是函数', typeof exp.apply === 'function')

  console.log('\n卡片注册')
  const { registrations, injected } = mountCard(exp)
  check('等了 plugins.bundle.config 槽位', injected.includes('plugins.bundle.config'), JSON.stringify(injected))
  check('注册了一张卡片', registrations.length === 1, String(registrations.length))
  const reg = registrations[0]
  check('槽位名正确', reg?.options?.name === 'plugins.bundle.config', reg?.options?.name)
  check('key 用包名', reg?.options?.key === 'dsh-agent2sync', reg?.options?.key)
  check('inject 工厂返回 routePath', reg?.options?.inject?.()?.routePath === '/agent2sync/sync')
  check('注册的是组件', typeof reg?.component === 'function')

  console.log('\n命名与品牌')
  {
    const { text } = await renderCard({ status: OK_STATUS })
    check('标题显示 Agent2Sync', text.includes('Agent2Sync'), text.slice(0, 80))
    check('说明里保留 Agent2API（网关名）', text.includes('Agent2API 网关'))
  }

  console.log('\n三块设置项')
  {
    const { text, inputs } = await renderCard({ status: OK_STATUS })
    check('渲染出三个输入框', inputs.length === 3, String(inputs.length))
    check('有「服务器」标签', text.includes('服务器'))
    check('有「API Key」标签', text.includes('API Key'))
    check('有「模型供应商名称」标签', text.includes('模型供应商名称'))
    check('API Key 输入框是密码型', inputs.some(input => input.props.type === 'password'))
    check('服务器输入框填的是当前地址',
      inputs.some(input => input.props.value === 'http://gateway.test/v1'),
      JSON.stringify(inputs.map(i => i.props.value)))
    check('供应商输入框填的是当前 id',
      inputs.some(input => input.props.value === 'agent2sync'))
    check('列出已有提供商', text.includes('已有提供商') && text.includes('workbuddy-free'), text.slice(0, 400))
  }

  console.log('\nAPI Key 状态提示')
  {
    const withKey = await renderCard({ status: OK_STATUS })
    check('已配置时显示已保存', withKey.text.includes('已保存网关 Key'), withKey.text.slice(0, 400))
    check('已配置时输入框占位为留空不修改',
      withKey.inputs.some(input => input.props.placeholder === '已保存，留空不修改'))

    const noKey = await renderCard({ status: { ...OK_STATUS, hasApiKey: false } })
    check('未配置时明确告警',
      noKey.text.includes('尚未配置网关 Key') && noKey.text.includes('对话请求会被网关拒绝'),
      noKey.text.slice(0, 400))
  }

  console.log('\n供应商名称重名校验（核心要求）')
  {
    // 改成已有提供商 other → 必须拒绝
    const conflict = await renderCard({ status: OK_STATUS, providerDraft: 'other' })
    check('重名时给出占用提示',
      conflict.text.includes('已被现有提供商占用') && conflict.text.includes('换一个名字才能保存'),
      conflict.text.slice(0, 400))
    const saveBtn = conflict.buttons.find(button => button.props.children === '保存设置')
    check('重名时保存按钮存在', saveBtn !== undefined)
    check('重名时保存按钮被禁用', saveBtn?.props?.disabled === true, JSON.stringify(saveBtn?.props?.disabled))

    // 保持自己的 id（不算重名）
    const same = await renderCard({ status: OK_STATUS, providerDraft: 'agent2sync' })
    const sameBtn = same.buttons.find(button => button.props.children === '保存设置')
    check('沿用自己原来的名字不算重名', !same.text.includes('已被现有提供商占用'))
    check('沿用自己原来的名字可以保存', sameBtn?.props?.disabled === false, JSON.stringify(sameBtn?.props?.disabled))

    // 换成没人用的名字 → 放行
    const free = await renderCard({ status: OK_STATUS, providerDraft: 'my-gateway' })
    const freeBtn = free.buttons.find(button => button.props.children === '保存设置')
    check('空闲名字不报冲突', !free.text.includes('已被现有提供商占用'))
    check('空闲名字可以保存', freeBtn?.props?.disabled === false, JSON.stringify(freeBtn?.props?.disabled))

    // 形状非法 → 拒绝
    const badShape = await renderCard({ status: OK_STATUS, providerDraft: 'Bad Name' })
    const badBtn = badShape.buttons.find(button => button.props.children === '保存设置')
    check('非法字符给出格式提示', badShape.text.includes('只能用小写字母'), badShape.text.slice(0, 400))
    check('非法字符时保存被禁用', badBtn?.props?.disabled === true)
  }

  console.log('\n服务器地址默认空白')
  {
    const empty = await renderCard({ status: { ...OK_STATUS, baseURL: '' } })
    check('空地址时给出「必填」提示',
      empty.text.includes('必填：填写 Agent2API 网关地址'), empty.text.slice(0, 400))
    check('空地址不算格式错误', !empty.text.includes('以 http:// 或 https:// 开头'))
    const saveBtn = empty.buttons.find(button => button.props.children === '保存设置')
    check('空地址时保存被禁用', saveBtn?.props?.disabled === true)
    check('输入框给的是示例占位符',
      empty.inputs.some(input => input.props.placeholder === 'http://<网关主机>:3065/v1'))
  }

  console.log('\n服务器地址校验')
  {
    const bad = await renderCard({ status: OK_STATUS, baseDraft: 'ftp://nope' })
    const badBtn = bad.buttons.find(button => button.props.children === '保存设置')
    check('非 http(s) 给出提示', bad.text.includes('以 http:// 或 https:// 开头'), bad.text.slice(0, 300))
    check('非 http(s) 时保存被禁用', badBtn?.props?.disabled === true)
  }

  console.log('\n同步按钮与结果')
  {
    const initial = await renderCard({ status: OK_STATUS })
    const syncBtn = initial.buttons.find(button => button.props.children === '同步模型列表')
    check('有同步按钮', syncBtn !== undefined)
    check('同步按钮默认可用', syncBtn?.props?.disabled === false)
    check('显示当前模型数', initial.text.includes('当前 16 个模型'), initial.text.slice(0, 400))

    const busy = await renderCard({ status: OK_STATUS, busy: true })
    const busyBtn = busy.buttons.find(button => button.props.children === '同步中…')
    check('同步中按钮变文案且禁用', busyBtn?.props?.disabled === true)

    const result = {
      ok: true, total: 16, fetched: 18, excluded: 2, durationMs: 573,
      added: ['new-model-a'], removed: ['gone-model-b'], unchanged: 15,
    }
    const done = await renderCard({ status: OK_STATUS, result })
    check('汇报同步总数', done.text.includes('已同步 16 个模型'))
    check('汇报排除的非对话模型', done.text.includes('排除 2 个非对话模型'))
    check('列出新增模型', done.text.includes('+new-model-a'))
    check('列出删除模型', done.text.includes('−gone-model-b'))
  }

  console.log('\n错误与边界')
  {
    const err = await renderCard({ status: OK_STATUS, error: '连不上网关' })
    check('显示错误信息', err.text.includes('失败：连不上网关'), err.text.slice(0, 300))

    const fieldErr = await renderCard({
      status: OK_STATUS,
      fieldError: { field: 'providerId', message: '供应商名称已被占用' },
    })
    check('字段级错误优先显示在供应商一栏', fieldErr.text.includes('供应商名称已被占用'))

    const client = await loadClient(seeds())
    const registration = mountCard(client.exports).registrations[0]
    let threw
    try {
      client.reset()
      expand(registration.component({ routePath: '/agent2sync/sync' }))
    } catch (error) { threw = error }
    check('无状态时也不抛错', threw === undefined, threw?.message)
  }

  console.log('\n非 react 依赖检查')
  {
    const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1])
    check('只 require 了 react', requires.every(name => name === 'react'), JSON.stringify(requires))
    check('没有 import 语句', !/^\s*import\s/m.test(source))
    check('没有 JSX 残留', !/<[A-Z][A-Za-z]*[\s/>]/.test(source))
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
