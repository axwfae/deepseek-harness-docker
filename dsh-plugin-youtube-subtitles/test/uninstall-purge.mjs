/**
 * 卸载自动清理矩阵：4 种场景 × 是否删除 bin/models。
 *
 * 判定规则：只有 profile 的 dependencies 不再引用本插件（= 真卸载）才清理；
 * 仅禁用（依赖还在）时一个字节都不动。自定义目录只删插件自己的 bin/ 与 models/。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const media = await import(new URL('../src/media.js', import.meta.url).href)
const exists = async (p) => {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

async function scenario(name, { owned, referenced, extraFile }, expect) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-'))
  process.env.DSH_HOME = home
  const root = owned
    ? path.join(home, 'plugins-data', 'dsh-plugin-youtube-subtitles')
    : path.join(home, 'my-data')
  await fs.mkdir(path.join(root, 'bin'), { recursive: true })
  await fs.mkdir(path.join(root, 'models'), { recursive: true })
  await fs.writeFile(path.join(root, 'bin', 'yt-dlp'), 'b')
  await fs.writeFile(path.join(root, 'bin', 'ffmpeg'), 'b')
  await fs.writeFile(path.join(root, 'models', 'x.onnx'), 'm')
  if (extraFile) await fs.writeFile(path.join(root, extraFile), 'keep me')

  await fs.mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await fs.writeFile(
    path.join(home, 'profiles', 'web', 'package.json'),
    JSON.stringify({ dependencies: referenced ? { 'dsh-plugin-youtube-subtitles': 'link:.' } : {} }),
  )

  const stop = media.scheduleUninstallPurge(root, { timeoutMs: 500, intervalMs: 80, logger: { info() {} } })
  await new Promise((r) => setTimeout(r, 900))
  stop?.()

  const actual = {
    dataRoot: await exists(root),
    ytdlp: await exists(path.join(root, 'bin', 'yt-dlp')),
    ffmpeg: await exists(path.join(root, 'bin', 'ffmpeg')),
    models: await exists(path.join(root, 'models')),
    extra: extraFile ? await exists(path.join(root, extraFile)) : true,
  }
  for (const key of Object.keys(expect)) {
    check(`${name} / ${key}`, actual[key] === expect[key], `期望 ${expect[key]}，实际 ${actual[key]}`)
  }
  await fs.rm(home, { recursive: true, force: true })
}

await scenario(
  '专属目录 + 真卸载',
  { owned: true, referenced: false },
  { dataRoot: false, ytdlp: false, ffmpeg: false, models: false },
)
await scenario(
  '专属目录 + 仅禁用',
  { owned: true, referenced: true },
  { dataRoot: true, ytdlp: true, ffmpeg: true, models: true },
)
await scenario(
  '自定义目录 + 真卸载 + 有其它文件',
  { owned: false, referenced: false, extraFile: 'notes.txt' },
  { dataRoot: true, ytdlp: false, ffmpeg: false, models: false, extra: true },
)
await scenario(
  '自定义目录 + 仅禁用',
  { owned: false, referenced: true, extraFile: 'notes.txt' },
  { dataRoot: true, ytdlp: true, ffmpeg: true, models: true, extra: true },
)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
