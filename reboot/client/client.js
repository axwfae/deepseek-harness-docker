/**
 * dsh-manual-reboot —— 浏览器端半边。
 *
 * 宿主用 __ModuleLoader__ 加载本文件：factory 收到一个同步 require，
 * 只从宿主静态模块表取 react（与 dshmarket 等插件同一来源）。
 * 导出的 { name, inject, apply } 由 cordis 客户端 loader 调用。
 *
 * 交互：设置页「重启」卡片 → 点「立即重启」→ 二次确认 → POST /dsh-reboot/restart
 * → 每 1.5s 轮询 /dsh-reboot/status，boot id 变了就 location.reload()。
 * 不碰 WebSocket：进程重启期间 fetch 抛错属于正常现象，继续轮询即可。
 *
 * 视觉：不带自己的卡片外壳（宿主设置页已经提供了容器），只做内容分层——
 * 状态点 + 徽章、等宽技术值、柔和的分隔线、主次分明的按钮、带左强调条的提示块。
 * 所有文字颜色走 inherit，有色只出现在圆点、边框和半透明底色上，
 * 因此浅色与深色主题下都不依赖某个具体主题变量存在。
 */
window.__ModuleLoader__.load({
  id: "dsh-manual-reboot",
  factory: (require) => {
    const React = require("react")
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const name = "dsh-manual-reboot"
    const inject = ["slots"]

    /** 反代/子路径部署下也能拼出正确的接口路径。 */
    function api(path) {
      const relative = path.replace(/^\/+/, "")
      if (typeof document === "undefined") return "/" + relative
      return new URL(relative, document.baseURI).pathname
    }

    /** 把 status 的能力位翻译成一句人话，没有限制时返回 null。 */
    function blockReason(status) {
      if (status === null) return null
      if (status.supervisor === "systemd") return "本进程由 systemd 托管，请用 systemctl restart 重启，页面内不提供。"
      if (status.debugger === "inspector") return "当前进程挂着调试器，界面内不允许杀进程。"
      if (status.restart === false) return "本宿主已禁用自重启（allowRestart: false）。"
      if (status.reachable === false) return "只接受本机直连的同源请求；通过代理或远程地址访问时不可用。"
      return null
    }

    /** 技术值（PID / 端口 / boot）单独用等宽，正文与标题继续跟随宿主字体。 */
    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

    /** 只放无法用内联样式表达的几件事：重启中的呼吸点、键盘焦点环、减少动效偏好。 */
    const CARD_CSS = [
      "@keyframes dshRebootPulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(77,107,254,0.34)}50%{opacity:.55;box-shadow:0 0 0 4px rgba(77,107,254,0)}}",
      ".dsh-reboot-dot-pulse{animation:dshRebootPulse 1.5s ease-in-out infinite}",
      "[data-dsh-reboot] button:focus-visible{outline:2px solid var(--dsh-accent,#4d6bfe);outline-offset:2px;border-radius:8px}",
      "@media (prefers-reduced-motion:reduce){.dsh-reboot-dot-pulse{animation:none}}",
    ].join("\n")

    const S = {
      wrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 },
      title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45, letterSpacing: "0.01em" },
      desc: { margin: 0, fontSize: 13, lineHeight: 1.75, opacity: 0.72, maxWidth: "60ch" },
      metaRow: {
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "8px 14px",
        fontSize: 12,
        lineHeight: 1.7,
        minHeight: 24,
      },
      badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 9px 2px 8px",
        borderRadius: 999,
        border: "1px solid rgba(128,128,128,0.26)",
        background: "rgba(128,128,128,0.07)",
        fontSize: 11.5,
        lineHeight: 1.7,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      },
      dot: {
        width: 6,
        height: 6,
        borderRadius: "50%",
        flex: "0 0 auto",
        boxShadow: "0 0 0 3px rgba(128,128,128,0.14)",
      },
      metaItem: { display: "inline-flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" },
      metaKey: { opacity: 0.5, fontSize: 11.5, letterSpacing: "0.02em" },
      metaVal: { fontFamily: MONO, fontSize: 11.5, opacity: 0.9 },
      sep: {
        height: 1,
        margin: "2px 0",
        border: 0,
        background: "linear-gradient(90deg, rgba(128,128,128,0.30), rgba(128,128,128,0.04))",
      },
      actions: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      confirmText: { fontSize: 13, lineHeight: 1.65, opacity: 0.85, maxWidth: "44ch" },
      aside: { fontSize: 12.5, lineHeight: 1.65, opacity: 0.7 },
      notice: {
        fontSize: 12.5,
        lineHeight: 1.65,
        borderRadius: 8,
        padding: "9px 12px",
        border: "1px solid transparent",
      },
      // 提示块只用半透明底色 + 中性文字色，深色主题不会出现低对比的深棕/暗红字。
      warn: {
        background: "rgba(214,150,40,0.10)",
        borderColor: "rgba(214,150,40,0.30)",
        boxShadow: "inset 2px 0 0 rgba(214,150,40,0.55)",
      },
      error: {
        background: "rgba(220,80,70,0.10)",
        borderColor: "rgba(220,80,70,0.32)",
        boxShadow: "inset 2px 0 0 rgba(220,80,70,0.60)",
      },
      hint: {
        background: "rgba(128,128,128,0.09)",
        borderColor: "rgba(128,128,128,0.22)",
        boxShadow: "inset 2px 0 0 var(--dsh-accent, #4d6bfe)",
      },
    }

    /**
     * 按钮只分「主」「次」两档，状态只分「常态 / 悬停 / 禁用」。
     * 主按钮用 accent（拿不到就退回 #4d6bfe），次按钮用中性半透明，二者都不写死背景色。
     */
    function buttonStyle(kind, state) {
      const base = {
        appearance: "none",
        font: "inherit",
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1.6,
        padding: "7px 15px",
        borderRadius: 8,
        cursor: "pointer",
        whiteSpace: "nowrap",
        transition: "background-color 120ms ease, border-color 120ms ease, filter 120ms ease, opacity 120ms ease",
      }
      if (kind === "primary") {
        const style = Object.assign(base, {
          border: "1px solid transparent",
          color: "#fff",
          background: "var(--dsh-accent, #4d6bfe)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.16)",
          filter: state === "hover" ? "brightness(1.08)" : "none",
        })
        if (state === "disabled") {
          style.opacity = 0.5
          style.cursor = "not-allowed"
          style.filter = "none"
          style.boxShadow = "none"
        }
        return style
      }
      return Object.assign(base, {
        border: "1px solid rgba(128,128,128,0.34)",
        color: "inherit",
        background: state === "hover" ? "rgba(128,128,128,0.16)" : "rgba(128,128,128,0.06)",
      })
    }

    function RestartCard(props) {
      const [status, setStatus] = useState(null)
      const [phase, setPhase] = useState("idle") // idle | confirm | restarting | failed
      const [error, setError] = useState(null)
      // 纯展示用的悬停档位，不参与重启状态机。
      const [hover, setHover] = useState(null) // "primary" | "ghost" | null
      const timer = useRef(null)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        fetch(api("/dsh-reboot/status"), { cache: "no-store" })
          .then((res) =>
            res
              .json()
              .catch(() => ({}))
              .then((body) => ({ code: res.status, body })),
          )
          .then(({ code, body }) => {
            if (!alive.current) return
            if (code === 200 && body !== null && body.ok === true) setStatus(body)
            // 服务端半边没起来时这里会拿到 404/403：把状态码留在界面上，
            // 否则用户只会看到一个永远灰着的「读取状态…」。
            else setStatus({ ok: false, error: String((body && body.error) || "HTTP " + String(code)) })
          })
          .catch(() => {
            if (alive.current) setStatus({ ok: false, error: "网络请求失败" })
          })
        return () => {
          alive.current = false
          if (timer.current !== null) clearTimeout(timer.current)
        }
      }, [])

      const reason = blockReason(status)
      const restarting = phase === "restarting"

      /** 进程换了一代（boot id 变化）才 reload，避免把"还没死"误判成成功。 */
      const awaitNewBoot = useCallback((previousBoot) => {
        const deadline = Date.now() + 60000
        const retry = () => {
          if (!alive.current) return
          if (Date.now() > deadline) {
            setPhase("failed")
            setError("等待新进程启动超时（60 秒）。可手动关闭 dsh 进程后重新运行 dsh web。")
            return
          }
          timer.current = setTimeout(poll, 1500)
        }
        const poll = () => {
          if (!alive.current) return
          fetch(api("/dsh-reboot/status"), { cache: "no-store" })
            .then((res) => res.json())
            .then((next) => {
              if (!alive.current) return
              // 没有基线就不敢判成功：把第一次连上当成"换了一代"会直接 reload 成死循环。
              if (previousBoot !== null && typeof next.boot === "string" && next.boot !== previousBoot) {
                globalThis.location.reload()
                return
              }
              retry()
            })
            .catch(retry) // 重启期间连接被拒是常态
        }
        retry()
      }, [])

      const requestRestart = useCallback(() => {
        setPhase("restarting")
        setError(null)
        // 先确立基线 boot id：页面刚加载就点按钮时 status 可能还是 null。
        const baseline = status !== null && typeof status.boot === "string" ? Promise.resolve(status.boot) : fetch(api("/dsh-reboot/status"), { cache: "no-store" })
          .then((res) => res.json())
          .then((body) => (typeof body.boot === "string" ? body.boot : null))
          .catch(() => null)
        baseline.then((previousBoot) => {
          if (!alive.current) return
          if (previousBoot === null) {
            setPhase("failed")
            setError("读不到插件状态（GET /dsh-reboot/status 失败），请确认插件已加载。")
            return
          }
          fetch(api("/dsh-reboot/restart"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
            .then((res) => res.json().then((body) => ({ status: res.status, body })))
            .then(({ status: code, body }) => {
              if (!alive.current) return
              if (code === 202 && body.ok === true) {
                awaitNewBoot(previousBoot)
                return
              }
              setPhase("failed")
              setError(String((body && body.error) || "HTTP " + String(code)))
            })
            .catch(() => awaitNewBoot(previousBoot)) // 进程可能在响应中途就退出了
        })
      }, [awaitNewBoot, status])

      const metaBits = []
      if (status && status.ok === true) {
        if (typeof status.pid === "number") metaBits.push(["PID", String(status.pid)])
        if (typeof status.port === "number") metaBits.push(["端口", String(status.port)])
        if (typeof status.boot === "string") metaBits.push(["boot", status.boot])
      }

      // 状态徽章：重启中 > 失败 > 受限 > 运行中 > 未知，颜色与文案同时变化，不只靠颜色传达。
      let view = { text: "读取状态…", color: "rgba(128,128,128,0.75)", pulse: false }
      if (restarting) {
        view = { text: "重启中", color: "var(--dsh-accent, #4d6bfe)", pulse: true }
      } else if (phase === "failed") {
        view = { text: "重启失败", color: "rgba(220,80,70,0.95)", pulse: false }
      } else if (reason !== null) {
        view = { text: "暂不可用", color: "rgba(214,150,40,0.95)", pulse: false }
      } else if (status !== null && status.ok === false) {
        view = { text: "状态读取失败", color: "rgba(220,80,70,0.95)", pulse: false }
      } else if (status && status.ok === true) {
        view = { text: "运行中", color: "rgba(46,160,110,0.95)", pulse: false }
      }

      const hoverBind = (key) => ({
        onMouseEnter: () => setHover(key),
        onMouseLeave: () => setHover((current) => (current === key ? null : current)),
      })
      const primaryState = restarting || reason !== null ? "disabled" : hover === "primary" ? "hover" : null

      return h(
        "div",
        { style: S.wrap, "data-dsh-reboot": "" },
        h("style", null, CARD_CSS),
        h("h3", { style: S.title }, "重启 DeepSeek Harness"),
        h(
          "p",
          { style: S.desc },
          "结束当前 dsh 进程，并按原启动参数重新拉起，让插件安装、卸载或配置改动生效。",
          "期间对话与页面连接会短暂断开；新进程接管端口后，本页自动刷新。",
        ),
        h(
          "div",
          { style: S.metaRow },
          h(
            "span",
            { style: S.badge, role: "status", "aria-live": "polite" },
            h("span", {
              style: Object.assign({}, S.dot, { background: view.color }),
              className: view.pulse ? "dsh-reboot-dot-pulse" : undefined,
            }),
            view.text,
          ),
          metaBits.map(([label, value]) =>
            h(
              "span",
              { key: label, style: S.metaItem },
              h("span", { style: S.metaKey }, label),
              h("span", { style: S.metaVal }, value),
            ),
          ),
        ),
        reason !== null
          ? h("div", { style: Object.assign({}, S.notice, S.warn) }, reason)
          : null,
        status !== null && status.ok === false && !restarting
          ? h(
              "div",
              { style: Object.assign({}, S.notice, S.error), role: "alert" },
              "读不到插件接口（" + String(status.error) + "）。刚安装本插件时，需要先手动重启一次 dsh web，服务端路由才会注册。",
            )
          : null,
        h("div", { style: S.sep }),
        phase === "confirm"
          ? h(
              "div",
              { style: S.actions },
              h("span", { style: S.confirmText }, "确认重启？本页连接会立即断开，正在进行的操作可能中断。"),
              h(
                "button",
                Object.assign(
                  {
                    type: "button",
                    style: buttonStyle("primary", hover === "primary" ? "hover" : null),
                    onClick: requestRestart,
                  },
                  hoverBind("primary"),
                ),
                "确认重启",
              ),
              h(
                "button",
                Object.assign(
                  {
                    type: "button",
                    style: buttonStyle("ghost", hover === "ghost" ? "hover" : null),
                    onClick: () => setPhase("idle"),
                  },
                  hoverBind("ghost"),
                ),
                "取消",
              ),
            )
          : h(
              "div",
              { style: S.actions },
              h(
                "button",
                Object.assign(
                  {
                    type: "button",
                    style: buttonStyle("primary", primaryState),
                    disabled: restarting || reason !== null,
                    "aria-busy": restarting ? "true" : "false",
                    onClick: () => setPhase("confirm"),
                  },
                  primaryState === "disabled" ? null : hoverBind("primary"),
                ),
                restarting ? "正在重启…" : "立即重启",
              ),
              restarting
                ? h("span", { style: S.aside }, "等待新进程接管端口，就绪后本页自动刷新。")
                : null,
            ),
        restarting
          ? h(
              "div",
              { style: Object.assign({}, S.notice, S.hint), role: "status", "aria-live": "polite" },
              "重启中。若 60 秒内仍未自动刷新，请手动重启 dsh web。",
            )
          : null,
        phase === "failed" && error !== null
          ? h("div", { style: Object.assign({}, S.notice, S.error), role: "alert" }, error)
          : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "manual-reboot",
            order: 90,
            label: () => "重启",
          },
          RestartCard,
        ),
      )
    }

    return { name, inject, apply }
  },
})
