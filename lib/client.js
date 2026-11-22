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
      warn: { padding: '8px 10px', borderRadius: '8px', background: '#3a2f14', color: '#e7c27d', border: '1px solid #6b551e', fontSize: '12px' },
      okText: { color: '#3fb950' },
      badText: { color: '#e0a458' },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '4px' },
      card: { pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '560px', width: '100%', textAlign: 'left', padding: '16px 18px', borderRadius: '12px', border: '1px solid #6b551e', background: '#fffaf0', color: '#5c4a1e', boxShadow: '0 6px 24px rgba(0,0,0,.08)' },
      cardTitle: { fontWeight: 700, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px', color: '#9a6b0f' },
      cardText: { fontSize: '12.5px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      cardCode: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px', wordBreak: 'break-all' },
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
      paneError: { padding: '6px 10px', color: '#e0a458', fontSize: '12px', borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)' },
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

    function RemoteDshPage() {
      const [hosts, setHosts] = React.useState([])
      const [busy, setBusy] = React.useState(null)
      const [tests, setTests] = React.useState({})
      const [error, setError] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [editForm, setEditForm] = React.useState({ webPort: '', profile: '', webLog: '', installProxy: '' })
      const [editError, setEditError] = React.useState(null)
      const [active, setActive] = React.useState(null)
      const [stage, setStage] = React.useState('idle')
      const [failure, setFailure] = React.useState(null)
      const [elapsed, setElapsed] = React.useState(0)
      const [expanded, setExpanded] = React.useState(false)
      const [showHint, setShowHint] = React.useState(false)
      const [reloadKey, setReloadKey] = React.useState(0)
      const [filesOpen, setFilesOpen] = React.useState(false)
      const stageRef = React.useRef(null)

      const refresh = React.useCallback(() => {
        fetch(API + '/hosts', { headers: { accept: 'application/json' } })
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
      // A settled failure stops the poll and shows the retry card instead.
      React.useEffect(() => {
        if (active === null || active.proxyUrl !== undefined) return undefined
        let alive = true
        const started = Date.now()
        const tick = async () => {
          try {
            const state = await jsonOf(await fetch(API + '/state', { headers: { accept: 'application/json' } }))
            if (!alive) return
            const row = (state.hosts || []).find(item => item.id === active.id)
            if (row !== undefined) {
              setStage(row.stage || 'connecting')
              setElapsed(Math.round((Date.now() - started) / 1000))
              if (row.stage === 'failed' || row.stage === 'manual-action-required') {
                setFailure({ error: row.error || '连接失败', detail: row.detail || null })
                return
              }
              if (row.proxyUrl) { setActive(prev => (prev === null ? prev : { ...prev, proxyUrl: row.proxyUrl })); return }
            }
          } catch { /* keep polling */ }
          if (alive) setTimeout(tick, 1500)
        }
        tick()
        return () => { alive = false }
      }, [active])

      // While embedded, keep a slow watch so a dead remote session (onDead on
      // the host) surfaces as the reconnect card instead of a frozen iframe.
      React.useEffect(() => {
        if (active === null || active.proxyUrl === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const state = await jsonOf(await fetch(API + '/state', { headers: { accept: 'application/json' } }))
            if (!alive) return
            const row = (state.hosts || []).find(item => item.id === active.id)
            if (row !== undefined && row.connected === false && (row.stage === 'failed' || row.stage === 'manual-action-required')) {
              setStage(row.stage)
              setFailure({ error: row.error || '远端连接已断开，请重新连接', detail: row.detail || null })
              setFilesOpen(false)
              setActive(prev => (prev === null ? prev : { id: prev.id, label: prev.label }))
              return
            }
          } catch { /* keep watching */ }
          if (alive) setTimeout(tick, 4000)
        }
        const timer = setTimeout(tick, 4000)
        return () => { alive = false; clearTimeout(timer) }
      }, [active])

      const connect = (host) => {
        setBusy(host.id)
        setError(null)
        setFailure(null)
        setStage('connecting')
        setElapsed(0)
        fetch(API + '/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '连接失败')
            setActive({ id: host.id, label: host.label })
            setStage(value.stage || 'connecting')
          })
          .catch(cause => {
            const message = String(cause.message || cause)
            setError(message)
            setStage('failed')
            if (active !== null) setFailure({ error: message, detail: null })
          })
          .finally(() => setBusy(null))
      }

      const disconnect = () => {
        const id = active === null ? null : active.id
        setActive(null)
        setExpanded(false)
        setFilesOpen(false)
        setStage('idle')
        setFailure(null)
        stageRef.current = null
        if (id !== null) {
          fetch(API + '/disconnect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          }).then(refresh).catch(() => {})
        }
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
            webLog: editForm.webLog,
            installProxy: editForm.installProxy,
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

      const chromeTop = document.documentElement.hasAttribute('data-windows-titlebar') ? 40 : 0
      const stageText = STAGE_TEXT[stage] || stage

      if (active !== null) {
        const settledFailure = failure !== null && (stage === 'failed' || stage === 'manual-action-required')
        return h(
          'div',
          { style: s.page, 'data-dsh-plugin': PANEL_ID },
          expanded ? null : h(
            'div',
            { style: s.header },
            h('span', { style: s.dot(stage === 'ready' ? true : (stage === 'failed' || stage === 'manual-action-required') ? false : null) }),
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
            h('button', { type: 'button', style: s.btn, disabled: active.proxyUrl === undefined, onClick: () => { setStage('ready'); setReloadKey(key => key + 1) } }, '重新加载'),
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
              : settledFailure
                ? h('div', { style: s.center },
                    h(FailureCard, {
                      stage,
                      failure,
                      retrying: busy === active.id,
                      onRetry: () => connect({ id: active.id, label: active.label }),
                    }))
                : h('div', { style: s.center },
                    stageText + (elapsed > 0 ? '（' + elapsed + 's）' : ''),
                    h('div', { style: { marginTop: '8px' } }, '首次连接一台新机器时，会先检查远端环境，必要时侧装匹配版本的 DSH，再启动 dsh web；不会改动远端已有的 DSH。')),
            filesOpen ? h(TransferView, { hostId: active.id, onClose: () => setFilesOpen(false) }) : null,
            error !== null && !settledFailure ? h('div', { style: { ...s.error, position: 'absolute', left: '16px', right: '16px', bottom: '16px' } }, error) : null,
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
        { style: s.page, 'data-dsh-plugin': PANEL_ID },
        h(
          'div',
          { style: s.header },
          h('span', { style: s.title }, '远程 DSH'),
          h('span', { style: s.muted }, 'OpenSSH 主机 · 复用 ~/.ssh/config'),
          h('span', { style: s.spacer }),
          h('button', { type: 'button', style: s.btn, onClick: refresh }, '刷新'),
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
            hosts.map(host => {
              const probe = tests[host.id]
              const inFlight = host.stage !== undefined && host.stage !== 'idle' && host.stage !== 'ready' && host.stage !== 'failed' && host.stage !== 'manual-action-required'
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
                      host.connected ? h('span', { style: s.badge }, '已连接') : null,
                      inFlight ? h('span', { style: s.badge }, STAGE_TEXT[host.stage] || host.stage) : null,
                      host.stage === 'manual-action-required' ? h('span', { style: { ...s.badge, color: '#e0a458' } }, '需人工处理') : null),
                    h('div', { style: s.muted }, (host.profile || 'web') + ' · ' + host.webPort + ' · ' + (host.webLog || '自动')),
                  ),
                  h('button', { type: 'button', style: s.btn, onClick: () => test(host), disabled: probe !== undefined && probe.state === 'running' },
                    probe !== undefined && probe.state === 'running' ? '测试中…' : '测试'),
                  h('button', { type: 'button', style: s.primary, onClick: () => connect(host), disabled: busy === host.id }, busy === host.id ? '连接中…' : '连接'),
                  h('button', { type: 'button', style: s.btn, onClick: () => openSettings(host), disabled: busy === 'settings' }, '设置'),
                ),
                probe !== undefined && probe.text !== undefined
                  ? h('div', { style: { ...s.muted, whiteSpace: 'normal', paddingLeft: '14px', color: probe.ok ? '#3fb950' : '#e0a458' } }, probe.text)
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
        console.warn('[remote-dsh-openssh] panel registration failed:', error)
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