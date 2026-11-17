/**
 * 本地语音识别：sherpa-onnx + VAD 分段，纯 CPU 推理。
 *
 * 设计原则（重要）：
 *   1. **插件自包含**——模型与二进制一律放在插件自己的数据目录下，
 *      绝不写入 $DSH_HOME/models 等共享位置，不与 DSH 内置语音插件争用资源。
 *      卸载插件时整个目录可一并删除，不留垃圾。
 *   2. **不自动下载**——模型体积不小，静默下载会让工具调用长时间无响应。
 *      缺失时返回可操作提示，由用户显式选择档位后再下载。
 *   3. **多档位可选**——用户按磁盘与效果需求在「轻量/全能」之间选。
 *
 * 引擎选型（本机实测，4 核 / 无 GPU / 100 秒中文演讲）：
 *   Paraformer-small  74MB  RTF 0.044  ✅ 轻量档：体积小、最快、中文准（无标点）
 *   SenseVoice       238MB  RTF 0.127  ✅ 全能档：带标点，支持粤/日/韩
 *   Whisper-tiny     244MB  RTF 0.059  ❌ 已淘汰：同体积下准确率明显更差
 *
 * 三个实测踩坑（勿改回）：
 *   1. readWave 只接受 16kHz 单声道 WAV；48kHz 立体声会静默只取第一声道，
 *      准确率崩塌（RTF 从 0.200 恶化到 0.544）。
 *   2. Vad.pop() 返回 undefined，必须「先 front() 再 pop()」；判断用 isEmpty()；
 *      分段对象只有 {start, samples}，**start 单位是样本数不是秒**。
 *   3. 模型文件缺失时原生层只打印警告不抛错，之后 acceptWaveform 变成静默空操作。
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/* ---------------------------------------------------------------- 模型档位定义 */

const ASSET_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

/**
 * 为什么 full 档不走 GitHub 的 tar.bz2：
 *   官方包 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2` 里只有
 *   fp32 的 model.onnx（约 563MB），**没有 model.int8.onnx**（2026-10 实测），
 *   而仓库里也没有单独的 int8 asset（404）。int8 版以单文件形式发布在
 *   HuggingFace 的同一模型目录下（239MB），直接下这个文件更小更快。
 *   sha256 实测：c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
 */
const SENSEVOICE_HF =
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'

/**
 * 可选的模型档位。每档声明：从哪个压缩包取、取哪些文件、体积、语言、特点。
 * 只搬运需要的文件，避免把一个压缩包里的全部权重都铺开。
 */
export const MODEL_TIERS = {
  small: {
    id: 'small',
    label: '轻量（Paraformer-small）',
    description:
      '74MB，速度最快。仅适合纯中文：中文准确率高，但英文词错误率 54%（全能档 37%），' +
      '英文专名会被汉字化（Ethereum→以太网、BitMine→mind、Tom Lee→tom 莉），且输出不带标点',
    downloadBytes: 77.9e6,
    diskBytes: 74e6,
    languages: ['zh', 'en'],
    punctuation: false,
    archive: `${ASSET_BASE}/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2`,
    extractedDir: 'sherpa-onnx-paraformer-zh-small-2024-03-09',
    items: [
      { from: 'model.int8.onnx', to: 'model.int8.onnx' },
      { from: 'tokens.txt', to: 'tokens.txt' },
    ],
    kind: 'paraformer',
  },
  full: {
    id: 'full',
    label: '全能（SenseVoiceSmall int8）',
    description:
      '239MB，带标点，支持中/英/粤/日/韩。中英混合与纯英文都明显更准：' +
      '英文词错误率 37%（轻量档 54%），专名命中 64%（轻量档 45%），Ethereum/ETF/Fidelity 能保留原形',
    downloadBytes: 239.2e6,
    diskBytes: 239.2e6,
    languages: ['zh', 'en', 'yue', 'ja', 'ko'],
    punctuation: true,
    files: [
      {
        url: `${SENSEVOICE_HF}/model.int8.onnx`,
        to: 'model.int8.onnx',
        sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
        bytes: 239233841,
      },
      { url: `${SENSEVOICE_HF}/tokens.txt`, to: 'tokens.txt' },
    ],
    kind: 'senseVoice',
  },
}

/** VAD 模型（各档共用，636KB）。 */
export const VAD_ASSET = {
  url: `${ASSET_BASE}/asr-models/silero_vad.onnx`,
  name: 'silero_vad.onnx',
  diskBytes: 636e3,
}

/** 各档支持的语言。 */
export const LANGUAGE_BY_TIER = {
  small: ['auto', 'zh', 'en'],
  full: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
}

/** 默认档位：体积与效果的最优平衡。 */
export const DEFAULT_TIER = 'small'

/* ---------------------------------------------------------------- 路径解析 */

/**
 * 插件专属数据目录。
 *
 * 刻意不用 $DSH_HOME/models —— 那是共享位置，DSH 内置的 SenseVoice 语音插件
 * 用同一个根目录。共用会导致两类问题：资源争用、卸载时误删他人文件。
 * 放在 plugins-data/<插件名>/ 下，插件即一个自包含个体，装卸都只影响自己。
 */
export function defaultDataRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugins-data', 'dsh-plugin-youtube-subtitles')
}

export function modelsRoot(dataRoot) {
  return join(dataRoot, 'models')
}
export function tierDir(dataRoot, tier) {
  return join(modelsRoot(dataRoot), tier)
}
export function vadPathFor(dataRoot) {
  return join(modelsRoot(dataRoot), VAD_ASSET.name)
}
export function binRoot(dataRoot) {
  return join(dataRoot, 'bin')
}

/* ---------------------------------------------------------------- 引擎加载 */

/** 加载 sherpa-onnx-node。它通常随 DSH 内置语音插件提供。 */
export function loadSherpa() {
  const candidates = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/',
    new URL('../', import.meta.url).pathname,
  ]
  for (const base of candidates) {
    try {
      return createRequire(join(base, 'noop.js'))('sherpa-onnx-node')
    } catch {
      /* 试下一个 */
    }
  }
  try {
    return createRequire(import.meta.url)('sherpa-onnx-node')
  } catch (err) {
    throw new Error(`无法加载 sherpa-onnx-node。它通常随 DSH 内置语音插件提供。原始错误：${err.message}`)
  }
}

/** 检查一个档位是否就绪。 */
export function checkTier(dataRoot, tier) {
  const spec = MODEL_TIERS[tier]
  if (!spec) return { ready: false, missing: [`未知模型档位：${tier}`], files: null, dir: null, spec: null }

  const dir = tierDir(dataRoot, tier)
  const files = {
    model: join(dir, 'model.int8.onnx'),
    tokens: join(dir, 'tokens.txt'),
    vad: vadPathFor(dataRoot),
  }
  const missing = []
  for (const [k, p] of Object.entries(files)) if (!existsSync(p)) missing.push(`${k} -> ${p}`)
  return { ready: missing.length === 0, missing, files, dir, spec }
}

/** 列出全部档位及就绪状态，供工具返回给用户选择。 */
export function listTiers(dataRoot) {
  return Object.values(MODEL_TIERS).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    diskMB: Math.round(t.diskBytes / 1e6),
    downloadMB: Math.round(t.downloadBytes / 1e6),
    languages: t.languages,
    punctuation: t.punctuation,
    installed: checkTier(dataRoot, t.id).ready,
  }))
}

/* ---------------------------------------------------------------- 下载 */

/**
 * 计算文件 sha256（流式，避免把 239MB 模型读进内存）。
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * 下载并安装一个档位（含 VAD）。全程只写插件自己的 dataRoot。
 *
 * 两种打包形态：
 *   - `files`：逐文件下载（SenseVoice int8 只以单文件形式发布在 HF）；
 *   - `archive` + `items`：下载 tar.bz2 后只提取需要的文件（Paraformer）。
 * 带 `sha256` / `bytes` 声明时会校验，避免把截断的下载当成可用模型。
 * @param {function} run - media.js 的 run()
 */
export async function installTier(dataRoot, tier, options = {}) {
  const { run, makeWorkDir } = await import('./media.js')
  const spec = MODEL_TIERS[tier]
  if (!spec) throw new Error(`未知模型档位：${tier}（可选 ${Object.keys(MODEL_TIERS).join(' / ')}）`)

  const dest = tierDir(dataRoot, tier)
  const work = await makeWorkDir('dsh-yt-model-')
  mkdirSync(dest, { recursive: true })

  const fetchFile = async (url, outPath, expected = {}) => {
    if (existsSync(outPath)) {
      const sizeOk = expected.bytes === undefined || (await fileSize(outPath)) === expected.bytes
      if (sizeOk) {
        if (!expected.sha256 || (await sha256File(outPath)) === expected.sha256) return
      }
    }
    const partial = `${outPath}.part`
    const dl = await run('curl', ['-sSL', '--fail', '--retry', '2', '-o', partial, url], {
      signal: options.signal,
      captureBytes: 8 * 1024,
    })
    if (dl.code !== 0) {
      throw new Error(`模型下载失败：${dl.stderr.slice(-300) || `curl 退出码 ${dl.code}`}`)
    }
    if (expected.bytes !== undefined) {
      const got = await fileSize(partial)
      if (got !== expected.bytes) throw new Error(`模型大小不符：期望 ${expected.bytes} 字节，实际 ${got}（${url}）`)
    }
    if (expected.sha256) {
      const got = await sha256File(partial)
      if (got !== expected.sha256) {
        throw new Error(`模型校验失败：sha256 期望 ${expected.sha256}，实际 ${got}（${url}）`)
      }
    }
    const { rename } = await import('node:fs/promises')
    await rename(partial, outPath)
  }

  try {
    if (spec.files) {
      for (const f of spec.files) {
        await fetchFile(f.url, join(dest, f.to), f)
      }
    } else {
      const archive = join(work.dir, 'model.tar.bz2')
      const dl = await run('curl', ['-sSL', '--fail', '--retry', '2', '-o', archive, spec.archive], {
        signal: options.signal,
        captureBytes: 8 * 1024,
      })
      if (dl.code !== 0) {
        throw new Error(`模型下载失败：${dl.stderr.slice(-300) || `curl 退出码 ${dl.code}`}`)
      }

      const ex = await run('tar', ['xjf', archive, '-C', work.dir], { signal: options.signal })
      if (ex.code !== 0) throw new Error(`模型解压失败：${ex.stderr.slice(-300)}`)

      // 只搬运该档真正需要的文件
      const srcDir = join(work.dir, spec.extractedDir)
      if (!existsSync(srcDir)) throw new Error(`解压后未找到目录 ${spec.extractedDir}`)
      const { copyFile } = await import('node:fs/promises')
      for (const item of spec.items) {
        const from = join(srcDir, item.from)
        if (!existsSync(from)) throw new Error(`模型包内缺少文件 ${item.from}`)
        await copyFile(from, join(dest, item.to))
      }
    }

    // VAD：用于生成精确时间轴
    const vadFile = vadPathFor(dataRoot)
    if (!existsSync(vadFile)) {
      mkdirSync(dirname(vadFile), { recursive: true })
      const vd = await run('curl', ['-sSL', '--fail', '-o', vadFile, VAD_ASSET.url], { signal: options.signal })
      if (vd.code !== 0) throw new Error(`VAD 模型下载失败：${vd.stderr.slice(-300)}`)
    }

    return { tier, dir: dest, vad: vadFile }
  } finally {
    await work.cleanup()
  }
}

/**
 * 删除某个档位已下载的模型文件（保留 VAD 与另一个档位）。
 *
 * 为什么单独做这件事而不是让用户删目录：档位目录的名字由插件决定，
 * 用户不该记路径；而且删完之后引擎缓存必须失效，否则会拿着已删除的
 * 原生句柄继续推理。这里只删 `models/<tier>`，不碰 VAD、不碰另一个档位。
 *
 * @param {string} dataRoot - 插件数据目录
 * @param {string} tier - 档位 id
 * @returns {Promise<{tier:string, removed:boolean, path:string, freedBytes:number, reason?:string}>}
 */
export async function removeTier(dataRoot, tier) {
  if (!Object.hasOwn(MODEL_TIERS, tier)) {
    throw new Error(`未知模型档位：${tier}（可选 ${Object.keys(MODEL_TIERS).join(' / ')}）`)
  }
  const dir = tierDir(dataRoot, tier)
  if (!existsSync(dir)) {
    return { tier, removed: false, path: dir, freedBytes: 0, reason: '该档位没有已下载的模型' }
  }
  const { dirSize } = await import('./media.js')
  const { rm } = await import('node:fs/promises')
  const freedBytes = await dirSize(dir)
  await rm(dir, { recursive: true, force: true })
  return { tier, removed: true, path: dir, freedBytes }
}

/** 文件字节数。 */
async function fileSize(path) {
  const { stat } = await import('node:fs/promises')
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

/* ---------------------------------------------------------------- 引擎 */

/** 创建识别引擎。持有原生资源，建议复用（加载有固定开销）。 */
export function createEngine(config) {
  const { dataRoot, tier = DEFAULT_TIER, numThreads = 4, language = 'auto' } = config
  const st = checkTier(dataRoot, tier)
  if (!st.ready) throw new Error(`模型档位「${tier}」尚未就绪，缺少：${st.missing.join('；')}`)

  const sherpa = loadSherpa()
  const spec = st.spec
  const dir = st.dir

  const modelConfig = {
    tokens: join(dir, 'tokens.txt'),
    numThreads,
    provider: 'cpu',
    debug: 0,
  }
  if (spec.kind === 'senseVoice') {
    modelConfig.senseVoice = {
      model: join(dir, 'model.int8.onnx'),
      language: LANGUAGE_BY_TIER.full.includes(language) ? language : 'auto',
      useInverseTextNormalization: 1,
    }
  } else {
    // Paraformer 是中/英非流式模型，不接受语言参数
    modelConfig.paraformer = { model: join(dir, 'model.int8.onnx') }
  }

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig,
  })

  const vadFile = vadPathFor(dataRoot)
  const vad = existsSync(vadFile)
    ? new sherpa.Vad(
        {
          sileroVad: {
            model: vadFile,
            threshold: 0.5,
            minSpeechDuration: 0.25,
            minSilenceDuration: 0.5,
            maxSpeechDuration: 20,
            windowSize: 512,
          },
          sampleRate: 16000,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        60,
      )
    : null

  return { sherpa, recognizer, vad, tier, spec, config }
}

/** 读取 16kHz 单声道 WAV。 */
export function readAudio(sherpa, wavPath) {
  const wave = sherpa.readWave(wavPath)
  if (wave.sampleRate !== 16000) {
    throw new Error(
      `音频采样率必须是 16000Hz，当前 ${wave.sampleRate}Hz。` +
        `请用 ffmpeg 转换：ffmpeg -i in -ac 1 -ar 16000 -c:a pcm_s16le out.wav`,
    )
  }
  return wave.samples
}

/** 整段识别（无时间轴）。 */
export function transcribeWhole(engine, samples) {
  const t0 = Date.now()
  const stream = engine.recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  engine.recognizer.decode(stream)
  const result = engine.recognizer.getResult(stream)
  return {
    text: (result.text ?? '').trim(),
    inferenceSeconds: (Date.now() - t0) / 1000,
    audioSeconds: samples.length / 16000,
  }
}

/** VAD 分段识别，产出带时间轴的字幕分段。 */
export function transcribeWithVad(engine, samples) {
  const SAMPLE_RATE = 16000

  if (!engine.vad) {
    const r = transcribeWhole(engine, samples)
    return {
      cues: r.text ? [{ start: 0, end: r.audioSeconds, text: r.text }] : [],
      inferenceSeconds: r.inferenceSeconds,
      audioSeconds: r.audioSeconds,
      segmented: false,
      segmentCount: 0,
    }
  }

  const t0 = Date.now()
  const vad = engine.vad
  const windowSize = 512
  const segments = []

  /** 取出一条分段并换算为秒——seg.start 的单位是样本数，不是秒。 */
  const take = (fallbackSamples) => {
    const seg = vad.front()
    vad.pop()
    if (!seg?.samples?.length) return null
    const startSamples = Number.isFinite(seg.start) ? seg.start : fallbackSamples
    return { startSeconds: startSamples / SAMPLE_RATE, sampleCount: seg.samples.length, samples: seg.samples }
  }

  for (let off = 0; off < samples.length; off += windowSize) {
    vad.acceptWaveform(samples.subarray(off, Math.min(off + windowSize, samples.length)))
    while (!vad.isEmpty()) {
      const seg = take(off)
      if (seg) segments.push(seg)
    }
  }
  vad.flush()
  while (!vad.isEmpty()) {
    const seg = take(samples.length)
    if (seg) segments.push(seg)
  }

  const cues = []
  for (const seg of segments) {
    const stream = engine.recognizer.createStream()
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: seg.samples })
    engine.recognizer.decode(stream)
    const text = (engine.recognizer.getResult(stream).text ?? '').trim()
    if (text === '') continue
    cues.push({
      start: seg.startSeconds,
      end: seg.startSeconds + seg.sampleCount / SAMPLE_RATE,
      text,
    })
  }

  return {
    cues,
    inferenceSeconds: (Date.now() - t0) / 1000,
    audioSeconds: samples.length / SAMPLE_RATE,
    segmented: true,
    segmentCount: segments.length,
  }
}
