/**
 * Host half of dsh-remote-panel-openssh: OpenSSH host bookkeeping + one live
 * SSH session at a time.
 *
 * Hosts come from ~/.ssh/config (lib/hosts.js); every remote operation rides
 * the SSH connection (lib/remote.js), so the remote keeps `dsh web` on
 * 127.0.0.1 and no helper or LAN binding is needed. A connect request returns
 * immediately with a job stage; the page polls /state while the remote is
 * checked, side-installed or started. This fork never kills or restarts a
 * remote process on its own: when taking over is unsafe the job lands in
 * 'manual-action-required' and the user decides.
 *
 * The DSH version is resolved host-side only (never trusted from the browser)
 * and gated against SUPPORTED_DSH before /test or /connect may proceed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { localFs } from './localfs.js'

/** Stable cordis plugin name. */
export const name = 'remote-dsh-openssh'

/** Service this plugin needs before it can register routes. */
export const inject = ['webServer']

/** The only DSH release this first fork version supports. */
export const SUPPORTED_DSH = '0.2.2-rc.3'

/** Read one candidate manifest; only the DSH CLI's own manifest counts. */
function readManifestVersion(file) {
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (pkg.name !== '@deepseek-ai/dsh') return null
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Resolve the running DSH version on the host. The authoritative source is
 * the profile context's installAnchor (the same fact shell-env turns into
 * DSH_INSTALL_DIR for tool shells — that env var is NOT necessarily present
 * in the host process itself). Falls back to a real DSH_INSTALL_DIR env, then
 * to resolving the CLI manifest from this module. Unresolvable reads fail
 * closed as 'unknown', which the gate rejects.
 * @param {object} [ctx] host plugin context carrying profileContext
 */
export function resolveDshVersion(ctx) {
  const candidates = []
  try {
    const anchor = ctx !== undefined && ctx !== null && typeof ctx.get === 'function'
      ? ctx.get('profileContext')?.installAnchor
      : undefined
    if (typeof anchor === 'string' && anchor !== '') {
      if (anchor.endsWith('package.json')) candidates.push(anchor)
      candidates.push(path.join(anchor, 'package.json'))
      // The anchor may be the package dir, its manifest, or a file inside it
      // (e.g. lib/bin.js): walk up a few levels and accept only the CLI manifest.
      let dir = path.dirname(anchor)
      for (let level = 0; level < 4; level++) {
        candidates.push(path.join(dir, 'package.json'))
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch { /* profileContext unavailable: fall through */ }
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir !== undefined && installDir !== '') candidates.push(path.join(installDir, 'package.json'))
  for (const file of candidates) {
    const version = readManifestVersion(file)
    if (version !== null) return version
  }
  try {
    const version = readManifestVersion(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
    if (version !== null) return version
  } catch { /* not resolvable from the plugin location */ }
  return 'unknown'
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

/**
 * One file-manager route, mounted twice: the remote pane resolves SFTP from the
 * live session, the local pane always has the desktop filesystem. Same protocol,
 * so the browser's transfer view can treat both sides identically.
 * @param {string} base route prefix
 * @param {(payload: object, query: URLSearchParams) => object} resolve file API for this request
 */
function createFsRoute(base, resolve) {
  return {
    kind: 'prefix',
    path: base,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local')
      const action = url.pathname.slice(base.length).replace(/^\/+/, '')
      const method = req.method ?? 'GET'
      const fail = (status, message) => {
        if (res.headersSent) { res.destroy(); return }
        writeJson(res, status, { ok: false, error: message })
      }
      const requirePath = value => {
        if (typeof value !== 'string' || value === '') throw new Error('path is required')
        // Absolute on either platform: a drive letter or a leading slash.
        if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) throw new Error('path must be absolute: ' + value)
        return value
      }

      try {
        if (method === 'GET' && action === 'list') {
          const api = resolve({}, url.searchParams)
          writeJson(res, 200, { ok: true, ...(await api.list(url.searchParams.get('path') ?? '')) })
          return
        }
        if (method === 'GET' && action === 'read') {
          const api = resolve({}, url.searchParams)
          writeJson(res, 200, { ok: true, ...(await api.read(requirePath(url.searchParams.get('path') ?? ''))) })
          return
        }
        if (method === 'GET' && action === 'download') {
          const api = resolve({}, url.searchParams)
          const target = requirePath(url.searchParams.get('path') ?? '')
          const file = await api.download(target)
          const name = target.split(/[\\/]/).pop() || 'download'
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(file.size),
            'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          file.stream.on('error', () => { try { res.destroy() } catch { /* gone */ } })
          file.stream.pipe(res)
          return
        }
        if (method === 'POST' && action === 'upload') {
          const api = resolve({}, url.searchParams)
          const target = requirePath(url.searchParams.get('path') ?? '')
          writeJson(res, 200, { ok: true, ...(await api.upload(target, req)) })
          return
        }

        const body = await readBody(req)
        if (body === null) { fail(400, 'invalid JSON body'); return }
        const api = resolve(body, url.searchParams)

        if (method === 'POST' && action === 'write') {
          const text = typeof body.text === 'string' ? body.text : ''
          if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请用上传')
          writeJson(res, 200, { ok: true, ...(await api.write(requirePath(body.path), text)) })
          return
        }
        if (method === 'POST' && action === 'mkdir') {
          writeJson(res, 200, { ok: true, ...(await api.mkdir(requirePath(body.path))) })
          return
        }
        if (method === 'POST' && action === 'rename') {
          const result = await api.rename(requirePath(body.from), requirePath(body.to))
          writeJson(res, 200, { ok: true, ...result })
          return
        }
        if (method === 'POST' && action === 'remove') {
          const result = await api.remove(requirePath(body.path), body.recursive === true)
          writeJson(res, 200, { ok: true, ...result })
          return
        }
        fail(404, 'unknown fs action: ' + action)
      } catch (error) {
        fail(400, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** Terminal job stages: a new connect may replace them; anything else is in flight. */
const isSettled = job => job.stage === 'ready' || job.stage === 'failed' || job.stage === 'manual-action-required'

/**
 * Build the panel's route table with injected dependencies, so tests can run
 * the whole HTTP surface without loading SSH modules.
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listHosts
 * @param {(id: string) => Promise<object|null>} deps.resolveHost
 * @param {(alias: string, patch: object) => Promise<object>} deps.saveSettings
 * @param {(entry: object, version: string) => Promise<object>} deps.probeHost
 * @param {(entry: object, options: object) => Promise<object>} deps.openSession
 * @param {() => object} deps.localFs
 * @param {string} deps.version host-resolved DSH version
 * @param {(message: string) => void} [deps.log]
 * @returns {{ routes: Array, closeAll: () => Promise<void> }}
 */
export function createApp(deps) {
  const { listHosts, resolveHost, saveSettings, probeHost, openSession, localFs, version } = deps
  const log = deps.log ?? (message => console.log('[remote-dsh-openssh] ' + message))

  /** id -> { session } for the connected host (at most one by policy). */
  const sessions = new Map()
  /** id -> { stage, error, detail, proxyUrl, startedAt } while connecting or settled. */
  const jobs = new Map()
  /**
   * Monotonic operation counter. Every connect/disconnect bumps it; a job
   * whose generation is no longer current was superseded and must close its
   * own late-arriving session instead of publishing it.
   */
  let generation = 0

  const versionGate = () => version === SUPPORTED_DSH
    ? null
    : '本插件首版仅支持 DSH ' + SUPPORTED_DSH + '（当前 ' + version + '）'

  const describe = async () => (await listHosts()).map(host => {
    const job = jobs.get(host.id)
    const session = sessions.get(host.id)
    return {
      ...host,
      connected: session !== undefined,
      proxyUrl: session !== undefined ? session.session.proxyUrl : (job === undefined ? null : job.proxyUrl),
      stage: job !== undefined ? job.stage : (session !== undefined ? 'ready' : 'idle'),
      error: job === undefined ? null : job.error,
      detail: job === undefined ? null : job.detail,
      sinceMs: job === undefined ? 0 : Date.now() - job.startedAt,
    }
  })

  const closeSession = async (id) => {
    const entry = sessions.get(id)
    sessions.delete(id)
    if (entry !== undefined) await entry.session.close().catch(() => {})
  }

  /** Wrap a handler so no thrown error ever escapes to the webserver. */
  const guard = handler => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) { try { res.destroy() } catch { /* gone */ } return }
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const runConnect = async (entry, job, gen) => {
    const superseded = () => gen !== generation || jobs.get(entry.id) !== job
    try {
      // Single active session: connecting any host retires every other one.
      for (const other of [...sessions.keys()]) {
        if (other === entry.id) continue
        jobs.delete(other)
        await closeSession(other)
      }
      await closeSession(entry.id)
      if (superseded()) return
      const session = await openSession(entry, {
        version,
        log,
        stage: value => { if (!superseded()) job.stage = value },
      })
      if (superseded()) {
        // A newer connect/disconnect won while we were opening: close our own
        // session and never publish it.
        await session.close().catch(() => {})
        return
      }
      sessions.set(entry.id, { session })
      session.onDead(() => {
        const current = sessions.get(entry.id)
        if (current === undefined || current.session !== session) return
        sessions.delete(entry.id)
        const dead = jobs.get(entry.id) ?? { startedAt: Date.now() }
        dead.stage = 'failed'
        dead.error = '远端连接已断开，请重新连接'
        dead.detail = null
        dead.proxyUrl = null
        jobs.set(entry.id, dead)
      })
      job.proxyUrl = session.proxyUrl
      job.stage = 'ready'
    } catch (error) {
      if (superseded()) return
      if (error !== null && typeof error === 'object' && error.code === 'manual-action-required') {
        job.stage = 'manual-action-required'
        job.error = error instanceof Error ? error.message : String(error)
        job.detail = error.detail ?? null
      } else {
        job.stage = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        job.detail = null
      }
      log('connect failed for ' + entry.id + ': ' + job.error)
    }
  }

  const startConnect = (entry) => {
    const gen = ++generation
    const job = { stage: 'connecting', error: null, detail: null, proxyUrl: null, startedAt: Date.now() }
    jobs.set(entry.id, job)
    void runConnect(entry, job, gen)
    return job
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/remote-dsh-openssh/hosts',
      handler: guard(async (req, res) => {
        const method = req.method ?? 'GET'
        if (method === 'GET') { writeJson(res, 200, { hosts: await describe() }); return }
        if (method === 'POST') {
          const body = await readBody(req)
          if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
          const alias = typeof body.alias === 'string' ? body.alias : ''
          if (alias === '') { writeJson(res, 400, { error: 'alias is required' }); return }
          try {
            await saveSettings(alias, {
              webPort: body.webPort,
              profile: body.profile,
              webLog: body.webLog,
              installProxy: body.installProxy,
            })
            writeJson(res, 201, { hosts: await describe() })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 405, { error: 'method not allowed' })
      }),
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh-openssh/connect',
      handler: guard(async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const gate = versionGate()
        if (gate !== null) { writeJson(res, 409, { error: gate }); return }
        const body = await readBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const entry = await resolveHost(id)
        if (entry === null) { writeJson(res, 404, { error: '未找到主机 ' + id }); return }
        const existing = jobs.get(id)
        if (existing !== undefined && !isSettled(existing)) {
          writeJson(res, 202, { stage: existing.stage, sinceMs: Date.now() - existing.startedAt, hosts: await describe() })
          return
        }
        const job = startConnect(entry)
        writeJson(res, 202, { stage: job.stage, sinceMs: 0, hosts: await describe() })
      }),
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh-openssh/disconnect',
      handler: guard(async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        const id = typeof body.id === 'string' ? body.id : ''
        if (id !== '') {
          generation++
          jobs.delete(id)
          await closeSession(id)
        }
        writeJson(res, 200, { hosts: await describe() })
      }),
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh-openssh/state',
      handler: guard(async (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        writeJson(res, 200, { hosts: await describe() })
      }),
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh-openssh/test',
      handler: guard(async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const gate = versionGate()
        if (gate !== null) { writeJson(res, 409, { error: gate }); return }
        const body = await readBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const entry = await resolveHost(id)
        if (entry === null) { writeJson(res, 404, { error: '未找到主机 ' + id }); return }
        try {
          writeJson(res, 200, await probeHost(entry, version))
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    createFsRoute('/api/remote-dsh-openssh/fs', (payload, query) => {
      const id = typeof payload.id === 'string' ? payload.id : (query.get('id') ?? '')
      const entry = sessions.get(id)
      if (entry === undefined) throw new Error('主机未连接，请先连接后再浏览文件')
      return entry.session.fs
    }),
    createFsRoute('/api/remote-dsh-openssh/local', () => localFs()),
  ]

  const closeAll = async () => {
    generation++
    jobs.clear()
    const entries = [...sessions.values()]
    sessions.clear()
    await Promise.all(entries.map(entry => entry.session.close().catch(() => {})))
  }

  return { routes, closeAll }
}

/**
 * Mount the panel's routes. The SSH-facing modules load dynamically inside
 * apply so importing this file (tests, tooling) never pulls in ssh2.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx) {
  const ready = Promise.all([import('./hosts.js'), import('./remote.js')]).then(([hosts, remote]) => createApp({
    listHosts: hosts.listHosts,
    resolveHost: hosts.resolveHost,
    saveSettings: hosts.saveSettings,
    probeHost: remote.probeHost,
    openSession: remote.openSession,
    localFs,
    version: resolveDshVersion(ctx),
    log: message => console.log('[remote-dsh-openssh] ' + message),
  }))
  try {
    ctx.effect(() => {
      let app = null
      let disposers = []
      let disposed = false
      void ready.then(value => {
        app = value
        if (disposed) { void app.closeAll(); return }
        disposers = app.routes.map(route => ctx.webServer.register(route))
      }).catch(error => {
        console.warn('[remote-dsh-openssh] route registration failed:', error)
      })
      return () => {
        disposed = true
        for (const dispose of disposers) dispose()
        if (app !== null) void app.closeAll()
      }
    }, 'remote-dsh-openssh: routes')
  } catch (error) {
    console.warn('[remote-dsh-openssh] route registration failed:', error)
  }
}