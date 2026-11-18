/**
 * 用宿主真实的 client-modules 模块系统加载本插件 bundle，
 * 模拟浏览器里「预加载 → 注册 factory → 物化 → 执行 apply」全过程。
 *
 * 目的：把「设置页被拖垮」这种症状在 Node 里复现出来，而不是靠猜。
 *
 * 运行：node tests/host-materialize.mjs
 */
import { readFileSync } from 'node:fs'

// 最小 DOM：只实现 claimStyles/untaggedStyles 用到的 querySelectorAll 与 style 记录。
class FakeStyle {
  constructor() {
    this.attrs = new Map()
  }
  setAttribute(name, value) {
    this.attrs.set(name, value)
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }
  remove() {
    const index = document._styles.indexOf(this)
    if (index !== -1) document._styles.splice(index, 1)
  }
}

const document = {
  _styles: [],
  querySelectorAll(selector) {
    if (selector === 'style:not([data-plugin])') return this._styles.filter((style) => !style.attrs.has('data-plugin'))
    const match = /^style\[data-plugin="?(.*?)"?\]$/.exec(selector)
    if (match !== null) return this._styles.filter((style) => style.attrs.get('data-plugin') === match[1])
    return []
  },
  createElement() {
    const style = new FakeStyle()
    this._styles.push(style)
    return style
  },
  head: {
    appendChild: (element) => {
      if (!document._styles.includes(element)) document._styles.push(element)
    },
  },
  baseURI: 'http://127.0.0.1:3079/',
}
globalThis.document = document
globalThis.window = globalThis

// 假 React：记录 hooks 调用，暴露 useState 的初始值以便检查渲染。
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => {
    React._effects.push(fn)
  },
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  _effects: [],
}

const factories = new Map()
let pending = null
globalThis.__ModuleLoader__ = {
  load: (entry) => {
    pending = entry
  },
}

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
// bundle 末尾会调用 __ModuleLoader__.load
new Function('window', source)(globalThis)

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name} —— 实际 ${JSON.stringify(detail)}`)
}

check('bundle 已注册', pending !== null, pending)
if (pending === null) {
  console.log(failures.join('\n'))
  process.exit(1)
}

const requireShim = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`client-modules: require("${specifier}") missed the module table`)
}

// 复刻 materialize()：记录样式快照 → 跑 factory → 认领样式。
const before = new Set(document.querySelectorAll('style:not([data-plugin])'))
let exports
try {
  exports = pending.factory(requireShim)
} catch (error) {
  console.log(`  ✗ factory 抛错：${error.message}`)
  process.exit(1)
}
for (const element of document.querySelectorAll('style:not([data-plugin])')) {
  if (!before.has(element)) element.setAttribute('data-plugin', pending.id)
}

check('导出 name', exports.name === 'dsh-manual-reboot', exports.name)
check('导出 inject 含 slots', Array.isArray(exports.inject) && exports.inject.includes('slots'), exports.inject)
check('导出 apply', typeof exports.apply === 'function', typeof exports.apply)
check('factory 期间未注入全局 style', document._styles.length === 0, document._styles.length)

// 执行 apply，模拟宿主的 slot 注册并渲染。
const registered = []
const ctx = {
  slots: {
    inject: (name, callback) => callback(),
    register: (options, render) => {
      registered.push({ options, render })
      return () => {}
    },
  },
}

try {
  exports.apply(ctx)
} catch (error) {
  failures.push(`apply 抛错：${error.message}`)
}

check('注册了一个 slot', registered.length === 1, registered.length)
if (registered.length > 0) {
  const { options, render } = registered[0]
  check('slot name', options.name === 'settings.section', options.name)
  check('slot id', options.id === 'manual-reboot', options.id)
  check('slot order', options.order === 90, options.order)
  check('slot label 是函数', typeof options.label === 'function', typeof options.label)
  check('slot label 返回中文', options.label() === '重启', options.label())

  // 渲染必须不抛错；抛错会打掉整个 settings.section（宿主行为）。
  try {
    const tree = render({ close: () => {} })
    check('渲染返回元素', tree !== null && typeof tree === 'object', typeof tree)
    // 执行 useEffect 里注册的回调，验证首次取状态不会抛错。
    for (const effect of React._effects) {
      const cleanup = effect()
      check('useEffect 返回清理函数或 undefined', cleanup === undefined || typeof cleanup === 'function', typeof cleanup)
    }
  } catch (error) {
    failures.push(`render 抛错（会打掉整个设置页）：${error.message}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log('宿主模块系统装载通过：factory 无全局副作用、apply 正常、render 不抛错')
}
