/**
 * purge 工具：预览列出 bin/models，confirm 后删除；不安全的路径必须被拒绝。
 *
 * 用临时 DSH_HOME 跑，不碰真实环境。安全路径放在
 * `<临时 DSH_HOME>/plugins-data/dsh-plugin-youtube-subtitles`，
 * 这样默认位置与自定义目录两种规则都能覆盖。
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

/** 造一个「已装模型 + 自带二进制」的数据目录。 */
async function seed(root) {
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(path.join(root, 'bin'), { recursive: true })
  await fs.mkdir(path.join(root, 'models', 'small'), { recursive: true })
  await fs.writeFile(path.join(root, 'bin', 'yt-dlp'), 'x'.repeat(3_000_000))
  await fs.writeFile(path.join(root, 'bin', 'ffmpeg'), 'x'.repeat(80_000_000))
  await fs.writeFile(path.join(root, 'models', 'small', 'model.int8.onnx'), 'x'.repeat(74_000_000))
  await fs.writeFile(path.join(root, 'models', 'silero_vad.onnx'), 'x'.repeat(600_000))
}

/** 用给定 dataRoot 注册插件，取回 purge 工具。 */
function toolsFor(dataRoot) {
  const tools = new Map()
  const service = { register: (d) => { tools.set(d.name, d); return () => {} } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (n) => (n === 'tools' ? service : undefined),
    effect: (fn) => { fn() },
    inject: (names, cb) => {
      if (Array.isArray(names) && names.includes('tools')) {
        cb({ get: (n) => (n === 'tools' ? service : undefined), effect: (fn) => { fn() } })
      }
    },
  }
  const config = mod.Config['~standard'].validate({ dataRoot }).value
  mod.apply(ctx, config)
  return tools
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-purge-'))
process.env.DSH_HOME = home
const owned = path.join(home, 'plugins-data', 'dsh-plugin-youtube-subtitles')

try {
  /* ---------------- 安全路径：整棵删除 ---------------- */
  await seed(owned)
  const tools = toolsFor(owned)
  const purge = tools.get('youtube_subs_purge')
  check('注册了 youtube_subs_purge', Boolean(purge))

  const preview = await purge.execute({}, {})
  console.log('\n=== 预览 ===')
  console.log('总占用:', preview.occupiedMB, 'MB')
  console.log('binaries:', JSON.stringify(preview.binaries))
  console.log('models:', JSON.stringify(preview.models))
  check('预览安全', preview.ok === true && preview.preview === true)
  check('预览列出 bin 体积', preview.binaries?.occupiedMB >= 80, `${preview.binaries?.occupiedMB} MB`)
  check('预览列出 models 体积', preview.models?.occupiedMB >= 74, `${preview.models?.occupiedMB} MB`)

  const done = await purge.execute({ confirm: true }, {})
  console.log('\n=== 执行 ===')
  console.log('removed:', done.removed, '| freedMB:', done.freedMB)
  console.log('deleted:', JSON.stringify(done.deleted))
  check('已删除', done.removed === true)
  check('释放体积合理', done.freedMB >= 157, `${done.freedMB} MB`)
  check('目录已消失', (await exists(owned)) === false)

  /* ---------------- 不安全路径：预览拒绝、confirm 也不删 ---------------- */
  const workspace = path.join(home, 'workspace', 'project')
  const sessions = path.join(home, 'sessions')
  await seed(workspace)
  await fs.mkdir(path.join(sessions, 'keep'), { recursive: true })
  await fs.writeFile(path.join(sessions, 'keep', 'session.json'), '{}')

  for (const [label, target] of [
    ['工作区路径', workspace],
    ['$DSH_HOME/sessions', sessions],
    ['plugins-data 本身', path.join(home, 'plugins-data')],
    ['$DSH_HOME 本身', home],
    ['相对路径', 'relative/dir'],
  ]) {
    const t = toolsFor(target).get('youtube_subs_purge')
    const p = await t.execute({}, {})
    const c = await t.execute({ confirm: true }, {})
    check(`${label} 预览被拒绝`, p.ok === false && p.safe === false, (p.reason ?? '').slice(0, 40))
    // 相对路径不对应任何真实存在的目录，只校验「没有报删除成功」
    const stillThere = path.isAbsolute(target) ? await exists(target) : true
    check(
      `${label} confirm 不删除`,
      c.removed === false && stillThere,
      (c.reason ?? '').slice(0, 30),
    )
  }

  check('工作区内容仍在', await exists(path.join(workspace, 'models', 'small', 'model.int8.onnx')))
  check('sessions 内容仍在', await exists(path.join(sessions, 'keep', 'session.json')))
} finally {
  await fs.rm(home, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
