/**
 * 设置卡片：轮询（running → done → 自动 refresh）与档位覆盖提示。
 *
 * 用自制的 React 替身把卡片真正渲染出来，断言的是「点了按钮之后发了哪些 RPC」，
 * 而不是像素。
 */
const { createReact } = await import('./react-shim.mjs')
const React = createReact()
const primitives = {
  SettingsForm: function () {}, Tag: function () {}, Button: function () {},
  SegmentedControl: function () {}, SettingsValueField: function () {},
  SettingsFormModel: class {
    constructor(s, sp) { this.scope = s; this.specs = sp }
    spec(f) { return this.specs.find((x) => x.field === f) }
    sectionValue(f) { return this.scope.getSnapshot().value?.[f] }
    field(f) { const s = this.spec(f); return { text: s.format(this.sectionValue(f)), overridden: false, invalid: false } }
    shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
    bind(sel) { return { getSnapshot: () => sel(), subscribe: () => () => {} } }
    actions() { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }
    dispose() {}
  },
}

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

let captured
globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d } } }
const require = (n) =>
  n === 'react'
    ? React
    : n === '@deepseek-ai/dsh-client-ui-primitives'
      ? primitives
      : (() => { throw new Error(n) })()
await import(new URL('../src/client.js', import.meta.url).href)

let state = {
  currentTier: 'full',
  tierSource: 'override',
  tierOverride: { tier: 'full', configTier: 'small' },
  configTier: 'small',
  vadInstalled: true,
  tiers: [
    { id: 'small', label: '轻量', installed: true, bytes: 74e6 },
    { id: 'full', label: '全能', installed: false, bytes: 0 },
  ],
  binaries: [],
}
const calls = []
const channels = []
let jobState = 'running'

/** 卡片现在直接 fetch 自建路由；这里按 URL 分派，模拟 host 行为。 */
globalThis.fetch = async (url, init) => {
  const path = String(url)
  const endpoint = path.replace(/^\/youtube-subtitles\//, '')
  channels.push('/youtube-subtitles')
  const payload = init?.body ? JSON.parse(init.body) : {}
  calls.push(endpoint + (payload?.id ? ':' + payload.id : ''))
  let body
  if (endpoint === 'status') body = { ok: true, value: structuredClone(state) }
  else if (endpoint === 'jobStatus') {
    body = {
      ok: true,
      value: {
        id: payload.id,
        label: '安装模型 full',
        state: jobState,
        message: jobState === 'done' ? '模型 full 安装完成' : '',
      },
    }
  } else if (endpoint === 'downloadModels') body = { ok: true, value: { jobId: 'j1' } }
  else if (endpoint === 'clearTierOverride') {
    state = { ...state, tierSource: 'config', tierOverride: null, currentTier: 'small' }
    body = { ok: true, value: { cleared: true, message: '已恢复为配置文件的档位' } }
  } else body = { ok: false, error: { message: 'x' } }
  return { ok: true, status: 200, json: async () => body }
}

const ctx = {
  locale: { bind: () => (k) => k, register: () => () => {} },
  effect: (fn) => fn(),
  configForms: {
    get: () => ({
      getSnapshot: () => ({ status: 'ready', writable: true, value: { tier: 'small', numThreads: 4 } }),
      subscribe: () => () => {},
    }),
    whileServed: (l, fn) => fn(),
  },
  slots: { inject: (n, fn) => fn(), register: (meta, Comp) => { captured.reg = { meta, Comp }; return () => {} } },
}

const exported = captured.factory(require)
exported.apply(ctx)
const face = captured.reg.meta.inject()
const snapshot = face.hooks.youtubeSubtitlesCard.getSnapshot()
const props = { ...face, view: 'page', t: (k) => k, useYoutubeSubtitlesCard: (sel) => sel(snapshot) }
const collect = (n) => {
  const o = []
  const w = (x) => {
    if (!x || typeof x !== 'object') return
    o.push(x)
    ;(x.children ?? []).forEach(w)
  }
  w(n)
  return o
}
const texts = (nodes) => nodes.filter((n) => n.type === 'p').map((n) => (n.children ?? []).join(''))

// 让 effect 真正跑起来：每 30ms 重渲染一次，模拟 React 的 re-render
const renderLoop = setInterval(() => {
  React.beginRender()
  const nodes = collect(captured.reg.Comp(props))
  const section = nodes.find((n) => n.type === 'ResourceSection')
  if (section) {
    React.beginRender()
    section.impl(section.props)
  }
}, 30)

// 启动
React.beginRender()
const rootNodes = collect(captured.reg.Comp(props))
const section = rootNodes.find((n) => n.type === 'ResourceSection')
React.beginRender()
section.impl(section.props)
await new Promise((r) => setTimeout(r, 120))

React.beginRender()
let sub = collect(section.impl(section.props))
check('渲染出档位覆盖提示', texts(sub).some((x) => x.includes('tierOverride')), texts(sub).join(' | '))

const clearBtn = sub
  .filter((n) => n.type === 'Button')
  .find((b) => (b.children ?? []).join('') === 'tierOverrideClear')
check('存在「恢复配置值」按钮', Boolean(clearBtn))
if (clearBtn) {
  clearBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 200))
  check('点击后调用 clearTierOverride', calls.includes('clearTierOverride'), calls.slice(-3).join(' → '))
check('走自建 /youtube-subtitles 路由', channels.every((c) => c === '/youtube-subtitles'), [...new Set(channels)].join(','))
  React.beginRender()
  sub = collect(section.impl(section.props))
  check('覆盖提示消失', !texts(sub).some((x) => x.includes('tierOverride')))
}

/* ---------------- 下载 → 轮询 → 完成 ---------------- */
const dl = sub.filter((n) => n.type === 'Button').find((b) => (b.children ?? []).join('') === 'download')
check('存在下载按钮', Boolean(dl))
dl.props.onClick()
await new Promise((r) => setTimeout(r, 120))
console.log('轮询中 RPC:', calls.slice(-3).join(' → '))
check('下载走 downloadModels + jobStatus', calls.includes('downloadModels') && calls.some((c) => c.startsWith('jobStatus')))

jobState = 'done'
state.tiers.find((t) => t.id === 'full').installed = true
state.tiers.find((t) => t.id === 'full').bytes = 239e6
await new Promise((r) => setTimeout(r, 1000)) // 等一个 800ms 轮询周期

React.beginRender()
const sub2 = collect(section.impl(section.props))
const doneText = texts(sub2).filter((x) => /完成|安装/.test(x))
check('完成提示出现', doneText.length > 0, doneText.join(' | '))
check('完成后自动刷新状态', calls.filter((c) => c === 'status').length >= 2)
check('已安装档位打上当前使用标记', sub2.filter((n) => n.type === 'Tag').length > 0)

clearInterval(renderLoop)
React.flushCleanups()
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
