# deepseek-harness（Docker 镜像）

镜像地址：**`wuyong1977/dsh_ssh:latest`**
Docker Hub 项目主页：https://hub.docker.com/r/wuyong1977/dsh_ssh
GitHub 项目主页：https://github.com/axwfae/deepseek-harness-docker

本镜像 fork 自 **`smanx/deepseek-harness`**（[Docker Hub](https://hub.docker.com/r/smanx/deepseek-harness) / [GitHub](https://github.com/smanx/deepseek-harness-docker)），在其基础上增加了非 root 运行、SSH 登录，并修复了「无法登录」的问题。

一个开箱即用的 **DeepSeek Harness（DSH）** Docker 镜像：容器内安装官方 npm 包 `@deepseek-ai/dsh`，内置 Node 反向代理，解决 DSH 官方不允许 `--host 0.0.0.0`、只能监听回环地址的问题，让 DSH 可以安全地通过局域网访问。

## 项目介绍

- **DSH**：容器内安装官方 npm 包 `@deepseek-ai/dsh`（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)），默认监听容器内 `127.0.0.1:3079`（源端口）；
- **Node 代理**：`0.0.0.0:3080`（代理端口）→ `127.0.0.1:3079`，对外提供 HTTP + WebSocket 转发；
- **为什么需要代理**：
  - DSH 官方禁止 `--host 0.0.0.0`（安全限制），只能监听回环地址；
  - 局域网 IP 页面属于浏览器**非安全上下文**，DSH 前端依赖的 `crypto.randomUUID` 不可用，代理在转发 HTML 时自动注入基于 `getRandomValues` 的 polyfill，否则实时通道（WS）会一直 pending；
  - 代理同时提供可选的 **HTTP Basic Auth**，给局域网访问加认证。

## 本镜像相对上游的差异

| # | 改动 | 说明 |
|---|---|---|
| 1 | 以普通用户 `node` 运行 | 不再用 root，避免部分程序拒绝以 root 运行 |
| 2 | 内置 SSH 服务 | 账号 `node` / 密码 `deepseek`，可直接进容器排查 |
| 3 | `sudo` 免密码 | `node` 用户可自行安装/调试 |
| 4 | `$DSH_HOME` 迁移 | 由 `/root/.dsh` 改为 **`/home/node/.dsh`**（卷要挂这里） |
| 5 | 工作区固定在 `/home/node/workspace` | 运行中创建的文件可直接在容器外取用 |
| 6 | 修复浏览器登录 | 不再出现 `dsh web authentication required`，用户无需接触 token（见下节） |

镜像内是 **devtools（完整工具）变体**：git、curl、wget、nano、jq、procps、unzip、vim、openssh-client、zip、htop、tmux、tree、openssl、python3、build-essential、bash-completion，npm 全局包 pnpm，以及 uv。

## 快速开始（拉取运行）

```bash
# 1. 拉取镜像
docker pull wuyong1977/dsh_ssh:latest

# 2. 启动（3080 = Web 入口，50022 = SSH；DSH 数据卷必须挂 /home/node/.dsh）
docker run -d \
  --name dsh-harness \
  --restart unless-stopped \
  -p 3080:3080 \
  -p 50022:22 \
  -v dsh-data:/home/node/.dsh \
  -v dsh-workspace:/home/node/workspace \
  wuyong1977/dsh_ssh:latest

# 3. 访问
#    Web：http://127.0.0.1:3080/ 或 http://<服务器局域网IP>:3080/
#    SSH：ssh -p 50022 node@<服务器局域网IP>   （密码 deepseek）
```

> 用 podman 时可直接用 bind mount，文件落在当前目录，便于外部取用：
> `-v ./config:/home/node/.dsh -v ./workspace:/home/node/workspace`。

WebSocket 实时通道（`/api/events.mux`、`/api/events.host`）由代理自动转发，无需额外配置。

## 登录修正：`dsh web authentication required`

**现象**：浏览器打开 `http://<主机>:3080/`，只得到一行纯文本

```
dsh web authentication required; reopen the URL printed by dsh web.
```

这是 **DSH 自身的 401**（`packages/client/connection/src/browser-auth.ts`），不是代理的 Basic Auth，也不是 `/api` 的信任栅栏（那是 403）。含义是：这次 `GET /` 既没带有效的 `?token=`，也没带有效的签名 cookie。DSH 的启动 token 每个进程一颗、只存在内存里，容器重启或切换 DSH 版本后就会变化。

本镜像的代理会自动用启动 token 换取会话 cookie，并修正了以下六种会导致永远 401 的情况：

| # | 修正 | 解决的情况 |
|---|---|---|
| 1 | token 缓存改由日志 mtime 驱动（去掉永久 `state.done`） | DSH 重启后新 token 抓不到，所有无 cookie 的浏览器卡 401 |
| 2 | 重送时**替换**已有的 `token` 参数 | URL 残留旧 `?token=` 时组成 `?token=old&token=new`，而上游要求恰好一个 → 永远 401 |
| 3 | 重送仍 401 时立即作废缓存 | DSH 已换 token 但日志尚未刷新时，下一次请求自动重扫 |
| 4 | `/index.html`、旧深链接等非 `/` 入口导回 `/?token=…`，带 `__dsh_auth` 标记防重导环 | 上游只认 `GET /` 做 token 交换，其余入口只返回裸 401 |
| 5 | 把 `Set-Cookie` 的 `SameSite=Strict` 改写为 `Lax` | 手机主屏幕 App、从其他 App/链接跨站打开时首跳不带 Strict cookie → 401 或重导环 |
| 6 | 外部链路为 HTTPS 时补 `Secure` | 反向代理终止 TLS 时 cookie 缺 `Secure`，无法长期保存 |

修正后：**用户只需打开 `http://<主机>:3080/`，不需要看到或粘贴任何 token**。token 只存在于「代理 ↔ DSH」之间，因此日常也不需要关闭认证；上游没有提供关闭认证的开关。

新增两个环境变量（详见下方配置表）：`DSH_COOKIE_SAMESITE`（默认 `lax`）、`DSH_COOKIE_SECURE`（默认 `auto`）。

完整说明（认证模型、全部环境变量、能否关闭 cookie/token、验证与排查）见
[LOGIN-FIX.md](https://github.com/axwfae/deepseek-harness-docker/blob/main/LOGIN-FIX.md)。

## 可用 tag

本镜像只发布 **devtools 变体**（含上面列出的完整工具集），平台为 `linux/amd64`：

| tag | DSH 版本 | 说明 |
|---|---|---|
| `wuyong1977/dsh_ssh:latest` | 最新 | 始终指向最新版本 |
| `wuyong1977/dsh_ssh:0.2.2-rc.1` | 0.2.2-rc.1 | 版本号 tag |
| `wuyong1977/dsh_ssh:0.2.1-rc.5` / `-rc.4` / `-rc.2` | 对应版本 | 历史版本，便于回退 |

> 版本号 tag 与构建时实际安装的 `@deepseek-ai/dsh` 版本一致。需要固定版本时优先用版本号 tag，不要只依赖 `latest`。

## 上游镜像的其他变体（本镜像未发布）

上游 `smanx/deepseek-harness` 另有精简版、精简工具版、管理版和 GHCR 备用源。本镜像**不包含**这些 tag；需要时请直接使用上游镜像，或参照本仓库自行构建：

| 上游 tag | 定位 |
|---|---|
| `smanx/deepseek-harness:latest` | 精简运行镜像（无开发工具） |
| `smanx/deepseek-harness:devtools-min-latest` | 精简工具版 |
| `smanx/deepseek-harness:devtools-latest` | 完整工具版（与本镜像工具集相近，但以 root 运行） |
| `smanx/deepseek-harness:admin-latest` | 管理版：预装最新 DSH，页面自选版本安装/切换 |

> 使用上游镜像时，DSH 数据卷路径是 `/root/.dsh`（上游以 root 运行）；本镜像必须用 `/home/node/.dsh`。
>
> 上游的 `ghcr.io/smanx/deepseek-harness:latest` 也是同样内容，仅镜像地址不同。
>
> admin 变体在本仓库中仍可自行构建（`docker build --build-arg DEV_TOOLS=admin -t dsh-admin .`），
> 但它同样需要把数据卷改挂到 `/home/node/.dsh`，并额外挂 `/opt/dsh`。

## 配置（环境变量）

| 环境变量 | 含义 | 默认值 |
|---|---|---|
| `DSH_PORT` | 源端口：DSH 在容器内监听（`127.0.0.1`） | `3079` |
| `PROXY_PORT` | 代理端口：代理对外监听（局域网入口） | `3080` |
| `PROXY_USERNAME` | Basic Auth 用户名（可选） | 未设置 |
| `PROXY_PASSWORD` | Basic Auth 密码（可选） | 未设置 |
| `DSH_COOKIE_SAMESITE` | `lax`：把上游 `SameSite=Strict` 改写为 `Lax`（修手机 App／跨站打开的 401）；`strict`：保持上游原样 | `lax` |
| `DSH_COOKIE_SECURE` | `auto`：请求带 `x-forwarded-proto: https` 时补 `Secure`；`always` / `never` 强制开关 | `auto` |
| `DSH_WEB_LOG` | 代理抓取启动 token 的 DSH 日志路径 | `/app/.dsh-web.log` |
| `DSH_TOKEN` | 手动指定启动 token，优先于日志（DSH 重启后同样失效） | 未设置 |
| `DSH_TOKEN_FILE` | 从文件读取启动 token（优先于日志、低于 `DSH_TOKEN`） | 未设置 |
| `NPM_CONFIG_REGISTRY` | admin 变体管理页「npm 源」的默认值（优先级低于页面配置） | `https://registry.npmjs.org/` |
| `DSH_INSTALL_DIR` | admin 变体 DSH 安装目录（页面安装的 DSH 及状态文件都在这里，建议挂载命名卷） | `/opt/dsh` |

> `DSH_PORT` 与 `PROXY_PORT` 必须不同（同一端口只能被一个进程监听）。
> 修改 `PROXY_PORT` 时，`-p` 端口映射要对应改成 `-p <宿主机端口>:<新代理端口>`。

### 启用 Basic Auth

```bash
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  -e PROXY_USERNAME=yourname \
  -e PROXY_PASSWORD=yourpass \
  --restart unless-stopped \
  wuyong1977/dsh_ssh:latest
```

- 用户名和密码**两个都设置**才启用认证；只设置一个（或都不设置）则完全放行；
- 认证对 HTTP 和 WebSocket 都生效，未通过认证返回 `401` + `WWW-Authenticate`，浏览器会弹出认证框；
- 公开静态资源 `/manifest.webmanifest`、`/favicon.svg`、`/favicon.ico` 不参与认证（只含应用名/图标等非敏感数据）。浏览器抓取 `<link rel="manifest">` 时不会携带 Basic Auth 凭据，若强制认证，控制台会持续报 `/manifest.webmanifest` 401。

### 修改代理端口

```bash
# 例如代理对外用 3088
docker run -d \
  --name dsh-harness \
  -p 3088:3088 \
  -v dsh-data:/home/node/.dsh \
  -e PROXY_PORT=3088 \
  --restart unless-stopped \
  wuyong1977/dsh_ssh:latest
```

## 数据持久化

DSH 的会话/配置数据保存在容器内 **`/home/node/.dsh`**（本镜像以 `USER node` 运行，上游原版为 `/root/.dsh`），上面的命令用命名卷 `dsh-data` 持久化：

> 卷挂错到 `/root/.dsh` 不会报错，但等于没持久化：容器重建后 cookie 签名密钥被重新生成，所有已有浏览器会话立即失效。

- `docker stop/start` 和容器删除后卷仍在，数据不丢；
- 彻底清除数据：`docker volume rm dsh-data`（先停容器）。

## 停止 / 重启 / 删除

```bash
docker stop dsh-harness     # 停止
docker start dsh-harness    # 再次启动
docker logs -f dsh-harness  # 查看日志
docker rm -f dsh-harness    # 删除容器（卷中的数据保留）
```

## 联系作者 / 反馈

- 本镜像（fork）问题反馈：https://github.com/axwfae/deepseek-harness-docker/issues
- 上游 DSH 交流与 Bug 反馈：https://github.com/deepseek-ai/deepseek-harness/discussions/1762
