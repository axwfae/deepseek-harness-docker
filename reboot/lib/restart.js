/**
 * 自重启核心：把「启动当前宿主的 DSH 调用」原样重放一遍，
 * 让必须重启才生效的改动不需要用户手动退出终端再启动。
 *
 * 安全模型（三层，缺一不可）：
 *   1. 只有直连本机回环、且 Origin 与 Host 同源的请求才能触发重启；
 *   2. 部署在 systemd 之类守护器之下时默认拒绝 —— 重启的归属权在守护器；
 *   3. 进程带调试器（inspector）时一律拒绝 —— 调试会话不该被无声杀掉。
 *
 * 本文件只使用 node: 内置模块，零第三方依赖。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import inspector from 'node:inspector';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * 本次进程启动的标识。
 *
 * pid 在不同次启动间可能复用，时间戳不会，两者拼接后前端就能用它
 * 区分「还是我原来那个进程」和「已经是重启后的新进程」。
 */
export const BOOT_ID = `${String(process.pid)}-${String(Date.now())}`;

/** Windows 上 `dsh` 是 .cmd 垫片，只能交给 shell 执行。 */
const winCmdShim = process.platform === 'win32';

/** 带调试端口的启动参数前缀，按 token 匹配而不是按子串匹配。 */
const INSPECT_ARG_PREFIXES = ['--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait'];

/**
 * 单个参数 token 是否属于调试族。
 *
 * 用前缀精确匹配，而不是 `/inspect/` 子串匹配：
 * 后者会把 `.../inspect-tool.js` 这类脚本路径误判成调试器。
 */
function tokenHasInspectFlag(token) {
    for (const prefix of INSPECT_ARG_PREFIXES) {
        if (token === prefix || token.startsWith(`${prefix}=`))
            return true;
    }
    if (token === '--debug-brk' || token.startsWith('--debug-brk='))
        return true;
    if (token === '--debug' || token.startsWith('--debug='))
        return true;
    return false;
}

/** 参数数组里是否出现了调试标志。 */
function argvHasInspectFlag(tokens) {
    for (const token of tokens) {
        if (tokenHasInspectFlag(token))
            return true;
    }
    return false;
}

/** 读取某个 pid 的 comm 名，读不到（非 Linux、权限不足）时返回 null。 */
function readParentComm(pid) {
    try {
        return readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim();
    }
    catch {
        return null;
    }
}

/**
 * 当前宿主的进程守护器，识别不出时返回 null。
 *
 * 为什么需要它：systemd 默认 `KillMode=control-group`，单元 cgroup 里的
 * 所有进程都会随主进程一起被杀 —— 包括那个本该拉起新进程的 detached 助手。
 * 此时「重启」等于把服务杀掉且再也起不来，是这里能造成的最大破坏。
 *
 * 为什么要求两个信号：`INVOCATION_ID` 会被继承，凡是某个 unit 的后代都带着它，
 * 普通桌面终端（shell 源自 user session 的 unit）和 CI runner 同样如此。
 * 只认环境变量会把一大批本来能正常重启的宿主一刀切禁掉。
 *
 * 父进程判定用于区分「自己就是该 unit 的主进程」和「只是某个 unit 的后代」：
 * 系统级 unit 的父进程是 PID 1，而 `systemd --user` 拉起的用户级 unit
 * 父进程是一个普通 pid、comm 为 `systemd`。因此父进程是 PID 1，
 * 或父进程 comm 是 `systemd`，才算作「有守护器」。
 *
 * 只识别 systemd：pm2 的 `pm_id` 同样是继承的，且 pm2 的父进程是 God daemon
 * 而不是 PID 1，没有等价的第二信号，猜测只会重新引入它本该避免的误判。
 */
export function detectedSupervisor(env = process.env, ppid = process.ppid, parentComm = readParentComm) {
    const set = (name) => (env[name] ?? '') !== '';
    if (!set('INVOCATION_ID') && !set('JOURNAL_STREAM'))
        return null;
    if (ppid === 1 || parentComm(ppid) === 'systemd')
        return 'systemd';
    return null;
}

/**
 * 进程是否正被调试器接管，是则返回 'inspector'，否则 null。
 *
 * 主信号是 `inspector.url()` —— 覆盖启动时的 `--inspect`、运行中的
 * `inspector.open()` 以及 SIGUSR1 附加；次信号是 execArgv 与 NODE_OPTIONS
 * 里的调试族标志，覆盖 `--inspect-wait` 这类「标志已存在但 inspector.url()
 * 尚未填充」的时机。
 *
 * 注意：它不参与 `restartAllowed()` 的判断，也压过显式的 allowRestart: true。
 * 调试会话下杀掉宿主从来不是正确操作，没有需要尊重的部署形态。
 */
export function detectedDebugger(inspectorUrl = inspector.url(), execArgv = process.execArgv, nodeOptions = process.env.NODE_OPTIONS ?? '') {
    if (inspectorUrl !== undefined && inspectorUrl !== '')
        return 'inspector';
    if (argvHasInspectFlag(execArgv))
        return 'inspector';
    const options = nodeOptions.trim();
    if (options !== '' && argvHasInspectFlag(options.split(/\s+/u)))
        return 'inspector';
    return null;
}

/**
 * 是否允许自重启。
 *
 * 显式配置优先：`allowRestart: true|false` 一旦给定就按它执行 ——
 * 运维把自己 unit 配成 `KillMode=process` 之类时，那是他对部署的明确声明。
 * 未配置时，有守护器（systemd）就默认关闭，其余情况默认开启。
 */
export function restartAllowed(config, env = process.env, ppid = process.ppid) {
    if (config.allowRestart !== undefined)
        return config.allowRestart;
    return detectedSupervisor(env, ppid) === null;
}

/**
 * 当前进程服务在哪个端口，从「发起这次请求的那个 Host 头」上读出来。
 *
 * 不能从启动 argv 里解析：宿主完全可能从配置或环境变量取端口。
 * Host 头是浏览器实际访问到我们的地址，也就是重启后新进程必须接管的端口；
 * 而且它已经先经过同源校验，取值不会被伪造的 Host 带偏。
 *
 * 返回 null 表示这个 Host 头里没带端口（默认端口）。
 */
export function servingPort(request) {
    const host = request.headers.host;
    if (host === undefined)
        return null;
    const match = /:(\d{1,5})$/u.exec(host);
    if (match === null)
        return null;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Host 头是否指向一个本机回环地址。
 *
 * 支持 `127.0.0.1`、`localhost`、`[::1]` 三种写法，允许带端口，
 * 大小写按 Host 头常规归一。
 */
function loopbackAuthority(host) {
    if (host === undefined)
        return false;
    const lower = host.toLowerCase();
    const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * 请求是否属于「本机直连」：对端是回环地址、没有任何转发痕迹、
 * 且 Host 头指向回环地址。
 *
 * 只看对端地址不够：DNS rebinding 页面可以借自己控制的域名解析到 127.0.0.1，
 * 此时 Host/Origin 里带的是攻击者的域名。Host 是攻击者无法伪造的那一项，
 * 所以必须要求它是回环写入。
 */
function directLoopbackRequest(request) {
    const address = request.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')
        return false;
    // 任何转发痕迹都说明这个回环对端其实是代理，不是用户本人。
    if (request.headers.forwarded !== undefined
        || request.headers['x-forwarded-for'] !== undefined
        || request.headers['x-real-ip'] !== undefined)
        return false;
    return loopbackAuthority(request.headers.host);
}

/**
 * 本机直连判定：回环对端、无任何转发痕迹、Host 指向回环地址。
 *
 * 这是 `reachable` 用的宽松版，**不检查 Origin**。
 *
 * 为什么 status 必须用它：浏览器对同源的 GET 请求不会发送 Origin 头，
 * 若用 trustedRebootRequest() 去算 reachable，正常页面打开时它恒为 false，
 * 前端就会把重启按钮永久置灰 —— 一个永远不会亮的按钮。
 * 它只表示「这个请求确实来自本机」，不构成任何放行依据：
 * 真正的门禁仍然是 POST 上的 Origin 同源校验。
 */
export function restartReachableFrom(request) {
    return directLoopbackRequest(request);
}

/**
 * 重启请求是否可信：在本机直连的基础上，再要求 Origin 与 Host 同源。
 *
 * Origin 缺失直接拒绝，不按「浏览器同源 GET 不带 Origin」放宽：
 * 这是 POST 触发进程控制的接口，浏览器对 POST 一定会带 Origin，
 * 缺失即意味着不是页面发起的，而同源判定正是这里唯一能做的事。
 */
export function trustedRebootRequest(request) {
    if (!directLoopbackRequest(request))
        return false;
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined)
        return false;
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
    }
    catch {
        return false;
    }
}

/**
 * 当前运行时应该用哪个 node 可执行文件。
 *
 * 优先用 `process.argv0`：在某些平台（例如 Android）`process.execPath`
 * 指向 `/apex/.../linker64` 之类的加载器，真正的 node 二进制在 argv0 上。
 * argv0 不是绝对路径或文件已不存在时退回 `process.execPath`。
 */
export function nodeExecutable(argv0 = process.argv0, execPath = process.execPath) {
    if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0))
        return argv0;
    return execPath;
}

/**
 * 还原「当前这颗 dsh 是怎么被启起来的」：可执行文件、参数、工作目录。
 *
 * 正常安装下 `process.argv[1]` 是 `.../bin.js` 或 `.../dsh`，此时用
 * node + 该入口文件重放，不依赖 PATH；其它情况（源码运行、打包器改写入口）
 * 退回 `dsh` 命令，并由 `viaShell` 说明 Windows 上需要 shell 来执行 .cmd 垫片。
 */
export function dshArgv() {
    const entry = process.argv[1];
    if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/u.test(entry)) {
        const abs = resolve(entry);
        return { file: nodeExecutable(), args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false };
    }
    return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim };
}

/** 新进程要重放的完整启动调用：入口参数之后接上原有的业务参数。 */
export function restartLaunch() {
    const launch = dshArgv();
    return {
        ...launch,
        args: [...launch.args, ...process.argv.slice(2)],
        cwd: launch.cwd ?? process.cwd(),
    };
}

/**
 * 平台正确的拉起方式。
 *
 * Windows 上 `detached` 对应 DETACHED_PROCESS —— 新宿主没有控制台，
 * 它之后拉起的每个控制台子进程（例如沙箱命令执行器）都会弹出一个可见窗口。
 * 用 `powershell -WindowStyle Hidden` 包一层，新宿主就带的是「隐藏控制台」，
 * 子进程继承它而不是各自弹窗。POSIX 保持普通的 detached 拉起。
 *
 * 助手进程本身没有控制台，所以它 spawn 时还要带 windowsHide，
 * 否则 Windows 会给 PowerShell 新建一个可见控制台。
 */
export function respawnInvocation(launch, platform = process.platform) {
    if (platform !== 'win32') {
        return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };
    }
    // PowerShell 单引号字符串里只需要把单引号双写。
    // 显式写上 cmd 垫片：直接调 `dsh` 会让 PowerShell 优先选 dsh.ps1，
    // 默认 Restricted 执行策略会在新进程起来之前就把它拒掉。
    const quote = (part) => `'${part.replace(/'/gu, "''")}'`;
    const file = launch.viaShell && !/\.(?:cmd|bat)$/iu.test(launch.file)
        ? `${launch.file}.cmd`
        : launch.file;
    return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
            [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
        viaShell: false,
        detached: false,
    };
}

/**
 * 那个比当前进程活得更久的独立助手进程的源码。
 *
 * 它用 `node -e <源码>` 启动，所以只能是 CommonJS，只能 require 内置模块。
 *
 * 它要解决的问题（Windows 上每次都能复现）：老进程已经退出，但监听套接字
 * 还没被系统释放，此时直接拉起新进程，新进程会立刻 EADDRINUSE 死掉；
 * 而原先的 spawn 包在空的 catch 里，什么日志都没有 —— 用户看到的就是
 * 一个点了没反应的重启按钮。所以这里的流程是：
 *
 *   1. 用 connect 探测端口（不是 bind 探测 —— bind 测试本身会占住端口，
 *      正好卡在新进程要用的那一刻），500ms 超时即视为「已释放」；
 *   2. 最多等 30 秒，每 250ms 轮询一次；超时则记一行日志后照样继续；
 *   3. 端口释放后再等 300ms（Windows 上已释放的套接字可能还在 TIME_WAIT）；
 *      没有端口信息时退回固定等待 1500ms；
 *   4. 以 detached + 日志重定向拉起目标进程；
 *   5. 有端口信息时，要求端口「持续 8 秒可连」才算成功 —— 启动失败的宿主
 *      可能已经绑定端口后才退出（例如激活审计在监听之后才拒绝整棵树），
 *      单次连上不足以判定成功；进程退出或触及 240 秒硬上限时，
 *      把诊断写进 .err.log 后退出；
 *   6. 助手自己的每一行输出都带时间戳，同时写进 .out.log 与 .err.log。
 *
 * @param spawned - `respawnInvocation()` 的结果：可执行文件、参数、是否经 shell、是否 detached。
 * @param launch - `restartLaunch()` 的结果，这里只取工作目录。
 * @param logs - 两个日志文件的绝对路径。
 * @param port - 新进程必须接管的端口；未知时为 null。
 */
export function restartHelperSource(spawned, launch, logs, port) {
    return [
        "const { spawn } = require('node:child_process')",
        "const fs = require('node:fs')",
        "const net = require('node:net')",
        `const file = ${JSON.stringify(spawned.file)}`,
        `const args = ${JSON.stringify(spawned.args)}`,
        `const cwd = ${JSON.stringify(launch.cwd)}`,
        `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
        `const detached = ${JSON.stringify(spawned.detached)}`,
        `const logOut = ${JSON.stringify(logs.out)}`,
        `const logErr = ${JSON.stringify(logs.err)}`,
        `const port = ${JSON.stringify(port)}`,
        'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
        // 助手的每一行输出都带时间戳，并同时写进两个日志：
        // 重启失败时助手是唯一还活着的现场，事后要能看清它做过什么。
        'const note = (line) => {',
        '  const text = `[dsh-reboot] ${new Date().toISOString()} ${line}\\n`',
        '  for (const target of [logOut, logErr]) {',
        '    try { fs.appendFileSync(target, text) } catch {}',
        '  }',
        '}',
        // 「助手凭空消失」和「助手自己退出」是两种不同的 bug，现象一样，必须分开记。
        'process.on("exit", (code) => note("助手退出（code " + code + "）"))',
        'process.on("uncaughtException", (error) => note("助手崩溃：" + (error && error.stack ? error.stack : error)))',
        'process.on("unhandledRejection", (error) => note("助手未处理的 rejection：" + (error && error.stack ? error.stack : error)))',
        // 「端口空了」的定义是没有任何东西还能接受连接。用 connect 探测而不是 bind：
        // bind 测试本身会占住端口，正好卡在新进程要用的那一刻。
        'const listening = () => new Promise((resolve) => {',
        '  const probe = net.connect({ host: "127.0.0.1", port })',
        '  const done = (value) => { probe.destroy(); resolve(value) }',
        '  probe.on("connect", () => done(true))',
        '  probe.on("error", () => done(false))',
        '  setTimeout(() => done(false), 500)',
        '})',
        // 新进程退出时的退出码，用于把「失败」与「还在启动」区分开。
        'let exited = null',
        'const main = async () => {',
        // 分阶段记日志不是调试残留：重启失败后这个文件是助手的唯一账本，
        // 而「端口到底有没有被释放过」会让同一句「新进程没起来」读起来完全不同。
        '  note(`助手已启动（pid ${process.pid}），目标端口 ${port}`)',
        '  if (port) {',
        '    const until = Date.now() + 30000',
        '    while (Date.now() < until && await listening()) await sleep(250)',
        // 等待结束只有两种原因：端口空了，或者等满了 30 秒。两者之后的处境完全不同，
        // 所以这里把探测结果存下来，而不是丢掉后无条件写「已释放」——
        // 那会在超时仍被占用时留下一句自相矛盾的假账。
        '    const stillBusy = await listening()',
        '    await sleep(300)',
        '    if (stillBusy) note(`端口 ${port} 等满 30s 仍未释放，仍然尝试启动（新进程可能 EADDRINUSE）`)',
        '    else note(`端口 ${port} 已释放，开始拉起新进程`)',
        '  } else {',
        '    await sleep(1500)',
        '  }',
        '  let child',
        '  try {',
        '    const out = fs.openSync(logOut, "a")',
        '    const err = fs.openSync(logErr, "a")',
        // windowsHide 在这里是必需的：助手本身是 detached 的、没有控制台，
        // 从无控制台父进程拉起控制台程序时 Windows 会给它新建一个可见控制台，
        // 那个窗口一旦被关掉，新宿主也跟着死。
        '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell, windowsHide: true })',
        // spawn 找不到或无法执行文件时报错是「异步」送达的，try/catch 只覆盖同步抛出，
        // 少了下面这个监听器，这类失败会像这个 bug 当初一样悄无声息。
        '    child.on("error", (error) => note(`无法启动新进程：${error && error.message ? error.message : error}`))',
        '    child.on("exit", (code) => { exited = code === null ? -1 : code })',
        '    child.unref()',
        '    note(`新进程已启动（pid ${child.pid}）`)',
        '  } catch (error) {',
        '    note(`无法启动新进程：${error && error.message ? error.message : error}`)',
        '    return',
        '  }',
        // 没有端口可轮询时也要多活一会儿：助手如果 spawn 完立刻退出，
        // Windows 上新进程还在它的进程组里、尚未真正 detach，会被一起带走。
        '  if (!port) { await sleep(3000); return }',
        // 成功不是「端口答应过一次」。启动失败的宿主可能已经绑定了 Web 端口
        // （树挂载、服务器监听之后才做激活审计并整棵树退出），
        // 单次应答会把一个正在崩塌的宿主判成成功。所以要求端口「连续可连」
        // 达到 SETTLE_MS 才算成功 —— 这比审计拒绝一棵树要久得多。
        '  const SETTLE_MS = 8000',
        '  const startedAt = Date.now()',
        // 45 秒是「是否已起来」的预算，而不是「是否已死」的判决：
        // 源码运行、插件树很大的宿主冷启动时，Web 服务器可能 40 秒以上才绑定端口。
        // 到这个点还没起来就先记一行，然后继续等。
        '  const upBy = Date.now() + 45000 + SETTLE_MS',
        // 240 秒硬上限：只要新进程还活着就一直等下去（提前抢它的端口只会让它
        // EADDRINUSE 死掉），真正失败的启动会由上面的 exit 提前结束等待。
        '  const hardBy = Date.now() + 240000',
        '  let steadySince = null',
        '  let announcedWait = false',
        '  while (true) {',
        '    if (await listening()) {',
        '      if (steadySince === null) steadySince = Date.now()',
        '      else if (Date.now() - steadySince >= SETTLE_MS) { note("端口已持续可连，重启成功"); return }',
        '    } else {',
        '      steadySince = null',
        '      if (exited !== null) break',
        '      const now = Date.now()',
        '      if (now >= hardBy) break',
        '      if (now >= upBy && !announcedWait) {',
        '        announcedWait = true',
        // 数字是算出来的，不是抄两遍：会和常量脱节的日志比没有日志更糟。
        '        note(`新进程启动已超过 ${String(Math.round((upBy - startedAt) / 1000))}s 但未退出，继续等到 ${String(Math.round((hardBy - startedAt) / 1000))}s，而不是抢它的端口（那会让它 EADDRINUSE 死掉）`)',
        '      }',
        '    }',
        '    await sleep(500)',
        '  }',
        '  note(`新进程始终没有在端口 ${port} 上起来${exited === null ? "（它仍在运行）" : `（退出码 ${exited}）`} —— 详见同目录下的输出日志`)',
        '}',
        'main()',
    ].join('\n');
}

/**
 * 安排一次自重启：拉起独立助手，然后让本进程退出。
 *
 * 助手比我们活得久（detached + unref），会等本进程的端口真正释放后再拉起
 * 替身，日志落在系统临时目录。
 *
 * @param port - 本进程正在服务的端口，让助手能等端口而不是猜延迟；未知时传 null。
 * @returns 本进程 pid、助手 pid 与两个日志路径，供调用方回给前端。
 */
export function scheduleRestart(port = null) {
    const launch = restartLaunch();
    const spawned = respawnInvocation(launch);
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
    const logOut = join(tmpdir(), `dsh-reboot-${stamp}.out.log`);
    const logErr = join(tmpdir(), `dsh-reboot-${stamp}.err.log`);
    const helper = spawn(nodeExecutable(), ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
        windowsHide: true,
    });
    helper.unref();
    // 留 500ms 让 HTTP 响应先送达浏览器，再优雅退出本进程：
    // 助手已经在等端口释放，所以这里不需要更长。
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
    return { pid: process.pid, helperPid: helper.pid, logOut, logErr };
}
