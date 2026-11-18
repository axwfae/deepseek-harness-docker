/**
 * 全 profile 客户端 bundle 体检。
 *
 * 宿主加载客户端 bundle 时，任何一个 bundle 抛错都会记进 importErrors，
 * 而 settings.section 里的插槽渲染异常会整块打掉设置页。这里用与宿主相同的
 * 校验口径，把每个 bundle 单独过一遍，指出是哪个包坏了、坏在哪。
 *
 * 运行：node tests/profile-audit.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const PROFILE = '/home/node/.dsh/profiles/web'
const pkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const bundles = pkg.dsh.profile.bundles

const rows = []
function bad(pkgName, kind, detail) {
  rows.push({ pkgName, kind, detail })
}

for (const bundle of bundles) {
  const dir = join(PROFILE, 'node_modules', bundle)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    bad(bundle, '缺包', dir)
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const decl = manifest.dsh && manifest.dsh.client
  if (decl === undefined) continue // 纯服务端插件，无客户端半边

  if (typeof decl.platform !== 'string') {
    bad(bundle, 'dsh.client.platform 缺失', decl)
    continue
  }
  if (decl.inject !== undefined) {
    if (!Array.isArray(decl.inject) || decl.inject.some((item) => typeof item !== 'string')) {
      bad(bundle, 'dsh.client.inject 非法', decl.inject)
      continue
    }
  }

  const clientRel = manifest.exports && manifest.exports['./client']
  const rel = typeof clientRel === 'string' ? clientRel : clientRel && clientRel.default
  if (typeof rel !== 'string') {
    bad(bundle, '声明了 dsh.client 但没有 exports["./client"]', manifest.exports)
    continue
  }
  const clientPath = resolve(dir, rel)
  if (!existsSync(clientPath)) {
    bad(bundle, '客户端 bundle 文件不存在', clientPath)
    continue
  }

  const source = readFileSync(clientPath, 'utf8')

  // 1) 纯 ESM 语句会让浏览器 <script> 直接语法错误。
  if (/^\s*(import|export)\s/m.test(source)) {
    bad(bundle, '客户端 bundle 含 ESM 语句', clientPath)
    continue
  }

  // 2) 必须注册 __ModuleLoader__，且 id 精确等于包名。
  const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?id\s*:\s*["']([^"']+)["']/.exec(source)
  if (idMatch === null) {
    bad(bundle, '未找到 __ModuleLoader__.load({id})', clientPath)
    continue
  }
  if (idMatch[1] !== bundle) {
    bad(bundle, `bundle id 与包名不一致（id=${idMatch[1]}）`, clientPath)
    continue
  }

  // 3) 语法能否被解析（等价于浏览器首次解析）。
  try {
    new Function(source)
  } catch (error) {
    bad(bundle, `语法错误：${error.message}`, clientPath)
    continue
  }

  // 4) 实际物化：跑 factory，看是否抛错。require 只放行 react 系列。
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useReducer: (reducer, initial) => [initial, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    Fragment: 'Fragment',
    createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
    useContext: (context) => context && context._value,
    memo: (component) => component,
    forwardRef: (render) => render,
  }
  const requireShim = (specifier) => {
    if (specifier === 'react' || specifier.startsWith('react/')) return fakeReact
    // 宿主种子表里的其它模块：给一个宽容的替身，避免因为缺包误报。
    return new Proxy(
      {},
      {
        get: () => () => undefined,
      },
    )
  }

  let registration = null
  const fakeWindow = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  try {
    new Function('window', 'document', source)(fakeWindow, {
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, remove() {} }),
      baseURI: 'http://127.0.0.1:3079/',
    })
  } catch (error) {
    bad(bundle, `执行 bundle 顶层抛错：${error.message}`, clientPath)
    continue
  }
  if (registration === null) {
    bad(bundle, 'bundle 没有调用 __ModuleLoader__.load', clientPath)
    continue
  }

  let exported
  try {
    exported = registration.factory(requireShim)
  } catch (error) {
    bad(bundle, `factory 抛错：${error.message}`, clientPath)
    continue
  }
  if (exported === null || typeof exported !== 'object') {
    bad(bundle, 'factory 返回值不是对象', typeof exported)
    continue
  }
  if (typeof exported.name !== 'string') bad(bundle, '导出缺少 name', Object.keys(exported))
  if (typeof exported.apply !== 'function') bad(bundle, '导出缺少 apply', Object.keys(exported))
}

if (rows.length === 0) {
  console.log(`全部 ${bundles.length} 个 bundle 通过体检`)
} else {
  for (const row of rows) console.log(`  ✗ ${row.pkgName.padEnd(38)} ${row.kind}`)
  process.exitCode = 1
}
