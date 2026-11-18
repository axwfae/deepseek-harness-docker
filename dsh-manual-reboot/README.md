# dsh-manual-reboot

给 DeepSeek Harness 加一个**手动重启**入口：在设置页多出一张「重启」卡片，点一下并确认后，
当前 `dsh web` 进程会按**原来的启动参数**重新拉起，用于让插件安装/卸载、配置变更生效。

实现方式照搬插件市场（`dshmarket`）的自重启思路，但只保留最小闭环：不做失败恢复页、不加 slash 命令。

## 它做了什么

```
设置页「重启」卡片
  → POST /dsh-reboot/restart
      → 门禁：仅本机同源直连 + 非调试器 + 宿主未禁用自重启 + 无并发
      → spawn(node -e <helper>)（detached）
      → 500ms 后 process.kill(process.pid, "SIGTERM") 结束自己
  → helper 轮询等旧端口真正释放
  → 用与原来完全相同的 argv 重新 spawn（node <bin.js> web --port 3079）
  → helper 轮询「端口连续 8 秒可连」才判定启动成功
前端每 1.5s 轮询 GET /dsh-reboot/status，boot id 变化后 location.reload()
```

为什么这么绕：DSH 官方没有 restart/stop 命令，进程是单进程模型；端口要先释放再 bind，
否则新进程会 `EADDRINUSE` 直接退出，所以必须有一个 detached helper 跨过进程死亡时刻。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：注册 `GET /dsh-reboot/status`、`POST /dsh-reboot/restart` |
| `lib/restart.js` | 重启核心：supervisor/调试器检测、请求门禁、argv 重放、detached helper |
| `client/client.js` | 设置页卡片（手写 bundle，`window.__ModuleLoader__.load`，只依赖宿主 `react`） |
| `cordis.patch.yml` | 作为 bundle 被 profile 引用时把本插件插进层栈 |

## 安装

在工作区外操作，需要写 `~/.dsh/profiles/web`：

```bash
# 1) 链接进 profile。dsh plugin 会同时把包名追加进 package.json 的
#    dsh.profile.bundles，插件自带的 cordis.patch.yml 因此自动叠加上 —
#    不要再手动往 profile 的 cordis.patch.yml 里加 insert，否则同名 entry 会插两次。
dsh plugin --profile web add link:/home/node/workspace/system/reboot

# 2) 手动重启 dsh web（第一次必须先重启，插件才会被加载）
```

用的是 `link:`，所以 `~/.dsh/profiles/web/node_modules/dsh-manual-reboot` 指向本目录；
之后改 `lib/`、`client/` 只需要再点一次卡片上的「重启」即可。

> 也可以不用 `dsh plugin`：把本目录软链到 `~/.dsh/profiles/web/node_modules/dsh-manual-reboot`，
> 然后把 `dsh-manual-reboot` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。

## 接口

`GET /dsh-reboot/status`

```json
{ "ok": true, "pid": 5, "port": 3079, "boot": "5-1699999999999",
  "restart": true, "supervisor": null, "debugger": null, "reachable": true }
```

`POST /dsh-reboot/restart`：成功 `202 { ok, boot, pid, helperPid, logOut, logErr }`；
被拒时 `403 { error }`，并发时 `409 { error }`。

## 为什么按钮会「不可用」

卡片会读取 status 的能力位并给出原因，对照关系：

| 条件 | 原因 |
| --- | --- |
| `supervisor: "systemd"` | 进程由 systemd 托管，应 `systemctl restart`；detached helper 会被 cgroup 一起杀掉 |
| `debugger: "inspector"` | 挂着调试器，不允许从界面杀进程 |
| `restart: false` | 显式配置了 `allowRestart: false` |
| `reachable: false` | 通过代理/远程地址访问；只接受 loopback + 同源的请求 |

端口一律从请求的 `Host` 头取，不从 argv 推断；`Host` 必须是 loopback 名称（防 DNS rebinding），
`Origin` 必须与 `Host` 同源，任何 `forwarded` / `x-forwarded-for` / `x-real-ip` 头都会拒绝。

## 配置

插件**不导出 `Config`**，这是有意的：

cordis 的 `resolveConfig()` 会执行 `runtime.Config["~standard"].validate(config)`。
只要插件导出了 `Config`，它就必须是真正的 schemastery Schema；而本插件以 `link:`
方式装在 profile 里时，运行时是从源码目录解析依赖的，那里找不到
`@deepseek-ai/schemastery`，退化出来的普通对象 `{}` 会让 `resolveConfig` 抛
`TypeError: Cannot read properties of undefined (reading 'validate')` ——
结果是**服务端半边整个加载失败、接口 404，而客户端卡片照常显示**。

不导出 `Config` 时 `runtime.Config` 是 `undefined`，配置原样传入。要关掉这个功能，
在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: manual-reboot
  config:
    allowRestart: false
```

不写 `allowRestart` 时按宿主形态自动判断：被 systemd 等 supervisor 托管时自重启会被禁用。

## 排错

先用 curl 确认服务端半边是否活着：

```bash
curl -s -i http://127.0.0.1:<端口>/dsh-reboot/status
```

拿到 `404` 说明 Node 侧没加载起来（卡片是客户端半边，两者独立加载），
此时重启 `dsh web` 并看宿主日志里的加载错误。

重启日志写在系统临时目录：

```bash
ls -t /tmp/dsh-reboot-*.out.log /tmp/dsh-reboot-*.err.log | head
```

新进程没起来时，`.err.log` 里会有 helper 的诊断（端口占用、进程退出码等）。

## 卸载

```bash
dsh plugin --profile web remove dsh-manual-reboot
```

若 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里仍留着 `dsh-manual-reboot`，
手动删掉那一行，否则下次启动会因为找不到包而报组合错误。

## 测试

```bash
node tests/client-smoke.mjs   # 前端 bundle：导出、slot 注册、渲染树
node tests/server-smoke.mjs   # 服务端路由：status、方法、来源与开关门禁
node tests/cordis-load.mjs    # 用宿主真实 cordis 装载，守住 Config 导出这个坑
```

`tests/server-smoke.mjs` 刻意不覆盖 202 成功路径——它会真的 spawn 助手并 SIGTERM 当前进程后重放
`dsh web`，只能由人手动触发。重启链路本身的证据请看 helper 源码与日志。
