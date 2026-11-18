/**
 * 用真实网关 + 真实凭据跑一次「同步并测试模型」。
 *
 * 走的是插件真实代码路径（apply → 同步端点 → 探测），但 settings 的写入落在
 * 内存里，不会改动 profile 的 cordis.patch.yml。
 *
 * 跑法：node test/real-probe.mjs
 * 环境变量：AGENT2SYNC_TEST_GATEWAY 换网关地址，AGENT2SYNC_API_KEY_REF 换凭据引用名。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRY = 'llm-pi-ai'
const GATEWAY = process.env.AGENT2SYNC_TEST_GATEWAY ?? 'http://192.168.123.200:3065/v1'
const KEY_REF = process.env.AGENT2SYNC_API_KEY_REF ?? 'AGENT2SYNC_API_KEY'

/** 从 DSH 凭据文件里取一把真实 Key（只用于本脚本，不打印）。 */
function readCredential(ref) {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  let inRefs = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (!inRefs) continue
    const match = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.+)$/)
    if (match !== null && match[1] === ref) return match[2].trim().replace(/^["']|["']$/g, '')
    if (line.length > 0 && !line.startsWith(' ')) inRefs = false
  }
  return undefined
}

const apiKey = readCredential(KEY_REF)
if (apiKey === undefined) {
  console.error(`凭据里没有 ${KEY_REF}，无法做真实探测`)
  process.exit(1)
}

const providers = {}
const routes = []
const ctx = {
  logger: { info() {}, warn: (...args) => console.error('[warn]', ...args), error() {} },
  get(service) {
    if (service === 'credentials') return { async resolve(ref) { return ref === KEY_REF ? { value: apiKey } : undefined } }
    return undefined
  },
  settings: {
    get documentPath() { return join(mkdtempSync(join(tmpdir(), 'probe-')), 'cordis.patch.yml') },
    describe() { return [{ ns: ENTRY, value: { providers: structuredClone(providers) } }] },
    async mutate(ns, ops) {
      for (const op of ops) {
        if (op.path.length === 2 && op.path[0] === 'providers') providers[op.path[1]] = structuredClone(op.value)
      }
    },
  },
  inject(names, callback) {
    if (!names.includes('webServer')) return
    callback({ webServer: { register(route) { routes.push(route); return () => {} } }, effect(fn) { return fn() } })
  },
  effect(fn) { return fn() },
}

const mod = await import(new URL('../src/index.js', import.meta.url).href)
mod.apply(ctx, { baseURL: GATEWAY, bootstrapOnLoad: false })

let status
let text
const res = { writeHead(code) { status = code }, end(chunk) { text = chunk } }
const body = JSON.stringify({ verify: true })
await routes[0].handler({
  method: 'POST',
  url: '/agent2sync/sync',
  headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
}, res)

const result = JSON.parse(text)
console.log(`HTTP ${status}`)
if (result.ok !== true) {
  console.log('失败：', result.error)
  process.exit(1)
}

console.log(`网关报告 ${result.fetched} 个，排除图像模型 ${result.excluded} 个`)
console.log(`探测 ${result.verification.tested} 个 → 通过 ${result.verification.passed} 个，未通过 ${result.verification.failed.length} 个`)
console.log(`用时 ${result.durationMs} ms`)
if (result.verification.failed.length > 0) {
  console.log('\n未通过的模型：')
  for (const failure of result.verification.failed) {
    console.log(`  × ${failure.id}`)
    console.log(`      ${failure.error}`)
    if (failure.prompt) console.log(`      题目：${failure.prompt}（期望 ${failure.expected}）`)
    if (failure.got) console.log(`      实际：${String(failure.got).slice(0, 160)}`)
  }
} else {
  console.log('\n全部模型都可用。')
}
if (Array.isArray(result.verification.results)) {
  console.log('\n每题明细：')
  for (const row of result.verification.results) {
    const mark = row.ok ? '✓' : '×'
    const answer = String(row.got ?? '').replace(/\s+/g, ' ').slice(0, 40)
    console.log(`  ${mark} ${row.id}`)
    console.log(`      [${row.kind}] ${row.prompt} → 期望 ${row.expected}，实答 ${answer}${row.attempts > 1 ? `（复判 ${row.attempts} 次）` : ''}`)
  }
}

console.log(`\n最终写入清单：${result.total} 个模型`)
console.log(providers.agent2sync.models.map(model => '  ' + model.id).join('\n'))
