/**
 * 跑一遍离线可用的全部回归脚本。
 *
 * 用法：
 *   node test/run-all.mjs              # 离线用例
 *   node test/run-all.mjs --with-network  # 额外跑 self-contained（会下载 ~160MB）
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const withNetwork = process.argv.includes('--with-network')

const suites = [
  'tool-schema.mjs',
  'tool-registration.mjs',
  'youtube-format.mjs',
  'rpc-channel.mjs',
  'binary-install.mjs',
  'schema-guard.mjs',
  'purge-tool.mjs',
  'tier-override.mjs',
  'uninstall-purge.mjs',
  'card-polling.mjs',
  ...(withNetwork ? ['self-contained.mjs'] : []),
]

const results = []
for (const file of suites) {
  console.log(`\n========== ${file} ==========`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  results.push({ file, code })
}

console.log('\n========== 汇总 ==========')
for (const r of results) console.log(`${r.code === 0 ? '✓' : '✗'} ${r.file}`)
if (!withNetwork) console.log('- self-contained.mjs（需网络，加 --with-network 运行）')

const failed = results.filter((r) => r.code !== 0)
process.exit(failed.length === 0 ? 0 : 1)
