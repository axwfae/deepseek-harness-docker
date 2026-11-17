/** 清理矩阵：4 种场景 × 是否删除 bin/models。 */
const fs = await import('node:fs/promises')
const path = await import('node:path')
const os = await import('node:os')

const m = await import('/home/node/workspace/system/plungin_yt/dsh-plugin-youtube-subtitles/src/media.js')
const exists = async (p) => { try { await fs.stat(p); return true } catch { return false } }

async function scenario(name, { owned, referenced, extraFile }) {
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

  const stop = m.scheduleUninstallPurge(root, { timeoutMs: 500, intervalMs: 80, logger: { info: () => {} } })
  await new Promise((r) => setTimeout(r, 900))
  stop?.()

  const row = {
    scenario: name,
    'dataRoot 存在': await exists(root),
    'bin/yt-dlp': await exists(path.join(root, 'bin', 'yt-dlp')),
    'bin/ffmpeg': await exists(path.join(root, 'bin', 'ffmpeg')),
    'models/': await exists(path.join(root, 'models')),
    '其它文件': extraFile ? await exists(path.join(root, extraFile)) : '—',
  }
  await fs.rm(home, { recursive: true, force: true })
  return row
}

const rows = []
rows.push(await scenario('专属目录 + 真卸载', { owned: true, referenced: false }))
rows.push(await scenario('专属目录 + 仅禁用', { owned: true, referenced: true }))
rows.push(await scenario('自定义目录 + 真卸载 + 有其它文件', { owned: false, referenced: false, extraFile: 'notes.txt' }))
rows.push(await scenario('自定义目录 + 仅禁用', { owned: false, referenced: true, extraFile: 'notes.txt' }))

const cols = Object.keys(rows[0])
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
const line = (vals) => vals.map((v, i) => String(v).padEnd(w[i])).join('  ')
console.log(line(cols))
console.log(w.map((x) => '─'.repeat(x)).join('  '))
for (const r of rows) console.log(line(cols.map((c) => r[c])))
