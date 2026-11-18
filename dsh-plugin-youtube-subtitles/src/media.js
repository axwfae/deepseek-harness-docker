/**
 * 媒体获取与音频预处理：依赖 yt-dlp（下载）与 ffmpeg（转码）。
 *
 * 解析顺序（自包含优先）：
 *   1. 插件配置中显式指定的绝对路径
 *   2. **插件自己的 bin 目录**（<dataRoot>/bin）—— 自包含安装放这里
 *   3. 系统 PATH
 *   4. 常见系统路径
 *
 * 缺失时给出可操作的提示，而不是抛出难以理解的 ENOENT。
 *
 * 为什么必须转码：本地 ASR 引擎（sherpa-onnx）的 readWave 只接受 16kHz 单声道 WAV。
 * yt-dlp -x 在没有 ffmpeg 时必然失败，所以「下载 + 转 16k 单声道 WAV」是绑定动作。
 */
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, mkdir, chmod, rename } from 'node:fs/promises'
import { constants as FS, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, isAbsolute, resolve, basename } from 'node:path'

/** 在 PATH 中查找可执行文件。 */
/** 文件字节数；读不到返回 0。 */
async function fileSize(path) {
  const { stat } = await import('node:fs/promises')
  return stat(path).then((st) => st.size).catch(() => 0)
}

async function onPath(cmd) {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of paths) {
    const full = join(dir, cmd)
    try {
      await access(full, FS.X_OK)
      return full
    } catch {
      /* 继续找 */
    }
  }
  return null
}

async function executable(path) {
  try {
    await access(path, FS.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析外部可执行文件路径。自包含优先：先看插件自己的 bin 目录。
 * @param {string} name - 可执行文件名，如 yt-dlp / ffmpeg
 * @param {string|undefined} configured - 配置中指定的绝对路径
 * @param {string[]} localCandidates - 插件自带目录中的候选（自包含安装）
 * @param {string[]} systemFallbacks - 系统常见路径
 */
export async function resolveBinary(name, configured, localCandidates = [], systemFallbacks = []) {
  if (configured) {
    if (!isAbsolute(configured)) throw new Error(`${name} 配置必须是绝对路径：${configured}`)
    if (!(await executable(configured))) throw new Error(`${name} 配置的路径不可执行：${configured}`)
    return configured
  }
  // 插件自带优先（自包含）
  for (const c of localCandidates) if (await executable(c)) return c
  // 系统 PATH
  const found = await onPath(name)
  if (found) return found
  // 常见系统路径
  for (const c of systemFallbacks) if (await executable(c)) return c
  return null
}

/**
 * 运行一个子进程并收集输出。
 * @returns {Promise<{code:number,stdout:string,stderr:string}>}
 */
export function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    // yt-dlp 的进度条会输出大量内容，只保留尾部用于诊断
    const cap = options.captureBytes ?? 64 * 1024
    child.stdout.on('data', (d) => {
      stdout += d
      if (stdout.length > cap) stdout = stdout.slice(-cap)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > cap) stderr = stderr.slice(-cap)
    })
    child.on('error', (err) => {
      if (err.name === 'AbortError') return reject(err)
      reject(new Error(`无法启动 ${bin}：${err.message}`))
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** 把 yt-dlp/ffmpeg 的 stderr 浓缩成一行可读错误。 */
export function conciseError(stderr, fallback = '命令执行失败') {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^\s*\[download\]\s+\d/.test(l))
  const errLine = lines.find((l) => /^ERROR|^error/i.test(l))
  const picked = errLine ?? lines[lines.length - 1] ?? fallback
  return picked.replace(/^ERROR:\s*/i, '').slice(0, 400)
}

/** 下载视频音频并转为 16kHz 单声道 WAV。 */
export async function downloadAudio(opts) {
  const { ytdlp, ffmpeg, videoId, outDir, signal, maxDurationSeconds } = opts

  if (!ytdlp) {
    throw new Error(
      '未找到 yt-dlp，无法下载音频。安装方式：pip install -U yt-dlp，' +
        '或从 https://github.com/yt-dlp/yt-dlp/releases 下载单文件二进制后在插件配置中指定 ytdlpPath。',
    )
  }
  if (!ffmpeg) {
    throw new Error(
      '未找到 ffmpeg，无法把音频转为 WAV。本地语音识别引擎只接受 16kHz 单声道 WAV。' +
        '安装方式：apt install ffmpeg，或在插件配置中指定 ffmpegPath。',
    )
  }

  const outputTemplate = join(outDir, 'audio.%(ext)s')
  const args = [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--js-runtimes', 'node',
    // 把 ffmpeg 位置显式告诉 yt-dlp：--download-sections 与后续合并都依赖它，
    // 否则会报 "ffmpeg is not installed"（即使 ffmpeg 就在我们手里）。
    '--ffmpeg-location', ffmpeg,
    '-o', outputTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]

  let dl = await run(ytdlp, args, { signal })
  if (dl.code !== 0 && /js-runtimes|no such option|unrecognized arguments/i.test(dl.stderr)) {
    // 旧版 yt-dlp 不认识 --js-runtimes；去掉这两个参数重试一次
    const fallback = args.filter((a, i) => a !== '--js-runtimes' && args[i - 1] !== '--js-runtimes')
    dl = await run(ytdlp, fallback, { signal })
  }
  if (dl.code !== 0) throw new Error(`音频下载失败：${conciseError(dl.stderr)}`)

  // 定位下载产物（扩展名由 YouTube 决定，可能是 webm / m4a）
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(outDir)
  const raw = files.find((f) => f.startsWith('audio.') && !f.endsWith('.wav'))
  if (!raw) throw new Error('音频下载后未找到产物文件')

  const wavPath = join(outDir, 'audio.wav')
  // 截断交给 ffmpeg 的 -t 完成：实测 --download-sections 与纯音频格式（bestaudio）
  // 组合时会因缺少视频流而失败，而下载完整音频再截断兼容性最好，
  // 代价是长视频会多下一段音频（可在插件配置中用 maxDurationSeconds 权衡）。
  const ffArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', join(outDir, raw),
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
  ]
  if (maxDurationSeconds) ffArgs.push('-t', String(maxDurationSeconds))
  ffArgs.push(wavPath)

  const ff = await run(ffmpeg, ffArgs, { signal })
  if (ff.code !== 0) throw new Error(`音频转码失败：${conciseError(ff.stderr)}`)

  return wavPath
}

/** 创建临时工作目录并返回其路径与清理函数。 */
export async function makeWorkDir(prefix = 'dsh-yt-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return {
    dir,
    async cleanup() {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响主流程 */
      }
    },
  }
}

/* ---------------------------------------------------------------- 自包含二进制 */

/**
 * 可取用的二进制清单。
 *
 * 下载到插件自己的 <dataRoot>/bin 下 —— 不写 /usr/local/bin，不动系统 PATH，
 * 卸载插件时随目录一起删除。用户若已有系统版本，插件会优先用自带的；
 * 想用系统版本就把 bin 目录删掉或在配置里显式指定路径。
 */
export const BINARY_ASSETS = {
  ytdlp: {
    id: 'ytdlp',
    name: 'yt-dlp',
    description: '下载 YouTube 音频（约 3MB，Python 单文件）',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
    bytes: 3.1e6,
  },
  ffmpeg: {
    id: 'ffmpeg',
    name: 'ffmpeg',
    description: '把音频转成 16kHz 单声道 WAV（约 75MB，静态单文件）',
    // 选单文件而不是压缩包的理由：解压包要么体积翻倍（BtbN 的 tar.xz 156MB，
    // 解出来 176MB），要么得依赖系统的 tar/xz。单文件下载后直接 chmod 就能用，
    // 落盘体积也最小。版本固定在 b6.0（ffmpeg 6.0-static），不用滚动 latest，
    // 避免某天上游换了构建导致行为漂移。
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64',
    bytes: 78.7e6,
    /**
     * 备选源。每个源自带 `archiveMember`：有值表示「压缩包，解压后取该成员」，
     * 没有表示「单文件，chmod 后直接用」。主源与镜像的格式可以不同，
     * 因此不能把 archiveMember 写在资产级——那会让回退到压缩包时走错分支。
     */
    mirrors: [
      {
        url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
        archiveMember: 'bin/ffmpeg',
      },
    ],
  },
}

/** 检查插件自带目录里是否已有某二进制。 */
export async function localBinary(dataRoot, id) {
  const asset = BINARY_ASSETS[id]
  if (!asset) return null
  const p = join(dataRoot, 'bin', asset.name)
  return (await executable(p)) ? p : null
}

/**
 * 把二进制安装到插件自己的目录（自包含）。
 * @param {string} dataRoot
 * @param {'ytdlp'|'ffmpeg'} id
 */
export async function installBinary(dataRoot, id, options = {}) {
  const asset = BINARY_ASSETS[id]
  if (!asset) throw new Error(`未知二进制：${id}（可选 ${Object.keys(BINARY_ASSETS).join(' / ')}）`)

  const binDir = join(dataRoot, 'bin')
  await mkdir(binDir, { recursive: true })
  const target = join(binDir, asset.name)

  const work = await makeWorkDir('dsh-yt-bin-')
  try {
    // 归一化下载源列表：主源 + 镜像，每个源形如 { url, archiveMember? }
    const sources = [
      { url: asset.url, archiveMember: asset.archiveMember },
      ...(asset.mirrors ?? []),
    ]
    const dlPath = join(work.dir, 'dl')
    let lastErr = null
    let used = null
    // 依次尝试；全部失败才报错，避免单一下载点挂掉就装不上
    for (const source of sources) {
      const dl = await run('curl', ['-sSL', '--fail', '--retry', '2', '-o', dlPath, source.url], {
        signal: options.signal,
        captureBytes: 8 * 1024,
      })
      if (dl.code === 0) {
        used = source
        break
      }
      lastErr = dl.stderr.slice(-300) || `curl 退出码 ${dl.code}`
    }
    if (!used) {
      throw new Error(`${asset.name} 下载失败（已尝试 ${sources.length} 个源）：${lastErr}`)
    }

    if (used.archiveMember) {
      // 压缩包：解压后取出其中的可执行文件
      const ex = await run('tar', ['xJf', dlPath, '-C', work.dir], { signal: options.signal })
      if (ex.code !== 0) throw new Error(`${asset.name} 解压失败：${ex.stderr.slice(-300)}`)
      const { readdir } = await import('node:fs/promises')
      const dirs = (await readdir(work.dir)).filter((d) => d.startsWith('ffmpeg-'))
      if (dirs.length === 0) throw new Error('解压后未找到 ffmpeg 目录')
      await copyAndChmod(join(work.dir, dirs[0], used.archiveMember), target)
    } else {
      // 单文件：改权限后落位
      await chmod(dlPath, 0o755)
      await moveIntoPlace(dlPath, target)
    }
    return target
  } finally {
    await work.cleanup()
  }
}

async function copyAndChmod(from, to) {
  const { copyFile } = await import('node:fs/promises')
  await copyFile(from, to)
  await chmod(to, 0o755)
}

/**
 * 把已下载的文件移动到目标位置，兼容跨文件系统。
 *
 * 为什么需要：下载用的临时目录在 `/tmp`，而插件数据目录在 `$DSH_HOME` 下，两者
 * 常是**不同挂载**（容器 overlay、挂载的 home 卷等）。此时 `rename` 抛
 * `EXDEV: cross-device link not permitted`，安装直接失败——用户点「下载」只会看到
 * 这条底层错误。
 *
 * 修法：`rename` 失败且 `code === 'EXDEV'` 时回落为「复制到目标同目录的临时名 →
 * 再 rename 到正式名」。复制目标放在**目标同目录**，那一次 rename 必然同文件系统、
 * 原子生效，因此不会留下半截可执行文件。
 *
 * @param {string} from - 源文件（通常在 /tmp）
 * @param {string} to - 目标绝对路径
 * @param {{rename?: Function, copyFile?: Function, chmod?: Function}} [ops] - 便于测试注入
 * @returns {Promise<string>} 目标路径
 */
export async function moveIntoPlace(from, to, ops = {}) {
  const doRename = ops.rename ?? rename
  const doCopy = ops.copyFile ?? (await import('node:fs/promises')).copyFile
  const doChmod = ops.chmod ?? chmod
  try {
    await doRename(from, to)
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err
    const temp = `${to}.part`
    await doCopy(from, temp)
    await doChmod(temp, 0o755)
    await doRename(temp, to)
  }
  await doChmod(to, 0o755)
  return to
}

/* ---------------------------------------------------------------- 卸载清理 */

/** 插件专属数据目录名：`<DSH_HOME>/plugins-data/<PLUGIN_DATA_DIR>`。 */
export const PLUGIN_DATA_DIR = 'dsh-plugin-youtube-subtitles'

/**
 * 删除插件自己的全部数据（模型 + 自带二进制）。
 *
 * 只删 <dataRoot> 这一棵树 —— 因为插件的所有持久化产物都在里面。
 * 明确**不碰**：
 *   - 系统 PATH 上的 yt-dlp / ffmpeg（可能是用户自己装的、别的程序也在用）
 *   - $DSH_HOME/models（DSH 内置语音插件的共享模型目录）
 * 这样卸载不会牵连系统、也不会留下垃圾。
 */
export async function purgePluginData(dataRoot) {
  // 先校验，再测量：对不安全的路径连体积都不统计
  const check = checkPurgeable(dataRoot)
  if (!check.safe) return { removed: false, path: dataRoot, reason: check.reason }
  const target = check.path

  const { stat } = await import('node:fs/promises')
  let exists = true
  try {
    await stat(target)
  } catch {
    exists = false
  }
  if (!exists) return { removed: false, path: target, reason: '目录不存在，无需清理' }

  // 先量体积，供返回给用户确认清理了多少
  const before = await dirSize(target).catch(() => null)

  await rm(target, { recursive: true, force: true })
  return { removed: true, path: target, freedBytes: before }
}

/**
 * 清理前的路径护栏（返回判定结果，不抛错）。
 *
 * `dataRoot` 是配置项，可以被写成任意值。如果用户或配置把它指到 `/`、
 * 主目录、`$DSH_HOME` 本身或任意工作目录，一次「清理插件数据」就会删掉
 * 不可恢复的内容 —— 递归删除没有撤销，所以必须先判定再动手。
 *
 * 规则（满足其一才算安全）：
 *   1. 位于 `<DSH_HOME>/plugins-data/` 之下（默认位置，最安全）；
 *   2. 路径最后一段就是本插件目录名（自定义位置的保底约束）。
 * 两条都不满足即拒绝，并说明原因。
 *
 * @param {string} dataRoot
 * @returns {{safe: true, path: string} | {safe: false, reason: string}}
 */
export function checkPurgeable(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !isAbsolute(dataRoot)) {
    return {
      safe: false,
      reason: `拒绝清理：数据目录必须是绝对路径（当前为 ${JSON.stringify(dataRoot)}）`,
    }
  }
  const target = resolve(dataRoot)
  const home = resolve(dshHome())
  const pluginsData = resolve(join(home, 'plugins-data'))
  const forbidden = new Set([
    '/', '/home', '/root', '/usr', '/etc', '/var', '/tmp', '/opt',
    resolve(homedir()), home, pluginsData,
    resolve(join(home, 'profiles')), resolve(join(home, 'plugins')),
    resolve(join(home, 'sessions')), resolve(join(home, 'storages')),
    resolve(join(home, 'attachments')), resolve(join(home, 'cache')),
    resolve(join(home, 'models')),
  ])
  if (forbidden.has(target)) {
    return {
      safe: false,
      reason: `拒绝清理 ${target}：这不是插件专属目录，删除会波及 DSH 自身数据`,
    }
  }
  // 也不能是 $DSH_HOME 的祖先（例如 ~ 或 /home/node）
  if (home === target || home.startsWith(target.endsWith('/') ? target : `${target}/`)) {
    return { safe: false, reason: `拒绝清理 ${target}：它是 DSH 数据目录的上级目录` }
  }
  if (target.split('/').filter(Boolean).length < 2) {
    return { safe: false, reason: `拒绝清理 ${target}：路径层级过浅` }
  }

  // 规则 1：位于 plugins-data 之下
  if (target.startsWith(pluginsData === '/' ? '/' : `${pluginsData}/`)) {
    return { safe: true, path: target }
  }
  // 规则 2：最后一段必须是本插件目录名
  if (basename(target) === PLUGIN_DATA_DIR) return { safe: true, path: target }

  return {
    safe: false,
    reason:
      `数据目录 ${target} 既不在 ${pluginsData} 之下，末段也不是 ${PLUGIN_DATA_DIR}。` +
      `为防误删，拒绝清理。若这是你特意配置的位置，请把目录名设为 ${PLUGIN_DATA_DIR}；` +
      `自定义目录只清理插件产物时可删除其中的 bin/ 与 models/，其它文件请自行保留。`,
  }
}

/**
 * `checkPurgeable` 的抛错版本，供内部调用方（自动清理、测试）使用。
 *
 * @param {string} dataRoot
 * @returns {string} 规范化后的绝对路径
 */
export function assertPurgeable(dataRoot) {
  const check = checkPurgeable(dataRoot)
  if (!check.safe) throw new Error(check.reason)
  return check.path
}

/** 计算目录体积（字节），用于清理前的提示。 */
export async function dirSize(dir) {
  const { readdir, stat } = await import('node:fs/promises')
  let total = 0
  const walk = async (d) => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else {
        try {
          total += (await stat(p)).size
        } catch {
          /* 跳过 */
        }
      }
    }
  }
  await walk(dir)
  return total
}

/* ---------------------------------------------------------------- 卸载自动清理 */

/** 插件包名，用于判断 profile 是否还引用它。 */
const PACKAGE_NAME = PLUGIN_DATA_DIR

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** dataRoot 是否位于 $DSH_HOME/plugins-data/<插件名> 之下（只有这种路径允许自动删除）。 */
export function isOwnedDataRoot(dataRoot) {
  const owned = join(dshHome(), 'plugins-data', PACKAGE_NAME)
  const normalized = dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot
  const ownedNormalized = owned.endsWith('/') ? owned.slice(0, -1) : owned
  return normalized === ownedNormalized
}

/**
 * 删除插件自己下载的某个二进制（yt-dlp / ffmpeg）。
 *
 * 只删 `<dataRoot>/bin/<name>`，不碰系统 PATH 上的同名程序——那些可能是用户
 * 自己装的、别的工具也在用。删完 `resolveBinary` 会自然回落到系统版本。
 *
 * @param {string} dataRoot
 * @param {'ytdlp'|'ffmpeg'} id
 * @returns {Promise<{id:string, name:string, removed:boolean, path:string, freedBytes:number, reason?:string}>}
 */
export async function removeBinary(dataRoot, id) {
  const asset = BINARY_ASSETS[id]
  if (!asset) throw new Error(`未知二进制：${id}（可选 ${Object.keys(BINARY_ASSETS).join(' / ')}）`)
  const target = join(dataRoot, 'bin', asset.name)
  if (!existsSync(target)) {
    return { id, name: asset.name, removed: false, path: target, freedBytes: 0, reason: '插件目录下没有该程序' }
  }
  const { stat } = await import('node:fs/promises')
  const freedBytes = await stat(target).then((st) => st.size).catch(() => 0)
  await rm(target, { force: true })
  return { id, name: asset.name, removed: true, path: target, freedBytes }
}

/**
 * 二进制状态：区分「插件自带」「系统 PATH」「都没有」三种来源。
 *
 * 为什么不能只报「有没有」：用户需要知道删掉插件自带的那份之后，是否还有系统版本
 * 可用；否则删完才发现功能不可用。source 字段就是回答这个问题的。
 *
 * @param {string} dataRoot
 * @param {Record<string,string>} [configured] - 配置里显式指定的绝对路径
 * @returns {Promise<Array<{id:string,name:string,description:string,ready:boolean,source:string,path:string|null,bytes:number}>>}
 */
export async function binaryStatus(dataRoot, configured = {}) {
  const out = []
  for (const asset of Object.values(BINARY_ASSETS)) {
    const local = join(dataRoot, 'bin', asset.name)
    const explicit = configured[asset.id]
    let source = 'missing'
    let path = null
    let bytes = 0

    if (explicit && isAbsolute(explicit) && (await executable(explicit))) {
      source = 'configured'
      path = explicit
    } else if (await executable(local)) {
      source = 'bundled'
      path = local
      bytes = await fileSize(local).catch(() => 0)
    } else {
      const found = await onPath(asset.name)
      if (found) {
        source = 'system'
        path = found
      }
    }
    if (path && bytes === 0) bytes = await fileSize(path).catch(() => 0)

    out.push({
      id: asset.id,
      name: asset.name,
      description: asset.description,
      ready: source !== 'missing',
      source,
      path,
      bytes,
    })
  }
  return out
}

/**
 * 只删除插件自己安装的东西：`bin/`（yt-dlp、ffmpeg）与 `models/`（语音识别模型）。
 *
 * 为什么需要它：
 *   用户可能把 dataRoot 指到自己的目录（例如 `~/yt-data`）。整棵删掉会误伤同目录下
 *   与插件无关的文件；但插件装的 yt-dlp / ffmpeg / 模型必须清掉，否则卸载后留下
 *   几百 MB 死文件。所以这里只精确删除两个子目录，其余内容原样保留。
 *
 * @param {string} dataRoot - 插件数据目录
 * @returns {Promise<{removed:string[], freedBytes:number}>}
 */
export async function purgeInstalledArtifacts(dataRoot) {
  const { stat } = await import('node:fs/promises')
  const removed = []
  let freedBytes = 0
  // bin 与 models 都由插件独占：前者是插件下载的可执行文件，后者是 ASR 模型
  for (const sub of ['bin', 'models']) {
    const dir = join(dataRoot, sub)
    let exists = true
    try {
      await stat(dir)
    } catch {
      exists = false
    }
    if (!exists) continue
    freedBytes += await dirSize(dir).catch(() => 0)
    await rm(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return { removed, freedBytes }
}

/**
 * 任一 profile 的 package.json 是否仍把本插件列为依赖。
 *
 * 为什么用它区分「卸载」和「禁用」：
 *   - 禁用 bundle 只会把包名从 `dsh.profile.bundles` 移除，`dependencies` 仍在；
 *   - 卸载（Web GUI 的 removeBundle / pnpm remove）会把它从 `dependencies` 删除。
 * 两种情况下插件 disposer 都会被调用，仅靠 loader 状态区分不了。
 */
export async function profileStillReferences(pkgName = PACKAGE_NAME) {
  const { readdir, readFile } = await import('node:fs/promises')
  const profilesDir = join(dshHome(), 'profiles')
  let entries
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch {
    return true // 读不到就保守认定仍被引用，不删数据
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = await readFile(join(profilesDir, entry.name, 'package.json'), 'utf8')
      const manifest = JSON.parse(raw)
      if (manifest?.dependencies && Object.hasOwn(manifest.dependencies, pkgName)) return true
    } catch {
      /* 该 profile 没有 package.json，跳过 */
    }
  }
  return false
}

/**
 * 卸载后的延迟清理：不阻塞插件销毁，轮询到 profile 不再引用本插件时才删数据。
 *
 * 为什么不直接在 disposer 里删：
 *   禁用插件同样会触发 disposer；如果立刻删除，用户只是关掉插件开关就会丢模型。
 *   因此这里先让出，等包从 profile 依赖里消失（= 真正卸载）再清理。
 *
 * 为什么是 detached 的：
 *   cordis 的 `_unload` 会 `await` 每个 disposer，任何长任务都会拖住卸载/HMR。
 *   这里只登记一个 unref 的定时器，立即返回。
 *
 * @param {string} dataRoot - 插件数据目录
 * @param {{timeoutMs?: number, intervalMs?: number, logger?: object}} [options]
 * @returns {() => void} 取消函数
 */
export function scheduleUninstallPurge(dataRoot, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 500
  const logger = options.logger

  // 专属目录（$DSH_HOME/plugins-data/<包名>）整棵删除；
  // 用户自定义目录只删插件自己装的 bin/ 与 models/，不动同目录下的其它文件。
  const owned = isOwnedDataRoot(dataRoot)

  const deadline = Date.now() + timeoutMs
  let stopped = false

  const stop = () => {
    stopped = true
    clearInterval(timer)
  }

  const timer = setInterval(() => {
    if (stopped) return
    void (async () => {
      try {
        const referenced = await profileStillReferences()
        if (referenced && Date.now() < deadline) return
        if (referenced) {
          stop()
          logger?.info?.('youtube-subtitles: 卸载超时，插件仍在 profile 依赖中，保留数据')
          return
        }
        stop()
        if (owned) {
          await rm(dataRoot, { recursive: true, force: true })
          logger?.info?.(`youtube-subtitles: 已清除插件数据 ${dataRoot}（含 yt-dlp / ffmpeg 与模型）`)
        } else {
          const r = await purgeInstalledArtifacts(dataRoot)
          logger?.info?.(
            r.removed.length > 0
              ? `youtube-subtitles: 已清除插件安装的 ${r.removed.join('、')}（自定义目录的其它文件保留）`
              : `youtube-subtitles: 自定义目录下没有插件安装的二进制或模型（${dataRoot}）`,
          )
        }
      } catch (err) {
        stop()
        logger?.warn?.(`youtube-subtitles: 自动清理失败：${err?.message ?? err}`)
      }
    })()
  }, intervalMs)
  // 不因这个定时器阻止进程退出
  timer.unref?.()

  return stop
}
