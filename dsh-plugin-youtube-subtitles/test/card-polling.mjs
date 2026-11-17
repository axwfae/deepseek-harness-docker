/** 只验证轮询逻辑：running → done → 自动 refresh。 */
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
let captured
globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d } } }
const require = (n) => n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : (() => { throw new Error(n) })()
await import(new URL('../src/client.js', import.meta.url).pathname)

let state = { currentTier: 'small', vadInstalled: true,
  tiers: [{ id: 'small', label: '轻量', installed: true, bytes: 74e6 }, { id: 'full', label: '全能', installed: false, bytes: 0 }],
  binaries: [] }
const calls = []
let jobState = 'running'
const ctx = {
  locale: { bind: () => (k) => k, register: () => () => {} }, effect: (fn) => fn(),
  connection: { rpc: { call: async (ch, ep, payload) => {
    calls.push(ep + (payload?.id ? ':' + payload.id : ''))
    if (ep === 'status') return { ok: true, value: structuredClone(state) }
    if (ep === 'jobStatus') return { ok: true, value: { id: payload.id, label: '安装模型 full', state: jobState, message: jobState === 'done' ? '模型 full 安装完成' : '' } }
    if (ep === 'downloadModels') return { ok: true, value: { jobId: 'j1' } }
    return { ok: false, error: { message: 'x' } }
  } } },
  configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: { tier: 'small', numThreads: 4 } }), subscribe: () => () => {} }), whileServed: (l, fn) => fn() },
  slots: { inject: (n, fn) => fn(), register: (meta, Comp) => { captured.reg = { meta, Comp }; return () => {} } },
}
const exported = captured.factory(require)
exported.apply(ctx)
const face = captured.reg.meta.inject()
const snapshot = face.hooks.youtubeSubtitlesCard.getSnapshot()
const props = { ...face, view: 'page', t: (k) => k, useYoutubeSubtitlesCard: (sel) => sel(snapshot) }
const collect = (n) => { const o = []; const w = (x) => { if (!x || typeof x !== 'object') return; o.push(x); (x.children ?? []).forEach(w) }; w(n); return o }

// 让 effect 真正跑起来：每 30ms 重渲染一次，模拟 React 的 re-render
let lastLen = 0
const renderLoop = setInterval(() => {
  React.beginRender()
  const nodes = collect(captured.reg.Comp(props))
  const section = nodes.find((n) => n.type === 'ResourceSection')
  if (section) { React.beginRender(); section.impl(section.props) }
}, 30)

// 启动
React.beginRender()
let nodes = collect(captured.reg.Comp(props))
const section = nodes.find((n) => n.type === 'ResourceSection')
React.beginRender(); section.impl(section.props)
await new Promise((r) => setTimeout(r, 120))
React.beginRender()
const sub = collect(section.impl(section.props))
const dl = sub.filter((n) => n.type === 'Button').find((b) => b.children.join('') === 'download')
console.log('点下载…')
dl.props.onClick()
await new Promise((r) => setTimeout(r, 120))
console.log('轮询中 RPC:', calls.slice(-3).join(' → '))

console.log('把任务标记为 done…')
jobState = 'done'
state.tiers.find((t) => t.id === 'full').installed = true
state.tiers.find((t) => t.id === 'full').bytes = 239e6
await new Promise((r) => setTimeout(r, 1000))   // 等一个 800ms 轮询周期

React.beginRender()
const sub2 = collect(section.impl(section.props))
console.log('完成提示:', sub2.filter((n) => n.type === 'p').map((n) => n.children.join('')).filter((x) => /完成|安装/.test(x)))
console.log('Tag:', sub2.filter((n) => n.type === 'Tag').map((n) => n.children.join('')).join(' | '))
console.log('RPC 全程:', calls.join(' → '))

clearInterval(renderLoop)
React.flushCleanups()
process.exit(0)
