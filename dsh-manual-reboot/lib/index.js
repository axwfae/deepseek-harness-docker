/**
 * DSH 插件入口：手动重启当前 dsh 宿主。
 *
 * 插件在宿主 Web 服务器上挂两条只读/控制路由：
 *   GET  /dsh-reboot/status  —— 上报当前进程、端口、可否重启与请求是否够格；
 *   POST /dsh-reboot/restart —— 按原启动参数调度一次自重启。
 *
 * 组装逻辑全部在 ./restart.js（纯函数、零第三方依赖），本文件只负责
 * 路由注册、配置与日志。所有响应都不缓存，避免前端读到上一颗进程的旧状态。
 */

import {
    BOOT_ID,
    detectedDebugger,
    detectedSupervisor,
    restartAllowed,
    scheduleRestart,
    servingPort,
    trustedRebootRequest,
    restartReachableFrom,
} from './restart.js';

/** 插件名，同时作为日志作用域名。 */
export const name = 'dsh-reboot';

/*
 * 这里刻意**不导出 Config**。
 *
 * cordis 的 resolveConfig() 会做 `runtime.Config["~standard"].validate(config)`：
 * 只要导出了 Config，它就必须是一个真正的 schemastery Schema，否则加载时直接
 * 抛 TypeError（Cannot read properties of undefined (reading 'validate')）。
 * 而本插件以 link: 方式装在 profile 里时，运行时解析路径是源码目录
 * /home/node/workspace/system/reboot，从那里向上找不到 @deepseek-ai/schemastery，
 * 拿不到 Schema 构造函数 —— 曾经退化成一个普通对象 {} 导出，结果整个服务端半边
 * 加载失败、路由 404，而客户端半边照常挂出卡片。
 *
 * 不导出 Config 时 runtime.Config 是 undefined，resolveConfig 原样返回传入的
 * config，patch 层里写的 { allowRestart: false } 依然生效；缺少该字段时
 * restartAllowed() 回落到 detectedSupervisor() 的自动判断。
 */

/** 取插件专属 logger；宿主未提供 logger 时返回 null，日志静默丢弃。 */
function loggerOf(ctx) {
    try {
        return ctx.logger?.(name) ?? null;
    }
    catch {
        return null;
    }
}

/** 统一的 JSON 响应：不缓存、UTF-8，附带头部由调用方补充。 */
function sendJson(response, status, payload, headers = {}) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        ...headers,
    });
    response.end(JSON.stringify(payload));
}

/**
 * 已调度标记：进程在 500ms 后才会退出，这段时间里并发点击只应生效一次。
 * 放在模块级而不是 apply 内，避免重复注册路由时各自持有一份。
 */
let restarting = false;

/**
 * GET /dsh-reboot/status：把「现在能不能重启、为什么不能」交给前端。
 *
 * `reachable` 用的是宽松版判定（restartReachableFrom：本机直连即可，不看 Origin）。
 * 原因：浏览器对同源的 GET 请求不带 Origin，若拿 POST 那套严格判定来算，
 * 正常打开页面时它恒为 false，前端只能把按钮永久置灰。
 * 这个字段只回答「请求是不是来自本机」，不是放行依据 ——
 * 真正的门禁仍然在 POST 上（那里要求 Origin 与 Host 同源）。
 */
function handleStatus(config, request, response) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: '仅支持 GET 请求' }, { allow: 'GET' });
        return;
    }
    sendJson(response, 200, {
        ok: true,
        pid: process.pid,
        port: servingPort(request),
        boot: BOOT_ID,
        restart: restartAllowed(config),
        supervisor: detectedSupervisor(),
        debugger: detectedDebugger(),
        reachable: restartReachableFrom(request),
    });
}

/** POST /dsh-reboot/restart：逐层校验通过后才调度自重启。 */
function handleRestart(context, config, request, response) {
    const log = loggerOf(context);
    if (request.method !== 'POST') {
        sendJson(response, 405, { error: '仅支持 POST 请求' }, { allow: 'POST' });
        return;
    }
    // 1. 部署形态：显式关闭，或宿主跑在守护器之下（重启权归守护器）。
    if (!restartAllowed(config)) {
        sendJson(response, 403, { error: '本宿主已禁用自重启' });
        return;
    }
    // 2. 调试器：无论配置怎么写都拒绝，调试会话不该被无声杀掉。
    const debuggerKind = detectedDebugger();
    if (debuggerKind !== null) {
        sendJson(response, 403, { error: '当前进程处于调试状态，不允许自重启' });
        return;
    }
    // 3. 请求来源：必须是本机直连且同源，挡掉跨站与 DNS rebinding。
    if (!trustedRebootRequest(request)) {
        sendJson(response, 403, { error: '仅接受本机同源请求' });
        return;
    }
    if (restarting) {
        sendJson(response, 409, { error: '重启已调度' });
        return;
    }
    restarting = true;
    try {
        // 端口取自本次请求的 Host 头：重启后的新进程必须接管同一个端口。
        const result = scheduleRestart(servingPort(request));
        log?.info?.(`重启已调度（pid ${String(result.pid)}，助手 ${String(result.helperPid)}），日志：${result.logErr}`);
        sendJson(response, 202, {
            ok: true,
            boot: BOOT_ID,
            pid: result.pid,
            helperPid: result.helperPid,
            logOut: result.logOut,
            logErr: result.logErr,
        });
    }
    catch (error) {
        // 调度失败时进程还活着，必须把标记复位，否则按钮永远只会得到 409。
        restarting = false;
        const message = error instanceof Error ? error.message : String(error);
        log?.error?.(`重启调度失败：${message}`);
        sendJson(response, 500, { error: message });
    }
}

/**
 * 插件入口。
 *
 * webServer 是宿主提供的可选服务：等它可用再注册路由，注册动作放进 effect，
 * 插件卸载/重载时由 effect 的清理函数反注册，不会留下野路由。
 */
export function apply(ctx, config = {}) {
    ctx.inject(['webServer'], (hostCtx) => {
        hostCtx.effect(() => {
            const routes = [
                {
                    kind: 'exact',
                    path: '/dsh-reboot/status',
                    handler: (request, response) => handleStatus(config, request, response),
                },
                {
                    kind: 'exact',
                    path: '/dsh-reboot/restart',
                    handler: (request, response) => handleRestart(ctx, config, request, response),
                },
            ];
            const disposers = routes.map((route) => hostCtx.webServer.register(route));
            loggerOf(ctx)?.debug?.('已注册 /dsh-reboot 路由');
            return () => {
                for (const dispose of disposers.flat()) {
                    try {
                        dispose();
                    }
                    catch {
                        // 反注册失败只可能发生在宿主已整体停机时，忽略即可。
                    }
                }
            };
        }, 'dsh-reboot: HTTP 路由');
    });
}
