/**
 * 用宿主 profile 里真实的 @deepseek-ai/cordis 装载本插件。
 *
 * 这一步专门守住那个曾经踩过的坑：只要插件导出了 Config，cordis 的
 * resolveConfig() 就会执行 runtime.Config["~standard"].validate(config)，
 * 而普通对象（如 {}）会让加载直接抛 TypeError —— 服务端路由 404，
 * 客户端卡片却照常显示。
 *
 * 运行：node tests/cordis-load.mjs
 */
import { createRequire } from 'node:module'

// profile 里 autoInstallPeers: false，cordis 本身不装在 profile 的 node_modules，
// 而是作为宿主依赖放在 dsh 安装目录下，所以两个位置都要找。
const manifestCandidates = [
  '/home/node/.dsh/profiles/web/package.json',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
]

let cordisUrl = null
for (const manifest of manifestCandidates) {
  try {
    cordisUrl = createRequire(manifest).resolve('@deepseek-ai/cordis')
    break
  } catch {
    // 继续找下一个
  }
}
if (cordisUrl === null) throw new Error('找不到 @deepseek-ai/cordis，无法做真实装载验证')

const { Context } = await import(cordisUrl)

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const registered = []
const app = new Context()
// 宿主会提供的两个服务：webServer 与 logger（logger 可选，这里一并给上）。
app.provide('webServer', {
  register: (route) => {
    registered.push(route)
    return () => {}
  },
})
// logger 由宿主提供；这里不注入，正好验证插件对缺失 logger 的兜底（loggerOf 返回 null）。

const fiber = app.plugin(mod, {})
await fiber

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name} —— 实际 ${JSON.stringify(detail)}`)
}

check('插件被 cordis 接受（未抛错）', fiber.error === undefined, String(fiber.error))
check('注册了两条路由', registered.length === 2, registered.map((route) => route.path))
check(
  '路由路径正确',
  registered.map((route) => route.path).sort().join(',') === '/dsh-reboot/restart,/dsh-reboot/status',
  registered.map((route) => route.path),
)
check('插件没有导出 Config', !('Config' in mod), Object.keys(mod))

app.stop?.()

if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`真实 cordis 装载通过：${registered.map((route) => route.path).join('、')}`)
}
