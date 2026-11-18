# dsh-agent2sync（显示名 **Agent2Sync**）

把 **Agent2API** 网关的模型目录同步成 DeepSeek Harness 里的一个模型提供商。

装好之后，「插件」页会多出一张 **Agent2Sync** 卡片，上面有：

- **服务器** — Agent2API 网关的 OpenAI 兼容地址
- **API Key** — 网关 Key，存进 DSH 凭据（不回显、不落明文）
- **模型供应商名称** — 这个提供商在模型列表里的 id，与已有提供商重名时直接拒绝保存
- **同步时逐个测试模型** — 一个勾选框；勾上就让每个模型**做一道题**，答不对的不进清单
- **保存设置** / **同步模型列表** 两个按钮

同步是双向对齐的：网关新增的模型自动加入，网关已下线的模型自动删除。每个模型的
**上下文长度**、**是否支持思考**、**是否支持图片输入** 都按网关报的元数据写进去。

## 它做了什么

一次同步：

1. Host 侧向 `GET {baseURL}/models` 取目录（Host→网关没有 CORS 问题，Key 不过 wire）；
2. 过滤掉不能对话的模型（`kind: "image"` 的图像生成模型，如 `hy-image-3.5`、`llm_pic`）；
3. 把每个模型翻译成 `llm-pi-ai` 的模型画像：

   | Agent2API 字段 | DSH 字段 | 说明 |
   |---|---|---|
   | `id` | `id` | 必填 |
   | `name` | `name` | 与 id 相同则省略 |
   | `max_input_tokens` | `contextWindow` | 网关没报的留给路由级兜底 |
   | `supports_images` / `input_modalities` | `input` | 含 image → `[text, image]`，否则 `[text]` |
   | `supports_reasoning` | `reasoningEfforts` | true → `off/low/medium/high`；false → `false` |

4. 勾了「测试模型」时，逐个**出一道有标准答案的题**并判分（详见下节）；答不对的不进清单；
5. 用 `ctx.settings.mutate()` 写入 `providers.<供应商名称>`。写入路径精确到这一个
   provider，**同一段里你自己配的其它 provider 一个字节都不会被动到**；因为写的是整个
   provider 对象，`models` 数组天然被整体替换——「删旧增新」不需要额外逻辑。

## 「测试模型」测的是什么

不是发个 `ping` 看有没有回包——那只证明端点活着，网关套层壳也能过。这里让模型**真的解题**，
答对才留下：

| 题型 | 题目 | 标准答案 |
|---|---|---|
| 算术 | 计算 3 + 5 等于多少？ | `8` |
| 时间 | 一小时等于多少分钟？ | `60` |
| 字母 | 英文单词 banana 里一共有几个字母 a？ | `3` |

- 题目按模型序号轮换，一次同步就能覆盖三种题型
- 要求模型「只输出一个阿拉伯数字」，插件取回复里的第一个整数比对
- 输出预算默认 **1024 tokens**：实测思考模型解字母题要花约 280 tokens 在 reasoning 上，
  给 256 会被 `finish=length` 截断成空正文，从而把好模型误判成坏模型
- **失败会单独复判一次**（串行、预算翻倍到 2048）：并发挤占和预算临界都会造成偶发空正文，
  两次都不过才判定为不可用
- 结果里带每题明细（问了什么、期望多少、实际答了什么），命令行和界面都能看到

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-agent2sync
```

装完刷新 Web 页面。「插件」页里出现 **Agent2Sync** 卡片即成功。

首次装配时若该提供商还不存在，插件会自动建一次；之后都靠卡片上的按钮手动触发。

## 配置存在哪

| 内容 | 位置 | 说明 |
|---|---|---|
| 服务器地址、供应商名称 | `$DSH_HOME/profiles/web/agent2sync.json` | 卡片上改，重启后仍在 |
| 网关 Key | `$DSH_HOME/.credentials.yaml` 的 `AGENT2SYNC_API_KEY` | 走 DSH 凭据服务，**不进**上面那个 JSON |
| 提供商与模型列表 | `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `providers.<id>` | 走 DSH 设置写入，注释与并发保护都保留 |

> **网关地址与 API Key 都不预置默认值**：两者都属于部署差异，插件不猜。全新安装时卡片上这两项是空的，
> 填好并保存后才建提供商。若 provider 已经建过（例如重启后 patch 里的地址仍为空），插件会沿用 provider
> 里已写入的地址，不会要求你重填。

> 为什么不把设置也放进 `cordis.patch.yml`：那需要 schemastery 提供表单 schema，而 DSH 自带的
> schemastery 在 CLI 自己的 `node_modules` 下、插件从 profile 解析不到，于是这个插件在设置
> 系统里没有可写的表单。JSON 文件是同样可靠又免掉这层依赖的做法；provider 本身照旧写进
> patch 文档，DSH 正常加载。

## providerId 规则

供应商名称就是 `llm-pi-ai` 里的 provider id，是永久的：请求、会话、凭据引用都用它。

- 只允许小写字母、数字、点、下划线、连字符，且以字母或数字开头
- **不能与列表里已有的提供商重名**（卡片上即时提示并禁用保存，Host 侧二次校验）
- 改名会清掉旧 provider、按新 id 重建并自动重新同步

## patch 层可调项

`$DSH_HOME/profiles/web/cordis.patch.yml` 里本插件那一段：

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `agent2sync` | 初始供应商名称（之后以卡片保存的为准） |
| `providerDisplayName` | `Agent2API` | 模型选择器里显示的名字 |
| `baseURL` | *（空）* | 网关地址**没有默认值**，首次使用请在卡片里填写 |
| `apiKeyEnv` | `AGENT2SYNC_API_KEY` | 凭据引用名 |
| `piAiEntry` | `llm-pi-ai` | 写进哪个插件的配置段 |
| `routePath` | `/agent2sync/sync` | 端点路径，卡片按它调用 |
| `defaultContextWindow` | `128000` | 网关没报上下文长度的模型用这个兜底 |
| `requestTimeoutMs` | `20000` | 请求网关的超时 |
| `bootstrapOnLoad` | `true` | 首次加载时若 provider 不存在就自动建一次 |

## 端点

都只接受同源请求：

- `GET /agent2sync/sync?settings=1` — 读当前设置与状态（不碰网关、不写配置）
- `POST /agent2sync/sync?settings=1` — 保存设置，body `{ baseURL?, providerId?, apiKey? }`
- `GET /agent2sync/sync?status=1` — 只读状态
- `POST /agent2sync/sync` — 执行一次同步，body `{ verify?: boolean }` 控制是否先测试模型；
  返回 `{ total, fetched, excluded, added, removed, verification? }`

不开界面也能用：

```sh
# 看状态（baseURL 为空说明还没配地址）
curl -s http://127.0.0.1:3079/agent2sync/sync?status=1 | jq

# 配服务器地址 —— 换成你自己的网关地址
curl -s -X POST http://127.0.0.1:3079/agent2sync/sync?settings=1 \
  -H 'content-type: application/json' \
  -d '{"baseURL":"http://<网关主机>:3065/v1"}' | jq

# 配网关 Key（存进 DSH 凭据，不回显）
curl -s -X POST http://127.0.0.1:3079/agent2sync/sync?settings=1 \
  -H 'content-type: application/json' \
  -d '{"apiKey":"<你的网关 Key>"}' | jq

# 同步
curl -s -X POST http://127.0.0.1:3079/agent2sync/sync | jq
```

## 已知边界

- **测试模型会真的调用每个模型**：每模型一道题（默认 1024 tokens 预算），16 个模型约 8–15 秒（并发 6）。
  会消耗一些额度，不想花就把勾选框去掉；失败复判会让个别模型多打一次请求。
- **没有 Key 时自动跳过测试**：探测本身要 Key，而没 Key 的模型对话也调不通，所以此时照常同步、
  不阻断流程，结果里会写明「已跳过测试」。
- **全部模型都没通过时不动原配置**：这通常意味着 Key 或网关出了问题，此时宁可保留上一次的清单
  并报错，也不把 provider 清空。

- **图像生成模型不进列表**：`kind: "image"` 的模型没有上下文长度、不接工具调用，放进 chat
  选择器只会换来调用失败，所以按 `kind` 过滤。
- **`maxTokens` 不写**：Agent2API 的目录不报输出上限，插件不猜，交给 `llm-pi-ai` 的默认值。
- **网关报的元数据是声明不是探针**：模型声称支持图片而端点实际拒绝时，是网关在请求中拒绝。
- **重名模型各占一行**：目录里 `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg` 显示名
  相同，选择器里靠 id 区分。
- **改源码后要重载 DSH**：插件以 `link:` 方式安装时，DSH 的热更新只监听 profile 配置，
  不监听这个包的源码，改完要重启 Web 进程才生效。

## 测试

两套离线测试都不依赖 DSH 运行时：

```sh
node test/real-probe.mjs # 真实探测：读 DSH 凭据里的 Key，对每个模型发一次最小请求（写入只在内存）
node test/offline.mjs   # 服务端 108 项：映射、写入路径、增删 diff、幂等、设置读写字、重名拒绝、改名、端点防护
node test/client.mjs    # 客户端 62 项：ModuleLoader 契约、卡片注册、三块设置项、重名禁用保存、渲染分支
```

`offline.mjs` 会真的向网关发一次匿名目录请求；`client.mjs` 用一个最小 React 模拟器把
bundle 执行起来并展开渲染树。
