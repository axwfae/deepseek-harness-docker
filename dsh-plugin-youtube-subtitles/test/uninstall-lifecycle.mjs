/**
 * 卸载清理的完整链路验证：**disposer 是否真的接上**。
 *
 * 现有 `uninstall-purge.mjs` 直接调 `scheduleUninstallPurge`，证明的是「函数本身对」；
 * 本脚本证明「卸载时它会被调用」——即 apply 里注册的 ctx.effect disposer 真的触发清理。
 *
 * 覆盖三种真实场景：
 *   A. Web GUI 卸载（依赖已移除）→ 整棵 dataRoot 消失；
 *   B. 仅禁用（依赖还在）→ 一个字节都不动；
 *   C. 自定义 dataRoot + 真卸载 → 只删 bin/、models/，同目录其它文件保留。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mod = await import(new URL('../src/index.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}
const exists = (p) => fs.stat(p).then(() => true).catch(() => false)

/**
 * 模拟一次插件生命周期：apply → 触发所有 effect disposer（= 插件被销毁）。
 * @param {string} dataRoot
 * @param {boolean} stillReferenced - profile 的 dependencies 是否仍含本插件
 * @returns {Promise<{dataRoot: string, home: string}>}
 */
async function lifecycle(dataRoot, stillReferenced) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (n) => (n === 'tools' ? { register: (d) => { tools.set(d.name, d); return () => {} } } : undefined),
    // 记录 effect 返回的 disposer —— 插件卸载时 cordis 正是逐个调用它们
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    inject: (names, cb) => {
      if (!Array.isArray(names)) return
      if (names.includes('tools')) {
        cb({ get: () => ({ register: (d) => { tools.set(d.name, d); return () => {} } }), effect: (fn) => fn() })
      }
    },
  }
  mod.apply(ctx, mod.Config['~standard'].validate({ dataRoot }).value)
  await new Promise((r) => setTimeout(r, 50))

  // 写 profile 依赖状态
  const home = process.env.DSH_HOME
  await fs.mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await fs.writeFile(
    path.join(home, 'profiles', 'web', 'package.json'),
    JSON.stringify({ dependencies: stillReferenced ? { 'dsh-plugin-youtube-subtitles': 'link:.' } : {} }),
  )

  // 触发销毁：这就是 Web GUI 卸载时发生的事
  for (const d of disposers) {
    try { await d() } catch { /* disposer 不应抛错，抛了也不该影响后续 */ }
  }
  // 清理是延迟轮询（默认 500ms 间隔），等它跑完
  await new Promise((r) => setTimeout(r, 2000))
  return { dataRoot, home }
}

/** 造一份「已装模型 + 自带二进制」的数据目录。 */
async function seed(root, { extraFile } = {}) {
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(path.join(root, 'bin'), { recursive: true })
  await fs.mkdir(path.join(root, 'models', 'small'), { recursive: true })
  await fs.writeFile(path.join(root, 'bin', 'yt-dlp'), 'x'.repeat(1000))
  await fs.writeFile(path.join(root, 'bin', 'ffmpeg'), 'x'.repeat(2000))
  await fs.writeFile(path.join(root, 'models', 'small', 'model.int8.onnx'), 'x'.repeat(3000))
  await fs.writeFile(path.join(root, 'models', 'silero_vad.onnx'), 'x'.repeat(500))
  if (extraFile) await fs.writeFile(path.join(root, extraFile), 'keep me')
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'uninstall-'))
process.env.DSH_HOME = home

try {
  /* ---------------- A. Web GUI 卸载（像点「卸载」按钮） ---------------- */
  const owned = path.join(home, 'plugins-data', 'dsh-plugin-youtube-subtitles')
  await seed(owned)
  check('A 安装后目录存在', await exists(path.join(owned, 'bin', 'yt-dlp')))
  await lifecycle(owned, false)
  check('A 卸载后整棵目录消失', !(await exists(owned)), owned)
  check('A 模型随之消失', !(await exists(path.join(owned, 'models'))))
  check('A 二进制随之消失', !(await exists(path.join(owned, 'bin'))))

  /* ---------------- B. 仅禁用（依赖还在） ---------------- */
  const owned2 = path.join(home, 'plugins-data', 'dsh-plugin-youtube-subtitles')
  await seed(owned2)
  await lifecycle(owned2, true)
  check('B 仅禁用时目录保留', await exists(owned2))
  check('B 模型保留', await exists(path.join(owned2, 'models', 'small', 'model.int8.onnx')))
  check('B 二进制保留', await exists(path.join(owned2, 'bin', 'ffmpeg')))

  /* ---------------- C. 自定义 dataRoot + 真卸载 ---------------- */
  const custom = path.join(home, 'my-data')
  await seed(custom, { extraFile: 'notes.txt' })
  await lifecycle(custom, false)
  check('C 自定义目录本身保留', await exists(custom))
  check('C 只删 bin/', !(await exists(path.join(custom, 'bin'))))
  check('C 只删 models/', !(await exists(path.join(custom, 'models'))))
  check('C 其它文件原样保留', await exists(path.join(custom, 'notes.txt')))
} finally {
  await fs.rm(home, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
