/**
 * 服务端路由冒烟测试：用假 ctx + 真实 HTTP 服务器驱动插件路由。
 *
 * 只覆盖不会真的重启进程的分支（status、方法不符、来源/开关被拒）。
 * POST 的成功路径（202）会 spawn detached 助手并 SIGTERM 本进程后重放
 * `dsh web` —— 按全局规则禁止由 agent 触发，故此处刻意不测。
 *
 * 运行：node tests/server-smoke.mjs
 */
import { createServer } from 'node:http'
import { once } from 'node:events'

const indexPath = new URL('../lib/index.js', import.meta.url).href

/** 用假 ctx 装载插件，返回它注册的路由表。 */
async function mount(config, cacheKey) {
  const mod = await import(indexPath + (cacheKey ?? ''))
  const routes = []
  const ctx = {
    logger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
    inject: (deps, cb) => {
      const hostCtx = {
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
        },
        effect: (fn) => {
          fn()
          return () => {}
        },
      }
      cb(hostCtx)
    },
  }
  mod.apply(ctx, config)
  return { mod, routes }
}

/** 把注册的路由挂到真实服务器上。 */
async function serve(routes) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const route = routes.find((item) => item.kind === 'exact' && item.path === url.pathname)
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    route.handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${String(port)}` }
}

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition, detail })
  if (!condition) process.exitCode = 1
}

const { mod, routes } = await mount({}, '?case=default')
check('导出 name', mod.name === 'dsh-reboot', mod.name)

const { server, origin } = await serve(routes)

// 1. status：同源 GET（浏览器不带 Origin）必须 reachable=true，否则按钮会恒灰。
const statusResponse = await fetch(`${origin}/dsh-reboot/status`, { headers: { 'cache-control': 'no-store' } })
const status = await statusResponse.json()
check('status 200', statusResponse.status === 200, statusResponse.status)
check('status 不缓存', statusResponse.headers.get('cache-control') === 'no-store', statusResponse.headers.get('cache-control'))
check('status content-type', /application\/json/.test(statusResponse.headers.get('content-type') ?? ''), statusResponse.headers.get('content-type'))
check('status.pid 为当前进程', status.pid === process.pid, status.pid)
check('status.port 来自 Host 头', status.port === server.address().port, `${status.port} vs ${server.address().port}`)
check('status.boot 非空字符串', typeof status.boot === 'string' && status.boot.length > 0, status.boot)
check('status.reachable=true（GET 无 Origin）', status.reachable === true, status.reachable)
check('status.restart=true（缺省回落到非 supervisor）', status.restart === true, status.restart)
check('status.supervisor=null', status.supervisor === null, status.supervisor)
check('status.debugger=null', status.debugger === null, status.debugger)

// 2. 方法不符。
const badStatus = await fetch(`${origin}/dsh-reboot/status`, { method: 'POST', headers: { origin } })
check('POST status → 405', badStatus.status === 405, badStatus.status)
const badRestart = await fetch(`${origin}/dsh-reboot/restart`, { method: 'GET', headers: { origin } })
check('GET restart → 405', badRestart.status === 405, badRestart.status)

// 3. 跨站 Origin 必须被拒（这一条最接近真实的重启请求形状）。
const crossSite = await fetch(`${origin}/dsh-reboot/restart`, {
  method: 'POST',
  headers: { origin: 'http://evil.test', 'content-type': 'application/json' },
  body: '{}',
})
const crossSiteBody = await crossSite.json()
check('跨站 Origin → 403', crossSite.status === 403, crossSite.status)
check('跨站 Origin 文案', crossSiteBody.error === '仅接受本机同源请求', crossSiteBody.error)

// 4. 缺 Origin 也必须被拒（POST 仍走严格判定）。
const noOrigin = await fetch(`${origin}/dsh-reboot/restart`, { method: 'POST', body: '{}' })
check('无 Origin → 403', noOrigin.status === 403, noOrigin.status)

// 5. allowRestart:false 时任何请求都被拒，且 status 如实上报 restart=false。
const disabled = await mount({ allowRestart: false }, '?case=disabled')
const disabledServer = await serve(disabled.routes)
const disabledStatus = await (await fetch(`${disabledServer.origin}/dsh-reboot/status`)).json()
check('allowRestart:false → status.restart=false', disabledStatus.restart === false, disabledStatus.restart)
const disabledRestart = await fetch(`${disabledServer.origin}/dsh-reboot/restart`, {
  method: 'POST',
  headers: { origin: disabledServer.origin, 'content-type': 'application/json' },
  body: '{}',
})
const disabledBody = await disabledRestart.json()
check('allowRestart:false → 403', disabledRestart.status === 403, disabledRestart.status)
check('allowRestart:false 文案', disabledBody.error === '本宿主已禁用自重启', disabledBody.error)
disabledServer.server.close()
server.close()

// 6. 不能导出 Config：cordis 会执行 runtime.Config["~standard"].validate(...)，
//    不是 schemastery Schema 的 Config（例如 {}）会让整个服务端半边加载失败。
check('不导出 Config', !('Config' in mod), Object.keys(mod))

for (const result of results) {
  console.log(`${result.ok ? '  ✓' : '  ✗'} ${result.name}${result.ok ? '' : ` —— 实际 ${JSON.stringify(result.detail)}`}`)
}
console.log(process.exitCode === 1 ? '\n服务端冒烟测试存在失败项' : '\n服务端冒烟测试全部通过')
