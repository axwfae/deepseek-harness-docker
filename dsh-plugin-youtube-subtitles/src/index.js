/**
 * dsh-plugin-youtube-subtitles —— YouTube 字幕抓取与无字幕语音转字幕。
 *
 * 四个 Agent 可调用工具：
 *   youtube_transcript   抓取已有字幕（人工优先，自动字幕兜底），零外部依赖
 *   youtube_transcribe   无字幕时下载音频并本地语音识别，纯 CPU
 *   youtube_subs_status  查看/安装依赖（模型、自带二进制）
 *   youtube_subs_purge   清理插件自己的全部数据（卸载前调用）
 *
 * 三条核心设计原则：
 *
 *  1. **自包含**：模型与二进制都放在插件自己的数据目录
 *     （$DSH_HOME/plugins-data/dsh-plugin-youtube-subtitles/），
 *     绝不写 $DSH_HOME/models 等共享位置，也不写 /usr/local/bin。
 *     插件是独立个体：装载不影响系统，卸载不留垃圾。
 *
 *  2. **不自动下载**：模型最小 74MB。静默下载会让工具调用长时间无响应，
 *     也剥夺用户对磁盘占用的决定权。缺失时返回可操作选项，由用户选档位后再下载。
 *
 *  3. **零 DSH 依赖**：不 import 任何 @deepseek-ai/* 包。bundle 通过 link 安装时
 *     插件代码在工作区，Node 解析链到不了 DSH 安装目录，import 会导致插件加载失败
 *     （"failed to import"）。工具定义由本地 toolkit.js 构造，形状与 registry 契约一致。
 *
 * 引擎选型（本机实测，4 核 / 无 GPU / 100 秒中文演讲）：
 *   Paraformer-small  74MB  RTF 0.044  轻量档（默认）：小、快、中文准，无标点
 *   SenseVoice       238MB  RTF 0.127  全能档：带标点，支持粤/日/韩
 *   Whisper-tiny     244MB  RTF 0.059  已淘汰：同体积下准确率明显更差
 */
import { join } from 'node:path'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { defineTool, jsonRender } from './toolkit.js'
import { createConfig, object, string, number, union } from './schema.js'
import { extractVideoId, getVideoInfo, pickTrack, fetchCues, formatCues } from './youtube.js'
import {
  resolveBinary, downloadAudio, makeWorkDir, installBinary, localBinary,
  purgePluginData, dirSize, BINARY_ASSETS, scheduleUninstallPurge, assertPurgeable,
  removeBinary, binaryStatus,
} from './media.js'
import {
  createEngine, readAudio, transcribeWithVad, checkTier, listTiers, installTier, removeTier,
  defaultDataRoot, tierDir, vadPathFor, binRoot,
  MODEL_TIERS, VAD_ASSET, DEFAULT_TIER, LANGUAGE_BY_TIER,
} from './asr.js'

export const name = 'dsh-plugin-youtube-subtitles'

/**
 * 插件配置。
 *
 * 必须是「schemastery 形状」的 schema 对象（带 `toJSON()` 与 `~standard.validate`）：
 *   - cordis 的 resolveConfig 调 `Config['~standard'].validate(config)`，缺了会在启动时
 *     抛 `TypeError: Cannot read properties of undefined (reading 'validate')`；
 *   - DSH 设置面板只列出「有 toJSON 且至少一个字段 volatile」的插件，缺了 `toJSON`
 *     或一个 volatile 字段都没有时，界面里看不到任何可配置项。
 * 两者都由本地 src/schema.js 以零依赖方式满足（不 import @deepseek-ai/schemastery，
 * 因为 link 安装时 Node 解析链到不了 DSH 安装目录）。
 *
 * volatile 语义：tier / numThreads 保存后不重载插件，引擎在下次识别时按新值重建；
 * 其余字段改动会重载插件（dataRoot 变更本就需要重新解析模型路径）。
 */
export const Config = createConfig(object({
  tier: union(['small', 'full'], {
    default: 'small',
    volatile: true,
    description: '模型档位：small=74MB 轻量（最快、中文准、无标点）；full=238MB 全能（带标点、支持中英日韩粤）',
  }),
  numThreads: number({
    step: 1,
    min: 1,
    max: 32,
    default: 4,
    volatile: true,
    description: '本地语音识别的 CPU 线程数，建议不超过物理核心数',
  }),
  dataRoot: string({
    description: '插件数据目录，默认 $DSH_HOME/plugins-data/dsh-plugin-youtube-subtitles',
  }),
  ytdlpPath: string({ description: 'yt-dlp 可执行文件绝对路径；留空则使用插件自带或系统 PATH' }),
  ffmpegPath: string({ description: 'ffmpeg 可执行文件绝对路径；留空则使用插件自带或系统 PATH' }),
  defaultLanguage: string({ description: '默认识别语言：auto / zh / en / yue / ja / ko' }),
  clientVersion: string({ description: 'InnerTube ANDROID client 版本号，YouTube 改版导致抓取失败时可覆盖' }),
}))

/**
 * 读取配置值。自定义 schema 不返回 cosmokit volatile ref，但这里仍兼容 `.get()`，
 * 以防宿主或其他加载路径把字段包装成响应式引用。
 */
function readConfig(value, fallback) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get() ?? fallback
  return value ?? fallback
}

/** 供工具共享的运行时状态。 */
function createContext(config) {
  const dataRoot = readConfig(config.dataRoot, '') || defaultDataRoot()
  return {
    config,
    dataRoot,
    numThreads: Number(readConfig(config.numThreads, 4)) || 4,
    defaultLanguage: readConfig(config.defaultLanguage, 'auto'),
    /** 识别引擎惰性加载并复用（模型加载有固定开销）。 */
    engine: null,
    /** 引擎缓存键：档位 + 语言。SenseVoice 的语言是加载期参数，换语言要重建。 */
    engineKey: null,

    /** 当前使用的档位：配置优先，否则默认档。 */
    tier() {
      const t = readConfig(config.tier, '')
      return t && MODEL_TIERS[t] ? t : DEFAULT_TIER
    },

    /**
     * 取得（或重建）识别引擎。
     * @param {string} [language] - auto / zh / en / yue / ja / ko；仅 SenseVoice 生效
     */
    async getEngine(language) {
      const tier = this.tier()
      const lang = language || this.defaultLanguage || 'auto'
      const key = `${tier}:${lang}`
      if (this.engine && this.engineKey === key) return this.engine
      this.engine = createEngine({
        dataRoot: this.dataRoot,
        tier,
        numThreads: this.numThreads,
        language: lang,
      })
      this.engineKey = key
      return this.engine
    },

    /** 解析二进制：插件自带优先，其次系统。 */
    async resolveBinaries() {
      return {
        ytdlp:
          (await localBinary(this.dataRoot, 'ytdlp')) ??
          (await resolveBinary('yt-dlp', readConfig(config.ytdlpPath, ''), [], ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'])),
        ffmpeg:
          (await localBinary(this.dataRoot, 'ffmpeg')) ??
          (await resolveBinary('ffmpeg', readConfig(config.ffmpegPath, ''), [], ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'])),
      }
    },
  }
}

/** 路径是否存在（不区分文件/目录）。 */
async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 把字幕写入文件（可选）。 */
async function maybeWriteFile(path, content) {
  if (!path) return null
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/**
 * 截断长文本用于工具返回值，避免灌满上下文。
 * 注意：json 格式绝不截断——截断后的 JSON 无法解析。见 jsonPayload。
 */
function clip(text, max = 4000) {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, max) + `\n…（已截断，共 ${s.length} 字符）`
}

/** json 格式返回值：保证始终是合法 JSON。 */
function jsonPayload(cues, max) {
  const full = JSON.stringify(cues, null, 2)
  if (full.length <= max) return { content: full, truncated: false }
  return {
    content: JSON.stringify(
      {
        cueCount: cues.length,
        characters: full.length,
        note: `字幕共 ${cues.length} 段 / ${full.length} 字符，已省略正文。请传入 outputPath 写入文件后读取。`,
      },
      null,
      2,
    ),
    truncated: true,
  }
}

/** 统一的「正文 + 落盘」返回组装，避免两个工具重复逻辑。 */
async function deliver(cues, fmt, outputPath, inlineLimit) {
  const full = formatCues(cues, fmt)
  const written = await maybeWriteFile(outputPath, full)

  if (written) {
    return {
      content:
        fmt === 'json'
          ? JSON.stringify({ cueCount: cues.length, characters: full.length, note: '完整内容已写入 outputPath' })
          : clip(formatCues(cues, 'text'), 1200),
      truncated: true,
      outputPath: written,
    }
  }
  if (fmt === 'json') {
    const p = jsonPayload(cues, inlineLimit)
    return { content: p.content, truncated: p.truncated, outputPath: null }
  }
  const content = clip(full, inlineLimit)
  return { content, truncated: content.length < full.length, outputPath: null }
}

export function apply(ctx, config = {}) {
  const rt = createContext(config)
  const tools = ctx.get('tools')
  if (!tools) {
    ctx.logger?.warn?.('youtube-subtitles: tools 服务不可用，未注册任何工具')
    return
  }

  const disposers = []
  const register = (def) => disposers.push(tools.register(def))
  ctx.effect(() => () => {
    for (const d of disposers) d()
  })

  /**
   * 卸载自动清理。
   *
   * DSH 没有「卸载时自动删插件数据」的机制，`dsh plugin remove` 走 pnpm 子进程
   * 根本不加载插件。Web GUI 卸载会先 dispose 插件，因此这里登记一个不阻塞的
   * 延迟清理：只有确认 profile 的 dependencies 已不再引用本插件（= 真卸载，
   * 而非禁用开关）时才删除 $DSH_HOME/plugins-data 下的插件目录。
   * 用 CLI 卸载时 disposer 不会执行，卸载前先调用 youtube_subs_purge。
   */
  ctx.effect(
    () => () => {
      scheduleUninstallPurge(rt.dataRoot, { logger: ctx.logger })
    },
    'youtube-subtitles: purge data on uninstall',
  )

  /**
   * 浏览器半（设置卡片）需要的两个只读/删除动作。
   *
   * 走 Connection 通用 RPC：客户端 `ctx.connection.rpc.call('/youtube-subtitles', 端点, 载荷)`，
   * 这里用 `connection.rpc.handle(channel, handler)` 注册。channel 只能是
   * `/^\/[A-Za-z0-9._~-]+$/` 且不能是 `/api`（那是 api-gateway 的保留通道）。
   * 非 Web 载体（TUI / headless）没有 webServer，此时 connection 缺失或注册失败，
   * 直接跳过——工具与 CLI 用法不受影响。
   */
  /**
   * 浏览器卡片用的 RPC 端点。
   *
   * 下载类操作（模型 / 二进制）要几十秒，直接同步返回会把卡片卡死、也可能撞上
   * 中间层超时。所以统一走「后台任务 + 轮询」：
   *   - 写操作（downloadModels / deleteModels / downloadBinaries / deleteBinary）
   *     只登记任务并立即返回 jobId；
   *   - 读操作（status / jobStatus）随时可查，卡片每 800ms 轮询一次进度。
   *
   * 任务状态放在闭包里，插件卸载即随之消失，不落盘、不跨进程。
   */
  const jobs = new Map()
  const startJob = (kind, label, work) => {
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const job = { id, kind, label, state: 'running', startedAt: Date.now(), message: '', result: null }
    jobs.set(id, job)
    // 不 await：让 RPC 立刻返回 jobId
    void (async () => {
      try {
        job.result = await work()
        job.state = 'done'
        job.message = job.result?.message ?? '完成'
      } catch (err) {
        job.state = 'failed'
        job.message = String(err?.message ?? err)
      } finally {
        job.endedAt = Date.now()
      }
    })()
    return job
  }
  /** 清理 5 分钟前结束的任务，避免长时间开着页面堆积。 */
  const pruneJobs = () => {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.endedAt && now - job.endedAt > 300_000) jobs.delete(id)
    }
  }

  /** 汇总当前状态：模型档位 + 二进制 + VAD。 */
  const collectStatus = async () => {
    const configured = {
      ytdlp: readConfig(config.ytdlpPath, ''),
      ffmpeg: readConfig(config.ffmpegPath, ''),
    }
    const tiers = await Promise.all(
      Object.entries(MODEL_TIERS).map(async ([id, spec]) => {
        const st = checkTier(rt.dataRoot, id)
        const bytes = st.ready ? await dirSize(tierDir(rt.dataRoot, id)).catch(() => 0) : 0
        return {
          id,
          label: spec.label,
          description: spec.description,
          installed: st.ready,
          bytes,
          missing: st.missing,
          languages: LANGUAGE_BY_TIER[id] ?? [],
          punctuation: Boolean(spec.punctuation),
        }
      }),
    )
    return {
      currentTier: rt.tier(),
      dataRoot: rt.dataRoot,
      vadInstalled: existsSync(vadPathFor(rt.dataRoot)),
      tiers,
      binaries: await binaryStatus(rt.dataRoot, configured),
    }
  }

  const registerRpc = (connection) => {
    ctx.effect(() => {
      const dispose = connection.rpc.handle('/youtube-subtitles', async (endpoint, payload) => {
        try {
          if (endpoint === 'status' || endpoint === 'modelStatus') {
            return { ok: true, value: await collectStatus() }
          }

          if (endpoint === 'jobStatus') {
            pruneJobs()
            const job = jobs.get(payload?.id)
            if (!job) return { ok: true, value: { state: 'unknown', message: '任务不存在或已过期' } }
            return {
              ok: true,
              value: {
                id: job.id, kind: job.kind, label: job.label, state: job.state,
                message: job.message, result: job.result,
                elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
              },
            }
          }

          if (endpoint === 'downloadModels') {
            const tier = payload?.tier
            if (!MODEL_TIERS[tier]) {
              return { ok: false, error: { code: 'bad-request', message: `未知档位：${tier}`, details: {} } }
            }
            const job = startJob('downloadModels', `安装模型 ${tier}`, async () => {
              await installTier(rt.dataRoot, tier, {})
              // 装完让引擎失效，下次识别按新模型重建
              rt.engine = null
              rt.engineKey = null
              return { tier, message: `模型 ${tier} 安装完成` }
            })
            return { ok: true, value: { jobId: job.id } }
          }

          if (endpoint === 'downloadBinaries') {
            const ids = Array.isArray(payload?.ids) ? payload.ids : []
            const valid = ids.filter((id) => BINARY_ASSETS[id])
            if (valid.length === 0) {
              return { ok: false, error: { code: 'bad-request', message: '没有可安装的程序', details: {} } }
            }
            const job = startJob('downloadBinaries', `安装 ${valid.join(' / ')}`, async () => {
              const done = []
              const failed = []
              for (const id of valid) {
                try {
                  await installBinary(rt.dataRoot, id, {})
                  done.push(BINARY_ASSETS[id].name)
                } catch (err) {
                  failed.push(`${id}: ${err?.message ?? err}`)
                }
              }
              if (done.length === 0) throw new Error(failed.join('；') || '全部失败')
              return {
                installed: done,
                failed,
                message: failed.length > 0
                  ? `已安装 ${done.join('、')}；失败 ${failed.length} 项`
                  : `已安装 ${done.join('、')}`,
              }
            })
            return { ok: true, value: { jobId: job.id } }
          }

          if (endpoint === 'deleteModels') {
            const tier = payload?.tier
            const r = await removeTier(rt.dataRoot, tier)
            if (r.removed) {
              rt.engine = null
              rt.engineKey = null
            }
            return { ok: true, value: { tier: r.tier, removed: r.removed, freedBytes: r.freedBytes, note: r.reason ?? null } }
          }

          if (endpoint === 'deleteBinary') {
            const r = await removeBinary(rt.dataRoot, payload?.id)
            return { ok: true, value: r }
          }

          return {
            ok: false,
            error: { code: 'not-found', message: `未知端点：${endpoint}`, details: {} },
          }
        } catch (err) {
          return {
            ok: false,
            error: { code: 'youtube-subtitles/failed', message: String(err?.message ?? err), details: {} },
          }
        }
      })
      return () => {
        void dispose?.()
      }
    }, 'youtube-subtitles: settings rpc')
  }

  // connection 是 Web 载体才有的服务。用 ctx.inject 延迟到服务就绪再注册：
  // 直接同步 ctx.get 的话，若本插件比 client-connection 先加载，就会永久跳过。
  // 服务始终不存在（TUI / headless）时子 fiber 保持挂起，不报错、不影响工具。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (inner) => {
      const connection = inner.get('connection')
      if (connection?.rpc?.handle) registerRpc(connection)
    })
  } else {
    const connection = ctx.get('connection')
    if (connection?.rpc?.handle) registerRpc(connection)
  }

  /* ------------------------------------------------------ 工具 1：抓已有字幕 */
  register(defineTool({
    name: 'youtube_transcript',
    description:
      '抓取 YouTube 视频的已有字幕（人工上传优先，自动生成兜底），返回带时间轴的文本。' +
      '支持 text / srt / vtt / json 四种格式。不需要任何外部依赖，也不消耗模型。' +
      '若视频没有字幕，改用 youtube_transcribe 做本地语音识别。',
    parameters: {
      url: { type: 'string', required: true, description: 'YouTube 视频地址或 11 位视频 ID' },
      lang: { type: 'string', description: '期望字幕语言，如 zh-Hans / zh / en / ja；默认 zh-Hans' },
      format: { type: 'string', enum: ['text', 'srt', 'vtt', 'json'], description: '输出格式，默认 text' },
      preferManual: { type: 'boolean', description: '是否优先人工字幕（默认 true）' },
      outputPath: { type: 'string', description: '可选：把结果写入该绝对路径文件' },
      listOnly: { type: 'boolean', description: '仅列出可用字幕轨道，不下载内容' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    async execute(args) {
      const videoId = extractVideoId(args.url)
      const clientVersion = readConfig(config.clientVersion, '')
      const info = await getVideoInfo(videoId, {
        client: clientVersion
          ? {
              clientVersion,
              userAgent: `com.google.android.youtube/${clientVersion} (Linux; U; Android 11) gzip`,
            }
          : {},
      })

      if (info.tracks.length === 0) {
        return {
          ok: false, videoId, title: info.title,
          reason: '该视频没有任何字幕轨道',
          suggestion: '改用 youtube_transcribe 做本地语音识别',
        }
      }

      if (args.listOnly) {
        return {
          ok: true, videoId, title: info.title, author: info.author,
          durationSeconds: info.durationSeconds,
          tracks: info.tracks.map((t) => ({ language: t.languageCode, type: t.kind, name: t.name })),
        }
      }

      const lang = args.lang || 'zh-Hans'
      const track = pickTrack(info.tracks, lang, { preferManual: args.preferManual !== false })
      if (!track) {
        return {
          ok: false, videoId, title: info.title,
          reason: `未找到语言「${lang}」的字幕轨道`,
          availableTracks: info.tracks.map((t) => `${t.languageCode}(${t.kind})`),
          suggestion: '可指定其它 lang，或改用 youtube_transcribe 做本地识别',
        }
      }

      const cues = await fetchCues(track)
      const fmt = args.format || 'text'
      // text/json 给较宽的内联预算（纯文本可读性高），srt/vtt 因带大量时间码更早落盘
      const inline = fmt === 'text' || fmt === 'json' ? 12000 : 6000
      const d = await deliver(cues, fmt, args.outputPath, inline)

      return {
        ok: true, videoId, title: info.title, author: info.author,
        durationSeconds: info.durationSeconds,
        language: track.languageCode, type: track.kind,
        cueCount: cues.length, content: d.content, truncated: d.truncated, outputPath: d.outputPath,
      }
    },
  }))

  /* ------------------------------------------------------ 工具 2：语音转字幕 */
  register(defineTool({
    name: 'youtube_transcribe',
    description:
      '对没有字幕的 YouTube 视频做本地语音识别并生成时间轴字幕，全程在本机 CPU 完成，音频不上传。' +
      '流程：yt-dlp 下载音频 → ffmpeg 转 16kHz 单声道 WAV → 本地模型识别。' +
      '需要模型与 yt-dlp、ffmpeg；若未就绪，先用 youtube_subs_status 查看并安装。',
    parameters: {
      url: { type: 'string', required: true, description: 'YouTube 视频地址或 11 位视频 ID' },
      lang: { type: 'string', description: '识别语言：auto / zh / en / yue / ja / ko，默认 auto' },
      format: { type: 'string', enum: ['text', 'srt', 'vtt', 'json'], description: '输出格式，默认 srt' },
      outputPath: { type: 'string', description: '可选：把字幕写入该绝对路径文件' },
      maxDurationSeconds: { type: 'number', description: '可选：只处理前 N 秒' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    async execute(args, exec) {
      const videoId = extractVideoId(args.url)

      // 1. 模型就绪性：不自动下载，返回选项让用户决定
      const tier = rt.tier()
      const st = checkTier(rt.dataRoot, tier)
      if (!st.ready) {
        return {
          ok: false, videoId, reason: '语音识别模型尚未安装',
          currentTier: tier,
          dataRoot: rt.dataRoot,
          missing: st.missing,
          options: listTiers(rt.dataRoot),
          suggestion:
            '模型不会自动下载。请让用户选择档位，然后调用 youtube_subs_status 并传 installTier（small=74MB 快，full=238MB 带标点多语言）。',
        }
      }

      // 2. 二进制
      const { ytdlp, ffmpeg } = await rt.resolveBinaries()
      if (!ytdlp || !ffmpeg) {
        const missing = []
        if (!ytdlp) missing.push('yt-dlp')
        if (!ffmpeg) missing.push('ffmpeg')
        return {
          ok: false, videoId,
          reason: `缺少必需程序：${missing.join('、')}`,
          available: Object.values(BINARY_ASSETS).map((b) => ({
            id: b.id, name: b.name, description: b.description, downloadMB: Math.round(b.bytes / 1e6),
          })),
          suggestion: `调用 youtube_subs_status 并传 installBinaries 下载到插件自己的目录，或自行安装 ${missing.join('、')}`,
        }
      }

      const work = await makeWorkDir()
      try {
        const wavPath = await downloadAudio({
          ytdlp, ffmpeg, videoId, outDir: work.dir,
          signal: exec.signal,
          maxDurationSeconds: args.maxDurationSeconds,
        })

        const language = args.lang || rt.defaultLanguage
        const engine = await rt.getEngine(language)
        const samples = readAudio(engine.sherpa, wavPath)
        const result = transcribeWithVad(engine, samples)

        if (result.cues.length === 0) {
          return { ok: false, videoId, reason: '未识别出任何语音内容（可能是纯音乐或静音视频）' }
        }

        const fmt = args.format || 'srt'
        const d = await deliver(result.cues, fmt, args.outputPath, fmt === 'text' || fmt === 'json' ? 12000 : 6000)

        return {
          ok: true, videoId,
          tier, model: MODEL_TIERS[tier].label,
          language,
          // 轻量档的英文能力很差（实测 WER 54% vs 全能档 37%），
          // 与其让用户事后发现专名全错，不如当场提示换档。
          ...(tier === 'small' && (language === 'en' || language === 'auto')
            ? {
                qualityWarning:
                  '当前是轻量档（Paraformer 中文模型）。若视频含英文语音/专名，识别结果会明显失真' +
                  '（Ethereum→以太网、BitMine→mind、Tom Lee→tom 莉），英文词错误率约 54%。' +
                  '英文或中英混合内容请改用 full 档（youtube_subs_status 传 installTier=full，' +
                  '再把配置 tier 设为 full）。',
              }
            : {}),
          audioSeconds: Number(result.audioSeconds.toFixed(1)),
          inferenceSeconds: Number(result.inferenceSeconds.toFixed(1)),
          realtimeFactor: Number((result.inferenceSeconds / result.audioSeconds).toFixed(3)),
          segmentCount: result.segmentCount,
          cueCount: result.cues.length,
          punctuation: MODEL_TIERS[tier].punctuation,
          content: d.content, truncated: d.truncated, outputPath: d.outputPath,
        }
      } catch (err) {
        return { ok: false, videoId, reason: err.message }
      } finally {
        await work.cleanup()
      }
    },
  }))

  /* ------------------------------------------------------ 工具 3：状态与安装 */
  register(defineTool({
    name: 'youtube_subs_status',
    description:
      '查看 YouTube 字幕插件的依赖状态，并按需安装。' +
      'installTier 安装语音识别模型（small=74MB 快，full=238MB 带标点多语言）；' +
      'installBinaries 安装 yt-dlp / ffmpeg 到插件自己的目录。' +
      '下载体积不小且不会自动进行，请先向用户确认档位。',
    parameters: {
      installTier: { type: 'string', enum: ['small', 'full'], description: '要安装的模型档位' },
      installBinaries: {
        type: 'array', items: { type: 'string', enum: ['ytdlp', 'ffmpeg'] },
        description: '要安装的二进制 id 列表',
      },
      removeTier: {
        type: 'string', enum: ['small', 'full'],
        description: '要删除的已下载模型档位（只删该档位，保留 VAD 与另一档位）',
      },
      removeBinaries: {
        type: 'array', items: { type: 'string', enum: ['ytdlp', 'ffmpeg'] },
        description: '要删除的插件自带程序（只删插件目录里的副本，不碰系统 PATH）',
      },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    async execute(args, exec) {
      const { ytdlp, ffmpeg } = await rt.resolveBinaries()
      const local = {
        ytdlp: (await localBinary(rt.dataRoot, 'ytdlp')) !== null,
        ffmpeg: (await localBinary(rt.dataRoot, 'ffmpeg')) !== null,
      }

      const installed = []
      const errors = []

      if (args.installTier) {
        try {
          await installTier(rt.dataRoot, args.installTier, { signal: exec.signal })
          installed.push(`模型档位 ${args.installTier}`)
        } catch (err) {
          errors.push(`模型安装失败：${err.message}`)
        }
      }
      for (const id of args.installBinaries ?? []) {
        try {
          await installBinary(rt.dataRoot, id, { signal: exec.signal })
          installed.push(`二进制 ${BINARY_ASSETS[id]?.name ?? id}`)
        } catch (err) {
          errors.push(`${id} 安装失败：${err.message}`)
        }
      }

      const removed = []
      if (args.removeTier) {
        try {
          const r = await removeTier(rt.dataRoot, args.removeTier)
          removed.push({
            tier: r.tier,
            removed: r.removed,
            freedMB: Number((r.freedBytes / 1e6).toFixed(1)),
            note: r.reason ?? null,
          })
          // 引擎可能正持有该档位的原生句柄，删完必须让它失效以便重建/报错
          if (r.removed) {
            rt.engine = null
            rt.engineKey = null
          }
        } catch (err) {
          errors.push(`删除模型失败：${err.message}`)
        }
      }

      const removedBinaries = []
      for (const id of args.removeBinaries ?? []) {
        try {
          const r = await removeBinary(rt.dataRoot, id)
          removedBinaries.push({ id, name: r.name, removed: r.removed, freedMB: Number((r.freedBytes / 1e6).toFixed(1)), note: r.reason ?? null })
        } catch (err) {
          errors.push(`删除 ${id} 失败：${err.message}`)
        }
      }

      // 安装后重新检查
      const tiers = listTiers(rt.dataRoot)
      const tier = rt.tier()
      const active = tiers.find((t) => t.id === tier)
      const { ytdlp: y2, ffmpeg: f2 } = await rt.resolveBinaries()

      return {
        ok: Boolean(active?.installed && y2 && f2),
        dataRoot: rt.dataRoot,
        installedNow: installed,
        removedNow: removed,
        removedBinaries,
        errors,
        model: {
          currentTier: tier,
          label: MODEL_TIERS[tier].label,
          ready: Boolean(active?.installed),
          languages: LANGUAGE_BY_TIER[tier] ?? [],
          punctuation: MODEL_TIERS[tier].punctuation,
          ...(tier === 'small'
            ? { limitation: '仅适合纯中文；英文词错误率约 54%，英文专名会被汉字化' }
            : {}),
        },
        tiers,
        binaries: {
          detail: await binaryStatus(rt.dataRoot, {
            ytdlp: readConfig(config.ytdlpPath, ''),
            ffmpeg: readConfig(config.ffmpegPath, ''),
          }),
          fromPluginDir: local,
          available: Object.values(BINARY_ASSETS).map((b) => ({
            id: b.id, name: b.name, description: b.description, downloadMB: Math.round(b.bytes / 1e6),
          })),
        },
        capabilities: {
          transcript: '可用（零依赖，抓已有字幕）',
          transcribe:
            active?.installed && y2 && f2
              ? '可用（本地语音识别）'
              : '不可用 —— 需模型 + yt-dlp + ffmpeg 三者齐备',
        },
      }
    },
  }))

  /* ------------------------------------------------------ 工具 4：清理自身数据 */
  register(defineTool({
    name: 'youtube_subs_purge',
    description:
      '删除本插件自己占用的全部数据（模型、自带二进制），用于卸载前清理。' +
      '只删除插件专属目录，绝不触碰系统 PATH 上的程序或 DSH 内置语音插件的模型目录。' +
      '默认只预览，confirm=true 才真正删除。',
    parameters: {
      confirm: { type: 'boolean', description: '为 true 才真正删除；缺省仅预览占用与将删除的路径' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    async execute(args) {
      // 预览前就校验路径：既防止误删，也避免对 `/` 这类巨大目录做体积统计
      const safePath = assertPurgeable(rt.dataRoot)
      const bytes = await dirSize(safePath).catch(() => 0)
      const mb = Number((bytes / 1e6).toFixed(1))

      // 逐项列出将删除的内容，让用户在 confirm 前能核对体积
      const inspect = async (sub) => {
        const dir = join(safePath, sub)
        const b = await dirSize(dir).catch(() => 0)
        return { dir, exists: b > 0 || (await pathExists(dir)), mb: Number((b / 1e6).toFixed(1)) }
      }
      const binInfo = await inspect('bin')
      const modelInfo = await inspect('models')

      if (!args.confirm) {
        return {
          ok: true, preview: true,
          path: safePath,
          occupiedMB: mb,
          binaries: binInfo.exists
            ? { path: binInfo.dir, occupiedMB: binInfo.mb, note: '插件下载的 yt-dlp / ffmpeg 会一并删除' }
            : { path: binInfo.dir, note: '未安装插件自带二进制（可能用的是系统 PATH 上的版本）' },
          models: modelInfo.exists
            ? { path: modelInfo.dir, occupiedMB: modelInfo.mb }
            : { path: modelInfo.dir, note: '未安装任何模型' },
          willDelete: [
            `${binInfo.dir}/（插件自带的 yt-dlp / ffmpeg，若有）`,
            `${modelInfo.dir}/（语音识别模型，含 VAD）`,
          ],
          willNotTouch: [
            '系统 PATH 上的 yt-dlp / ffmpeg（可能是你手动安装、别的程序也在用）',
            '$DSH_HOME/models（DSH 内置语音插件的共享模型目录）',
          ],
          suggestion: '确认后传 confirm=true 执行删除',
        }
      }

      const r = await purgePluginData(rt.dataRoot)
      // 引擎持有已加载的模型，清理后让其失效以便重建
      rt.engine = null
      rt.engineKey = null

      return {
        ok: true, preview: false,
        removed: r.removed,
        path: r.path,
        freedMB: Number(((r.freedBytes ?? bytes) / 1e6).toFixed(1)),
        deleted: {
          binaries: binInfo.exists ? binInfo.dir : null,
          models: modelInfo.exists ? modelInfo.dir : null,
        },
        note: r.removed
          ? '插件数据已清空（含 yt-dlp / ffmpeg 与模型）。此时移除插件不会留下垃圾。'
          : r.reason,
      }
    },
  }))

  ctx.logger?.info?.(
    `youtube-subtitles: 已注册 4 个工具（数据目录 ${rt.dataRoot}，模型档位 ${rt.tier()}）`,
  )
}
