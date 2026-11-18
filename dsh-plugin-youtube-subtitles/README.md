# dsh-plugin-youtube-subtitles

YouTube 字幕抓取 · 无字幕视频本地语音转字幕 —— DSH 插件。

给 DSH 的 Agent 新增四个工具：抓已有字幕、用本地小模型把语音转成带时间轴的字幕、依赖管理、自我清理。
**语音识别全程在本机 CPU 完成，音频不上传任何云端。**

---

## 设计原则

这三点决定了插件的所有行为，也是它与众不同的地方：

**1. 自包含 —— 插件是独立个体**

模型与二进制全部放在插件自己的数据目录：

```
$DSH_HOME/plugins-data/dsh-plugin-youtube-subtitles/
├── models/
│   ├── small/            # 轻量档模型（74MB）
│   ├── full/             # 全能档模型（239MB，按需）
│   └── silero_vad.onnx   # 时间轴分段用（636KB）
└── bin/                  # 插件自带的 yt-dlp / ffmpeg（按需）
```

**不写** `$DSH_HOME/models`（那是 DSH 内置语音插件的共享目录），
**不写** `/usr/local/bin`（那是系统位置）。装载不影响系统，卸载不留垃圾。

**2. 不自动下载 —— 把磁盘决定权交给用户**

模型最小 74MB、最大 239MB，二进制 82MB（yt-dlp 3MB + ffmpeg 79MB）。静默下载会让工具调用长时间无响应，
也剥夺用户的决定权。所以缺失时工具**返回可选项**，由用户选档位后再显式安装。

**3. 可完全清理（含反安装）**

`youtube_subs_purge` 只删插件自己那一棵目录树，并明确保护系统文件；数据目录不在
`plugins-data` 下、末段又不是插件目录名时直接拒绝（见「卸载与清理」）。

在 Web GUI 的插件面板里**卸载**本插件时，插件被销毁的瞬间会登记一次延迟清理：
确认 profile 的 `dependencies` 里已没有本插件（= 真卸载，而不是关掉开关）之后，
自动删除 `$DSH_HOME/plugins-data/dsh-plugin-youtube-subtitles` —— **模型、yt-dlp、
ffmpeg、临时文件一并消失**，不留死文件。

若 `dataRoot` 被指到用户自己的目录，则只删其中的 `bin/`（yt-dlp、ffmpeg）与
`models/`（模型 + VAD）两个子目录，同目录下其它文件原样保留。

> 为什么不能「一销毁就删」：**禁用**插件与**卸载**插件都会销毁插件实例，
> 但禁用只是关掉开关，用户随时会再打开——如果那时就把 74/239MB 模型删了，
> 等于关一次开关重新下载一次。所以清理必须等到包真的从依赖里消失。
>
> 用 `dsh plugin remove`（命令行）卸载时，pnpm 只是删目录，**不会加载插件**，
> 清理钩子没有机会运行。这条路径请先在会话里说「清理 YouTube 字幕插件的数据」
> 调 `youtube_subs_purge`，再执行卸载；或卸载后手动删除上面那个目录。

---

## 能做什么

| 工具 | 用途 | 依赖 |
|---|---|---|
| `youtube_transcript` | 抓取视频**已有**字幕（人工优先／自动兜底），输出 text / srt / vtt / json | **零依赖** |
| `youtube_transcribe` | 对**没有字幕**的视频下载音频并本地识别，产出带时间轴字幕 | 模型 + yt-dlp + ffmpeg |
| `youtube_subs_status` | 查看依赖状态、按需安装模型与二进制 | 无 |
| `youtube_subs_purge` | 删除插件自己的全部数据（卸载前清理） | 无 |

---

## 模型档位

实测环境：4 核 CPU（i5-7200U）/ 7.8GB 内存 / 无 GPU，`numThreads=4`。
测试素材为 38 分 42 秒的真实中英混合视频（中文主讲 + Tom Lee / ETH / ETF 等英文专名）。

| 档位 | 磁盘 | 下载 | RTF | 中文 | 英文词错误率 | 英文专名 | 标点 | 语言 |
|---|---|---|---|---|---|---|---|---|
| **`small`（默认）** | **74 MB** | 78 MB | **0.029** | 准确 | **54.35%** | 差（44.9%） | ✗ | 中、英 |
| `full` | 239 MB | 239 MB | 0.071 | 准确 | **37.44%** | 好（64.1%） | ✓ | 中、英、粤、日、韩 |

> RTF 越小越快（< 1 表示快于实时）。同一段 38 分钟音频：`small` 约 67 秒、峰值内存 534MB；
> `full` 约 165 秒、峰值内存 772MB。**`small` 快约 2.5 倍、省约 1.45 倍内存。**

**选 `small`**：**只适合纯中文内容**，追求速度与省空间。输出无标点（分句靠时间轴分隔，可读性仍好）。

**选 `full`**：中英混合、纯英文、需要标点、或需要粤语／日语／韩语。

### 轻量档的英文到底有多差（实测，可复核）

结论：**轻量档并非不输出英文，而是英文准确率低到不可用**。数据来自同一段 38 分钟真实视频，
按 30 秒窗口聚合、以 YouTube 英译轨为参照、只统计英文原声区间（2815 个参考词）：

| 指标 | `small` | `full` | 差距 |
|---|---|---|---|
| 英文词错误率（WER） | **54.35%** | **37.44%** | 17 个百分点 |
| 纯英文连续段落 WER | 51.46% | 33.94% | 17.5 个百分点 |
| 英文专名命中率 | 44.9%（70/156） | 64.1%（100/156） | 19.2 个百分点 |
| `Ethereum`（51 次） | 26 次 | 48 次 | — |
| `Fidelity`（2 次） | 0 次 | 2 次 | — |

具体失真形态（`small` 的真实输出）：

| 正确 | `small` 输出 | 性质 |
|---|---|---|
| Ethereum | `以太网` / `以太而` / `a therium` / `thetheum` | 汉字化，语义跑偏（以太网 ≠ 以太坊） |
| BitMine | `mind`（12 次）/ `bit mine` / `bit minine` | 退化成常见英文词 |
| Tom Lee | `tom 莉` / `tom y` | 中英混杂 |
| ETF | `e t f` | 拆成字母 |
| crypto bull | `criptobal` | 连读粘连 |
| BlackRock | `black rub` | 音近词 |
| Fidelity | `peatality` | 音近词 |
| non-humans | `男 humans` | 英文词听成汉字 |

`full` 在这些位置大多能保留原形（`Ethereum` / `ETF` / `Fidelity` / `Black rock`），
并且输出带标点、数字用阿拉伯数字（ITN），下游可直接检索。

> 注意：`small` 是 Paraformer 中文模型（`sherpa-onnx-paraformer-zh-small`），
> 官方定位就是中文语音识别。它能勉强输出英文字母序列，但那是「按音找最近的英文词」，
> 不是真正的英文识别，**调参补不回来**。

> 逐条对照（10 个时间窗的 ref / 两模型并排输出）是这次量测的工作底稿，未随仓库分发；
> 上表是聚合结果，可用同一段素材跑 `youtube_transcribe` 复现。

> `full` 用的是 SenseVoice-small 的 **int8** 权重（239MB），从 HuggingFace 单文件下载。
> 官方 GitHub tar 包里只有 fp32（563MB）、没有 int8，所以不要改回那个地址。
>
> 另测试过 Whisper-tiny（244MB，RTF 0.059）：**体积与 `full` 相当，但准确率明显更差**
> （把「守着他爸爸」听成「手的他爸爸 川普布林」），已淘汰，不提供为选项。

### 为什么默认不装

74MB 虽不大，但插件无法预知用户是否需要语音转字幕——
很多人只用「抓已有字幕」这一个零依赖功能。因此装好插件后**立即可用抓字幕**，
只有真正需要语音转字幕时才引导安装模型。

---

## 安装

### 1. 安装插件

```bash
dsh plugin --profile web add /绝对路径/dsh-plugin-youtube-subtitles
```

安装后**需要重启 DSH**：新增 bundle 只有重启才会并入组合。

重启后 `youtube_transcript`（抓字幕）**立刻可用**，无需任何其他准备。

### 2. 需要语音转字幕时

直接对 Agent 说：

```
帮我把这个视频转成字幕：https://youtu.be/xxx
```

Agent 会调用 `youtube_transcribe`，若依赖缺失则返回选项。你也可以主动说：

```
安装 YouTube 字幕插件的轻量模型和 yt-dlp、ffmpeg
```

Agent 会调用 `youtube_subs_status` 完成安装，全部装进插件自己的目录。

**对话式示例**：

| 你说 | 发生什么 |
|---|---|
| 检查 YouTube 字幕插件状态 | 列出档位与依赖可用性 |
| 安装轻量模型 | 下载 74MB 到插件目录 |
| 安装全能模型（带标点） | 下载 239MB |
| 顺便装 yt-dlp 和 ffmpeg | 下载到插件自己的 `bin/`，不动系统 |

### 3. 卸载与清理

卸载会删掉**插件自己装的一切**：语音识别模型（含 VAD）**以及 yt-dlp、ffmpeg 这两个二进制**。
不会留下任何死文件。

**Web GUI 卸载（推荐）**：插件面板里移除本插件即可，上面这些东西自动清除（见「设计原则 3」）。

**命令行卸载**：pnpm 移除不会触发插件清理，先清理再卸载——

```
清理 YouTube 字幕插件的数据
```

Agent 会**先预览**，逐项列出将删除的内容与各自体积：

```
binaries: { path: .../bin,  occupiedMB: 83,   note: '插件下载的 yt-dlp / ffmpeg 会一并删除' }
models:   { path: .../models, occupiedMB: 74.6 }
```

确认后才删除；随后再执行：

```bash
dsh plugin --profile web remove dsh-plugin-youtube-subtitles
```

若已用命令行卸载、数据仍残留，直接删目录（`bin/` 与 `models/` 都在这一棵树下）：

```bash
rm -rf "$DSH_HOME/plugins-data/dsh-plugin-youtube-subtitles"
```

**清理前的路径护栏**：`youtube_subs_purge` 只接受两种数据目录——
`<DSH_HOME>/plugins-data/` 之下，或末段名为 `dsh-plugin-youtube-subtitles` 的目录。
其它路径（工作区、`$DSH_HOME/sessions`、`storages`、`plugins-data` 本身、相对路径……）
一律拒绝，并把原因原样回给你，不会静默删除。

> 为什么要这么严：purge 是递归删除，而 `dataRoot` 是可配置项。只挡几个「已知危险路径」
> 挡不住误填——把 `dataRoot` 指到工作区或 `$DSH_HOME/sessions`，一次 `confirm` 就是
> 不可恢复的数据丢失。自定义目录请把末段命名为 `dsh-plugin-youtube-subtitles`。

**清理范围（明确不碰的）**：

| 位置 | 处理 |
|---|---|
| `<dataRoot>/bin/`（yt-dlp、ffmpeg） | **删** |
| `<dataRoot>/models/`（模型 + VAD） | **删** |
| 系统 PATH 上的 yt-dlp / ffmpeg | 不碰——可能是你手动装的、别的程序也在用 |
| `$DSH_HOME/models`（DSH 内置语音插件的共享模型） | 不碰 |

> 如果配置里用 `ytdlpPath` / `ffmpegPath` 指向了**外部**路径（例如你系统里已有的 ffmpeg），
> 那两个文件不属于插件，卸载时**不会**删除——插件只清自己下载到 `bin/` 下的副本。

**自定义 `dataRoot` 的情况**：如果 `dataRoot` 指向你自己的目录，卸载时只删其中的
`bin/` 与 `models/` 两个子目录，同目录下的其它文件原样保留。
显式 `youtube_subs_purge` 则只对末段名为 `dsh-plugin-youtube-subtitles` 的自定义目录生效。

---

## 使用

```
把 https://www.youtube.com/watch?v=xxx 的字幕提取出来，存成 SRT
这个视频没有字幕，帮我做一份中文转写：https://youtu.be/xxx
列出这个视频有哪些语言的字幕：https://youtu.be/xxx
```

### 工具参数速查

**`youtube_transcript`**

| 参数 | 说明 |
|---|---|
| `url`（必填） | 视频地址或 11 位 ID；支持 watch / youtu.be / shorts / embed |
| `lang` | 期望语言，默认 `zh-Hans` |
| `format` | `text` / `srt` / `vtt` / `json`，默认 `text` |
| `preferManual` | 默认 `true`（人工字幕优先） |
| `outputPath` | 可选，结果写入指定绝对路径 |
| `listOnly` | 只列字幕轨，不下载内容 |

**`youtube_transcribe`**

| 参数 | 说明 |
|---|---|
| `url`（必填） | 同上 |
| `lang` | `auto` / `zh` / `en` / `yue` / `ja` / `ko`，默认 `auto`（`small` 档仅中/英） |
| `format` | 默认 `srt` |
| `outputPath` | 可选，字幕写入指定绝对路径 |
| `maxDurationSeconds` | 可选，只处理前 N 秒 |

**`youtube_subs_status`**

| 参数 | 说明 |
|---|---|
| `setTier` | `small` / `full` 切换当前档位（只改选择，不下载）；`config` 清除对话式切换 |
| `installTier` | `small` / `full`，安装模型档位 |
| `installBinaries` | `["ytdlp", "ffmpeg"]`，安装二进制到插件目录 |
| `removeTier` | `small` / `full`，删除该档位已下载的模型（保留 VAD 与另一档位） |
| `removeBinaries` | `["ytdlp", "ffmpeg"]`，删除插件目录里的程序副本（不碰系统 PATH） |

界面上的「已下载的模型」区块也提供删除，且带二次确认；两个入口删的是同一批文件。

**`youtube_subs_purge`**

| 参数 | 说明 |
|---|---|
| `confirm` | 缺省仅预览；`true` 才真正删除 |

---

## 配置

### 界面上改（推荐）

打开 **设置 → 插件 → YouTube 字幕**，卡片上可以直接改：

| 字段 | 说明 |
|---|---|
| 模型档位 | 分段按钮切换 `small` / `full`，保存后立即生效（下次识别时按新档重建引擎） |
| 推理线程数 `numThreads` | 1–32，默认 4，建议不超过物理核心数 |

这两个字段在插件里标成了 `volatile`：修改后**不会重载插件**，也不会丢已加载的模型缓存键。
其余字段（数据目录、二进制路径、client 版本）设计上不放进界面，避免误改导致数据被清或路径失效。

> 档位有三条设置路径，优先级从高到低：**对话式切换**（`youtube_subs_status` 传 `setTier`，
> 立即生效、不下载）> **本页/配置文件** 的 `tier` > 内置默认 `small`。
> 对话式切换会把「发起时的配置档位」一起记进 `<dataRoot>/tier-override.json`；一旦这里或
> `cordis.patch.yml` 改了档位，覆盖自动失效。卡片会标出来源并提供「恢复配置值」按钮，
> 也可以在对话里传 `setTier: "config"` 清除。

卡片下方还有一块 **「资源管理」**，分两组，每项都能单独下载或删除：

**语音识别模型**

| 状态 | 界面显示 | 可做的操作 |
|---|---|---|
| 未下载 | 「未下载」 | 「下载」按钮（后台任务，带进度） |
| 已下载 | 实际占用体积 + 「当前使用」标记 | 「删除」→ 再点「确认删除？」 |

**依赖工具（yt-dlp / ffmpeg）**

这一组回答「到底装没装、装在哪」，四个来源分别标注：

| `source` | 含义 | 界面 |
|---|---|---|
| `bundled` | 插件自己下载的，在 `<dataRoot>/bin/` | 「插件目录」+ 体积，可删除 |
| `system` | 系统 PATH 上找到的 | 「系统 PATH」，不提供删除（不是插件的） |
| `configured` | 配置里 `ytdlpPath` / `ffmpegPath` 指定的 | 「配置指定」，不提供删除 |
| `missing` | 都没有 | 「缺失」+ 「下载」按钮 |

> 为什么区分来源而不是只报「有/没有」：用户需要知道删掉插件自带的那份之后，
> 是否还有系统版本可用。只删 `bundled` 的，删完会自动回落到 `system`。

下载走**后台任务 + 轮询**：点击后立即返回，卡片每 800ms 查一次进度，完成后自动刷新状态。
这样几十秒的下载不会把界面卡住，也不会撞上中间层超时。

### 写配置文件

在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: youtube-subtitles
  name: dsh-plugin-youtube-subtitles
  config:
    dataRoot: /data/my-yt-plugin    # 自定义数据目录
    tier: full                       # 用全能档模型
    numThreads: 4
    defaultLanguage: auto
    # ytdlpPath / ffmpegPath: 想改用系统版本时显式指定
    # clientVersion: YouTube 抓取失败时调整
```

所有字段可省略。想用系统的 yt-dlp／ffmpeg 而不装插件自带的，
直接配置 `ytdlpPath` / `ffmpegPath` 指向即可（显式配置优先级最高）。

> 注意：`dataRoot` 改成非默认路径后，**卸载时不会自动删除**该目录（避免误删用户数据）。
> 这类自定义目录请自己管理，或用 `youtube_subs_purge` 显式清理。

---

## 依赖清单与体积

| 项目 | 用途 | 体积 | 是否必需 |
|---|---|---|---|
| 模型 `small` | 语音识别 | 74 MB | 仅语音转字幕 |
| 模型 `full` | 语音识别（带标点/多语言） | 239 MB | 仅语音转字幕 |
| silero_vad.onnx | 时间轴分段 | 636 KB | 仅语音转字幕 |
| yt-dlp | 下载音频 | 3 MB | 仅语音转字幕 |
| ffmpeg | 转 16kHz 单声道 WAV | 79 MB | 仅语音转字幕 |
| **抓已有字幕** | | **0** | — |

**最省配置**：只用抓字幕功能 → **0 额外空间**。
**语音转字幕最省**：`small`(74) + yt-dlp(3) + ffmpeg(79) + VAD(0.6) ≈ **157 MB**，实测落盘 164.3 MB。

---

## 技术实现要点

以下结论均来自本机实测，是插件能稳定工作的关键，改动前请留意。

### 字幕抓取：靠 InnerTube 的 ANDROID client

决定成败的不是「用哪个库」，而是「用哪个 client」：

| client | 结果 |
|---|---|
| `WEB` | ❌ `UNPLAYABLE`，无字幕轨 |
| `TVHTML5` | ❌ `UNPLAYABLE`，无字幕轨 |
| **`ANDROID`** | ✅ 正常拿到全部字幕轨 |

因此插件用 Node 内置 `fetch` 直连 `/youtubei/v1/player`，
**不需要** yt-dlp、ffmpeg、Playwright、PO Token 或代理就能抓字幕。

两个反直觉的坑：

1. **HTTP 200 不代表成功**。缺正确 client 上下文时，timedtext 返回 `200`
   但 body 长度为 0（`server: video-timedtext`）。只判断 `res.ok` 会静默拿到空字幕。
2. **`fmt` 必须替换而非追加**。ANDROID 的 baseUrl 已内置 `fmt=srv3`，
   追加 `&fmt=json3` 无效（仍返回 srv3 XML）。

### 语音识别：VAD 分段提供时间轴

识别模型是整段非流式推理，本身不给分段边界。插件用 Silero-VAD 先切出语音段、
逐段识别，**段边界即字幕时间轴**——这是生成 SRT 的关键。

四个真实的坑（已在代码注释标注）：

1. `readWave` **只接受 16kHz 单声道 WAV**。喂 48kHz 立体声会静默只取第一声道，
   准确率崩塌（RTF 从 0.200 恶化到 0.544，结果错误）。
2. `Vad.pop()` 返回 `undefined`，必须「先 `front()` 再 `pop()`」；判断用 `isEmpty()`。
3. 分段对象**只有 `{start, samples}`，没有 `end`**；且
   **`start` 的单位是样本数，不是秒**（实测 11872 样本 = 0.742 秒）。
   漏掉换算会得到「306784 秒」这种荒谬时间轴。
4. 模型文件缺失时原生层只打印警告不抛错，之后调用变成静默空操作。必须提前校验。
5. SenseVoice 的 `language` 是**加载期参数**，不是每次调用能改的开关；换语言必须
   重建引擎（插件按 `档位:语言` 缓存）。`auto` 偶尔会把中文段落误判成日语（冒出
   「あ。」这种句子），所以识别中文时显式传 `lang: "zh"` 更稳。

### 为什么不 import `@deepseek-ai/*` 包

插件代码通过 link 安装时位于工作区，Node 模块解析链到不了 DSH 安装目录。
这几个陷阱都踩过并修正：

**陷阱 1：`import '@deepseek-ai/dsh-tools'` → 插件完全不激活**

加载期抛 `MODULE_NOT_FOUND`，表现为插件面板报 **"failed to import"**。
修法：工具定义由 `src/toolkit.js` 自行构造（形状与 registry 契约一致）。

**陷阱 2：`Config` 写成普通对象 → 启动时报错**

```js
// ❌ 错误：启动时抛 TypeError
export const Config = { tier: { type: 'string' } }

// 报错原文：
//   TypeError: Cannot read properties of undefined (reading 'validate')
//   at resolveConfig (.../cordis/lib/index.js:958)
//   dsh: warning: 1 entry did not activate
```

cordis 的 `resolveConfig` 会调用 `Config['~standard'].validate(config)`。
`~standard` 是 [Standard Schema](https://standardschema.dev) 接口，
普通字面量没有它，所以读到 `undefined.validate` 直接抛错。

**陷阱 3：`import '@deepseek-ai/schemastery'` → 同样解析失败**

要让设置面板出现表单，`Config` 还得是「schemastery 形状」（带 `toJSON()`）。
最直接的做法是 `import { Schema } from '@deepseek-ai/schemastery'`，
但 link 安装下这个包同样解析不到。修法：`src/schema.js` 自己实现一个兼容层——
产出的 JSON 图能被真正的 schemastery `new Schema(json)` 完整重建（已用 DSH 自带
的 schemastery 反向验证过），同时给出 `~standard.validate`。

```js
import { createConfig, object, number, union } from './schema.js'

export const Config = createConfig(object({
  tier: union(['small', 'full'], { default: 'small', volatile: true }),
  numThreads: number({ step: 1, min: 1, max: 32, default: 4, volatile: true }),
}))
```

`validate` 同步返回 `{ value }` 或 `{ issues: [{ message, path }] }`。

> 注意：`Config` **可以省略**（省略即不校验）。但一旦声明，就必须是合规校验器——
> 写普通对象比不写更糟，会让整个插件无法激活。

---

### 设置界面：为什么还要一个 `client.js`

DSH 的 Web GUI **没有**「按 Config schema 自动渲染表单」的实现。设置面板要出现
插件卡片，三个条件缺一不可：

1. `Config` 有 `toJSON()`（schemastery 形状）——**且每个子节点也必须自带 `toJSON()`**；
2. 至少一个字段标了 `volatile: true`（只有 volatile 字段会进表单）；
3. 客户端插件往 **`plugins.bundle.config`** 插槽注册了卡片组件（key = 包名）。

第 1 条有个容易踩的坑：`dsh-settings` 的 `volatileForm()` 会为**每个带 `volatile` 的字段
单独**调用 `plainSchema(child)`，里面第一句是 `new Schema(schema.toJSON())`。如果只给根节点
加 `toJSON()`，子节点被单独访问时就会抛 `schema.toJSON is not a function`，把**整个设置页**
打崩（不只是本插件的卡片）。`src/schema.js` 的 `node()` 因此让每个节点都自带 `toJSON()`，
回归测试见 `test/schema-guard.mjs`。

第 3 条就是 `src/client.js` 存在的理由。它是**给浏览器直接执行的普通脚本**，
不是 ESM 模块：必须整体包在 `window.__ModuleLoader__.load({ id, factory })` 里，
`id` 必须精确等于包名，React 和 UI 组件从平台种子表 `require()` 取得。
`package.json` 里对应的两处声明：

```json
"exports": { "./client": "./src/client.js" },
"dsh": { "client": { "platform": "web", "inject": [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-plugin-manager"
] } }
```

注意 `dsh.client.inject` 里写的是**包名**（只决定 bundle 加载顺序），而客户端插件自己
`exports.inject` 里写的是 **Cordis 服务名**（`slots` / `locale` / `configForms` /
`connection`），两者不能混。

**插槽别选错**：`plugins.item` 是官方设置页专用的（`slot-contract.d.ts` 里写明
「a bundle's configuration belongs in `plugins.bundle.config` or `plugins.row.config`
instead」）。第三方 bundle 必须用 `plugins.bundle.config`，`key` 写包名，页面会用
`renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })` 来取。
用错插槽的表现是**插件详情页里什么都不显示，控制台也不报错**，极难排查。

`configForms.get()` 的入参是 settings 命名空间，也就是 `cordis.patch.yml` 里那个
`id: youtube-subtitles`，两边必须一致，否则拿不到 config form。

`plugins.bundle.config` 只在插件详情页渲染、`view` 恒为 `'page'`，所以卡片里不需要
`view === 'summary'` 分支。

#### 卡片上的按钮怎么调用 host

「删除已下载的模型」需要在浏览器里触发 node 侧的文件删除。走的是 **Connection 通用 RPC**，
不需要自己起 HTTP 服务、也不引入任何 `@deepseek-ai/*` 依赖：

```js
// host（src/index.js）：通道名必须匹配 /^\/[A-Za-z0-9._~-]+$/，且不能是 /api
ctx.get('connection').rpc.handle('/youtube-subtitles', async (endpoint, payload) => {
  if (endpoint === 'deleteModels') return { ok: true, value: await removeTier(rt.dataRoot, payload.tier) }
  return { ok: false, error: { code: 'not-found', message: `未知端点：${endpoint}`, details: {} } }
})

// client（src/client.js）
const r = await ctx.connection.rpc.call('/youtube-subtitles', 'deleteModels', { tier: 'full' })
if (!r.ok) throw new Error(r.error.message)   // 业务失败是 ok:false，不是抛异常
```

几个容易踩的点：

- `rpc.handle` 的 disposer 归属 connection 服务自己的 ctx，插件里要用 `ctx.effect` 显式
  持有并在卸载时释放，否则热卸载会残留路由；
- host 侧 handler 抛异常会变成 HTTP 500 且丢失错误细节，所以要自己 catch 成
  `{ok:false,error:{code,message,details}}`；
- 非 Web 载体（TUI / headless）没有 `connection`，注册要能优雅跳过。

---

## 目录结构

```
dsh-plugin-youtube-subtitles/
├── package.json           # bundle 清单
├── cordis.patch.yml       # 插入插件行
├── icon.svg
├── locale/{zh,en}.json    # 插件面板显示文案
└── src/
    ├── index.js           # 服务端入口：注册 4 个工具、配置、卸载清理
    ├── client.js          # 浏览器入口：设置 → 插件 里的配置卡片
    ├── schema.js          # 零依赖 schemastery 兼容层（配置 schema）
    ├── settings.js        # 对话式档位切换的覆盖记录与优先级判定
    ├── toolkit.js         # 零依赖工具定义构造器
    ├── youtube.js         # InnerTube 抓取 + SRT/VTT/Text 转换
    ├── media.js           # 二进制解析/安装、音频下载转码、清理与护栏
    └── asr.js             # 模型档位、下载安装、VAD 分段识别
test/
├── run-all.mjs            # npm test 入口
├── tool-schema.mjs        # 工具参数/输出 schema 子集校验
├── tool-registration.mjs  # 工具注册顺序（tools 服务先到 / 后到）
├── youtube-format.mjs     # SRT/VTT 时间戳边界与 JSON 数值整洁
├── schema-guard.mjs       # 设置页 schema 三道闸
├── purge-tool.mjs         # 清理工具 + 拒绝场景
├── tier-override.mjs      # 档位覆盖规则与工具链路
├── uninstall-purge.mjs    # 卸载清理矩阵
├── card-polling.mjs       # 设置卡片轮询
├── self-contained.mjs     # 自包含审计（需网络）
└── react-shim.mjs         # 测试用 React 替身
```

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 插件显示 "failed to import" | 插件 import 了 DSH 包。本插件已规避 |
| 启动报 `Cannot read properties of undefined (reading 'validate')` | `Config` 不是 Standard Schema 对象。用 `defineConfig()` 构造，或直接省略 `Config` |
| 工具未出现在列表 | 新增 bundle 需**重启 DSH** |
| 抓字幕报「视频不可播放（UNPLAYABLE）」 | YouTube 调整了 client 校验，改配置 `clientVersion` |
| 抓字幕返回空 | IP 被限流，稍后重试或换网络出口 |
| 语音转字幕报「模型尚未安装」 | 用 `youtube_subs_status` 选档位安装（会给出体积与特点）；若刚删过模型，重新安装即可 |
| 语音转字幕报「缺少必需程序」 | 用 `youtube_subs_status` 传 `installBinaries` |
| 识别结果与预期语言不符 | 显式指定 `lang`（如 `zh`），别用 `auto` |
| 唱歌曲识别差 | 音乐场景是 ASR 固有弱点，属正常 |
| 想省空间 | 用 `tier: small`；只抓字幕则完全不需要模型 |
| 设置 → 插件里看不到本插件卡片 | 确认已重启 DSH；卡片由 `src/client.js` 注册，缺 `exports["./client"]` 或 `dsh.client.platform` 时不会出现 |
| 装 `full` 档卡在下载或校验失败 | 模型来自 HuggingFace。网络不通时改用 `small`，或手动把 `model.int8.onnx` / `tokens.txt` 放进 `models/full/`（sha256 见 `src/asr.js`） |
| 中英混合识别把英文专名写错 | `small`（Paraformer）不保留英文原形，中英混合请切 `full`（SenseVoice） |

---

## 时效性风险

以下项最可能随上游变更而失效，插件已做成**配置项**而非硬编码：

- `clientVersion`（默认 `20.10.38`）—— YouTube 调整校验时需更新
- ANDROID client 免 PO Token 的状态 —— 官方可能收紧
- `fmt` 替换技巧 —— timedtext 接口行为可能变化
- `playabilityStatus: OK` —— 数据中心 IP 可能变 `LOGIN_REQUIRED`

字幕 baseUrl 带 `expire` 短时效签名，**不可缓存**，每次需重新请求 player。

---

## 调研报告

技术选型基于两份实测调研报告，位于上级目录 `research/`：

- [youtube_captions.md](../research/youtube_captions.md) —— 字幕抓取方案
  （各 client 实测矩阵、yt-dlp、youtube-transcript-api、youtubei.js、Data API v3 逐一裁决）
- [speech_to_text.md](../research/speech_to_text.md) —— 语音转文字方案
  （模型对比表、whisper.cpp / faster-whisper / SenseVoice / Parakeet / Transformers.js 选型依据）

---

## 变更记录

### 1.6.4

卡片点「下载」报
`EXDEV: cross-device link not permitted, rename '/tmp/dsh-yt-bin-…/dl' -> '<dataRoot>/bin/yt-dlp'`。

- 根因：下载临时目录在 `/tmp`，插件数据目录在 `$DSH_HOME` 下，两者常是**不同挂载**
  （容器 overlay / 挂载的 home 卷）。`rename` 跨文件系统必然抛 `EXDEV`。
  v1.2.0 修过同类问题，1.5.0 重写安装流程时没保留这段兜底。
- 修法：抽出 `moveIntoPlace(from, to)` —— `rename` 遇 `EXDEV` 时回落为
  「复制到目标同目录的 `<target>.part` → 再 rename」。第二次 rename 位于同一文件系统，
  原子生效，不会留下半截可执行文件；其它错误（如 `EACCES`）原样抛出，不掩盖。
- 回归：`test/binary-install.mjs` 覆盖同文件系统、EXDEV 回落、非 EXDEV 不掩盖三条路径。

### 1.6.3

卡片「资源管理」报 `读取状态失败：transport failure … HTTP 405` 的最终修复（前两次方案均失败）。

失败路径留档，避免再走：

| 方案 | 结果 | 原因 |
|---|---|---|
| `connection.rpc.intercept('/api', …)` | ❌ 插件激活失败 | `/api` 只允许**一个**拦截器，已被 `dsh-api-gateway` 占用，再注册抛 `already has an interceptor` |
| `connection.rpc.handle('/youtube-subtitles', …)` + `inject(['connection','webServer'])` | ❌ 端点仍 405 | 内部 `owner.webServer.register` 的 owner 经 cordis traceable proxy 换成交付方 ctx，实测路由始终没挂上 |
| **`webServer.register({kind:'prefix', path})` + `inject(['webServer'])`** | ✅ 采用 | 只依赖 webServer 一个服务，没有中间层语义；与 v1.2.0 已被验证可工作的路径一致 |

实现要点：

- Host：自建 prefix 路由 `/youtube-subtitles/*`，POST + JSON，体限 64KB，GET 返回 405。
- Client：`fetch('/youtube-subtitles/<endpoint>', { method:'POST' })`，不再依赖 `ctx.connection`。
- 回归：`test/tier-override.mjs` 用假 `req`/`res` 真跑一遍 handler（含 GET 405 与清除覆盖）。

### 1.6.2

设置卡片的「资源管理」显示 `读取状态失败：transport failure for /youtube-subtitles/status: HTTP 405`。

- 根因：`connection.rpc.handle()` 内部会 `owner.webServer.register(route)`，而 owner 解析到
  的 ctx 在 Web 宿主上会抛 `cannot get property "webServer" without inject`；错误被子 fiber
  吞掉，通道从未挂载——请求落到静态回退，于是 405。插件与四个工具都正常，只有卡片受影响。
- 修法：`ctx.inject(['connection', 'webServer'], …)` —— **必须同时声明 `webServer`**。
  原因：cordis 的 traceable proxy 会把 `connection.rpc` getter 里的 `this.ctx` 换成交付方
  （我方的）ctx，于是 `owner.webServer.register(route)` 读的是**我的** ctx；少声明就抛
  `cannot get property "webServer" without inject`，被 fiber 吞掉后路由静默不挂。
  用真实 cordis 搭最小宿主验证：声明后 prefix 路由正确挂到 `/youtube-subtitles`。
- **走过的弯路（已回滚，勿再尝试）**：曾改用 `connection.rpc.intercept('/api', …)`。
  `/api` 是共享通道且只允许一个拦截器，`dsh-api-gateway` 已占用，再注册抛
  `already has an interceptor`，插件直接激活失败。`test/rpc-channel.mjs` 固化了这条结论。

### 1.6.1

安装到真实 profile 后暴露的两个激活问题（本地单测看不到），已修并补回归测试：

- **工具 schema**：输出 schema 由 `{ type: 'json' }` 改为 `{ type: 'object' }`。前者不在
  DSH 强制的 JSON Schema 子集内，注册工具时抛 `JsonSchemaError`，表现为
  「1 entry did not activate」。新增 `test/tool-schema.mjs`，用宿主自带
  `assertSupportedJsonSchema` 校验四个工具的参数与输出。
- **工具注册时机**：改为 `ctx.inject(['tools'])` 等依赖就绪后再注册。冷启动时本插件的行
  虽在 `tools` 之后声明，但服务提供是异步的；直接 `ctx.get('tools')` 会拿到 undefined 并
  静默跳过——症状是重启后 fiber `active`、四个工具全 `unknown tool`，手动重载又恢复。
  新增 `test/tool-registration.mjs` 覆盖「服务先到 / 服务后到」两种顺序。
- **JSON 时间轴浮点噪音**：`start + duration` 会产出 `21.880000000000003`。JSON 输出统一
  规整到三位小数（`toSrtTime` 的 `,1000` 边界本就已修）；新增 `test/youtube-format.mjs`。

### 1.6.0

以 1.5.0 为基线，按评审结论补强：

**安全**

- `assertPurgeable()` 换回严格护栏：只允许 `<DSH_HOME>/plugins-data/` 之下，或末段为
  `dsh-plugin-youtube-subtitles` 的目录。`$DSH_HOME/sessions`、`storages`、工作区路径、
  相对路径一律拒绝；不安全的路径在预览阶段就返回 `ok:false / safe:false + reason`，
  `confirm` 也不会删。
- 拆成 `checkPurgeable()`（返回判定，供工具回话）与 `assertPurgeable()`（抛错版，供内部）。

**能力**

- `youtube_subs_status` 恢复 `setTier`：`small` / `full` 立即生效、不下载；`config` 清除
  对话式切换。切换记录写在 `<dataRoot>/tier-override.json`，配置档位一改动即自动失效，
  不会出现「界面改了没反应」。
- 状态输出新增 `configTier` / `tierSource` / `tierOverride` / `staleOverride` / `changeTierHint`。
- 设置卡片在覆盖生效时标出来源，并提供「恢复配置值」按钮（RPC `clearTierOverride`）。

**测试**

- 所有测试改为相对路径导入，不再硬编码旧目录。
- `purge-tool` 增加 5 个拒绝场景（工作区、`sessions`、`plugins-data` 本身、`$DSH_HOME`、相对路径）
  与真实断言；`uninstall-purge` 改为逐格断言；`schema-guard` 在缺少 schemastery 时明确略过。
- 新增 `tier-override` 回归（规则 / 工具 / 失效 / RPC）与 `run-all` 汇总入口：
  `npm test`（离线）、`npm run test:network`（额外跑 self-contained，需下载约 160MB）。

**清理**

- 删除未使用的 `toolkit.defineConfig()`。
- 修掉 README 指向不存在的 `research/accuracy_zh_en.md` 的链接；补回变更记录与测试目录说明。

更早版本（1.5.0 及以前）的变更记录见 v1.2.0 副本的 README 与 git 历史。

---

## 许可

MIT
