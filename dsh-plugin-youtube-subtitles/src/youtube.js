/**
 * YouTube 视频信息与字幕轨道抓取（零外部依赖）。
 *
 * 路线说明（2026-10 实测）：
 *   InnerTube /youtubei/v1/player 的 ANDROID client 是当前唯一稳定可用的组合。
 *   WEB / TVHTML5 返回 UNPLAYABLE 且无字幕轨；ANDROID 可正常拿到 captionTracks。
 *
 * 两个必须遵守的实测约束：
 *   1. HTTP 200 不代表成功 —— 缺少正确 client 上下文时 timedtext 返回 200 但 body 为空
 *      （响应头 server: video-timedtext）。只判断 res.ok 会静默拿到空字幕。
 *   2. fmt 必须「替换」而非「追加」—— ANDROID 的 baseUrl 已内置 fmt=srv3，
 *      追加 &fmt=json3 无效（仍返回 srv3 XML），必须先用正则替换掉原 fmt。
 */

/** 默认 ANDROID client 上下文；版本号易失效，允许通过 Config 覆盖。 */
export const DEFAULT_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 30,
  userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
}

/** 从各种形态的 YouTube URL 或裸 ID 中提取 11 位视频 ID。 */
export function extractVideoId(input) {
  const text = String(input ?? '').trim()
  if (text === '') throw new Error('视频地址为空')
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text

  let url
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`)
  } catch {
    throw new Error(`无法解析视频地址：${text}`)
  }
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '')

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id
  }
  // /watch?v=<id>
  const v = url.searchParams.get('v')
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v
  // /shorts/<id> | /embed/<id> | /live/<id> | /v/<id>
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/)
  if (m) return m[1]

  throw new Error(`无法从地址中提取视频 ID：${text}`)
}

/** 调用 InnerTube player 接口，返回原始 playerResponse。 */
async function fetchPlayer(videoId, client, signal) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': client.userAgent,
      'accept-language': client.hl ?? 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          androidSdkVersion: client.androidSdkVersion,
          hl: client.hl ?? 'en',
        },
      },
      videoId,
    }),
    signal,
  })

  const text = await res.text()
  if (text === '') {
    throw new Error(
      `InnerTube 返回空响应（HTTP ${res.status}）。通常是 client 组合失效或本机 IP 被 YouTube 风控；` +
        `可在插件配置中调整 clientName / clientVersion。`,
    )
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`InnerTube 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }

  const status = json.playabilityStatus?.status
  if (status && status !== 'OK') {
    const reason = json.playabilityStatus?.reason ?? '未知原因'
    throw new Error(`视频不可播放（${status}）：${reason}`)
  }
  return json
}

/** 把 captionTrack 规整为稳定形状。 */
function normalizeTrack(track) {
  const url = new URL(track.baseUrl)
  const kind = track.kind === 'asr' ? 'asr' : 'manual'
  return {
    languageCode: track.languageCode,
    /** manual = 人工上传字幕；asr = 语音自动识别生成 */
    kind,
    /** 语言显示名（YouTube 提供时） */
    name: track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode,
    /** 是否可翻译 */
    translatable: url.searchParams.get('tlang') !== null || track.isTranslatable === true,
    baseUrl: track.baseUrl,
  }
}

/**
 * 获取视频元信息与全部可用字幕轨道。
 * @returns {Promise<{videoId:string,title:string,author:string,durationSeconds:number|null,
 *                    tracks:Array<{languageCode:string,kind:string,name:string,baseUrl:string}>}>}
 */
export async function getVideoInfo(videoId, options = {}) {
  const client = { ...DEFAULT_CLIENT, ...(options.client ?? {}) }
  const json = await fetchPlayer(videoId, client, options.signal)

  const raw = json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  const details = json.videoDetails ?? {}
  const lengthSeconds = Number(details.lengthSeconds)

  return {
    videoId,
    title: details.title ?? '',
    author: details.author ?? '',
    durationSeconds: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds : null,
    tracks: raw.map(normalizeTrack),
  }
}

/**
 * 按语言偏好从轨道列表中挑选轨道。
 * 优先级：人工字幕 > 自动字幕；完全匹配 > 前缀匹配（zh 命中 zh-Hans / zh-CN）。
 * @param {Array} tracks - getVideoInfo().tracks
 * @param {string} lang - 期望语言代码，如 zh-Hans / zh / en
 * @param {{preferManual?:boolean}} [opts]
 */
export function pickTrack(tracks, lang, opts = {}) {
  const preferManual = opts.preferManual !== false
  const want = String(lang ?? '').toLowerCase()
  const lower = (s) => String(s ?? '').toLowerCase()

  const score = (t) => {
    const code = lower(t.languageCode)
    let s = 0
    if (code === want) s += 100
    else if (code.startsWith(want) || want.startsWith(code)) s += 60
    else if (code.split('-')[0] === want.split('-')[0]) s += 30
    else s = -1
    if (s < 0) return -1
    if (preferManual) s += t.kind === 'manual' ? 10 : 0
    return s
  }

  let best = null
  let bestScore = -1
  for (const t of tracks) {
    const s = score(t)
    if (s > bestScore) {
      bestScore = s
      best = t
    }
  }
  return bestScore >= 0 ? best : null
}

/**
 * 下载一条字幕轨并解析为统一的分段结构。
 *
 * 关键实现点：fmt 用替换而非追加（见文件头说明）。
 * @returns {Promise<Array<{start:number,end:number,text:string}>>} start/end 单位为秒
 */
export async function fetchCues(track, options = {}) {
  const client = { ...DEFAULT_CLIENT, ...(options.client ?? {}) }
  // 不用 URL API 重建：baseUrl 里带 expire/signature 等签名参数，重新编码可能破坏签名。
  // 手动重拼，只摘掉原有的 fmt 参数（它可能是 &fmt=srv3 也可能是 ?fmt=...）。
  const base = String(track.baseUrl).replace(/&amp;/g, '&')
  const [head, query = ''] = base.split('?')
  const kept = query.split('&').filter((part) => part !== '' && !part.startsWith('fmt='))
  const url = `${head}?${[...kept, 'fmt=json3'].join('&')}`

  const res = await fetch(url, {
    headers: {
      'user-agent': client.userAgent,
      'accept-language': client.hl ?? 'en-US,en;q=0.9',
    },
    signal: options.signal,
  })
  const text = await res.text()

  // 实测约束 1：HTTP 200 + 空 body 是风控表现，必须显式报错而不是返回空字幕
  if (text.trim() === '') {
    throw new Error(
      `字幕内容为空（HTTP ${res.status}）。YouTube 对本机 IP 的字幕接口限流，` +
        `请稍后重试或更换网络出口。`,
    )
  }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`字幕返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }

  const events = Array.isArray(json.events) ? json.events : []
  const cues = []
  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue
    const body = ev.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\n/g, ' ')
      .trim()
    if (body === '') continue
    const start = Number(ev.tStartMs ?? 0) / 1000
    const dur = Number(ev.dDurationMs ?? 0) / 1000
    cues.push({ start, end: start + dur, text: body })
  }
  if (cues.length === 0) throw new Error('字幕解析结果为空（视频可能没有该语言的有效字幕）')

  return dedupeCues(cues)
}

/**
 * 自动字幕常有滚动重复（同一句被连续事件重复吐出），做一次收敛。
 * 规则：紧邻且文本相同、或新文本是旧文本前缀延续时合并。
 */
export function dedupeCues(cues) {
  const out = []
  for (const cue of cues) {
    const last = out[out.length - 1]
    if (last && last.text === cue.text) {
      last.end = Math.max(last.end, cue.end)
      continue
    }
    // 自动字幕的滚动行：新行以旧行结尾部分开头，取更长的那个
    if (last && cue.text.startsWith(last.text) && cue.start - last.end < 0.35) {
      last.text = cue.text
      last.end = Math.max(last.end, cue.end)
      continue
    }
    out.push({ ...cue })
  }
  return out
}

/* ---------------------------------------------------------------- 格式转换 */

/**
 * 秒 -> SRT 时间戳 HH:MM:SS,mmm
 *
 * 先换算成整数毫秒再拆分：直接对秒的小数部分取整会在 1.9996 这类边界上
 * 产生 `,1000`（SRT 非法），进而把整段时间轴写坏。
 */
export function toSrtTime(sec) {
  const totalMs = Math.max(0, Math.round(Number(sec) * 1000))
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const ss = totalSec % 60
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(ss)},${p(ms, 3)}`
}

/** 秒 -> WebVTT 时间戳 HH:MM:SS.mmm */
export function toVttTime(sec) {
  return toSrtTime(sec).replace(',', '.')
}

/** 纯文本（按标点断句合并段落） */
export function toPlainText(cues, options = {}) {
  const joiner = options.joiner ?? ' '
  return cues
    .map((c) => c.text)
    .join(joiner)
    .replace(/\s+/g, ' ')
    .trim()
}

export function toSrt(cues) {
  return (
    cues
      .map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}`)
      .join('\n\n') + '\n'
  )
}

export function toVtt(cues) {
  const body = cues
    .map((c) => `${toVttTime(c.start)} --> ${toVttTime(c.end)}\n${c.text}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

/** 统一格式化入口 */
/** 秒值保留三位小数：避免 18.64 + 3.24 变成 21.880000000000003 这类浮点噪音。 */
function round3(sec) {
  const n = Number(sec)
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0
}

export function formatCues(cues, format) {
  switch (String(format ?? 'text').toLowerCase()) {
    case 'srt':
      return toSrt(cues)
    case 'vtt':
      return toVtt(cues)
    case 'json':
      return JSON.stringify(
        cues.map((c) => ({ start: round3(c.start), end: round3(c.end), text: c.text })),
        null,
        2,
      )
    case 'text':
    case 'txt':
      return toPlainText(cues)
    default:
      throw new Error(`不支持的字幕格式：${format}（可选 text / srt / vtt / json）`)
  }
}
