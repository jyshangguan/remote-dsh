/**
 * Browser half of dsh-remote-panel-openssh.
 *
 * Two views:
 *  - host picker: Host aliases discovered from ~/.ssh/config, each with an
 *    inline settings editor (web port, profile, log path, install proxy);
 *  - session: the remote DSH embedded through the loopback gateway, with
 *    reload / maximize / disconnect and the two-pane SFTP transfer view.
 *
 * A connect request only starts a host-side job; this page polls /state and
 * shows the current stage (SSH, environment check, side install, start,
 * gateway). When taking over the remote is unsafe the job lands in
 * 'manual-action-required' and this page shows a warning card with the reason
 * and a retry button — it never kills or restarts anything on its own.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-panel-openssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'remote-dsh-openssh'
    const API = '/api/remote-dsh-openssh'

    const STAGE_TEXT = {
      idle: '未连接',
      connecting: '正在连接 SSH…',
      ssh: 'SSH 已连通',
      checking: '正在检查远端环境…',
      installing: '正在侧装远端 DSH（首次可能需要几分钟）…',
      starting: '正在启动远端 dsh web…',
      gateway: '正在建立会话通道…',
      ready: '已连接',
      failed: '连接失败',
      'manual-action-required': '需人工处理',
    }

    /** A connect job still running on the host (anything not settled). */
    const isInFlight = stage => stage !== 'idle' && stage !== 'ready' && stage !== 'failed' && stage !== 'manual-action-required'

    const s = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '13px/1.5 system-ui, "Segoe UI", sans-serif', color: 'var(--dsw-alias-label-primary, inherit)', background: 'var(--dsw-alias-bg-base, #fff)' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', flex: '0 0 auto' },
      dot: (ok) => ({ width: '8px', height: '8px', borderRadius: '50%', background: ok === true ? 'var(--dsw-alias-state-success-primary, #3fb950)' : ok === false ? 'var(--dsw-alias-state-warn-primary, #d29922)' : 'var(--dsw-alias-state-idle-primary, #8b95a5)', flex: '0 0 auto' }),
      title: { fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      spacer: { flex: 1 },
      btn: { font: 'inherit', padding: '4px 10px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { font: 'inherit', padding: '4px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-brand-primary, #2563eb)', background: 'var(--dsw-alias-brand-primary, #2563eb)', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
      body: { position: 'relative', flex: 1, minHeight: 0, background: 'var(--dsw-alias-bg-base, #fff)', overflow: 'auto' },
      frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 },
      list: { padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '860px' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      badge: { fontSize: '11px', padding: '0 6px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', color: 'var(--dsw-alias-label-secondary, inherit)' },
      form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', padding: '14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' },
      input: { font: 'inherit', padding: '6px 8px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, inherit)' },
      error: { padding: '10px 12px', borderRadius: '9px', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d29922) 14%, transparent)', color: 'var(--dsw-alias-state-error-primary, #f6b8b8)', border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #6b1e1e) 45%, transparent)', fontSize: '12.5px' },
      center: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-tertiary, #8b95a5)', fontSize: '12.5px', pointerEvents: 'none', textAlign: 'center', padding: '24px' },
      restore: { position: 'fixed', top: '52px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483000, padding: '6px 14px', borderRadius: '999px', background: 'var(--dsw-alias-bg-overlay, rgba(24,26,32,.78))', color: 'var(--dsw-alias-label-primary, #fff)', border: '1px solid var(--dsw-alias-border-l1, transparent)', font: 'inherit', fontSize: '12.5px', pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.25)' },
      section: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))' },
      sectionTitle: { fontWeight: 600, fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '8px' },
      warn: { padding: '8px 10px', borderRadius: '8px', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e7c27d) 14%, transparent)', color: 'var(--dsw-alias-state-warn-primary, #e7c27d)', border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #6b551e) 45%, transparent)', fontSize: '12px' },
      okText: { color: 'var(--dsw-alias-state-success-primary, #3fb950)' },
      badText: { color: 'var(--dsw-alias-state-warn-primary, #e0a458)' },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '4px' },
      card: { pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '560px', width: '100%', textAlign: 'left', padding: '16px 18px', borderRadius: '12px', border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #6b551e) 45%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fffaf0) 10%, var(--dsw-alias-bg-layer-1, #fffaf0))', color: 'var(--dsw-alias-label-primary, #5c4a1e)', boxShadow: '0 6px 24px rgba(0,0,0,.08)' },
      cardTitle: { fontWeight: 700, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--dsw-alias-state-warn-primary, #9a6b0f)' },
      cardText: { fontSize: '12.5px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      cardCode: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px', wordBreak: 'break-all' },
      tabBar: { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 8px 0', flex: '0 0 auto', overflowX: 'auto', overflowY: 'hidden', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      tab: (active) => ({ display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto', padding: '5px 12px', borderRadius: '8px 8px 0 0', cursor: 'pointer', whiteSpace: 'nowrap', font: 'inherit', fontSize: '12.5px', fontWeight: active ? 600 : 400, color: active ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, inherit)', background: active ? 'var(--dsw-alias-bg-base, #fff)' : 'transparent', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', borderBottom: active ? '1px solid var(--dsw-alias-bg-base, #fff)' : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', boxShadow: active ? 'inset 0 2px 0 var(--dsw-alias-brand-primary, #2563eb)' : 'none' }),
      tabDot: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto', background: 'var(--dsw-alias-state-success-primary, #3fb950)' },
      tabAdd: (active) => ({ ...s.btn, flex: '0 0 auto', padding: '5px 11px', fontWeight: 600, borderRadius: '8px', color: active ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-label-secondary, inherit)', borderColor: active ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))' }),
      sessionRoot: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
      pickerRoot: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
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
        h('circle', { cx: 6.75, cy: 6.75, r: 1.25 }),
        h('path', { d: 'M8 6.75h2.75M9.75 6.75v1.5' }),
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
      paneError: { padding: '6px 10px', color: 'var(--dsw-alias-state-warn-primary, #e0a458)', fontSize: '12px', borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)' },
      middle: { flex: '0 0 auto', width: '96px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' },
      status: { minHeight: '22px', display: 'flex', gap: '12px', padding: '2px 12px 8px', fontSize: '12px', flex: '0 0 auto' },
    }

    /**
     * One side of the transfer view: the same protocol, two backends.
     * `local` talks to /api/remote-dsh-openssh/local, `remote` to
     * /api/remote-dsh-openssh/fs.
     */
    function usePane(kind, hostId) {
      const base = kind === 'local' ? API + '/local' : API + '/fs'
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

    /** Warning card for a failed or manual-action-required connect job. */
    function FailureCard({ stage, failure, onRetry, retrying }) {
      const manual = stage === 'manual-action-required'
      const detail = failure.detail === null || failure.detail === undefined ? {} : failure.detail
      const pids = Array.isArray(detail.pids) && detail.pids.length > 0 ? detail.pids.join(', ') : null
      return h(
        'div',
        { style: s.card },
        h('div', { style: s.cardTitle }, manual ? '⚠ 需人工处理' : '连接失败'),
        h('div', { style: s.cardText }, failure.error || (manual ? '远端状态需要人工确认。' : '连接失败')),
        manual && typeof detail.hint === 'string' && detail.hint !== ''
          ? h('div', { style: { ...s.cardText, opacity: 0.85 } }, detail.hint)
          : null,
        pids !== null ? h('div', { style: s.cardCode }, '涉及进程 PID：' + pids) : null,
        manual
          ? h('div', { style: { ...s.cardText, opacity: 0.7 } }, '本插件不会自动结束或重启远端进程。请人工确认并处理后，再重试连接。')
          : null,
        h(
          'div',
          { style: s.footer },
          h('button', { type: 'button', style: s.primary, disabled: retrying === true, onClick: onRetry }, retrying === true ? '重试中…' : '重试'),
        ),
      )
    }

    // ------------------------------------------------------- keep-alive store
    //
    // The layout's main slot renders ONLY the active entry, so RemoteDshPage
    // unmounts whenever the user navigates to a local session. Removing an
    // iframe from the DOM discards its browsing context (verified in Chromium:
    // contentDocument becomes null and re-appending reloads it), so the frame
    // must never leave the DOM while its session lives. FrameHost below is
    // registered into shell.overlay — a slot the shell renders unconditionally —
    // and owns the iframe; this module-level store is the bridge that survives
    // the page's unmount/remount. visibility:hidden keeps the frame alive while
    // preserving its layout size (also verified empirically).
    const frameStore = (() => {
      const initial = () => ({
        /** hostId -> { proxyUrl, sessionId, epoch, loaded } — one per live session. */
        frames: new Map(),
        /** Which session paints (null = picker / none). */
        activeId: null,
        /** Panel mounted AND the active frame should paint. */
        visible: false,
        /** Authoritative: the shell's active main panel is THIS panel (ctx.layout). */
        panelActive: false,
        hint: false,
        error: null,
        /** () => DOMRect|null — live stage-rect reader published by SessionView. */
        measure: null,
      })
      let state = initial()
      const listeners = new Set()
      const notify = () => { for (const fn of [...listeners]) fn() }
      const commit = next => { state = next; notify() }
      return {
        get: () => state,
        set(patch) { commit({ ...state, ...patch }) },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
        /** Add/refresh a session's frame; reset loaded only when its identity changes. */
        upsertFrame(hostId, { proxyUrl, sessionId }) {
          const frames = new Map(state.frames)
          const prev = frames.get(hostId)
          const same = prev !== undefined && prev.proxyUrl === proxyUrl && prev.sessionId === sessionId
          frames.set(hostId, { proxyUrl, sessionId, epoch: prev === undefined ? 0 : prev.epoch, loaded: same ? prev.loaded : false })
          commit({ ...state, frames })
        },
        removeFrame(hostId) {
          if (!state.frames.has(hostId)) return
          const frames = new Map(state.frames)
          frames.delete(hostId)
          commit({ ...state, frames })
        },
        /** 重新加载: force a fresh iframe for this host only. */
        bumpEpoch(hostId) {
          const prev = state.frames.get(hostId)
          if (prev === undefined) return
          const frames = new Map(state.frames)
          frames.set(hostId, { ...prev, epoch: prev.epoch + 1, loaded: false })
          commit({ ...state, frames })
        },
        setFrameLoaded(hostId, loaded) {
          const prev = state.frames.get(hostId)
          if (prev === undefined || prev.loaded === loaded) return
          const frames = new Map(state.frames)
          frames.set(hostId, { ...prev, loaded })
          commit({ ...state, frames })
        },
        reset() { commit(initial()) },
      }
    })()

    /**
     * Per-host chrome view state (stage/failure/expanded/filesOpen), remembered
     * across host switches AND panel switches. Lost on full page refresh, which
     * re-adopts connected sessions from host /state instead.
     */
    const viewStates = new Map()
    /** Last active host, restored on panel-switch remount (not across refresh). */
    let lastActiveId = null

    /**
     * Persistent frame host, mounted in shell.overlay for the plugin's whole
     * lifetime. Renders ONE iframe PER live session, all kept in the DOM (all
     * kept alive); only the active one is visibility:visible. Each iframe is
     * keyed by (hostId, sessionId, proxyUrl, epoch): switching the active host
     * never remounts any frame, reload/death/new-session replaces only its own.
     * The shared container is position:absolute inside the overlay layer and
     * tracks the active stage rect in layer-relative coordinates (offsetParent),
     * correct even if an ancestor creates a containing block. A rAF loop while
     * visible follows the shell's animated column resizes without 60fps React.
     */
    function FrameHost() {
      const snap = React.useSyncExternalStore(frameStore.subscribe, frameStore.get)
      const boxRef = React.useRef(null)
      const entries = [...snap.frames.entries()]
      const signature = entries.map(([id, f]) => id + ':' + f.sessionId + ':' + f.epoch).join('|')
      // Paint only when the page wants it AND the shell confirms this panel is
      // the active main view. The layout signal is authoritative even if the
      // page's unmount cleanup is delayed or the panel stays mounted inactive.
      const show = snap.visible && snap.panelActive

      React.useLayoutEffect(() => {
        const box = boxRef.current
        if (box === null) return undefined
        if (!show) {
          box.style.left = '0px'
          box.style.top = '0px'
          box.style.width = '0px'
          box.style.height = '0px'
          box.style.visibility = 'hidden'
          box.style.pointerEvents = 'none'
          return undefined
        }
        const place = () => {
          if (!frameStore.get().panelActive || !frameStore.get().visible) {
            box.style.left = '0px'
            box.style.top = '0px'
            box.style.width = '0px'
            box.style.height = '0px'
            box.style.visibility = 'hidden'
            box.style.pointerEvents = 'none'
            return
          }
          const measure = frameStore.get().measure
          const rect = typeof measure === 'function' ? measure() : null
          if (rect === null || rect.width <= 0 || rect.height <= 0) {
            box.style.left = '0px'
            box.style.top = '0px'
            box.style.width = '0px'
            box.style.height = '0px'
            box.style.visibility = 'hidden'
            box.style.pointerEvents = 'none'
            return
          }
          // Layer-relative coords: the overlay layer is the positioned ancestor
          // (offsetParent); subtracting its rect cancels any ancestor transform.
          const parent = box.offsetParent
          const base = parent !== null && parent !== document.body ? parent.getBoundingClientRect() : { left: 0, top: 0 }
          box.style.left = (rect.left - base.left) + 'px'
          box.style.top = (rect.top - base.top) + 'px'
          box.style.width = rect.width + 'px'
          box.style.height = rect.height + 'px'
          box.style.visibility = 'visible'
          box.style.pointerEvents = 'auto'
        }
        place()
        let raf = 0
        const loop = () => { place(); raf = requestAnimationFrame(loop) }
        raf = requestAnimationFrame(loop)
        return () => {
          cancelAnimationFrame(raf)
          if (box) {
            box.style.left = '0px'
            box.style.top = '0px'
            box.style.width = '0px'
            box.style.height = '0px'
            box.style.visibility = 'hidden'
            box.style.pointerEvents = 'none'
          }
        }
      }, [show, snap.activeId, signature])

      if (entries.length === 0) return null
      return h(
        'div',
        {
          ref: boxRef,
          'data-dsh-remote-frame': PANEL_ID,
          // Constant style values: React only writes keys that change between
          // renders, so the imperative left/top/width/height survive re-renders.
          style: {
            position: 'absolute', left: 0, top: 0, width: 0, height: 0,
            overflow: 'hidden', zIndex: 0,
            visibility: show ? 'visible' : 'hidden',
            pointerEvents: show ? 'auto' : 'none',
          },
        },
        entries.map(([id, f]) => h('iframe', {
          key: id + ':' + f.sessionId + ':' + f.proxyUrl + ':' + f.epoch,
          src: f.proxyUrl,
          style: {
            position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block',
            visibility: (show && id === snap.activeId) ? 'visible' : 'hidden',
            pointerEvents: (show && id === snap.activeId) ? 'auto' : 'none',
          },
          title: 'remote dsh',
          // The remote page is cross-origin to the dsh-app shell, so clipboard
          // permissions must be delegated explicitly.
          allow: 'clipboard-read; clipboard-write',
          onLoad: () => frameStore.setFrameLoaded(id, true),
        })),
        // The Esc hint and the error toast live HERE, above the iframes: the
        // page's main-slot stacking context paints below the overlay layer.
        show && snap.hint
          ? h('div', { style: { ...s.restore, position: 'absolute', top: '12px', zIndex: 2 } }, '已放大 · 按 Esc 退出')
          : null,
        show && snap.error !== null
          ? h('div', { style: { ...s.error, position: 'absolute', left: '16px', right: '16px', bottom: '16px', zIndex: 1 } }, snap.error)
          : null,
      )
    }

    /**
     * One host's session view, keyed by hostId so switching hosts remounts the
     * chrome (cheap) while the iframe lives on in FrameHost (kept alive). Chrome
     * state (stage/failure/expanded/filesOpen) is remembered per host in the
     * module-level viewStates map, so A→B→A restores A's exact view.
     */
    /**
     * Persistent tab bar above the session view / picker: one tab per connected
     * (non-hidden) server, plus a trailing "+" that opens the server list to
     * start another. Clicking a tab enters that server via the idempotent
     * connect (no SPA reload, no SSH rebuild); the active tab is highlighted.
     */
    function TabBar({ hosts, activeId, busy, onEnter, onNew }) {
      const tabs = hosts.filter(host => host.connected === true && host.hidden !== true)
      return h(
        'div',
        { style: s.tabBar, 'data-dsh-tabbar': PANEL_ID },
        tabs.map(host => h('button', {
          key: host.id,
          type: 'button',
          style: s.tab(activeId === host.id),
          disabled: busy === host.id,
          onClick: () => onEnter(host),
          title: '切换到 ' + (host.alias || host.label) + '（会话保持，不重连）',
        }, h('span', { style: s.tabDot }), h('span', null, host.alias || host.label))),
        h('button', {
          type: 'button',
          style: s.tabAdd(activeId === null),
          onClick: onNew,
          title: '添加远程服务器 / 打开服务器列表',
        }, '+'),
      )
    }

    function SessionView({ hostId, row, busy, onDisconnect, onRetry }) {
      const cached = viewStates.get(hostId)
      const label = (row && row.label) || hostId.replace(/^openssh:/, '')
      const initStage = cached !== undefined ? cached.stage
        : (row && row.connected ? 'ready' : (row && isInFlight(row.stage) ? row.stage : 'idle'))
      const [stage, setStage] = React.useState(initStage)
      const [failure, setFailure] = React.useState(cached !== undefined ? cached.failure : null)
      const [expanded, setExpanded] = React.useState(cached !== undefined ? cached.expanded : false)
      const [filesOpen, setFilesOpen] = React.useState(cached !== undefined ? cached.filesOpen : false)
      const [elapsed, setElapsed] = React.useState(0)
      const [showHint, setShowHint] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [session, setSession] = React.useState(() => (
        row && row.connected && row.proxyUrl ? { proxyUrl: row.proxyUrl, sessionId: row.sessionId ?? null } : null
      ))
      const stageRef = React.useRef(null)

      // Remember this host's chrome across host switches and panel switches.
      React.useEffect(() => { viewStates.set(hostId, { stage, failure, expanded, filesOpen }) }, [hostId, stage, failure, expanded, filesOpen])

      const frameSnap = React.useSyncExternalStore(frameStore.subscribe, frameStore.get)
      const frameLoaded = frameSnap.frames.has(hostId) ? frameSnap.frames.get(hostId).loaded : false
      React.useEffect(() => {
        if (frameLoaded && session !== null) setStage('ready')
      }, [frameLoaded, session])

      const rowConnected = row ? row.connected : undefined
      const rowStage = row ? row.stage : undefined
      const rowProxy = row ? row.proxyUrl : undefined
      const rowSessionId = row ? row.sessionId : undefined
      const rowError = row ? row.error : undefined
      const rowDetail = row ? row.detail : undefined
      const settledFailure = failure !== null && (stage === 'failed' || stage === 'manual-action-required')

      // Adopt a live session from the authoritative row (covers remount before
      // /hosts loads, and reconciliation). Primitive deps avoid 4s re-runs.
      React.useEffect(() => {
        if (session === null && rowConnected === true && rowProxy && !settledFailure) {
          const next = { proxyUrl: rowProxy, sessionId: rowSessionId ?? null }
          setSession(next)
          frameStore.upsertFrame(hostId, next)
          setStage('ready')
        }
      }, [rowConnected, rowProxy, rowSessionId, session, settledFailure, hostId])

      // Death of THIS host (active): discard its frame and show the retry card.
      React.useEffect(() => {
        if (rowConnected === false && (rowStage === 'failed' || rowStage === 'manual-action-required')) {
          frameStore.removeFrame(hostId)
          setSession(null)
          setStage(rowStage)
          setFailure({ error: rowError || '远端连接已断开，请重新连接', detail: rowDetail || null })
          setFilesOpen(false)
        }
      }, [rowConnected, rowStage, rowError, rowDetail, hostId])

      // Poll an in-flight connect job (install can take minutes). The boolean
      // dep stays true across in-flight stage transitions, so the loop is not
      // restarted on every stage change.
      const polling = session === null && (isInFlight(stage) || (row !== undefined && isInFlight(row.stage)))
      React.useEffect(() => {
        if (!polling) return undefined
        let alive = true
        const tick = async () => {
          try {
            const state = await jsonOf(await fetch(API + '/state', { headers: { accept: 'application/json' } }))
            if (!alive) return
            const r = (state.hosts || []).find(item => item.id === hostId)
            if (r !== undefined) {
              setStage(r.stage || 'connecting')
              setElapsed(Math.round((r.sinceMs || 0) / 1000))
              if (r.stage === 'failed' || r.stage === 'manual-action-required') {
                setFailure({ error: r.error || '连接失败', detail: r.detail || null })
                return
              }
              if (r.proxyUrl) {
                const next = { proxyUrl: r.proxyUrl, sessionId: r.sessionId ?? null }
                setSession(next)
                frameStore.upsertFrame(hostId, next)
                return
              }
            }
          } catch { /* keep polling */ }
          if (alive) setTimeout(tick, 1500)
        }
        tick()
        return () => { alive = false }
      }, [polling, hostId])

      // Escape closes the maximized view (the gateway bridges Esc out of the
      // embedded frame via postMessage). Only the active SessionView is mounted.
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

      React.useEffect(() => {
        if (!expanded) { setShowHint(false); return undefined }
        setShowHint(true)
        const timer = setTimeout(() => setShowHint(false), 2500)
        return () => clearTimeout(timer)
      }, [expanded])

      // Publish the view intent to FrameHost before paint (no flash on switch).
      React.useLayoutEffect(() => {
        if (session !== null && !filesOpen && !settledFailure) {
          frameStore.upsertFrame(hostId, session)
          frameStore.set({
            activeId: hostId,
            visible: true,
            hint: showHint,
            error,
            measure: () => (stageRef.current === null ? null : stageRef.current.getBoundingClientRect()),
          })
        } else {
          frameStore.set({ visible: false, hint: false, error: null, measure: null })
        }
      }, [hostId, session, filesOpen, settledFailure, showHint, error])

      // Unmount (host switch / navigate away): hide, keep the frame alive.
      // MUST be a layout effect: its cleanup runs synchronously during the
      // unmount commit, before paint. A passive useEffect cleanup flushes
      // asynchronously after paint, so a heavy conversation view mounting can
      // delay it and leave the overlay iframe painted over the local session
      // (the "frozen remote window" bug). Layout cleanup hides it pre-paint.
      React.useLayoutEffect(() => () => { frameStore.set({ visible: false, hint: false, measure: null }) }, [])

      const proxyUrl = session === null ? undefined : session.proxyUrl
      const chromeTop = document.documentElement.hasAttribute('data-windows-titlebar') ? 40 : 0
      const stageText = STAGE_TEXT[stage] || stage

      return h(
        'div',
        { style: s.sessionRoot },
        expanded ? null : h(
          'div',
          { style: s.header },
          h('span', { style: s.dot(stage === 'ready' ? true : (stage === 'failed' || stage === 'manual-action-required') ? false : null) }),
          h('span', { style: s.title }, '远程 DSH'),
          h('span', { style: s.muted }, label),
          h('span', { style: s.muted }, stageText + (elapsed > 0 && stage !== 'ready' ? '（' + elapsed + 's）' : '')),
          h('span', { style: s.spacer }),
          h('button', {
            type: 'button',
            style: s.btn,
            disabled: proxyUrl === undefined,
            onClick: () => setFilesOpen(value => !value),
            title: '通过 SFTP 浏览、上传、下载远端文件',
          }, filesOpen ? '返回界面' : '文件'),
          h('button', { type: 'button', style: s.btn, disabled: proxyUrl === undefined, onClick: () => { setStage('ready'); frameStore.bumpEpoch(hostId) } }, '重新加载'),
          h('button', { type: 'button', style: s.btn, onClick: () => setExpanded(value => !value) }, '放大'),
          h('button', {
            type: 'button',
            style: s.btn,
            onClick: () => { if (proxyUrl !== undefined) window.open(proxyUrl, '_blank', 'noopener') },
            title: '在独立浏览器窗口打开（剪贴板不受嵌入限制）',
          }, '在新窗口打开'),
          h('button', { type: 'button', style: s.btn, onClick: () => onDisconnect(hostId) }, '断开'),
        ),
        h(
          'div',
          // Expanded: fullscreen background + measurement anchor only (the frame
          // paints in shell.overlay at z 20), so sit just BELOW the overlay layer.
          { ref: stageRef, style: expanded ? { ...s.body, position: 'fixed', left: 0, right: 0, bottom: 0, top: chromeTop, zIndex: 19 } : s.body },
          proxyUrl !== undefined
            ? null
            : settledFailure
              ? h('div', { style: s.center },
                  h(FailureCard, {
                    stage,
                    failure,
                    retrying: busy === hostId,
                    onRetry: () => onRetry({ id: hostId, label }),
                  }))
              : h('div', { style: s.center },
                  stageText + (elapsed > 0 ? '（' + elapsed + 's）' : ''),
                  h('div', { style: { marginTop: '8px' } }, '首次连接一台新机器时，会先检查远端环境，必要时侧装匹配版本的 DSH，再启动 dsh web；不会改动远端已有的 DSH。')),
          filesOpen ? h(TransferView, { hostId, onClose: () => setFilesOpen(false) }) : null,
          (proxyUrl === undefined || filesOpen) && error !== null && !settledFailure
            ? h('div', { style: { ...s.error, position: 'absolute', left: '16px', right: '16px', bottom: '16px' } }, error)
            : null,
        ),
      )
    }

    function RemoteDshPage() {
      const [hosts, setHosts] = React.useState([])
      const [busy, setBusy] = React.useState(null)
      const [tests, setTests] = React.useState({})
      const [error, setError] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [editForm, setEditForm] = React.useState({ webPort: '', profile: '', webLog: '', nodeBin: '', installProxy: '' })
      const [editError, setEditError] = React.useState(null)
      const [showHidden, setShowHidden] = React.useState(false)
      const [activeId, setActiveId] = React.useState(lastActiveId)
      const activeIdRef = React.useRef(activeId)
      React.useEffect(() => {
        activeIdRef.current = activeId
        lastActiveId = activeId
        frameStore.set({ activeId })
      }, [activeId])

      /** Mirror host rows into the frame map: upsert connected, prune the rest. */
      const syncFrames = React.useCallback(rows => {
        const connectedIds = new Set()
        for (const r of rows) {
          if (r.connected === true && r.proxyUrl) {
            connectedIds.add(r.id)
            frameStore.upsertFrame(r.id, { proxyUrl: r.proxyUrl, sessionId: r.sessionId ?? null })
          }
        }
        for (const id of [...frameStore.get().frames.keys()]) {
          if (!connectedIds.has(id)) { frameStore.removeFrame(id); viewStates.delete(id) }
        }
      }, [])

      /** Mount-time adoption: keep the current host if live, else adopt one. */
      const reconcile = React.useCallback(rows => {
        syncFrames(rows)
        const usable = rows.filter(item => item.hidden !== true)
        const current = activeIdRef.current
        let row = current === null ? undefined : usable.find(item => item.id === current)
        const keepCurrent = row !== undefined && (row.connected === true || isInFlight(row.stage))
        if (!keepCurrent) {
          row = usable.find(item => item.connected === true && item.proxyUrl)
            ?? usable.find(item => isInFlight(item.stage))
        }
        setActiveId(row === undefined ? null : row.id)
      }, [syncFrames])

      const refresh = React.useCallback(withReconcile => {
        fetch(API + '/hosts', { headers: { accept: 'application/json' } })
          .then(jsonOf)
          .then(value => {
            const rows = Array.isArray(value.hosts) ? value.hosts : []
            setHosts(rows)
            setError(null)
            syncFrames(rows)
            if (withReconcile === true) reconcile(rows)
          })
          .catch(cause => setError(cause.message || String(cause)))
      }, [reconcile, syncFrames])

      React.useEffect(() => { refresh(true) }, [refresh])

      // Page-level watch: keep hosts + ALL frames fresh, so a NON-active session
      // dying prunes its frame (the active SessionView handles its own death via
      // its row prop). Runs only while the panel is mounted.
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const state = await jsonOf(await fetch(API + '/state', { headers: { accept: 'application/json' } }))
            if (!alive) return
            const rows = Array.isArray(state.hosts) ? state.hosts : []
            setHosts(rows)
            syncFrames(rows)
          } catch { /* keep watching */ }
          if (alive) setTimeout(tick, 4000)
        }
        const timer = setTimeout(tick, 4000)
        return () => { alive = false; clearTimeout(timer) }
      }, [syncFrames])

      // Navigating away unmounts this page: hide frames, keep them alive.
      // Layout effect (synchronous pre-paint cleanup) — see SessionView note.
      React.useLayoutEffect(() => () => { frameStore.set({ visible: false, hint: false, measure: null }) }, [])

      const connect = (host) => {
        setBusy(host.id)
        setError(null)
        fetch(API + '/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '连接失败')
            if (Array.isArray(value.hosts)) setHosts(value.hosts)
            if (value.alreadyConnected === true && value.proxyUrl) {
              frameStore.upsertFrame(host.id, { proxyUrl: value.proxyUrl, sessionId: value.sessionId ?? null })
            }
            setActiveId(host.id)
          })
          .catch(cause => setError(String(cause.message || cause)))
          .finally(() => setBusy(null))
      }

      const disconnect = (hostId) => {
        frameStore.removeFrame(hostId)
        viewStates.delete(hostId)
        if (activeIdRef.current === hostId) setActiveId(null)
        fetch(API + '/disconnect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: hostId }),
        }).then(() => refresh()).catch(() => {})
      }

      /**
       * Panel-level hide/restore ("remove" a server from the list). Persisted
       * in the plugin's own settings store; ~/.ssh/config stays untouched.
       * Connected/in-flight hosts are guarded here (disabled button) AND
       * host-side (409), so a hidden host can never keep a live session.
       */
      const setHidden = (host, hidden) => {
        setError(null)
        fetch(API + '/hide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id, hidden }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '操作失败')
            setHosts(Array.isArray(value.hosts) ? value.hosts : [])
            if (hidden && activeIdRef.current === host.id) {
              frameStore.removeFrame(host.id)
              viewStates.delete(host.id)
              setActiveId(null)
            }
          })
          .catch(cause => setError(cause.message || String(cause)))
      }

      /** Open the inline settings editor for one OpenSSH alias. */
      const openSettings = (host) => {
        setEditing(host.alias)
        setEditError(null)
        setEditForm({
          webPort: String(host.webPort === undefined || host.webPort === null ? '' : host.webPort),
          profile: host.profile || '',
          webLog: host.webLog || '',
          installProxy: host.installProxy || '',
          nodeBin: host.nodeBin || '',
        })
      }

      const saveSettings = () => {
        if (editing === null) return
        setBusy('settings')
        setEditError(null)
        fetch(API + '/hosts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            alias: editing,
            webPort: Number(editForm.webPort),
            profile: editForm.profile,
            webLog: editForm.webLog.trim() === '' ? null : editForm.webLog.trim(),
            installProxy: editForm.installProxy,
            nodeBin: editForm.nodeBin.trim(),
          }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '保存失败')
            setHosts(Array.isArray(value.hosts) ? value.hosts : hosts)
            setEditing(null)
          })
          .catch(cause => setEditError(String(cause.message || cause)))
          .finally(() => setBusy(null))
      }

      /** Connectivity/environment probe; never installs or starts anything. */
      const test = (host) => {
        setTests(prev => ({ ...prev, [host.id]: { state: 'running', text: '正在测试 SSH 与环境…' } }))
        fetch(API + '/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id }),
        })
          .then(jsonOf)
          .then(value => {
            if (value.ok !== true) {
              setTests(prev => ({ ...prev, [host.id]: { state: 'failed', ok: false, text: '测试失败：' + (value.error || '未知错误') } }))
              return
            }
            const parts = ['SSH 正常']
            parts.push(value.node ? 'Node ' + value.node : 'Node 缺失')
            const runtime = value.sideRuntime || {}
            parts.push('侧装运行时 ' + (runtime.installed === true ? (runtime.version || '已安装') : '未安装'))
            parts.push(value.web && value.web.alive === true ? 'dsh web 运行中' : 'dsh web 未运行')
            if (value.action === 'attach') parts.push('可直接接管')
            else if (value.action === 'install-and-start') parts.push('将侧装并启动')
            else if (value.action === 'manual-action-required') parts.push('需人工处理：' + (value.reason || '远端状态需要人工确认'))
            parts.push(value.ms + 'ms')
            setTests(prev => ({ ...prev, [host.id]: { state: 'done', ok: value.action !== 'manual-action-required', text: parts.join(' · ') } }))
          })
          .catch(cause => setTests(prev => ({ ...prev, [host.id]: { state: 'failed', ok: false, text: '测试失败：' + (cause.message || cause) } })))
      }

      const visibleHosts = hosts.filter(host => host.hidden !== true)
      const hiddenHosts = hosts.filter(host => host.hidden === true)

      const content = activeId !== null
        ? h(SessionView, {
            key: activeId,
            hostId: activeId,
            row: hosts.find(host => host.id === activeId),
            busy,
            onDisconnect: disconnect,
            onRetry: connect,
          })
        : h(
          'div',
          { style: s.pickerRoot },
          h(
            'div',
            { style: s.header },
          h('span', { style: s.title }, '远程 DSH'),
          h('span', { style: s.muted }, 'OpenSSH 主机 · 复用 ~/.ssh/config'),
          h('span', { style: s.spacer }),
          hiddenHosts.length > 0
            ? h('button', { type: 'button', style: s.btn, onClick: () => setShowHidden(value => !value) },
                (showHidden ? '收起已隐藏' : '已隐藏') + ' (' + hiddenHosts.length + ')')
            : null,
          h('button', { type: 'button', style: s.btn, onClick: () => refresh() }, '刷新'),
        ),
        h(
          'div',
          { style: s.body },
          h(
            'div',
            { style: s.list },
            error !== null ? h('div', { style: s.error }, error) : null,
            hosts.length === 0
              ? h('div', { style: { ...s.muted, whiteSpace: 'normal', padding: '10px 2px' } }, '没有发现 SSH 主机。请在 ~/.ssh/config 中配置 Host 条目（本插件直接复用 OpenSSH 公钥/agent/known_hosts）。')
              : null,
            hosts.length > 0 && visibleHosts.length === 0
              ? h('div', { style: { ...s.muted, whiteSpace: 'normal', padding: '10px 2px' } }, '所有主机均已隐藏。点右上角「已隐藏」可恢复显示。')
              : null,
            visibleHosts.map(host => {
              const probe = tests[host.id]
              const inFlight = isInFlight(host.stage)
              const hideBlocked = host.connected === true || inFlight
              return h(
                'div',
                { key: host.id, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h(
                  'div',
                  { style: s.row },
                  h('div', { style: s.rowMain },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      h('span', { style: { fontWeight: 600 } }, host.alias || host.label),
                      h('span', { style: s.badge }, 'OpenSSH'),
                      host.connected ? h('span', { style: { ...s.badge, color: 'var(--dsw-alias-state-success-primary, #3fb950)' } }, '已连接') : null,
                      inFlight ? h('span', { style: s.badge }, STAGE_TEXT[host.stage] || host.stage) : null,
                      host.stage === 'manual-action-required' ? h('span', { style: { ...s.badge, color: 'var(--dsw-alias-state-warn-primary, #e0a458)' } }, '需人工处理') : null),
                    h('div', { style: s.muted }, (host.profile || 'web') + ' · ' + host.webPort + ' · ' + (host.webLog || '自动')),
                  ),
                  h('button', { type: 'button', style: s.btn, onClick: () => test(host), disabled: probe !== undefined && probe.state === 'running' },
                    probe !== undefined && probe.state === 'running' ? '测试中…' : '测试'),
                  host.connected
                    ? h('button', { type: 'button', style: s.primary, onClick: () => connect(host), disabled: busy === host.id, title: '进入该主机的实时画面（会话保持）' }, '进入')
                    : h('button', { type: 'button', style: s.primary, onClick: () => connect(host), disabled: busy === host.id }, busy === host.id ? '连接中…' : '连接'),
                  host.connected
                    ? h('button', { type: 'button', style: s.btn, onClick: () => disconnect(host.id) }, '断开')
                    : null,
                  h('button', { type: 'button', style: s.btn, onClick: () => openSettings(host), disabled: busy === 'settings' }, '设置'),
                  h('button', {
                    type: 'button',
                    style: s.btn,
                    onClick: () => setHidden(host, true),
                    disabled: hideBlocked,
                    title: hideBlocked ? '连接中的主机不能隐藏，请先断开' : '从面板列表隐藏（不改动 ~/.ssh/config，可随时恢复）',
                  }, '隐藏'),
                ),
                probe !== undefined && probe.text !== undefined
                  ? h('div', { style: { ...s.muted, whiteSpace: 'normal', paddingLeft: '14px', color: probe.ok ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-state-warn-primary, #e0a458)' } }, probe.text)
                  : null,
                editing === host.alias
                  ? h(
                      'div',
                      { style: s.form },
                      h(Field, { label: '远端 dsh web 端口' },
                        h('input', { style: s.input, type: 'number', min: 1, max: 65535, value: editForm.webPort, onChange: e => setEditForm({ ...editForm, webPort: e.target.value }) })),
                      h(Field, { label: 'profile 名称' },
                        h('input', { style: s.input, value: editForm.profile, onChange: e => setEditForm({ ...editForm, profile: e.target.value }), placeholder: 'web' })),
                      h(Field, { label: '远端日志路径（可选，留空自动）' },
                        h('input', { style: s.input, value: editForm.webLog, onChange: e => setEditForm({ ...editForm, webLog: e.target.value }), placeholder: '~/.dsh/logs/dsh-web.log' })),
                      h(Field, { label: '远端 Node bin 目录（可选，如 ~/.nvm/versions/node/v24.13.0/bin）' },
                        h('input', { style: s.input, value: editForm.nodeBin, onChange: e => setEditForm({ ...editForm, nodeBin: e.target.value }), placeholder: '留空用远端默认 PATH' })),
                      h(Field, { label: '安装用代理（可选，如 http://127.0.0.1:7890）' },
                        h('input', { style: s.input, value: editForm.installProxy, onChange: e => setEditForm({ ...editForm, installProxy: e.target.value }) })),
                      editError !== null ? h('div', { style: { ...s.error, gridColumn: '1 / -1' } }, editError) : null,
                      h('div', { style: { gridColumn: '1 / -1', display: 'flex', gap: '10px', justifyContent: 'flex-end' } },
                        h('button', { type: 'button', style: s.btn, onClick: () => { setEditing(null); setEditError(null) } }, '取消'),
                        h('button', { type: 'button', style: s.primary, onClick: saveSettings, disabled: busy === 'settings' }, busy === 'settings' ? '保存中…' : '保存')),
                    )
                  : null,
              )
            }),
            showHidden && hiddenHosts.length > 0
              ? h(
                  'div',
                  { style: { ...s.section, marginTop: '6px' } },
                  h('div', { style: s.sectionTitle }, '已隐藏的主机', h('span', { style: s.muted }, '仅从面板隐藏，~/.ssh/config 未改动')),
                  hiddenHosts.map(host => h(
                    'div',
                    { key: host.id, style: { ...s.row, opacity: 0.75 } },
                    h('div', { style: s.rowMain },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                        h('span', { style: { fontWeight: 600 } }, host.alias || host.label),
                        h('span', { style: s.badge }, '已隐藏')),
                      h('div', { style: s.muted }, (host.profile || 'web') + ' · ' + host.webPort)),
                    h('button', { type: 'button', style: s.btn, onClick: () => setHidden(host, false) }, '恢复'),
                  )),
                )
              : null,
          ),
        ),
        )

      return h(
        'div',
        { style: s.page, 'data-dsh-plugin': PANEL_ID },
        h(TabBar, { hosts, activeId, busy, onEnter: connect, onNew: () => setActiveId(null) }),
        content,
      )
    }

    exports.inject = ['slots', 'layout']

    exports.apply = (ctx) => {
      const disposers = []
      // Authoritative panel-active signal from the shell (ctx.layout.panelInfo).
      // Hide the kept-alive overlay the moment the active main panel is not this
      // one — independent of component unmount timing, which proved unreliable.
      const syncPanelActive = () => {
        const observable = ctx.layout && ctx.layout.panelInfo
        const info = observable && typeof observable.getSnapshot === 'function' ? observable.getSnapshot() : null
        const active = info !== null && info !== undefined && info.activePanelId === PANEL_ID
        frameStore.set(active
          ? { panelActive: true }
          : { panelActive: false, visible: false, hint: false, measure: null })
      }
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
        // shell.overlay is rendered unconditionally by the app frame, so the
        // frame host survives panel switches (wildcard entry, no key). Disposal
        // unmounts it → React removes the iframe → no leaked browsing context.
        disposers.push(slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: PANEL_ID + '-frame-host',
        }, FrameHost)))
        const observable = ctx.layout && ctx.layout.panelInfo
        if (observable && typeof observable.subscribe === 'function') {
          syncPanelActive()
          disposers.push(observable.subscribe(syncPanelActive))
        } else {
          // No layout service (older shell): fall back to unmount-driven hiding.
          frameStore.set({ panelActive: true })
        }
      } catch (error) {
        console.warn('[remote-dsh-openssh] panel registration failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* already gone */ }
        }
        frameStore.reset()
        viewStates.clear()
        lastActiveId = null
      })
    }

    return module.exports
  },
})