/**
 * 二进制安装的跨文件系统落位回归。
 *
 * 真实故障：`/tmp` 与 `$DSH_HOME` 常是不同挂载，`rename` 抛
 * `EXDEV: cross-device link not permitted`，用户在卡片点「下载」只看到这一条底层错误。
 *
 * 覆盖：
 *   1. 同文件系统（rename 成功）→ 直接落位；
 *   2. 跨文件系统（rename 抛 EXDEV）→ 复制到目标同目录 .part 再 rename；
 *   3. 其它错误（如 EACCES）→ 原样抛出，不掩盖；
 *   4. 真实文件系统上仍能正确移动（不注入 mock 的冒烟）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const media = await import(new URL('../src/media.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'move-'))

try {
  /* ---------------- 1. 同文件系统 ---------------- */
  const src1 = path.join(dir, 'src1')
  const dst1 = path.join(dir, 'out1')
  await fs.writeFile(src1, 'binary-1')
  await media.moveIntoPlace(src1, dst1)
  check('同文件系统落位成功', (await fs.readFile(dst1, 'utf8')) === 'binary-1')
  check('源文件已移走', !(await fs.stat(src1).catch(() => null)))
  check('权限 755', ((await fs.stat(dst1)).mode & 0o777) === 0o755)

  /* ---------------- 2. 跨文件系统：rename 抛 EXDEV ---------------- */
  const src2 = path.join(dir, 'src2')
  const dst2 = path.join(dir, 'out2')
  await fs.writeFile(src2, 'binary-2')
  const calls = []
  const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
  const realRename = (await import('node:fs/promises')).rename
  const { copyFile } = await import('node:fs/promises')
  await media.moveIntoPlace(src2, dst2, {
    rename: async (from, to) => {
      calls.push({ from: path.basename(from), to: path.basename(to) })
      // 第一次（跨设备）失败；第二次（同目录 .part → 正式名）交给真实实现
      if (from === src2) throw exdev
      return realRename(from, to)
    },
    copyFile,
  })
  check('EXDEV 后回落复制', (await fs.readFile(dst2, 'utf8')) === 'binary-2')
  // 流程：rename 失败 → copyFile 到 <target>.part → rename(.part → target)
  check('经 .part 中转再 rename', calls.some((c) => c.from.endsWith('.part')), JSON.stringify(calls))
  check('不残留 .part', !(await fs.stat(`${dst2}.part`).catch(() => null)))
  check('回落路径权限 755', ((await fs.stat(dst2)).mode & 0o777) === 0o755)

  /* ---------------- 3. 其它错误不掩盖 ---------------- */
  const src3 = path.join(dir, 'src3')
  const dst3 = path.join(dir, 'out3')
  await fs.writeFile(src3, 'binary-3')
  let message = ''
  try {
    await media.moveIntoPlace(src3, dst3, {
      rename: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
      copyFile,
    })
  } catch (err) {
    message = err.message
  }
  check('非 EXDEV 原样抛出', /EACCES/.test(message), message)
  check('非 EXDEV 不产生目标文件', !(await fs.stat(dst3).catch(() => null)))
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
