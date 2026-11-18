/**
 * 浏览器半：在「设置 → 插件」里注册本插件的配置卡片。
 *
 * 为什么需要这个文件：
 *   DSH 的 Web GUI 没有「按 Config schema 自动生成表单」的实现。插件配置卡片由各
 *   插件自己往 `plugins.item` 插槽注册（官方范式见
 *   dsh-client-ui-settings-agent-loop/lib/client.js）。只改 host 侧 Config 不会出现
 *   任何控件，用户因此看不到「模型档位」。
 *
 * 运行时形态（重要）：
 *   浏览器用普通 <script> 加载本文件，因此这里**不能有 import / export 语句**，
 *   必须整体包在 `window.__ModuleLoader__.load({ id, factory })` 里，且 id 必须
 *   精确等于 package.json 的 name。React 与 UI primitives 由平台种子表提供，
 *   直接 `require()` 即可，不需要打包。
 *
 * 注册在哪个插槽（关键）：
 *   **`plugins.bundle.config`**，key 用包名。不能用 `plugins.item` —— 那个插槽是官方
 *   设置页专用的（slot-contract.d.ts 里明确写着「a bundle's configuration belongs in
 *   `plugins.bundle.config` or `plugins.row.config` instead」）。用错插槽的表现是：
 *   插件详情页里什么都不显示，但控制台不报错，很难查。
 *   该插槽只在插件详情页渲染，view 固定为 'page'，所以卡片里不需要 summary 分支。
 *
 * 卡片包含两块：
 *   1. 设置表单：模型档位（SegmentedControl）与推理线程数（文本输入），保存后写进
 *      profile 的 patch，不重载插件。
 *   2. 模型管理：通过 Connection RPC 向 host 询问各档位是否已下载、占用多少，并提供
 *      删除按钮（删除前要二次确认，因为 full 档有 239MB）。
 *
 * 关于控件的两个约定（照官方实现核对过，见 dsh-client-ui-settings-models 与
 * dsh-experimental-client-ui-cot-translation）：
 *   1. `props.edit(field, token)` 的第二参**只能是字符串**，真正的值由 spec.parse
 *      从 token 推出；所以枚举字段的选中/未选中都走字符串 token。
 *   2. `SettingsValueField` 只会渲染 <input type="text">，没有枚举能力。枚举要自己
 *      用 SegmentedControl 画，并且 overridden 徽标与「恢复默认」按钮也要自己画
 *      （SettingsValueField 不会代劳）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-youtube-subtitles',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 必须与 cordis.patch.yml 里的 entry id 一致，否则拿不到 form。 */
    const ENTRY_ID = 'youtube-subtitles'
    /** bundle 的包名，作为 plugins.bundle.config 这个 keyed 插槽的 key。 */
    const PACKAGE_NAME = 'dsh-plugin-youtube-subtitles'
    /** 本插件拥有的词典命名空间。 */
    const NS = 'settings.youtubeSubtitles'
    /** host 侧用 `webServer.register` 挂的 prefix 路由，两边必须逐字一致。 */
    const RPC_CHANNEL = '/youtube-subtitles'

    /** 档位 token 与 host 侧 MODEL_TIERS 的 key 一一对应。 */
    const TIERS = ['small', 'full']
    /** 未配置（或配置损坏）时的兜底档位，必须与 host 的 DEFAULT_TIER 一致。 */
    const FALLBACK_TIER = 'small'

    const zh = {
      title: 'YouTube 字幕',
      description: '抓取 YouTube 已有字幕，或用本地小模型把无字幕视频转成字幕。',
      tier: '模型档位',
      tierSmall: '轻量 small',
      tierFull: '全能 full',
      tierSmallTitle: '74MB，最快，但只适合纯中文：英文词错误率 54%，专名会被汉字化',
      tierFullTitle: '239MB，带标点，中英混合与纯英文都准：英文词错误率 37%，专名保留原形',
      tierHint: '切档位不会自动下载；选定后让 Agent 安装对应模型（或查看模型状态）。',
      tierWarn: '视频里有英文（尤其是英文演讲、专名、数字）请选「全能 full」，轻量档的英文输出基本不可用。',
      threads: '推理线程数',
      threadsHint: '本地语音识别的 CPU 线程数，建议不超过物理核心数。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidThreads: '请填 1–32 的整数；留空表示使用默认值。',
      resources: '资源管理',
      resourcesHint: '模型与工具都装在本插件自己的目录里，不会写入系统目录；卸载时一并删除。',
      models: '语音识别模型',
      tools: '依赖工具',
      inUse: '当前使用',
      tierOverride: '当前档位由工具切换为',
      tierOverrideHint: '配置里的档位是',
      tierOverrideClear: '恢复配置值',
      tierOverrideStale: '配置档位已改动，工具切换记录已失效',
      notDownloaded: '未下载',
      download: '下载',
      downloading: '正在下载',
      ready: '可用',
      missing: '缺失',
      sourceBundled: '插件目录',
      sourceSystem: '系统 PATH',
      sourceConfigured: '配置指定',
      delete: '删除',
      confirmDelete: '确认删除？',
      cancel: '取消',
      loading: '读取中…',
      loadFailed: '读取状态失败：',
      deletedFreed: ' 已删除，释放 ',
      nothingToDelete: '没有可删除的文件',
      deleteFailed: '删除失败：',
      jobFailed: '操作失败：',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
    }

    const en = {
      title: 'YouTube subtitles',
      description: 'Fetch existing YouTube captions, or transcribe caption-less videos with a small on-device model.',
      tier: 'Model tier',
      tierSmall: 'Light small',
      tierFull: 'Full full',
      tierSmallTitle: '74 MB, fastest, but Chinese only in practice: 54% English word error rate, names get sinicised',
      tierFullTitle: '239 MB, punctuation; solid on mixed and pure English: 37% word error rate, names keep their form',
      tierHint: 'Switching does not download anything; ask the agent to install the selected model.',
      tierWarn: 'If the video contains English — especially English speech, names or numbers — pick "Full full". The light tier\'s English output is effectively unusable.',
      threads: 'Inference threads',
      threadsHint: 'CPU threads for local speech recognition; keep it at or below the physical core count.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidThreads: 'Enter an integer from 1 to 32; leave blank for the default.',
      resources: 'Resources',
      resourcesHint: 'Models and tools live inside this plugin directory, never in system paths, and are removed on uninstall.',
      models: 'Speech models',
      tools: 'Required tools',
      inUse: 'In use',
      tierOverride: 'Tier currently switched by the agent to',
      tierOverrideHint: 'the configured tier is',
      tierOverrideClear: 'Use configured',
      tierOverrideStale: 'The configured tier changed, so the agent override no longer applies',
      notDownloaded: 'Not downloaded',
      download: 'Download',
      downloading: 'Downloading',
      ready: 'Ready',
      missing: 'Missing',
      sourceBundled: 'Plugin directory',
      sourceSystem: 'System PATH',
      sourceConfigured: 'Configured path',
      delete: 'Delete',
      confirmDelete: 'Delete now?',
      cancel: 'Cancel',
      loading: 'Loading…',
      loadFailed: 'Could not read status: ',
      deletedFreed: ' deleted, freed ',
      nothingToDelete: 'Nothing to delete',
      deleteFailed: 'Delete failed: ',
      jobFailed: 'Failed: ',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * 档位字段规格。
     *
     * format 必须返回字符串，并且是 parse 的逆向：SettingsFormModel 用
     * `staged.text === format(sectionValue)` 判断「有没有改动」，一旦它返回
     * 非字符串或与 parse 不对称，字段会永远处于 dirty 或者选回默认值却不写入。
     * 这里对未知值兜底成 FALLBACK_TIER，顺带保证 SegmentedControl 的选中项
     * 一定能命中 options（否则指示条 index=-1 会错位）。
     */
    const tierSpec = {
      field: 'tier',
      format: (value) => (TIERS.includes(value) ? value : FALLBACK_TIER),
      parse: (text) => {
        const raw = String(text ?? '').trim()
        if (raw === '') return { kind: 'clear' }
        return TIERS.includes(raw) ? { kind: 'set', value: raw } : undefined
      },
    }

    const threadsSpec = {
      field: 'numThreads',
      format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
      parse: (text) => {
        const raw = String(text ?? '').trim()
        if (raw === '') return { kind: 'clear' }
        const n = Number(raw)
        return Number.isInteger(n) && n >= 1 && n <= 32 ? { kind: 'set', value: n } : undefined
      },
    }

    /* 本包没有自己的样式表（平台不提供 CSS module），自画的部分用内联样式，
     * 只求与官方卡片视觉接近：小字提示、行内徽标、不抢主内容的层级。 */
    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '16px' },
      row: { display: 'flex', flexDirection: 'column', gap: '8px' },
      head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { margin: 0, fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      badgeRow: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        paddingTop: '14px',
        borderTop: '1px solid rgba(128, 128, 128, 0.25)',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsh-color-danger, #d9534f)' },
      warn: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsh-color-warning, #b8860b)' },
      ok: { margin: 0, fontSize: '12px', color: 'var(--dsh-color-success, #3f8f4f)' },
      strongish: { fontSize: '13px', fontWeight: 500 },
      subLabel: { fontSize: '12px', fontWeight: 600, opacity: 0.8, marginTop: '4px' },
      row2: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid rgba(128, 128, 128, 0.2)',
      },
    }

    /**
     * 字节 -> 「12.3 MB」。
     *
     * 用十进制 MB（1e6）而不是 MiB（1024²）：README 与工具输出里的 74MB / 239MB 都是
     * 十进制，两处口径必须一致，否则用户会看到「明明写的 74MB，界面却说 70.6MB」。
     */
    function mbText(bytes) {
      const mb = (Number(bytes) || 0) / 1e6
      return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`
    }

    /**
     * 生成卡片组件。
     *
     * 用闭包持有 ctx：模型管理要发 RPC，而插槽注入面只传 hooks / 表单动作，不传 ctx。
     *
     * @param ctx - 浏览器插件上下文
     */
    function createCard(ctx) {
      /** 调 host 的 RPC；失败统一抛错，UI 只处理一个分支。 */
      async function callRpc(endpoint, payload) {
        // 直接 POST 到插件自己挂在 webServer 上的 prefix 路由。
        //
        // 为什么不用 ctx.connection.rpc：`/api` 被 api-gateway 独占（只能一个拦截器），
        // 而 `rpc.handle` 内部的 owner.webServer 语义在真实宿主上让路由挂不上，
        // 只会得到 HTTP 405。自建 HTTP 路由是唯一不依赖中间层语义的路径。
        const response = await fetch(`${RPC_CHANNEL}/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        if (!response.ok) {
          throw new Error(`请求失败：HTTP ${response.status}`)
        }
        const result = await response.json()
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? 'RPC 调用失败')
        return result.value
      }

      /**
       * 资源管理区块：模型档位 + 二进制（yt-dlp / ffmpeg）。
       *
       * 下载走「后台任务 + 轮询」：RPC 立即返回 jobId，这里每 800ms 查一次状态，
       * 避免几十秒的下载把卡片卡住（也避免中间层超时）。
       */
      function ResourceSection(props) {
        const { t } = props
        const [data, setData] = React.useState(null)
        const [loading, setLoading] = React.useState(true)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(null) // 正在进行的 jobId
        const [job, setJob] = React.useState(null) // { label, state, message }
        const [confirming, setConfirming] = React.useState(null) // 'model:small' | 'bin:ytdlp'
        const [message, setMessage] = React.useState(null)

        const refresh = React.useCallback(async () => {
          try {
            setData(await callRpc('status'))
            setError(null)
          } catch (err) {
            setError(String(err?.message ?? err))
          } finally {
            setLoading(false)
          }
        }, [])

        React.useEffect(() => {
          void refresh()
        }, [refresh])

        // 有任务在跑就轮询；任务结束后刷新一次状态
        React.useEffect(() => {
          if (!busy) return undefined
          let alive = true
          const tick = async () => {
            try {
              const j = await callRpc('jobStatus', { id: busy })
              if (!alive) return
              setJob(j)
              if (j.state === 'done' || j.state === 'failed' || j.state === 'unknown') {
                setBusy(null)
                setMessage(j.state === 'done' ? j.message : `${t('jobFailed')}${j.message}`)
                await refresh()
              }
            } catch (err) {
              if (alive) {
                setBusy(null)
                setMessage(`${t('jobFailed')}${String(err?.message ?? err)}`)
              }
            }
          }
          void tick()
          const timer = setInterval(() => void tick(), 800)
          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [busy, refresh, t])

        /** 发起一个后台任务：拿 jobId 后交给轮询。 */
        const launch = async (endpoint, payload, label) => {
          setMessage(null)
          setJob({ label, state: 'running', message: '' })
          try {
            const r = await callRpc(endpoint, payload)
            setBusy(r.jobId)
          } catch (err) {
            setJob(null)
            setMessage(`${t('jobFailed')}${String(err?.message ?? err)}`)
          }
        }

        const remove = async (endpoint, payload, label) => {
          setBusy('inline')
          setMessage(null)
          try {
            const r = await callRpc(endpoint, payload)
            setConfirming(null)
            setMessage(r.removed ? `${label}${t('deletedFreed')}${mbText(r.freedBytes)}` : t('nothingToDelete'))
            await refresh()
          } catch (err) {
            setMessage(`${t('deleteFailed')}${String(err?.message ?? err)}`)
          } finally {
            setBusy(null)
          }
        }

        /** 清除「由工具发起的档位切换」，让配置值重新生效。 */
        const clearOverride = async () => {
          setBusy('inline')
          setMessage(null)
          try {
            const r = await callRpc('clearTierOverride')
            setMessage(r.message ?? t('tierOverrideClear'))
            await refresh()
          } catch (err) {
            setMessage(`${t('jobFailed')}${String(err?.message ?? err)}`)
          } finally {
            setBusy(null)
          }
        }

        const blocked = busy !== null

        /** 通用的「删除 / 确认删除」按钮组。 */
        const deleteButtons = (key, onDelete) =>
          confirming === key
            ? [
                h(
                  P.Button,
                  { key: 'ok', size: 'sm', disabled: blocked, onClick: onDelete },
                  t('confirmDelete'),
                ),
                h(
                  P.Button,
                  { key: 'no', size: 'sm', disabled: blocked, onClick: () => setConfirming(null) },
                  t('cancel'),
                ),
              ]
            : [
                h(
                  P.Button,
                  { key: 'del', size: 'sm', disabled: blocked, onClick: () => setConfirming(key) },
                  t('delete'),
                ),
              ]

        /* ---------- 模型行 ---------- */
        const modelRows = (data?.tiers ?? []).map((tier) => {
          const isCurrent = tier.id === data?.currentTier
          return h(
            'div',
            { key: `m-${tier.id}`, style: styles.row2 },
            h(
              'div',
              { style: styles.head },
              h('span', { style: styles.strongish }, tier.label),
              isCurrent ? h(P.Tag, { tone: 'neutral' }, t('inUse')) : null,
              h('span', { style: styles.hint }, tier.installed ? mbText(tier.bytes) : t('notDownloaded')),
            ),
            h(
              'div',
              { style: styles.actions },
              ...(tier.installed
                ? deleteButtons(`model:${tier.id}`, () =>
                    void remove('deleteModels', { tier: tier.id }, tier.label),
                  )
                : [
                    h(
                      P.Button,
                      {
                        key: 'dl',
                        size: 'sm',
                        disabled: blocked,
                        onClick: () => void launch('downloadModels', { tier: tier.id }, `${t('downloading')} ${tier.label}`),
                      },
                      t('download'),
                    ),
                  ]),
            ),
          )
        })

        /* ---------- 二进制行 ---------- */
        const binRows = (data?.binaries ?? []).map((bin) => {
          // source: bundled = 插件目录里的；system = 系统 PATH；configured = 配置指定；missing = 没有
          const sourceLabel =
            bin.source === 'bundled'
              ? t('sourceBundled')
              : bin.source === 'system'
                ? t('sourceSystem')
                : bin.source === 'configured'
                  ? t('sourceConfigured')
                  : t('notDownloaded')
          return h(
            'div',
            { key: `b-${bin.id}`, style: styles.row2 },
            h(
              'div',
              { style: styles.head },
              h('span', { style: styles.strongish }, bin.name),
              h(
                P.Tag,
                { tone: bin.ready ? 'neutral' : 'quiet' },
                bin.ready ? t('ready') : t('missing'),
              ),
              h('span', { style: styles.hint }, `${sourceLabel}${bin.ready ? ' · ' + mbText(bin.bytes) : ''}`),
            ),
            h(
              'div',
              { style: styles.actions },
              ...(bin.source === 'bundled'
                ? deleteButtons(`bin:${bin.id}`, () =>
                    void remove('deleteBinary', { id: bin.id }, bin.name),
                  )
                : bin.source === 'missing'
                  ? [
                      h(
                        P.Button,
                        {
                          key: 'dl',
                          size: 'sm',
                          disabled: blocked,
                          onClick: () =>
                            void launch('downloadBinaries', { ids: [bin.id] }, `${t('downloading')} ${bin.name}`),
                        },
                        t('download'),
                      ),
                    ]
                  : []),
            ),
          )
        })

        const progress = job
          ? h(
              'p',
              { style: job.state === 'failed' ? styles.error : styles.hint },
              `${job.label}${job.state === 'running' ? '…' : ''}${job.message ? ' · ' + job.message : ''}`,
            )
          : null

        return h(
          'div',
          { style: styles.section },
          h('span', { style: styles.label }, t('resources')),
          h('p', { style: styles.hint }, t('resourcesHint')),
          loading ? h('p', { style: styles.hint }, t('loading')) : null,
          error ? h('p', { style: styles.error }, `${t('loadFailed')}${error}`) : null,
          message ? h('p', { style: styles.ok }, message) : null,
          progress,
          h('span', { style: styles.subLabel }, t('models')),
          data?.tierOverride
            ? h(
                'div',
                { style: styles.row2 },
                h(
                  'p',
                  { style: styles.warn },
                  `${t('tierOverride')} ${data.tierOverride.tier}；${t('tierOverrideHint')} ` +
                    `${data.tierOverride.configTier || '—'}。`,
                ),
                h(
                  'div',
                  { style: styles.actions },
                  h(
                    P.Button,
                    { size: 'sm', disabled: blocked, onClick: () => void clearOverride() },
                    t('tierOverrideClear'),
                  ),
                ),
              )
            : data?.staleOverride
              ? h('p', { style: styles.hint }, t('tierOverrideStale'))
              : null,
          ...modelRows,
          h('span', { style: styles.subLabel }, t('tools')),
          ...binRows,
        )
      }

      /**
       * 卡片：summary 只显示一句话，page 显示表单 + 模型管理。
       * props 由插槽注入：view / t / hooks 展开的 useXxx / 表单动作。
       */
      return function YouTubeSubtitlesCard(props) {
        const { t } = props
        const state = props.useYoutubeSubtitlesCard((snapshot) => snapshot)

        const disabled = !state.writable || state.saving
        const tier = state.tier
        const tierValue = TIERS.includes(tier.text) ? tier.text : FALLBACK_TIER

        /** overridden 徽标 + 恢复默认按钮，SettingsValueField 不会替枚举控件画。 */
        const overriddenBadge = tier.overridden
          ? h(
              'span',
              { style: styles.badgeRow },
              h(P.Tag, { tone: 'neutral' }, t('overridden')),
              h(
                P.Button,
                { size: 'sm', disabled, onClick: () => props.resetField('tier') },
                t('reset'),
              ),
            )
          : null

        const tierField = h(
          'div',
          { style: styles.row },
          h(
            'div',
            { style: styles.head },
            h('span', { style: styles.label }, t('tier')),
            overriddenBadge,
          ),
          h(P.SegmentedControl, {
            id: 'plugin-config-youtube-subtitles-tier',
            label: t('tier'),
            value: tierValue,
            disabled,
            options: [
              { value: 'small', label: t('tierSmall'), title: t('tierSmallTitle') },
              { value: 'full', label: t('tierFull'), title: t('tierFullTitle') },
            ],
            // 只传字符串 token，真正的值由 tierSpec.parse 推出
            onChange: (next) => props.edit('tier', next),
          }),
          h('p', { style: styles.warn }, t('tierWarn')),
          h('p', { style: styles.hint }, t('tierHint')),
        )

        return h(
          'div',
          { style: styles.root },
          h(
            P.SettingsForm,
            {
              labels: formLabels(t),
              state,
              onSave: props.save,
              onDiscard: props.discard,
            },
            tierField,
            h(P.SettingsValueField, {
              id: 'plugin-config-youtube-subtitles-threads',
              label: t('threads'),
              hint: t('threadsHint'),
              overriddenLabel: t('overridden'),
              resetLabel: t('reset'),
              invalidLabel: t('invalidThreads'),
              numeric: true,
              disabled,
              ...state.numThreads,
              onEdit: (text) => {
                props.edit('numThreads', text)
              },
              onReset: () => {
                props.resetField('numThreads')
              },
            }),
          ),
          h(ResourceSection, { t }),
        )
      }
    }

    /** 把 configForms 的 scope 桥接成卡片使用的快照与动作。 */
    class CardController {
      constructor(scope) {
        this.form = new P.SettingsFormModel(scope, [tierSpec, threadsSpec])
        this.store = this.form.bind(() => ({
          ...this.form.shell(),
          tier: this.form.field('tier'),
          numThreads: this.form.field('numThreads'),
        }))
      }

      inject() {
        return {
          hooks: { youtubeSubtitlesCard: this.store },
          ...this.form.actions(),
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    /**
     * 依赖的客户端服务（Cordis 服务名，不是包名）：
     *   slots / locale / configForms —— 注册设置卡片
     *   connection                   —— 调 host 的 RPC（模型状态、删除模型）
     */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * 挂载配置卡片：Host 提供该 namespace 时才注册，避免在未加载的部署里留下空卡片。
     * @param ctx - 浏览器插件上下文
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'youtube-subtitles: dictionaries')

      const card = new CardController(ctx.configForms.get(ENTRY_ID))
      const Card = createCard(ctx)
      ctx.effect(() => () => card.dispose(), 'youtube-subtitles: form subscription')

      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                // keyed 插槽：key 必须是 bundle 的包名，页面用 entryKey=pkg.name 去取
                key: PACKAGE_NAME,
                locale: NS,
                inject: () => card.inject(),
              },
              Card,
            ),
          ),
        'youtube-subtitles: bundle settings card',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
