/**
 * dsh-lightpanda-cdp 的浏览器半区：插件页上的端点设置卡片。
 *
 * 为什么需要它：dsh 的插件配置页只渲染插件自己注册的卡片，导出 Config 并不会
 * 自动长出表单。所以 host 半区把端点开成 JSON 路由（/lightpanda-cdp/config），
 * 这张卡片注册到 `plugins.bundle.config`（以包名为 key）负责显示与编辑。
 *
 * 写法沿用 dsh 的懒加载 CJS bundle 协议（window.__ModuleLoader__.load + 返回
 * cordis 插件导出），不需要构建步骤，也不 import 任何 dsh client 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lightpanda-cdp',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** 与 package.json 的 name 一致；也是 plugins.bundle.config 的 key。 */
    var PACKAGE_NAME = 'dsh-lightpanda-cdp'
    var ROUTE = '/lightpanda-cdp/config'

    var zh = {
      title: 'Lightpanda 端点',
      subtitle: 'CDP 服务地址。保存后立即生效，不需要重启 DSH。',
      host: '主机',
      hostHint: 'DSH 容器内可解析的主机名，例如 lightpanda 或 127.0.0.1。',
      port: '端口',
      portHint: 'CDP 监听端口，默认 9222。',
      hostHeader: 'Host 标头',
      hostHeaderHint: 'Lightpanda 只接受 loopback 主机名（127.0.0.1），否则返回 403。',
      timeoutMs: '请求预算（ms）',
      timeoutHint: '一次 CDP 呼叫的默认超时，默认 30000。',
      effective: '当前生效',
      reachable: '可达',
      unreachable: '不可达',
      sources: '取值来源',
      sourceCall: '单次调用参数',
      sourceEnv: '环境变量',
      sourceFile: '设置文件',
      sourceConfig: '插件配置',
      sourceDefault: '内建默认',
      envWarning: '环境变量正在覆盖此字段，保存文件不会改变生效值：',
      file: '设置文件',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      reset: '恢复默认',
      resetting: '恢复中…',
      resetDone: '已恢复默认',
      loadFailed: '读取设置失败',
      retry: '重试',
      loading: '读取中…',
      probeFailed: '探测失败',
      noRoute: '未检测到设置路由',
    }

    var en = {
      title: 'Lightpanda endpoint',
      subtitle: 'CDP service address. Saving takes effect immediately; no DSH restart needed.',
      host: 'Host',
      hostHint: 'Hostname the DSH container can resolve, e.g. lightpanda or 127.0.0.1.',
      port: 'Port',
      portHint: 'CDP listen port, 9222 by default.',
      hostHeader: 'Host header',
      hostHeaderHint: 'Lightpanda only accepts a loopback hostname (127.0.0.1); anything else returns 403.',
      timeoutMs: 'Request budget (ms)',
      timeoutHint: 'Default timeout for one CDP call, 30000 by default.',
      effective: 'In effect',
      reachable: 'reachable',
      unreachable: 'unreachable',
      sources: 'Where each value comes from',
      sourceCall: 'call arguments',
      sourceEnv: 'environment',
      sourceFile: 'settings file',
      sourceConfig: 'plugin config',
      sourceDefault: 'built-in default',
      envWarning: 'Environment variables override these fields; saving the file will not change what runs:',
      file: 'Settings file',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed',
      reset: 'Restore defaults',
      resetting: 'Restoring…',
      resetDone: 'Defaults restored',
      loadFailed: 'Could not read the settings',
      retry: 'Retry',
      loading: 'Loading…',
      probeFailed: 'Probe failed',
      noRoute: 'Settings route not found',
    }

    function labels(language) {
      return String(language || '').toLowerCase().startsWith('en') ? en : zh
    }

    function request(method, payload) {
      var init = { method: method, headers: { accept: 'application/json' } }
      if (payload !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(payload)
      }
      return fetch(ROUTE, init).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
          return body
        })
      })
    }

    function draftOf(snapshot) {
      var endpoint = (snapshot && snapshot.endpoint) || {}
      return {
        host: String(endpoint.host || ''),
        port: String(endpoint.port || ''),
        hostHeader: String(endpoint.hostHeader || ''),
        timeoutMs: String(endpoint.timeoutMs || ''),
      }
    }

    function isDirty(snapshot, draft) {
      if (!snapshot || !draft) return false
      var saved = draftOf(snapshot)
      return (
        draft.host !== saved.host ||
        draft.port !== saved.port ||
        draft.hostHeader !== saved.hostHeader ||
        draft.timeoutMs !== saved.timeoutMs
      )
    }

    function EndpointCard(react, localeRef) {
      var h = react.createElement
      var borderColor = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))'
      var labelSecondary = 'var(--dsw-alias-label-secondary, inherit)'
      var labelTertiary = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))'
      var positive = 'var(--dsw-alias-label-positive, #2f9e44)'
      var negative = 'var(--dsw-alias-label-negative, #e03131)'

      var subscribeLocale = function (onChange) {
        var locale = localeRef && localeRef.current
        return locale ? locale.subscribe(onChange) : function () {}
      }
      var readLocale = function () {
        var locale = localeRef && localeRef.current
        return locale ? locale.getSnapshot().active : ''
      }

      function useLabel() {
        if (typeof react.useSyncExternalStore === 'function') {
          return react.useSyncExternalStore(subscribeLocale, readLocale)
        }
        return readLocale()
      }

      function field(label, hint, input) {
        return h(
          'label',
          { style: { display: 'block', marginBottom: '10px' } },
          h('div', { style: { fontSize: '12px', color: labelSecondary, marginBottom: '4px' } }, label),
          input,
          hint
            ? h('div', { style: { fontSize: '11px', color: labelTertiary, marginTop: '3px' } }, hint)
            : null,
        )
      }

      function inputStyle() {
        return {
          boxSizing: 'border-box',
          width: '100%',
          font: 'inherit',
          fontSize: '13px',
          padding: '5px 8px',
          color: 'inherit',
          background: 'var(--dsw-alias-bg-layer-2, transparent)',
          border: '1px solid ' + borderColor,
          borderRadius: '8px',
        }
      }

      function buttonStyle(primary, disabled) {
        return {
          appearance: 'none',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: 1.5,
          padding: '5px 14px',
          borderRadius: '8px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          border: '1px solid ' + (primary ? 'transparent' : borderColor),
          background: primary ? 'var(--dsw-alias-label-primary, currentColor)' : 'none',
          color: primary ? 'var(--dsw-alias-bg-layer-3, white)' : 'inherit',
        }
      }

      function sourceName(t, layer) {
        if (layer === 'env') return t.sourceEnv
        if (layer === 'file') return t.sourceFile
        if (layer === 'config') return t.sourceConfig
        if (layer === 'call') return t.sourceCall
        return t.sourceDefault
      }

      return function LightpandaEndpointCard() {
        var t = labels(useLabel())
        var snapshotState = react.useState(null)
        var snapshot = snapshotState[0]
        var setSnapshot = snapshotState[1]
        var draftState = react.useState(null)
        var draft = draftState[0]
        var setDraft = draftState[1]
        var noteState = react.useState('')
        var note = noteState[0]
        var setNote = noteState[1]
        var busyState = react.useState('')
        var busy = busyState[0]
        var setBusy = busyState[1]

        var apply = react.useCallback(function (body) {
          setSnapshot(body)
          setDraft(draftOf(body))
        }, [])

        var load = react.useCallback(function () {
          setNote(t.loading)
          return request('GET')
            .then(function (body) {
              apply(body)
              setNote('')
            })
            .catch(function (error) {
              setNote(error.message || t.loadFailed)
            })
        }, [])

        react.useEffect(function () {
          load()
        }, [])

        var save = function () {
          if (!draft) return
          setBusy('save')
          setNote(t.saving)
          request('POST', {
            host: draft.host.trim(),
            port: Number(draft.port),
            hostHeader: draft.hostHeader.trim(),
            timeoutMs: Number(draft.timeoutMs),
          })
            .then(function (body) {
              apply(body)
              setNote(t.saved)
            })
            .catch(function (error) {
              setNote(error.message || t.saveFailed)
            })
            .finally(function () {
              setBusy('')
            })
        }

        var reset = function () {
          setBusy('reset')
          setNote(t.resetting)
          request('POST', { reset: true })
            .then(function (body) {
              apply(body)
              setNote(t.resetDone)
            })
            .catch(function (error) {
              setNote(error.message || t.saveFailed)
            })
            .finally(function () {
              setBusy('')
            })
        }

        if (!snapshot) {
          return h(
            'div',
            { style: { padding: '12px 0', fontSize: '13px', color: labelSecondary } },
            note || t.loading,
            note && note !== t.loading
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: load,
                    style: Object.assign(buttonStyle(false, false), { marginLeft: '10px' }),
                  },
                  t.retry,
                )
              : null,
          )
        }

        var probe = snapshot.probe || {}
        var sources = snapshot.sources || {}
        var envFields = Object.keys(snapshot.env || {})
        var dirty = isDirty(snapshot, draft)

        return h(
          'div',
          null,
          h(
            'div',
            { style: { paddingTop: '12px' } },
            h('div', { style: { fontSize: '14px', color: labelSecondary, marginBottom: '4px' } }, t.title),
            h('div', { style: { fontSize: '12px', color: labelTertiary } }, t.subtitle),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '16px', alignItems: 'baseline', marginTop: '10px', flexWrap: 'wrap' } },
            h(
              'code',
              { style: { fontSize: '13px' } },
              snapshot.endpoint.host + ':' + snapshot.endpoint.port,
            ),
            h(
              'span',
              { style: { fontSize: '12px', color: probe.ok ? positive : negative } },
              probe.ok
                ? t.reachable + ' · ' + (probe.lightpanda || probe.browser || '')
                : t.unreachable + ' · ' + (probe.error || t.probeFailed),
            ),
          ),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: '12px' } },
            field(
              t.host,
              t.hostHint + ' · ' + sourceName(t, sources.host),
              h('input', {
                type: 'text',
                value: draft.host,
                spellCheck: false,
                onChange: function (event) {
                  setDraft(Object.assign({}, draft, { host: event.target.value }))
                },
                style: inputStyle(),
              }),
            ),
            field(
              t.port,
              t.portHint + ' · ' + sourceName(t, sources.port),
              h('input', {
                type: 'number',
                min: 1,
                max: 65535,
                value: draft.port,
                onChange: function (event) {
                  setDraft(Object.assign({}, draft, { port: event.target.value }))
                },
                style: inputStyle(),
              }),
            ),
            field(
              t.hostHeader,
              t.hostHeaderHint + ' · ' + sourceName(t, sources.hostHeader),
              h('input', {
                type: 'text',
                value: draft.hostHeader,
                spellCheck: false,
                onChange: function (event) {
                  setDraft(Object.assign({}, draft, { hostHeader: event.target.value }))
                },
                style: inputStyle(),
              }),
            ),
            field(
              t.timeoutMs,
              t.timeoutHint + ' · ' + sourceName(t, sources.timeoutMs),
              h('input', {
                type: 'number',
                min: 1000,
                step: 1000,
                value: draft.timeoutMs,
                onChange: function (event) {
                  setDraft(Object.assign({}, draft, { timeoutMs: event.target.value }))
                },
                style: inputStyle(),
              }),
            ),
          ),
          envFields.length
            ? h(
                'div',
                { style: { fontSize: '11px', color: labelTertiary, marginTop: '2px' } },
                t.envWarning + ' ' + envFields.join(', '),
              )
            : null,
          snapshot.warning
            ? h('div', { style: { fontSize: '11px', color: negative, marginTop: '4px' } }, snapshot.warning)
            : null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap' } },
            h(
              'span',
              { role: 'status', style: { fontSize: '12px', color: labelTertiary, marginRight: 'auto' } },
              note,
            ),
            h(
              'button',
              { type: 'button', onClick: reset, disabled: Boolean(busy), style: buttonStyle(false, Boolean(busy)) },
              busy === 'reset' ? t.resetting : t.reset,
            ),
            h(
              'button',
              { type: 'button', onClick: save, disabled: Boolean(busy) || !dirty, style: buttonStyle(true, Boolean(busy) || !dirty) },
              busy === 'save' ? t.saving : t.save,
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11px', color: labelTertiary, marginTop: '10px', borderTop: '1px solid ' + borderColor, paddingTop: '8px' } },
            t.file + ': ' + snapshot.configPath,
          ),
        )
      }
    }

    /** 只在 host 路由真的存在时挂卡片：404 说明没装 web 半区或路由未注册。 */
    function registerCard(ctx) {
      if (typeof ctx.inject !== 'function') return
      var localeRef = { current: null }

      ctx.inject(['locale'], function (scope) {
        localeRef.current = scope.locale
        if (typeof scope.effect === 'function') {
          scope.effect(
            function () {
              return function () {
                localeRef.current = null
              }
            },
            'lightpanda-cdp: locale handle',
          )
        }
      })

      ctx.inject(['slots'], function (scope) {
        fetch(ROUTE)
          .then(function (response) {
            if (response.status === 404) return
            try {
              mountCard(scope, localeRef)
            } catch (error) {
              console.error('[lightpanda-cdp] settings card skipped: ' + error)
            }
          })
          .catch(function () {})
      })
    }

    function mountCard(ctx, localeRef) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error('[lightpanda-cdp] settings card skipped: ' + error)
        return
      }
      var Card = EndpointCard(react, localeRef)
      ctx.slots.inject('plugins.bundle.config', function* () {
        yield ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, Card)
      })
    }

    function apply(ctx) {
      registerCard(ctx)
    }

    exports.apply = apply
    exports.inject = []
    exports.__card = { draftOf, isDirty, labels }
    return module.exports
  },
})
