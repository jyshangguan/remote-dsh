/**
 * Browser half of dsh-remote-panel.
 *
 * Two views:
 *  - host picker: hosts already configured in dsh-ssh plus hosts added here,
 *    with an inline "add host" form (password, ports, optional install proxy);
 *  - session: the remote DSH embedded through the loopback gateway, with
 *    reload / maximize / disconnect.
 *
 * A connect request only starts a host-side job; this page polls /state and
 * shows the current stage (SSH, environment check, install, start, gateway) so
 * a first-time host that still needs dsh installed is readable instead of a
 * silent long wait.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-panel-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'remote-dsh'
    const EMPTY_FORM = { label: '', host: '', sshPort: '22', user: '', password: '', webPort: '18080', installProxy: '' }

    const STAGE_TEXT = {
      idle: '未连接',
      connecting: '正在连接 SSH…',
      ssh: 'SSH 已连通',
      checking: '正在检查远端环境…',
      installing: '正在安装远端 dsh（首次可能需要几分钟）…',
      restarting: '检测到旧版本进程，正在重启远端 dsh web…',
      starting: '正在启动远端 dsh web…',
      gateway: '正在建立会话通道…',
      ready: '已连接',
      failed: '连接失败',
    }

    const s = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '13px/1.5 system-ui, "Segoe UI", sans-serif', color: 'inherit' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)', flex: '0 0 auto' },
      dot: (ok) => ({ width: '8px', height: '8px', borderRadius: '50%', background: ok === true ? '#3fb950' : ok === false ? '#d29922' : '#8b95a5', flex: '0 0 auto' }),
      title: { fontWeight: 600 },
      muted: { opacity: 0.7, fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      spacer: { flex: 1 },
      btn: { font: 'inherit', padding: '4px 10px', borderRadius: '7px', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { font: 'inherit', padding: '4px 12px', borderRadius: '7px', border: '1px solid #2563eb', background: '#2563eb', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
      body: { position: 'relative', flex: 1, minHeight: 0, background: '#fff', overflow: 'auto' },
      frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 },
      list: { padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '860px' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '10px', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      badge: { fontSize: '11px', padding: '0 6px', borderRadius: '5px', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', opacity: 0.75 },
      form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', padding: '14px', borderRadius: '10px', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' },
      input: { font: 'inherit', padding: '6px 8px', borderRadius: '7px', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit' },
      error: { padding: '10px 12px', borderRadius: '9px', background: '#3a1a1a', color: '#f6b8b8', border: '1px solid #6b1e1e', fontSize: '12.5px' },
      center: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#8b95a5', fontSize: '12.5px', pointerEvents: 'none', textAlign: 'center', padding: '24px' },
      restore: { position: 'fixed', top: '52px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483000, padding: '6px 14px', borderRadius: '999px', background: 'rgba(24,26,32,.78)', color: '#fff', font: 'inherit', fontSize: '12.5px', pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.25)' },
      section: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', borderRadius: '10px', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
      sectionTitle: { fontWeight: 600, fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '8px' },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '7px 0', borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)' },
      checkbox: { marginTop: '2px', flex: '0 0 auto' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px', wordBreak: 'break-all', opacity: 0.8 },
      log: { margin: 0, padding: '10px 12px', borderRadius: '8px', background: '#0f1115', color: '#c9d1d9', maxHeight: '220px', overflow: 'auto', fontSize: '11.5px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      warn: { padding: '8px 10px', borderRadius: '8px', background: '#3a2f14', color: '#e7c27d', border: '1px solid #6b551e', fontSize: '12px' },
      okText: { color: '#3fb950' },
      badText: { color: '#e0a458' },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '4px' },
      select: { font: 'inherit', padding: '6px 8px', borderRadius: '7px', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit' },
    }

    function RemoteDshIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 1.75, y: 2.5, width: 12.5, height: 8.5, rx: 1.5 }),
        h('path', { d: 'M5.5 14h5' }),
        h('path', { d: 'M8 11v3' }),
      )
    }

    function Field({ label, children }) {
      return h('label', { style: s.field }, h('span', { style: s.muted }, label), children)
    }

    /** Parse a JSON body with a readable failure for a stale host half. */
    async function jsonOf(response) {
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('面板后端未就绪（HTTP ' + response.status + '）。请完全退出应用后重新打开，让它加载新版插件。')
      }
    }

    /** The version this client half was built with (the remote must match). */
    function clientVersion() {
      const boot = window.__DSH_BOOT__
      return boot !== undefined && boot.release !== undefined && typeof boot.release.version === 'string'
        ? boot.release.version
        : '0.2.1-rc.3'
    }

    const SYNC_STAGE_TEXT = {
      connecting: '连接 SSH…',
      checking: '检查远端环境…',
      'installing-pnpm': '准备远端 pnpm…',
      installing: '安装插件…',
      'writing-config': '写入模型配置…',
      'syncing-keys': '同步 API Key…',
      validating: '校验远端配置…',
      restarting: '重启远端 dsh web…',
      done: '完成',
      failed: '失败',
    }

    /** One checkbox row used by the sync form. */
    function CheckRow({ checked, disabled, onChange, title, meta, note }) {
      return h(
        'label',
        { style: { ...s.checkRow, opacity: disabled === true ? 0.55 : 1 } },
        h('input', {
          type: 'checkbox',
          style: s.checkbox,
          checked: checked === true,
          disabled: disabled === true,
          onChange: event => { if (disabled !== true) onChange(event.target.checked) },
        }),
        h(
          'span',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' } },
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, title),
            meta !== undefined && meta !== null ? meta : null,
          ),
          note !== undefined && note !== null && note !== ''
            ? h('span', { style: { ...s.muted, whiteSpace: 'normal', opacity: 0.65 } }, note)
            : null,
        ),
      )
    }

    /**
     * Sync form: pick plugins/providers, preview the remote state, run a
     * host-side job and stream its log.
     */
    function SyncView({ host, version, onClose }) {
      const [loading, setLoading] = React.useState(true)
      const [plan, setPlan] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [profile, setProfile] = React.useState('web')
      const [pluginSel, setPluginSel] = React.useState({})
      const [providerSel, setProviderSel] = React.useState({})
      const [syncDefault, setSyncDefault] = React.useState(true)
      const [syncKeys, setSyncKeys] = React.useState(true)
      const [restart, setRestart] = React.useState(true)
      const [dryRun, setDryRun] = React.useState(false)
      const [registry, setRegistry] = React.useState('')
      const [proxy, setProxy] = React.useState(host.installProxy || '')
      const [advanced, setAdvanced] = React.useState(false)
      const [starting, setStarting] = React.useState(false)
      const [job, setJob] = React.useState(null)
      const logRef = React.useRef(null)

      const loadPlan = React.useCallback((nextProfile) => {
        setLoading(true)
        setError(null)
        const target = nextProfile === undefined || nextProfile === '' ? 'web' : nextProfile
        fetch(
          '/api/remote-dsh/sync/plan?id=' + encodeURIComponent(host.id)
            + '&profile=' + encodeURIComponent(target)
            + '&version=' + encodeURIComponent(version),
          { headers: { accept: 'application/json' } },
        )
          .then(jsonOf)
          .then(value => {
            if (value.ok !== true) throw new Error(value.error || '读取同步计划失败')
            const next = value.plan
            setPlan(next)
            setProfile(next.remote.profile || target)
            const plugins = {}
            for (const plugin of next.local.plugins) plugins[plugin.name] = plugin.defaultSelected === true
            setPluginSel(plugins)
            const providers = {}
            for (const provider of next.local.providers) providers[provider.id] = provider.defaultSelected === true
            setProviderSel(providers)
            setSyncDefault(next.local.defaultModel !== null && next.local.defaultModel !== undefined)
            if (typeof next.host.installProxy === 'string' && next.host.installProxy !== '') setProxy(next.host.installProxy)
          })
          .catch(cause => setError(cause.message || String(cause)))
          .finally(() => setLoading(false))
      }, [host.id, host.installProxy, version])

      React.useEffect(() => { loadPlan('web') }, [loadPlan])

      const running = job !== null && job.stage !== 'done' && job.stage !== 'failed'

      React.useEffect(() => {
        if (job === null || job.stage === 'done' || job.stage === 'failed') return undefined
        let alive = true
        const tick = async () => {
          try {
            const value = await jsonOf(await fetch('/api/remote-dsh/sync/state?id=' + encodeURIComponent(host.id), { headers: { accept: 'application/json' } }))
            if (!alive) return
            if (value.job !== undefined) {
              setJob(value.job)
              if (value.job.stage === 'done' || value.job.stage === 'failed') return
            }
          } catch { /* keep polling */ }
          if (alive) setTimeout(tick, 1200)
        }
        const timer = setTimeout(tick, 500)
        return () => { alive = false; clearTimeout(timer) }
      }, [job === null ? null : job.stage, host.id])

      React.useEffect(() => {
        const node = logRef.current
        if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight
      }, [job === null ? 0 : (job.logs || []).length])

      const start = () => {
        if (plan === null) return
        const plugins = plan.local.plugins.filter(plugin => pluginSel[plugin.name] === true).map(plugin => plugin.name)
        const providers = plan.local.providers.filter(provider => providerSel[provider.id] === true).map(provider => provider.id)
        if (plugins.length === 0 && providers.length === 0) {
          setError('至少选择一个插件或一个模型 provider。')
          return
        }
        const defaultModel = syncDefault ? plan.local.defaultModel : null
        if (defaultModel !== null && providers.includes(defaultModel.provider) === false) {
          setError('默认模型所属的 provider「' + defaultModel.provider + '」没有被勾选。')
          return
        }
        setStarting(true)
        setError(null)
        setJob({ stage: 'connecting', logs: [], error: null, result: null, sinceMs: 0 })
        fetch('/api/remote-dsh/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: host.id,
            profile,
            version,
            plugins,
            providers,
            defaultModel,
            syncKeys,
            restart,
            registry,
            proxy,
            dryRun,
          }),
        })
          .then(jsonOf)
          .then(value => {
            if (value.error !== undefined && value.error !== null && value.job === undefined) throw new Error(value.error)
            if (value.job !== undefined) setJob(value.job)
          })
          .catch(cause => setError(cause.message || String(cause)))
          .finally(() => setStarting(false))
      }

      const pluginStatus = (plugin) => {
        if (plugin.remoteVersion === null || plugin.remoteVersion === undefined) return { text: '远端未安装', ok: false }
        if (plugin.remoteVersion !== plugin.version) return { text: '远端 ' + plugin.remoteVersion + '，将升级', ok: false }
        if (plugin.remoteActive !== true) return { text: '已安装但未启用', ok: false }
        return { text: '已同步', ok: true }
      }

      const header = h(
        'div',
        { style: s.header },
        h('button', { type: 'button', style: s.btn, onClick: onClose }, '← 返回'),
        h('span', { style: s.title }, '同步配置'),
        h('span', { style: s.muted }, host.label),
        h('span', { style: s.spacer }),
        h('button', {
          type: 'button', style: s.btn, disabled: loading || running,
          onClick: () => loadPlan(profile),
        }, loading ? '读取中…' : '重新读取'),
      )

      if (loading && plan === null) {
        return h('div', { style: s.page, 'data-dsh-plugin': 'remote-dsh' }, header,
          h('div', { style: s.body }, h('div', { style: s.center }, '正在读取本地配置与远端环境…')))
      }

      if (plan === null) {
        return h('div', { style: s.page, 'data-dsh-plugin': 'remote-dsh' }, header,
          h('div', { style: s.body }, h('div', { style: { ...s.list, maxWidth: '920px' } },
            h('div', { style: s.error }, error || '读取同步计划失败'),
            h('div', { style: s.footer }, h('button', { type: 'button', style: s.btn, onClick: onClose }, '返回')),
          )))
      }

      const remote = plan.remote
      const local = plan.local
      const stageText = job === null ? '' : (SYNC_STAGE_TEXT[job.stage] || job.stage)
      const result = job === null ? null : job.result
      const selectedProviderCount = Object.keys(providerSel).filter(id => providerSel[id] === true).length
      const selectedPluginCount = Object.keys(pluginSel).filter(name => pluginSel[name] === true).length

      return h(
        'div',
        { style: s.page, 'data-dsh-plugin': 'remote-dsh' },
        header,
        h(
          'div',
          { style: s.body },
          h(
            'div',
            { style: { ...s.list, maxWidth: '920px' } },
            error !== null ? h('div', { style: s.error }, error) : null,

            h(
              'div',
              { style: s.section },
              h('div', { style: s.sectionTitle }, '远端 profile'),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } },
                h(Field, { label: 'profile 名称' },
                  h('input', {
                    style: s.input, value: profile, disabled: running,
                    onChange: event => setProfile(event.target.value),
                  })),
                h('button', { type: 'button', style: s.btn, disabled: loading || running, onClick: () => loadPlan(profile) }, '读取此 profile'),
              ),
              h('div', { style: { ...s.muted, whiteSpace: 'normal' } },
                'dsh ' + (remote.dshVersion || '未安装')
                + ' · Node ' + (remote.node || '缺失')
                + ' · ' + (remote.pnpm ? 'pnpm ' + (remote.pnpmVersion || '可用') : '无 pnpm（同步时会自动安装）')
                + ' · ' + (remote.webAlive ? 'dsh web 运行中' : 'dsh web 未运行')),
              h('div', { style: s.code }, remote.profileDir + (remote.patchExists ? '  ·  已有 cordis.patch.yml' : '  ·  新建 cordis.patch.yml')),
              (plan.warnings || []).map((warning, index) => h('div', { key: 'w' + index, style: s.warn }, warning)),
            ),

            h(
              'div',
              { style: s.section },
              h('div', { style: s.sectionTitle }, '插件', h('span', { style: s.badge }, selectedPluginCount + ' / ' + local.plugins.length + ' 已选')),
              local.plugins.length === 0
                ? h('div', { style: { ...s.muted, whiteSpace: 'normal' } }, '本地 profile 没有声明 dsh.bundle 的依赖。')
                : local.plugins.map(plugin => {
                    const status = pluginStatus(plugin)
                    return h(CheckRow, {
                      key: plugin.name,
                      checked: pluginSel[plugin.name] === true,
                      disabled: running || plugin.supported !== true,
                      onChange: value => setPluginSel(prev => ({ ...prev, [plugin.name]: value })),
                      title: plugin.name,
                      meta: [
                        h('span', { key: 'v', style: s.badge }, plugin.version),
                        h('span', { key: 's', style: { ...s.badge, color: status.ok ? '#3fb950' : '#e0a458' } }, status.text),
                      ],
                      note: plugin.reason || (plugin.active ? '' : '本地未启用'),
                    })
                  }),
              h('div', { style: { ...s.muted, whiteSpace: 'normal' } }, '按本地已装版本精确安装（包名@版本）；已同步的会跳过。'),
            ),

            h(
              'div',
              { style: s.section },
              h('div', { style: s.sectionTitle }, '模型 Provider', h('span', { style: s.badge }, selectedProviderCount + ' / ' + local.providers.length + ' 已选')),
              local.providers.length === 0
                ? h('div', { style: { ...s.muted, whiteSpace: 'normal' } }, '本地 llm-pi-ai 没有配置 provider。')
                : local.providers.map(provider => {
                    const keyText = provider.apiKeyEnv === ''
                      ? '无 apiKeyEnv'
                      : provider.keyConfigured === true ? 'API Key 已配置' : provider.keyConfigured === false ? 'API Key 未配置' : 'API Key 状态未知'
                    const note = [
                      provider.baseURL || '(默认 baseURL)',
                      provider.modelCount + ' 个模型',
                      keyText,
                      provider.loopback ? '127.0.0.1 地址，远端可能访问不到' : '',
                    ].filter(Boolean).join(' · ')
                    return h(CheckRow, {
                      key: provider.id,
                      checked: providerSel[provider.id] === true,
                      disabled: running,
                      onChange: value => {
                        setProviderSel(prev => ({ ...prev, [provider.id]: value }))
                        if (value !== true && local.defaultModel !== null && local.defaultModel !== undefined && local.defaultModel.provider === provider.id) setSyncDefault(false)
                      },
                      title: provider.displayName + '  ' + provider.id,
                      meta: [
                        h('span', { key: 'm', style: s.badge }, provider.modelCount + ' 模型'),
                        h('span', { key: 'k', style: { ...s.badge, color: provider.keyConfigured === false ? '#e0a458' : undefined } }, keyText),
                      ],
                      note,
                    })
                  }),
              h('div', { style: { ...s.muted, whiteSpace: 'normal' } }, '同步会整组替换远端 llm-pi-ai.providers：未勾选的 provider 不会出现在远端。'),
            ),

            h(
              'div',
              { style: s.section },
              h('div', { style: s.sectionTitle }, '默认模型'),
              local.defaultModel === null || local.defaultModel === undefined
                ? h('div', { style: { ...s.muted, whiteSpace: 'normal' } }, '本地没有可识别的默认模型。')
                : h(CheckRow, {
                    checked: syncDefault,
                    disabled: running,
                    onChange: value => {
                      setSyncDefault(value)
                      if (value === true) setProviderSel(prev => ({ ...prev, [local.defaultModel.provider]: true }))
                    },
                    title: '把本地默认模型设为远端默认',
                    meta: h('span', { key: 'd', style: s.badge }, local.defaultModel.provider + ' / ' + local.defaultModel.model),
                    note: local.defaultModel.reasoningEffort === undefined ? '' : 'reasoningEffort: ' + local.defaultModel.reasoningEffort,
                  }),
              h(CheckRow, {
                checked: syncKeys,
                disabled: running,
                onChange: setSyncKeys,
                title: '同步 API Key 到远端 ~/.dsh/.env（0600）',
                note: '只写 apiKeyEnv 引用的值；值不会显示在页面或日志里。',
              }),
              h(CheckRow, {
                checked: restart,
                disabled: running,
                onChange: setRestart,
                title: '同步后重启远端 dsh web',
                note: '重启会让当前已连接的远端面板断开，需要重新连接。',
              }),
              h(CheckRow, {
                checked: dryRun,
                disabled: running,
                onChange: setDryRun,
                title: '只预演，不写入远端',
                note: '连接远端、读取状态并列出将执行的步骤，不改任何文件、不装插件。',
              }),
            ),

            h(
              'div',
              { style: s.section },
              h('div', { style: s.sectionTitle },
                h('button', { type: 'button', style: s.btn, onClick: () => setAdvanced(value => !value) }, advanced ? '收起高级选项' : '高级选项'),
              ),
              advanced ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                h(Field, { label: 'npm registry（可选，例如 https://registry.npmmirror.com）' },
                  h('input', { style: s.input, value: registry, disabled: running, onChange: event => setRegistry(event.target.value), placeholder: '留空使用远端默认 registry' })),
                h(Field, { label: '安装用代理（可选，例如 http://127.0.0.1:7890）' },
                  h('input', { style: s.input, value: proxy, disabled: running, onChange: event => setProxy(event.target.value), placeholder: '留空则沿用主机设置 / 探测 7890' })),
              ) : null,
            ),

            h(
              'div',
              { style: s.footer },
              h('button', {
                type: 'button', style: s.primary,
                disabled: running || starting || loading,
                onClick: start,
              }, running ? '同步中…' : starting ? '提交中…' : dryRun ? '开始预演' : '开始同步'),
              running ? h('span', { style: { ...s.muted, whiteSpace: 'normal' } }, stageText + '（' + Math.round((job.sinceMs || 0) / 1000) + 's）') : null,
            ),

            job !== null ? h(
              'div',
              { style: s.section },
              h('div', { style: s.sectionTitle },
                '同步进度',
                h('span', { style: s.badge }, stageText),
                job.sinceMs > 0 ? h('span', { style: { ...s.muted, whiteSpace: 'normal' } }, Math.round(job.sinceMs / 1000) + 's') : null,
                job.stage === 'done' ? h('span', { style: { ...s.badge, color: '#3fb950' } }, '完成') : null,
                job.stage === 'failed' ? h('span', { style: { ...s.badge, color: '#e0a458' } }, '失败') : null,
              ),
              job.error !== null && job.error !== undefined ? h('div', { style: s.error }, job.error) : null,
              (job.logs || []).length > 0 ? h('pre', { ref: logRef, style: s.log }, (job.logs || []).map(line => line.text).join('\n')) : null,
              result !== null && result !== undefined ? h(
                'div',
                { style: { ...s.muted, whiteSpace: 'normal', lineHeight: 1.7 } },
                h('div', null, result.dryRun ? '预演完成，未修改远端。' : '同步完成。'),
                h('div', null, '插件：' + (result.plugins.length === 0 ? '无变化' : result.plugins.map(item => item.name + ' → ' + item.action).join('；'))),
                h('div', null, '模型 provider：' + (result.patch === null ? '未改动' : (result.patch.providers || []).join(', ') || '未改动')),
                h('div', null, 'API Key：' + (result.env == null || result.env.keys.length === 0 ? '未写入' : result.env.keys.join(', '))),
                h('div', null, result.restarted ? '远端 dsh web 已重启。' : '远端 dsh web 未重启。'),
                (result.notes || []).length > 0 ? h('div', { style: s.warn }, result.notes.join('；')) : null,
              ) : null,
            ) : null,
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ files

    /** Readable byte size for a directory listing. */
    function formatSize(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
      return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    }

    /** `YYYY-MM-DD HH:mm` in the browser's zone, or '' when unknown. */
    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = value => String(value).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** POSIX parent directory. */
    function parentOf(target) {
      const trimmed = String(target || '/').replace(/\/+$/, '')
      if (trimmed === '') return '/'
      const at = trimmed.lastIndexOf('/')
      return at <= 0 ? '/' : trimmed.slice(0, at)
    }

    /** POSIX join of one entry name onto a directory. */
    function joinPath(dir, name) {
      return (dir === '/' ? '' : String(dir || '').replace(/\/+$/, '')) + '/' + name
    }

    const fsStyles = {
      page: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'Canvas', color: 'CanvasText', font: '13px/1.5 system-ui, "Segoe UI", sans-serif' },
      bar: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px', borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)', flex: '0 0 auto' },
      input: { flex: 1, minWidth: 0, font: 'inherit', padding: '4px 8px', borderRadius: '6px', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit' },
      list: { flex: 1, minHeight: 0, overflow: 'auto' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px', borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' },
      icon: { flex: '0 0 auto', width: '16px', textAlign: 'center' },
      name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' },
      meta: { flex: '0 0 auto', opacity: 0.6, fontSize: '11.5px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      mini: { font: 'inherit', fontSize: '11.5px', padding: '0 6px', borderRadius: '5px', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer', flex: '0 0 auto' },
      empty: { padding: '24px 16px', textAlign: 'center', opacity: 0.65, fontSize: '12.5px' },
      notice: { padding: '6px 12px', fontSize: '12px', opacity: 0.8, borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' },
      preview: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      textarea: { flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none', border: 0, outline: 'none', padding: '12px 14px', background: 'Canvas', color: 'CanvasText', font: '12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace' },
      columns: { flex: 1, minHeight: 0, display: 'flex', gap: '8px', padding: '8px' },
      pane: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: '8px', overflow: 'hidden' },
      paneHead: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)', flex: '0 0 auto' },
      paneError: { padding: '6px 10px', color: '#e0a458', fontSize: '12px', borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)' },
      middle: { flex: '0 0 auto', width: '96px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' },
      status: { minHeight: '22px', display: 'flex', gap: '12px', padding: '2px 12px 8px', fontSize: '12px', flex: '0 0 auto' },
    }

    /**
     * One side of the transfer view: the same protocol, two backends.
     * `local` talks to /api/remote-dsh/local, `remote` to /api/remote-dsh/fs.
     */
    function usePane(kind, hostId) {
      const base = kind === 'local' ? '/api/remote-dsh/local' : '/api/remote-dsh/fs'
      const extra = kind === 'local' ? '' : '&id=' + encodeURIComponent(hostId)
      const [path, setPath] = React.useState('')
      const [parent, setParent] = React.useState('')
      const [typed, setTyped] = React.useState('')
      const [entries, setEntries] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [selected, setSelected] = React.useState([])

      const load = React.useCallback(target => {
        setLoading(true)
        setError(null)
        setSelected([])
        fetch(base + '/list?path=' + encodeURIComponent(target || '') + extra)
          .then(jsonOf)
          .then(value => {
            if (value.ok !== true) throw new Error(value.error || '读取目录失败')
            setPath(value.path)
            setParent(typeof value.parent === 'string' ? value.parent : value.path)
            setTyped(value.path)
            setEntries(Array.isArray(value.entries) ? value.entries : [])
          })
          .catch(cause => setError(String(cause.message || cause)))
          .finally(() => setLoading(false))
      }, [base, extra])

      React.useEffect(() => { load('') }, [load])

      return {
        kind, base, extra, path, parent, typed, setTyped, entries, loading, error, selected, setSelected, load,
        refresh: () => load(path),
      }
    }

    /** One column: path bar, entry list, per-row actions. */
    function FilePane({ pane, title, renaming, onRename, onRenameStart, onDelete, onMkdir, onPreview }) {
      const toggle = name => pane.setSelected(prev => (
        prev.indexOf(name) === -1 ? [...prev, name] : prev.filter(item => item !== name)
      ))
      const rows = pane.loading
        ? h('div', { style: fsStyles.empty }, '读取中…')
        : pane.entries.length === 0
          ? h('div', { style: fsStyles.empty }, '空目录')
          : pane.entries.map(entry => {
              const full = joinPath(pane.path, entry.name)
              const editing = renaming !== null && renaming.pane === pane.kind && renaming.path === full
              return h(
                'div',
                { key: entry.name, style: fsStyles.row },
                h('input', {
                  type: 'checkbox',
                  style: { flex: '0 0 auto', margin: 0 },
                  checked: pane.selected.indexOf(entry.name) !== -1,
                  onChange: () => toggle(entry.name),
                }),
                h('span', { style: fsStyles.icon }, entry.dir ? '📁' : entry.link ? '🔗' : '📄'),
                editing
                  ? h('input', {
                      style: fsStyles.input,
                      value: renaming.value,
                      autoFocus: true,
                      onChange: event => {
                        const value = event.target.value
                        onRename.change(prev => (prev === null ? prev : { ...prev, value }))
                      },
                      onKeyDown: event => {
                        if (event.key === 'Enter') onRename.commit()
                        if (event.key === 'Escape') onRename.cancel()
                      },
                      onBlur: onRename.cancel,
                    })
                  : h('span', {
                      style: fsStyles.name,
                      title: full + (entry.dir ? '' : '\n' + formatSize(entry.size) + ' · ' + formatTime(entry.mtime)),
                      onClick: () => (entry.dir ? pane.load(full) : onPreview(entry)),
                    }, entry.name),
                h('span', { style: fsStyles.meta }, entry.dir ? '' : formatSize(entry.size)),
                h('button', { type: 'button', style: fsStyles.mini, onClick: () => onRenameStart(entry) }, '改名'),
                h('button', { type: 'button', style: fsStyles.mini, onClick: () => onDelete(entry) }, '删除'),
              )
            })

      return h(
        'div',
        { style: fsStyles.pane },
        h(
          'div',
          { style: fsStyles.paneHead },
          h('span', { style: { fontWeight: 600 } }, title),
          h('span', { style: { ...s.muted, marginLeft: '6px' } }, pane.selected.length + ' 已选'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: s.btn, onClick: onMkdir }, '新建'),
        ),
        h(
          'div',
          { style: fsStyles.bar },
          h('button', { type: 'button', style: s.btn, title: '上一级', onClick: () => pane.load(pane.parent) }, '↑'),
          h('input', {
            style: fsStyles.input,
            value: pane.typed,
            spellCheck: false,
            placeholder: '路径，回车跳转',
            onChange: event => pane.setTyped(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') pane.load(pane.typed) },
          }),
          h('button', { type: 'button', style: s.btn, onClick: pane.refresh }, '刷新'),
        ),
        h('div', { style: fsStyles.list }, rows),
        pane.error !== null ? h('div', { style: fsStyles.paneError }, pane.error) : null,
      )
    }

    /**
     * Local ↔ remote transfer: two columns, check files on either side and push
     * them across. Both halves speak the same fs protocol, so a transfer is one
     * download URL piped into one upload URL.
     */
    function TransferView({ hostId, onClose }) {
      const local = usePane('local', hostId)
      const remote = usePane('remote', hostId)
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [renaming, setRenaming] = React.useState(null)

      const post = (pane, action, body) => fetch(pane.base + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ...(pane.kind === 'remote' ? { id: hostId } : {}) }),
      })
        .then(jsonOf)
        .then(value => {
          if (value.ok !== true) throw new Error(value.error || '操作失败')
          return value
        })

      /**
       * POST a fetched body to an upload endpoint. Small files are buffered,
       * which is the most compatible path; large ones stream so a multi-GB file
       * never lands in page memory.
       */
      const sendBody = async (url, response, size) => {
        const init = { method: 'POST', headers: { 'content-type': 'application/octet-stream' } }
        if (size > 8 * 1024 * 1024 && response.body !== null && response.body !== undefined) {
          try {
            return await fetch(url, { ...init, body: response.body, duplex: 'half' })
          } catch {
            // Streaming request bodies are not universal; fall back to buffering.
          }
        }
        return fetch(url, { ...init, body: await response.blob() })
      }

      const transfer = async (from, to) => {
        const fromLabel = from.kind === 'local' ? '本地' : '服务器'
        if (from.selected.length === 0) { setError('先在「' + fromLabel + '」勾选文件'); return }
        const files = from.entries.filter(entry => from.selected.indexOf(entry.name) !== -1)
        const dirs = files.filter(entry => entry.dir)
        if (dirs.length > 0) {
          setError('暂不支持整目录传输：' + dirs.map(entry => entry.name).join('、'))
          return
        }
        const clashes = files.filter(entry => to.entries.some(row => row.name === entry.name))
        if (clashes.length > 0
          && !window.confirm('目标目录已有同名文件：' + clashes.map(entry => entry.name).join('、') + '，覆盖？')) return
        setError(null)
        setNotice(null)
        setBusy('传输中 0/' + files.length)
        let done = 0
        for (const file of files) {
          const source = from.base + '/download?path=' + encodeURIComponent(joinPath(from.path, file.name)) + from.extra
          const target = to.base + '/upload?path=' + encodeURIComponent(joinPath(to.path, file.name)) + to.extra
          try {
            const response = await fetch(source)
            if (response.ok !== true) throw new Error('读取源文件失败（HTTP ' + response.status + '）')
            const put = await sendBody(target, response, file.size)
            const value = await put.json()
            if (value.ok !== true) throw new Error(value.error || '写入失败')
            done += 1
            setBusy('传输中 ' + done + '/' + files.length)
          } catch (cause) {
            setError(String(cause.message || cause))
            break
          }
        }
        setBusy(null)
        if (done === files.length) setNotice('已传输 ' + done + ' 个文件')
        to.load(to.path)
        from.load(from.path)
      }

      const mkdir = pane => {
        const name = window.prompt('新建文件夹的名称')
        if (name === null || name.trim() === '') return
        post(pane, 'mkdir', { path: joinPath(pane.path, name.trim()) })
          .then(pane.refresh)
          .catch(cause => setError(String(cause.message || cause)))
      }

      const removeEntry = (pane, entry) => {
        const label = pane.kind === 'local' ? '本地' : '服务器'
        const message = entry.dir
          ? '删除' + label + '目录「' + entry.name + '」及其全部内容？'
          : '删除' + label + '文件「' + entry.name + '」？'
        if (!window.confirm(message)) return
        post(pane, 'remove', { path: joinPath(pane.path, entry.name), recursive: entry.dir })
          .then(pane.refresh)
          .catch(cause => setError(String(cause.message || cause)))
      }

      const commitRename = () => {
        if (renaming === null) return
        const name = renaming.value.trim()
        const pane = renaming.pane === 'local' ? local : remote
        if (name === '' || name === renaming.name) { setRenaming(null); return }
        post(pane, 'rename', { from: renaming.path, to: joinPath(pane.path, name) })
          .then(() => { setRenaming(null); pane.refresh() })
          .catch(cause => { setRenaming(null); setError(String(cause.message || cause)) })
      }

      const openPreview = (pane, entry) => {
        fetch(pane.base + '/read?path=' + encodeURIComponent(joinPath(pane.path, entry.name)) + pane.extra)
          .then(jsonOf)
          .then(value => {
            if (value.ok !== true) throw new Error(value.error || '读取失败')
            setPreview({ ...value, pane, name: entry.name, dirty: false })
          })
          .catch(cause => setError(String(cause.message || cause)))
      }

      const savePreview = () => {
        post(preview.pane, 'write', { path: preview.path, text: preview.text })
          .then(() => {
            setPreview(prev => (prev === null ? prev : { ...prev, dirty: false }))
            setNotice('已保存 ' + preview.path)
          })
          .catch(cause => setError(String(cause.message || cause)))
      }

      const renameProps = {
        change: setRenaming,
        commit: commitRename,
        cancel: () => setRenaming(null),
      }

      if (preview !== null) {
        return h(
          'div',
          { style: fsStyles.page },
          h(
            'div',
            { style: fsStyles.bar },
            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview.name),
            h('span', { style: { ...s.muted, flex: 1, minWidth: 0 } },
              (preview.pane.kind === 'local' ? '本地 · ' : '服务器 · ') + preview.path + (preview.dirty ? ' · 未保存' : '')),
            preview.binary ? null : h('button', { type: 'button', style: s.btn, onClick: savePreview }, '保存'),
            h('button', { type: 'button', style: s.btn, onClick: () => { setPreview(null); preview.pane.refresh() } }, '关闭'),
          ),
          error !== null ? h('div', { style: { ...s.error, margin: '8px 10px' } }, error) : null,
          preview.binary
            ? h('div', { style: fsStyles.empty }, '二进制文件（' + formatSize(preview.size) + '），不支持在线预览；可以用传输按钮复制到另一侧。')
            : h('textarea', {
                style: fsStyles.textarea,
                value: preview.text,
                spellCheck: false,
                onChange: event => setPreview(prev => (prev === null ? prev : { ...prev, text: event.target.value, dirty: true })),
              }),
          preview.truncated
            ? h('div', { style: fsStyles.notice }, '文件超过 512 KB，只载入了开头部分；保存会覆盖整个文件，请谨慎。')
            : null,
        )
      }

      return h(
        'div',
        { style: fsStyles.page },
        h(
          'div',
          { style: fsStyles.bar },
          h('span', { style: { fontWeight: 600 } }, '文件传输'),
          h('span', { style: s.muted }, '勾选文件后按中间按钮互传'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: s.btn, onClick: onClose }, '返回界面'),
        ),
        h(
          'div',
          { style: fsStyles.columns },
          h(FilePane, {
            pane: local,
            title: '本地',
            renaming,
            onRename: renameProps,
            onRenameStart: entry => setRenaming({ pane: 'local', path: joinPath(local.path, entry.name), name: entry.name, value: entry.name }),
            onDelete: entry => removeEntry(local, entry),
            onMkdir: () => mkdir(local),
            onPreview: entry => openPreview(local, entry),
          }),
          h(
            'div',
            { style: fsStyles.middle },
            h('button', {
              type: 'button', style: s.primary, disabled: busy !== null,
              title: '把左侧勾选的文件传到右侧当前目录',
              onClick: () => transfer(local, remote),
            }, '上传 →'),
            h('button', {
              type: 'button', style: s.primary, disabled: busy !== null,
              title: '把右侧勾选的文件传到左侧当前目录',
              onClick: () => transfer(remote, local),
            }, '← 下载'),
          ),
          h(FilePane, {
            pane: remote,
            title: '服务器',
            renaming,
            onRename: renameProps,
            onRenameStart: entry => setRenaming({ pane: 'remote', path: joinPath(remote.path, entry.name), name: entry.name, value: entry.name }),
            onDelete: entry => removeEntry(remote, entry),
            onMkdir: () => mkdir(remote),
            onPreview: entry => openPreview(remote, entry),
          }),
        ),
        h(
          'div',
          { style: fsStyles.status },
          busy !== null ? h('span', null, busy) : null,
          notice !== null ? h('span', { style: s.okText }, notice) : null,
          error !== null ? h('span', { style: s.badText }, error) : null,
        ),
      )
    }

    function RemoteDshPage() {
      const [hosts, setHosts] = React.useState([])
      const [busy, setBusy] = React.useState(null)
      const [tests, setTests] = React.useState({})
      const [error, setError] = React.useState(null)
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [showForm, setShowForm] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [stage, setStage] = React.useState('idle')
      const [elapsed, setElapsed] = React.useState(0)
      const [expanded, setExpanded] = React.useState(false)
      const [showHint, setShowHint] = React.useState(false)
      const [reloadKey, setReloadKey] = React.useState(0)
      const [filesOpen, setFilesOpen] = React.useState(false)
      const [syncHost, setSyncHost] = React.useState(null)
      const stageRef = React.useRef(null)

      const refresh = React.useCallback(() => {
        fetch('/api/remote-dsh/hosts', { headers: { accept: 'application/json' } })
          .then(jsonOf)
          .then(value => {
            setHosts(Array.isArray(value.hosts) ? value.hosts : [])
            setError(null)
          })
          .catch(cause => setError(cause.message || String(cause)))
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      // Escape closes the maximized view. Focus normally sits inside the
      // embedded frame after any click there, and a focused child frame never
      // bubbles key events to this document — the gateway injects a bridge into
      // the remote page that postMessages Escape here instead.
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') setExpanded(false) }
        const onMessage = (event) => {
          const data = event.data
          if (data !== null && typeof data === 'object' && data.type === 'dsh-remote-esc') setExpanded(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('message', onMessage)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('message', onMessage)
        }
      }, [])

      // Briefly explain how to leave maximized mode; there is no button.
      React.useEffect(() => {
        if (!expanded) { setShowHint(false); return undefined }
        setShowHint(true)
        const timer = setTimeout(() => setShowHint(false), 2500)
        return () => clearTimeout(timer)
      }, [expanded])

      // Poll while a host-side connect job is running (install can take minutes).
      React.useEffect(() => {
        if (active === null || active.proxyUrl !== undefined) return undefined
        let alive = true
        const started = Date.now()
        const tick = async () => {
          try {
            const state = await jsonOf(await fetch('/api/remote-dsh/state', { headers: { accept: 'application/json' } }))
            if (!alive) return
            const row = (state.hosts || []).find(item => item.id === active.id)
            if (row !== undefined) {
              setStage(row.stage || 'connecting')
              setElapsed(Math.round((Date.now() - started) / 1000))
              if (row.error) { setError(row.error); setActive(null); setStage('failed'); return }
              if (row.proxyUrl) { setActive(prev => (prev === null ? prev : { ...prev, proxyUrl: row.proxyUrl })); return }
            }
          } catch { /* keep polling */ }
          if (alive) setTimeout(tick, 1500)
        }
        tick()
        return () => { alive = false }
      }, [active])

      const connect = (host) => {
        setBusy(host.id)
        setError(null)
        setStage('connecting')
        setElapsed(0)
        fetch('/api/remote-dsh/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id, version: clientVersion() }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '连接失败')
            setActive({ id: host.id, label: host.label })
            setStage(value.stage || 'connecting')
          })
          .catch(cause => { setError(String(cause.message || cause)); setStage('failed') })
          .finally(() => setBusy(null))
      }

      const disconnect = () => {
        const id = active === null ? null : active.id
        setActive(null)
        setExpanded(false)
        setFilesOpen(false)
        setStage('idle')
        stageRef.current = null
        if (id !== null) {
          fetch('/api/remote-dsh/disconnect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          }).then(refresh).catch(() => {})
        }
      }

      const save = () => {
        setBusy('form')
        setError(null)
        fetch('/api/remote-dsh/hosts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label: form.label,
            host: form.host,
            sshPort: Number(form.sshPort || 22),
            user: form.user,
            password: form.password,
            webPort: Number(form.webPort || 18080),
            installProxy: form.installProxy,
          }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '保存失败')
            setHosts(Array.isArray(value.hosts) ? value.hosts : hosts)
            setForm(EMPTY_FORM)
            setShowForm(false)
          })
          .catch(cause => setError(String(cause.message || cause)))
          .finally(() => setBusy(null))
      }

      const remove = (host) => {
        setBusy(host.id)
        fetch('/api/remote-dsh/hosts?id=' + encodeURIComponent(host.id), { method: 'DELETE' })
          .then(jsonOf)
          .then(value => setHosts(Array.isArray(value.hosts) ? value.hosts : hosts))
          .catch(cause => setError(String(cause.message || cause)))
          .finally(() => setBusy(null))
      }

      /** Delete with a source-aware confirmation. */
      const askRemove = (host) => {
        const message = host.source === 'dsh-ssh'
          ? '「' + host.label + '」来自 SSH 插件，删除会同时把它从 ~/.dsh/dsh-ssh.json 里移除。继续？'
          : '删除主机「' + host.label + '」？'
        if (window.confirm(message)) remove(host)
      }

      /** Connectivity/environment probe; never installs or starts anything. */
      const test = (host) => {
        setTests(prev => ({ ...prev, [host.id]: { state: 'running', text: '正在测试 SSH 与环境…' } }))
        fetch('/api/remote-dsh/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id, version: clientVersion() }),
        })
          .then(jsonOf)
          .then(value => {
            if (value.ok !== true) {
              setTests(prev => ({ ...prev, [host.id]: { state: 'failed', ok: false, text: '测试失败：' + (value.error || '未知错误') } }))
              return
            }
            const parts = ['SSH 正常']
            parts.push(value.node === '' ? 'Node 缺失' : 'Node ' + value.node)
            parts.push(value.dsh === '' ? 'dsh 未安装（连接时会自动安装）'
              : 'dsh ' + value.dsh + (value.versionMatches ? '（版本匹配）' : '（版本不符，连接时会自动安装）'))
            parts.push(value.webAlive
              ? (value.webStale ? '远端 dsh web 在运行但是旧进程（连接时会自动重启）' : '远端 dsh web 在运行')
              : '远端 dsh web 未运行（连接时会启动）')
            setTests(prev => ({ ...prev, [host.id]: { state: 'done', ok: true, text: parts.join(' · ') + ' · ' + value.ms + 'ms' } }))
          })
          .catch(cause => setTests(prev => ({ ...prev, [host.id]: { state: 'failed', ok: false, text: '测试失败：' + (cause.message || cause) } })))
      }

      const chromeTop = document.documentElement.hasAttribute('data-windows-titlebar') ? 40 : 0
      const stageText = STAGE_TEXT[stage] || stage

      if (syncHost !== null) {
        return h(SyncView, {
          host: syncHost,
          version: clientVersion(),
          onClose: () => { setSyncHost(null); refresh() },
        })
      }

      if (active !== null) {
        return h(
          'div',
          { style: s.page, 'data-dsh-plugin': 'remote-dsh' },
          expanded ? null : h(
            'div',
            { style: s.header },
            h('span', { style: s.dot(stage === 'ready' ? true : null) }),
            h('span', { style: s.title }, '远程 DSH'),
            h('span', { style: s.muted }, active.label),
            h('span', { style: s.muted }, stageText + (elapsed > 0 && stage !== 'ready' ? '（' + elapsed + 's）' : '')),
            h('span', { style: s.spacer }),
            h('button', {
              type: 'button',
              style: s.btn,
              disabled: active.proxyUrl === undefined,
              onClick: () => setFilesOpen(value => !value),
              title: '通过 SFTP 浏览、上传、下载远端文件',
            }, filesOpen ? '返回界面' : '文件'),
            h('button', { type: 'button', style: s.btn, onClick: () => { setStage('ready'); setReloadKey(key => key + 1) } }, '重新加载'),
            h('button', { type: 'button', style: s.btn, onClick: () => setExpanded(value => !value) }, '放大'),
            h('button', {
              type: 'button',
              style: s.btn,
              onClick: () => { if (active.proxyUrl !== undefined) window.open(active.proxyUrl, '_blank', 'noopener') },
              title: '在独立浏览器窗口打开（剪贴板不受嵌入限制）',
            }, '在新窗口打开'),
            h('button', { type: 'button', style: s.btn, onClick: disconnect }, '断开'),
          ),
          h(
            'div',
            { ref: stageRef, style: expanded ? { ...s.body, position: 'fixed', left: 0, right: 0, bottom: 0, top: chromeTop, zIndex: 999999 } : s.body },
            active.proxyUrl !== undefined
              ? h('iframe', {
                  key: reloadKey,
                  src: active.proxyUrl,
                  style: filesOpen ? { ...s.frame, visibility: 'hidden' } : s.frame,
                  title: 'remote dsh',
                  // The remote page is cross-origin to the dsh-app shell, so the
                  // clipboard permissions must be delegated explicitly; without
                  // this the remote UI's "copy link" buttons fail silently.
                  allow: 'clipboard-read; clipboard-write',
                  onLoad: () => setStage('ready'),
                })
              : h('div', { style: s.center },
                  stageText + (elapsed > 0 ? '（' + elapsed + 's）' : ''),
                  h('div', { style: { marginTop: '8px' } }, '首次连接一台新机器时，会先检查/安装远端的 dsh，再启动 dsh web。')),
            filesOpen ? h(TransferView, { hostId: active.id, onClose: () => setFilesOpen(false) }) : null,
            error !== null ? h('div', { style: { ...s.error, position: 'absolute', left: '16px', right: '16px', bottom: '16px' } }, error) : null,
          ),
          // Maximized mode is keyboard-only by design: Esc closes it (the
          // gateway bridges Esc out of the embedded frame). A short-lived hint
          // is the only affordance, and it disappears on its own.
          expanded && showHint
            ? h('div', { style: s.restore }, '已放大 · 按 Esc 退出')
            : null,
        )
      }

      return h(
        'div',
        { style: s.page, 'data-dsh-plugin': 'remote-dsh' },
        h(
          'div',
          { style: s.header },
          h('span', { style: s.title }, '远程 DSH'),
          h('span', { style: s.muted }, '选择主机后在本面板内打开远端 DSH'),
          h('span', { style: s.spacer }),
          h('button', { type: 'button', style: s.btn, onClick: () => { setShowForm(value => !value); setError(null) } }, showForm ? '取消' : '添加主机'),
        ),
        h(
          'div',
          { style: s.body },
          h(
            'div',
            { style: s.list },
            error !== null ? h('div', { style: s.error }, error) : null,
            showForm ? h(
              'div',
              { style: s.form },
              h(Field, { label: '名称（可选）' }, h('input', { style: s.input, value: form.label, onChange: e => setForm({ ...form, label: e.target.value }), placeholder: '实验室服务器' })),
              h(Field, { label: '主机 / IP' }, h('input', { style: s.input, value: form.host, onChange: e => setForm({ ...form, host: e.target.value }), placeholder: '10.82.186.100' })),
              h(Field, { label: 'SSH 端口' }, h('input', { style: s.input, value: form.sshPort, onChange: e => setForm({ ...form, sshPort: e.target.value }) })),
              h(Field, { label: '用户名' }, h('input', { style: s.input, value: form.user, onChange: e => setForm({ ...form, user: e.target.value }), placeholder: 'zhao' })),
              h(Field, { label: '密码' }, h('input', { style: s.input, type: 'password', value: form.password, onChange: e => setForm({ ...form, password: e.target.value }) })),
              h(Field, { label: '远端 dsh web 端口' }, h('input', { style: s.input, value: form.webPort, onChange: e => setForm({ ...form, webPort: e.target.value }) })),
              h(Field, { label: '安装用代理（可选，如 http://127.0.0.1:7890）' }, h('input', { style: s.input, value: form.installProxy, onChange: e => setForm({ ...form, installProxy: e.target.value }) })),
              h('div', { style: { gridColumn: '1 / -1', display: 'flex', gap: '10px', justifyContent: 'flex-end' } },
                h('button', { type: 'button', style: s.btn, onClick: () => { setForm(EMPTY_FORM); setShowForm(false) } }, '取消'),
                h('button', { type: 'button', style: s.primary, onClick: save, disabled: busy === 'form' }, busy === 'form' ? '保存中…' : '保存')),
            ) : null,
            hosts.length === 0
              ? h('div', { style: { ...s.muted, padding: '10px 2px' } }, '还没有可用主机。可以在上面「添加主机」，或先在 SSH 插件里配置（会自动出现在这里）。')
              : null,
            hosts.map(host => {
              const probe = tests[host.id]
              return h(
                'div',
                { key: host.id, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h(
                  'div',
                  { style: s.row },
                  h('div', { style: s.rowMain },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      h('span', { style: { fontWeight: 600 } }, host.label),
                      h('span', { style: s.badge }, host.source === 'dsh-ssh' ? 'SSH 插件' : '本面板'),
                      host.connected ? h('span', { style: s.badge }, '已连接') : null,
                      host.stage !== undefined && host.stage !== 'idle' && host.stage !== 'ready' && host.stage !== 'failed'
                        ? h('span', { style: s.badge }, STAGE_TEXT[host.stage] || host.stage)
                        : null),
                    h('div', { style: s.muted }, host.user + '@' + host.host + ':' + host.sshPort + '  ·  web ' + host.webPort)),
                  h('button', { type: 'button', style: s.btn, onClick: () => test(host), disabled: probe !== undefined && probe.state === 'running' },
                    probe !== undefined && probe.state === 'running' ? '测试中…' : '测试'),
                  h('button', {
                    type: 'button', style: s.btn, onClick: () => setSyncHost(host),
                    disabled: busy === host.id || (host.stage !== 'idle' && host.stage !== 'ready' && host.stage !== 'failed'),
                  }, '同步'),
                  h('button', { type: 'button', style: s.primary, onClick: () => connect(host), disabled: busy === host.id }, busy === host.id ? '连接中…' : '连接'),
                  h('button', { type: 'button', style: s.btn, onClick: () => askRemove(host), disabled: busy === host.id }, '删除'),
                ),
                probe !== undefined && probe.text !== undefined
                  ? h('div', { style: { ...s.muted, whiteSpace: 'normal', paddingLeft: '14px', color: probe.ok ? '#3fb950' : '#e0a458' } }, probe.text)
                  : null,
              )
            }),
          ),
        ),
      )
    }

    exports.inject = ['slots']

    exports.apply = (ctx) => {
      const disposers = []
      try {
        const slots = ctx.slots
        disposers.push(slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 45,
          label: () => '远程 DSH',
        }, RemoteDshIcon)))
        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, RemoteDshPage)))
      } catch (error) {
        console.warn('[remote-dsh] panel registration failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* already gone */ }
        }
      })
    }

    return module.exports
  },
})
