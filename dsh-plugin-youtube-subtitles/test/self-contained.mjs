/**
 * 自包含审计：插件的所有产物必须只落在 dataRoot 内。
 *
 * 这是「插件要单纯」的验收测试：
 *   1. yt-dlp / ffmpeg / 模型都装进 <dataRoot>/{bin,models}；
 *   2. 不写系统 bin、不写 $DSH_HOME/models；
 *   3. 卸载后全部消失，临时目录零残留。
 *
 * 用临时 DSH_HOME 跑，不碰真实环境。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../src/', import.meta.url).pathname
const media = await import(path.join(PLUGIN, 'media.js'))
const asr = await import(path.join(PLUGIN, 'asr.js'))

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'selfcontained-'))
process.env.DSH_HOME = home
const root = path.join(home, 'plugins-data', 'dsh-plugin-youtube-subtitles')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

try {
  // 系统目录基线
  const baseline = new Set([
    ...(await fs.readdir('/usr/local/bin').catch(() => [])),
    ...(await fs.readdir('/usr/bin').catch(() => [])),
  ])

  console.log('安装三件套（首次约 60s）…')
  await media.installBinary(root, 'ytdlp')
  await media.installBinary(root, 'ffmpeg')
  await asr.installTier(root, 'small')

  // 1) 落点
  for (const rel of ['bin/yt-dlp', 'bin/ffmpeg', 'models/small/model.int8.onnx', 'models/silero_vad.onnx']) {
    const st = await fs.stat(path.join(root, rel)).catch(() => null)
    check(`${rel} 在 dataRoot 内`, st !== null, st ? `${(st.size / 1e6).toFixed(1)} MB` : '缺失')
  }

  // 2) 可执行
  for (const b of ['yt-dlp', 'ffmpeg']) {
    const p = path.join(root, 'bin', b)
    const st = await fs.stat(p)
    check(`${b} 权限 755`, (st.mode & 0o777) === 0o755)
  }
  const ver = execFileSync(path.join(root, 'bin', 'ffmpeg'), ['-version']).toString().split('\n')[0]
  check('ffmpeg 可执行', /ffmpeg version/.test(ver), ver.slice(0, 40))

  // 3) 系统目录零污染
  const after = new Set([
    ...(await fs.readdir('/usr/local/bin').catch(() => [])),
    ...(await fs.readdir('/usr/bin').catch(() => [])),
  ])
  const added = [...after].filter((f) => !baseline.has(f) && /^(yt-dlp|ffmpeg)$/.test(f))
  check('未写入系统 bin', added.length === 0, added.join(', '))

  const dshModels = await fs.readdir(path.join(home, 'models')).catch(() => [])
  check('未写入 $DSH_HOME/models', dshModels.length === 0, dshModels.join(', '))

  // 4) 临时目录零残留
  const leftovers = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('dsh-yt-'))
  check('临时目录零残留', leftovers.length === 0, leftovers.join(', '))

  // 5) 卸载全清
  await fs.mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await fs.writeFile(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: {} }))
  const stop = media.scheduleUninstallPurge(root, { timeoutMs: 3000, intervalMs: 100, logger: {} })
  await new Promise((r) => setTimeout(r, 1200))
  stop?.()
  const gone = await fs.stat(root).then(() => false).catch(() => true)
  check('卸载后 dataRoot 已删除', gone)
} finally {
  await fs.rm(home, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
