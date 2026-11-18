/**
 * 前端 bundle 冒烟测试：不启动浏览器，用假的 __ModuleLoader__ / require / ctx
 * 验证「bundle 能被解析、导出 name/inject/apply、apply 会把卡片挂到 settings.section」。
 *
 * 运行：node tests/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// 最小 React 替身：只要能让组件被"渲染"成树，不关心真实 DOM。
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

const requireShim = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`未预期的 require：${specifier}`)
}

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      registration = entry
    },
  },
}

// 执行 bundle（它只调用 __ModuleLoader__.load）
new Function('window', source)(globalThis.window)

if (registration === null) throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
if (registration.id !== 'dsh-manual-reboot') throw new Error(`bundle id 不符：${registration.id}`)

const mod = registration.factory(requireShim)
if (mod.name !== 'dsh-manual-reboot') throw new Error(`name 不符：${mod.name}`)
if (!Array.isArray(mod.inject) || !mod.inject.includes('slots')) throw new Error('inject 缺少 slots')
if (typeof mod.apply !== 'function') throw new Error('apply 不是函数')

// 记录 slots 调用，确认卡片挂到设置页，并且渲染函数能产出元素而不抛错。
const calls = []
const ctx = {
  slots: {
    inject: (name, cb) => {
      calls.push(['inject', name])
      cb()
    },
    register: (options, render) => {
      calls.push(['register', options])
      const element = render({ close: () => {} })
      if (element === null || typeof element !== 'object') throw new Error('render 没有返回元素')
      const stack = [element]
      let nodes = 0
      while (stack.length > 0) {
        const node = stack.pop()
        nodes += 1
        if (node !== null && typeof node === 'object') stack.push(...(node.children ?? []))
      }
      if (nodes < 3) throw new Error('渲染树过小，卡片可能没有内容')
      calls.push(['rendered-nodes', nodes])
      return () => {}
    },
  },
}

mod.apply(ctx)

const inject = calls.find((call) => call[0] === 'inject')
const register = calls.find((call) => call[0] === 'register')
if (inject === undefined || inject[1] !== 'settings.section') throw new Error('没有注入 settings.section')
if (register === undefined) throw new Error('没有注册 slot')
if (register[1].name !== 'settings.section' || register[1].id !== 'manual-reboot') {
  throw new Error(`slot 注册参数不符：${JSON.stringify(register[1])}`)
}
if (typeof register[1].label !== 'function') throw new Error('label 必须是函数')

console.log('前端冒烟测试通过')
console.log('  渲染节点数：', calls.find((call) => call[0] === 'rendered-nodes')[1])
console.log('  slot 参数：', JSON.stringify(register[1]))
