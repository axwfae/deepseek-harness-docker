# deepseek-harness

[English](README_EN.md) | 中文

Docker 化部署 **DeepSeek Harness（DSH）** + **Node 反向代理**：

1. 容器内安装并启动 DSH（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的官方 npm 包 `@deepseek-ai/dsh`），默认监听容器内 `127.0.0.1:3079`（源端口）；
2. 启动 Node 代理：`0.0.0.0:3080`（代理端口）→ `127.0.0.1:3079`，提供局域网访问 + WebSocket 转发。

> 为什么要代理而不是直接暴露 DSH：
> - DSH 的 `--host 0.0.0.0` 被官方禁止（安全限制），只能监听回环地址；
> - 局域网 IP 页面属于浏览器非安全上下文，DSH 前端依赖的 `crypto.randomUUID` 不可用，
>   代理通过注入 polyfill 解决（否则实时通道/WS 一直 pending）；
> - 代理同时提供 **HTTP Basic Auth**，可给局域网访问加认证。

## 本 fork 发布的镜像：`wuyong1977/dsh_ssh`

本仓库构建并发布的镜像在 Docker Hub：

- 镜像主页：**https://hub.docker.com/r/wuyong1977/dsh_ssh**
- 拉取地址：**`wuyong1977/dsh_ssh:latest`**
- 常见 tag：`latest`、`0.2.2-rc.1`、`0.2.1-rc.5`、`0.2.1-rc.4`、`0.2.1-rc.2`

相对上游 `smanx/deepseek-harness` 的改动：

1. 以普通用户 `node` 运行（非 root），避免部分程序拒绝以 root 运行；
2. 内置 SSH 服务，可直接进入容器，账号 `node` / 密码 `deepseek`；
3. `sudo` 免密码；
4. `$DSH_HOME` 由 `/root/.dsh` 改为 **`/home/node/.dsh`**；
5. 工作区开在 `/home/node/workspace`，运行中创建的文件可直接在容器外取用；
6. 修复「`dsh web authentication required`」无法登录的问题（见下一节）。

```bash
docker pull wuyong1977/dsh_ssh:latest

docker run -d \
  --name dsh-harness \
  --restart unless-stopped \
  -p 3080:3080 \
  -p 50022:22 \
  -v dsh-data:/home/node/.dsh \
  -v dsh-workspace:/home/node/workspace \
  wuyong1977/dsh_ssh:latest
```

- 浏览器入口：`http://<主机>:3080/`
- SSH 入口：`ssh -p 50022 node@<主机>`（容器内仍是 22 端口）
- 用 podman 时可按上游写法改用 bind mount：`-v ./config:/home/node/.dsh -v ./workspace:/home/node/workspace`

> 本 fork 的 Dockerfile 以 `USER node` 运行，所以容器内的 home 是 `/home/node`，
> 数据卷必须挂到 **`/home/node/.dsh`**；挂到 `/root/.dsh` 不会生效，
> 容器重建时会重建 cookie 签名密钥，导致所有已有会话一次性失效。

## 登录修正：`dsh web authentication required`

现象：浏览器打开 `http://<主机>:3080/`，只得到一行纯文本：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

这是 **DSH 自身的 401**（`packages/client/connection/src/browser-auth.ts`），不是代理的 Basic Auth，
也不是 `/api` 的信任栅栏（那是 403）。含义是：这次 `GET /` 既没带有效的 `?token=`，也没带有效的签名 cookie。

本次修正改动 `proxy/upstream-token.js`，并同步放开 `proxy/index.js`、`manager/index.js` 中 `/index.html` 的入口，共六项：

| # | 修正 | 解决的情况 |
|---|---|---|
| 1 | token 缓存改由日志 mtime 驱动，去掉永久 `state.done` | DSH 重启 / admin 变体切换版本后新 token 抓不到，所有无 cookie 的浏览器卡 401 |
| 2 | 重送时**替换**已有的 `token` 参数（不再追加） | URL 残留旧 `?token=`（书签、历史记录）时组成 `?token=old&token=new`，上游要求恰好一个 → 永远 401 |
| 3 | 重送仍 401 时立即作废缓存 | DSH 已换 token 但日志尚未刷新时，下一次请求自动重扫，不再永久卡死 |
| 4 | 非 `/` 的首页入口（`/index.html`、旧深链接）302 导回 `/?token=…`，带 `__dsh_auth` 标记防重导环 | 上游只认 `GET /` 做 token 交换，`/index.html` 只会得到裸 401 |
| 5 | 把响应 `Set-Cookie` 的 `SameSite=Strict` 改写为 `Lax`（可用 `DSH_COOKIE_SAMESITE=strict` 还原） | 手机主屏幕 App、从其他 App/链接跨站打开时首跳不带 Strict cookie → 401 或重导环（上游 discussion #5362、#9096） |
| 6 | 外部链路为 HTTPS 时补 `Secure`（`DSH_COOKIE_SECURE`） | 反向代理终止 TLS 时 cookie 缺 `Secure`；纯 HTTP 内网不补，避免被浏览器丢弃 |

行为细节：原始 query 参数会保留（`/index.html?session=abc` → `/?session=abc&token=…&__dsh_auth=1`）；
已带 `__dsh_auth` 仍 401 时直接透传，不再重导；`Cache-Control` 只在缺失时补 `no-store`，不再重复输出。

新增环境变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_COOKIE_SAMESITE` | `lax` | `lax`：把上游 `SameSite=Strict` 改写为 `Lax`；`strict`：保持上游原样 |
| `DSH_COOKIE_SECURE` | `auto` | `auto`：请求带 `x-forwarded-proto: https` 时补 `Secure`；`always` / `never` 强制开关 |

修正后用户打开 `http://<主机>:3080/` **不需要看到或粘贴任何 token**：代理会自动用启动 token 换取会话 cookie。
token 只存在于「代理 ↔ DSH」之间，因此日常也不需要关闭认证；上游没有提供关闭开关。

完整说明（认证模型、全部环境变量、能否关闭 cookie/token、验证与排错）见 **[LOGIN-FIX.md](LOGIN-FIX.md)**。

## 目录结构

```
deepseek-harness/
├── Dockerfile            # node:24-slim + 安装 DSH + 代理（支持 DEV_TOOLS 构建参数；admin 变体预装最新 DSH）
├── entrypoint.sh         # 先启动 DSH，等待就绪，再启动代理（检测到 admin 变体标记则改走管理服务）
├── proxy/
│   ├── index.js          # 代理（转发 + polyfill 注入 + Origin 对齐 + Basic Auth）
│   ├── upstream-token.js # 上游 401 时用启动 token 自动换取会话 cookie（登录修正）
│   └── package.json
├── manager/              # admin 变体专用：页面安装/切换 DSH 版本、配置 npm 源、托管 DSH 进程
│   ├── index.js
│   ├── admin.html
│   └── package.json
├── LOGIN-FIX.md          # 登录问题（dsh web authentication required）的修正说明
└── README.md / README_EN.md
```

## 使用

```bash
# 进入项目目录
cd deepseek-harness

# 构建镜像（默认精简运行镜像，不带开发工具）
docker build -t smanx/deepseek-harness .

# 启动（默认：代理对外端口 3080，数据持久化到命名卷 dsh-data）
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  --restart unless-stopped \
  smanx/deepseek-harness

# 查看日志
docker logs -f dsh-harness

# 停止 / 删除（卷中的数据保留）
docker stop dsh-harness
docker rm dsh-harness
```

构建会通过 npm 安装 DSH（约 250MB 依赖），首次构建较慢属正常。
Linux 下 node-pty 没有预编译产物，会从源码编译（Dockerfile 已用多阶段构建装好 python3/make/g++，
编译完成后运行镜像不保留编译工具）。

## 各 tag 的区别

默认运行镜像为精简版，不保留编译工具，适合生产部署。若需要在容器内开发/调试，
构建时用 `--build-arg DEV_TOOLS=<tag前缀>` 启用开发工具；各前缀安装哪些工具
在项目根目录的 `.build-variants` 文件中定义（每行 `<tag前缀>|<apt 工具列表>|<npm 全局包列表>`，
第二列走 apt-get install，第三列走 npm install -g，可留空），
直接编辑该文件即可动态增删工具，无需改动 Dockerfile。
每个 tag 同时提供对应的**版本号 tag**（版本号与构建时实际安装的 `@deepseek-ai/dsh` 版本一致，当前 `<版本>`）：

| tag（最新） | 版本 tag | 定位 | 包含工具 |
|---|---|---|---|
| `smanx/deepseek-harness:latest` | `smanx/deepseek-harness:<版本>` | 原版精简镜像，适合生产部署 | 无开发工具 |
| `smanx/deepseek-harness:devtools-min-latest` | `smanx/deepseek-harness:devtools-min-<版本>` | 精简工具版，常用调试工具 | git、curl、wget、nano、jq、procps、ca-certificates、unzip；npm 全局包：pnpm；uv |
| `smanx/deepseek-harness:devtools-latest` | `smanx/deepseek-harness:devtools-<版本>` | 完整工具版，可在容器内开发/编译 | 精简版全部 + vim、openssh-client、zip、htop、tmux、tree、openssl、python3、build-essential(make+g++)、bash-completion；npm 全局包：pnpm；uv |
| `smanx/deepseek-harness:test-latest` | `smanx/deepseek-harness:test-<版本>` | 测试 tag：完整工具 + 自动安装 DSH 插件 | 同完整工具版（含 pnpm、uv）；DSH 安装后额外执行 `dsh plugin --profile web add github:smanx/dsh-conversation-indicator#main` |
| `smanx/deepseek-harness:admin-latest` | `smanx/deepseek-harness:admin-<版本>` | 管理版：**预装最新 DSH**，开箱即用，管理台可自选版本安装/切换 | 同完整工具版（含 pnpm、uv）+ 管理服务；保留 python3/build-essential 供运行时编译 node-pty |

```bash
# 精简工具版（DEV_TOOLS=前缀与 .build-variants 第一列一致）
docker build -t smanx/deepseek-harness:devtools-min-<版本> --build-arg DEV_TOOLS=devtools-min .

# 完整工具版
docker build -t smanx/deepseek-harness:devtools-<版本> --build-arg DEV_TOOLS=devtools .
```

> GitHub Actions（`docker-build/.github/workflows/projects.yml`）按各项目目录下的 `.build-variants`
> 清单自动打包并推送全部 tag（Docker Hub 与 GHCR 各一组）。

> 完整工具版含 `python3` + `build-essential`，可在容器内直接编译原生模块（如 node-pty），
> 相当于把多阶段构建里 `dsh-builder` 阶段的编译工具也带进了运行镜像。
> 版本号随 `@deepseek-ai/dsh` 实际版本更新，例如升级到 `0.2.0` 后 tag 应改为
> `devtools-0.2.0` / `devtools-min-0.2.0`。

> 工具版（devtools / devtools-min / test）内置 **pnpm**（npm 全局安装），
> DSH 的 `dsh plugin` 命令依赖 pnpm 管理插件，社区插件市场 [dsh-market](https://github.com/dsh-market/dsh-market)
> （`dsh plugin --profile web add dshmarket`）也需要它；精简版 `latest` 不内置，首次使用插件时
> dsh-market 会检测缺失并提供一键自动安装。
>
> 工具版还内置 **uv**（Python 包管理器，静态二进制，不依赖系统 Python）。
> 不少社区 MCP server 以 `uvx` / `uv run` 方式启动（DSH 的 MCP 客户端配置中常见
> `"command": "uvx"`），缺少 uv 时这类 MCP 无法运行；uv 会在首次使用时按需下载 Python 解释器。

### admin 变体（管理版，预装最新 DSH）

`admin` 变体**随镜像预装最新 DSH（@next）**，容器启动后管理服务自动识别并拉起 DSH，直接访问 `/` 即可进入 DSH 界面；
访问 `/__admin/` 进入管理台，你可以在页面上：

- 查看 npm 包 `@deepseek-ai/dsh` 的可用版本（`latest`/`next` 等 dist-tag + 全部版本列表），
  选择并**安装 / 切换** DSH 版本，安装进度实时显示；
- 手动配置 **npm 源（NPM_CONFIG_REGISTRY）**：输入框会**自动回显默认值**（环境变量
  `NPM_CONFIG_REGISTRY` 或官方源 `https://registry.npmjs.org/`）与**上次配置的值**，
  并显示当前生效值，可一键「使用默认值」或清空恢复默认；
  优先级：**页面配置 > 环境变量 `NPM_CONFIG_REGISTRY` > 默认值**；
- 一键**重启** DSH；安装完成后 DSH 自动启动，页面右下角悬浮「⚙ 管理」按钮可随时回到管理台调整版本。

启动命令（需要两个命名卷：`dsh-data` 保存 DSH 配置/会话、`dsh-install` 保存 DSH 安装文件与配置状态，
容器重建后升级/源配置依然有效）：

```bash
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  -v dsh-install:/opt/dsh \
  --restart unless-stopped \
  smanx/deepseek-harness:admin-latest
```

> admin 变体保留了 `python3` + `build-essential`：node-pty 在 Linux 上没有预编译产物，
> 在管理台安装其他版本 DSH 时需要容器内从源码编译原生模块，因此该镜像比精简版略大。
> admin 变体预装最新 DSH，版本号 tag 即为 DSH 版本（如 `admin-0.1.1`）。

## 端口配置

源端口（DSH）和代理端口（对外）都可通过环境变量配置，默认值：

| 环境变量 | 含义 | 默认值 |
|---|---|---|
| `DSH_PORT` | 源端口：DSH 监听（容器内 `127.0.0.1`） | `3079` |
| `PROXY_PORT` | 代理端口：代理对外监听（局域网入口） | `3080` |

> 两者必须不同（同一端口只能被一个进程监听）。

admin 变体另有以下环境变量：

| 环境变量 | 含义 | 默认值 |
|---|---|---|
| `NPM_CONFIG_REGISTRY` | admin 管理页「npm 源」的默认值（页面未配置时使用；优先级低于页面配置） | `https://registry.npmjs.org/` |
| `DSH_INSTALL_DIR` | admin 变体中 DSH 的安装目录（页面安装的 DSH 及状态文件都在这，建议挂载命名卷） | `/opt/dsh` |

例如改为「DSH 内部 3082、代理对外 3080」：

```bash
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  -e DSH_PORT=3082 \
  --restart unless-stopped \
  smanx/deepseek-harness
```

## 访问

- 本机：`http://127.0.0.1:3080/`
- 局域网：`http://<服务器局域网IP>:3080/`（如 `http://192.168.1.100:3080/`）
- WebSocket 实时通道由代理自动转发（`/api/events.mux`、`/api/events.host`）

## Basic Auth（可选）

在启动前设置环境变量，两个都设置才启用认证：

```bash
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  -e PROXY_USERNAME=yourname \
  -e PROXY_PASSWORD=yourpass \
  --restart unless-stopped \
  smanx/deepseek-harness
```

- 认证对 HTTP 和 WebSocket 都生效；未通过认证返回 `401` + `WWW-Authenticate`，
  浏览器会弹出认证框；
- 不设置（或只设置一个）则完全放行，无需认证；
- 公开静态资源 `/manifest.webmanifest`、`/favicon.svg`、`/favicon.ico` 不参与认证
  （只含应用名/图标等非敏感数据）。浏览器抓取 `<link rel="manifest">` 时不会携带
  Basic Auth 凭据，若强制认证，控制台会持续报 `/manifest.webmanifest` 401。

## 数据持久化

DSH 的会话/配置数据保存在命名卷 `dsh-data`（本 fork 容器内为 `/home/node/.dsh`，因镜像以 `USER node` 运行；上游原版为 `/root/.dsh`）。
`docker stop/start` 与删除容器后卷仍在，数据不丢；彻底清除需先停容器再 `docker volume rm dsh-data`。

## 说明

- DSH 官方禁止 `--host 0.0.0.0`，因此容器内 DSH 保持默认回环监听，代理负责对外；
- 若 `node:24-slim` 下 DSH 因缺少系统库启动失败，可将 Dockerfile 两个阶段的基础镜像都改为 `node:24` 再构建；
- 代理逻辑与独立版 [dsh-proxy](https://github.com/smanx/dsh-proxy) 一致（polyfill 注入、Origin 对齐、Basic Auth、WS 转发）。
- DSH 前端用 `connection.isLoopback` 决定设置类功能是否可用（设置里的插件配置卡片、设置文件按钮等），
  且只把 `localhost`/`127.x.x.x` 等回环主机名算作 loopback。通过主机名/局域网 IP 访问时这些功能会被隐藏
  （例如「插件配置」页从 3 个卡片变成空列表）。代理在转发 JS 时把
  `isLoopbackHostname(pageLocation.hostname)` 判定改写为恒真，使局域网访问也能正常使用设置功能。
