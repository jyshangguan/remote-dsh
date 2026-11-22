/**
 * Host half of dsh-remote-panel: host bookkeeping + one live SSH session per
 * connected host.
 *
 * Every remote operation rides the SSH connection (lib/remote.js), so the remote
 * keeps `dsh web` on 127.0.0.1 and no helper or LAN binding is needed. A connect
 * request returns immediately with a job stage; the page polls /state while the
 * remote installs dsh or starts its web server.
 */
import { listHosts, resolveHost, upsertHost, removeHost } from './hosts.js'
import { localFs } from './localfs.js'
import { openSession, probeHost } from './remote.js'
import { planSync, runSync } from './sync.js'

/** Stable cordis plugin name. */
export const name = 'remote-dsh'

/** Service this plugin needs before it can register routes. */
export const inject = ['webServer']

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

/**
 * Mount the panel's routes.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx) {
  /** id -> { session } for a connected host. */
  const sessions = new Map()
  /** id -> { stage, error, proxyUrl, startedAt } while connecting/installing. */
  const jobs = new Map()
  /** id -> { stage, profile, logs, error, result, startedAt } for a sync job. */
  const syncJobs = new Map()

  const describe = () => listHosts().map(host => {
    const job = jobs.get(host.id)
    const session = sessions.get(host.id)
    return {
      id: host.id,
      label: host.label,
      host: host.host,
      user: host.user,
      sshPort: host.sshPort,
      webPort: host.webPort,
      source: host.source,
      connected: session !== undefined,
      proxyUrl: session === undefined ? (job === undefined ? null : job.proxyUrl) : session.session.proxyUrl,
      stage: job === undefined ? (session === undefined ? 'idle' : 'ready') : job.stage,
      error: job === undefined ? null : job.error,
      sinceMs: job === undefined ? 0 : Date.now() - job.startedAt,
    }
  })

  const closeSession = async (id) => {
    const entry = sessions.get(id)
    sessions.delete(id)
    if (entry !== undefined) await entry.session.close().catch(() => {})
  }

  const startConnect = (id, version) => {
    const job = { stage: 'connecting', error: null, proxyUrl: null, startedAt: Date.now() }
    jobs.set(id, job)
    void (async () => {
      try {
        const host = resolveHost(id)
        if (host === null) throw new Error('未找到主机 ' + id)
        await closeSession(id)
        const session = await openSession(host, {
          version,
          log: message => console.log('[remote-dsh] ' + message),
          stage: value => { job.stage = value },
        })
        sessions.set(id, { session })
        job.proxyUrl = session.proxyUrl
        job.stage = 'ready'
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.stage = 'failed'
        console.warn('[remote-dsh] connect failed for ' + id + ': ' + job.error)
      }
    })()
    return job
  }

  const describeSync = (id) => {
    const job = syncJobs.get(id)
    if (job === undefined) return { id, stage: 'idle', profile: null, logs: [], error: null, result: null, sinceMs: 0 }
    return {
      id,
      profile: job.profile,
      stage: job.stage,
      logs: job.logs.slice(-250),
      error: job.error,
      result: job.result,
      sinceMs: Date.now() - job.startedAt,
    }
  }

  const startSync = (id, request) => {
    const job = {
      stage: 'connecting',
      profile: request.profile,
      logs: [],
      error: null,
      result: null,
      startedAt: Date.now(),
    }
    syncJobs.set(id, job)
    const push = (text) => {
      job.logs.push({ at: Date.now(), text: String(text) })
      if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400)
    }
    void (async () => {
      try {
        const host = resolveHost(id)
        if (host === null) throw new Error('未找到主机 ' + id)
        const result = await runSync({
          host,
          profile: request.profile,
          version: request.version,
          pluginNames: request.plugins,
          providerIds: request.providers,
          defaultModel: request.defaultModel,
          syncKeys: request.syncKeys,
          restart: request.restart,
          registry: request.registry,
          proxy: request.proxy,
          dryRun: request.dryRun,
          services: {
            configEditor: ctx.get('configEditor'),
            credentials: ctx.get('credentials'),
            agentDefaultModel: ctx.get('agentDefaultModel'),
          },
          log: push,
          stage: value => { job.stage = value },
          onRestart: async () => { await closeSession(id) },
        })
        job.result = result
        job.stage = 'done'
        push(result.dryRun ? '预演完成，未修改远端。' : '同步完成。')
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.stage = 'failed'
        push('失败：' + job.error)
        console.warn('[remote-dsh] sync failed for ' + id + ': ' + job.error)
      }
    })()
    return job
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/remote-dsh/hosts',
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (method === 'GET') { writeJson(res, 200, { hosts: describe() }); return }
        if (method === 'POST') {
          const body = await readBody(req)
          if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
          try {
            upsertHost(body)
            writeJson(res, 201, { hosts: describe() })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method === 'DELETE') {
          const id = new URL(req.url ?? '/', 'http://local').searchParams.get('id') ?? ''
          const bare = id.replace(/^local:/, '')
          const removed = removeHost(bare)
          jobs.delete(id.startsWith('local:') ? id : 'local:' + bare)
          await closeSession(id.startsWith('local:') ? id : 'local:' + bare)
          writeJson(res, removed ? 200 : 404, { hosts: describe() })
          return
        }
        writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/connect',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const version = typeof body?.version === 'string' && body.version !== '' ? body.version : '0.2.1-rc.3'
        const existing = jobs.get(id)
        if (existing !== undefined && existing.stage !== 'failed' && existing.stage !== 'ready') {
          writeJson(res, 202, { stage: existing.stage, sinceMs: Date.now() - existing.startedAt, hosts: describe() })
          return
        }
        const job = startConnect(id, version)
        writeJson(res, 202, { stage: job.stage, sinceMs: 0, hosts: describe() })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/disconnect',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id !== '') {
          jobs.delete(id)
          await closeSession(id)
        }
        writeJson(res, 200, { hosts: describe() })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/state',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        writeJson(res, 200, { hosts: describe() })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/test',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const host = resolveHost(id)
        if (host === null) { writeJson(res, 404, { error: '未找到主机 ' + id }); return }
        const version = typeof body?.version === 'string' && body.version !== '' ? body.version : '0.2.1-rc.3'
        try {
          writeJson(res, 200, await probeHost(host, version))
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/sync/plan',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const url = new URL(req.url ?? '/', 'http://local')
        const id = url.searchParams.get('id') ?? ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const host = resolveHost(id)
        if (host === null) { writeJson(res, 404, { error: '未找到主机 ' + id }); return }
        const profile = url.searchParams.get('profile') ?? 'web'
        const version = url.searchParams.get('version') ?? ''
        try {
          const plan = await planSync(host, {
            profile,
            version,
            services: {
              configEditor: ctx.get('configEditor'),
              credentials: ctx.get('credentials'),
              agentDefaultModel: ctx.get('agentDefaultModel'),
            },
          })
          writeJson(res, 200, { ok: true, plan })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/sync',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const host = resolveHost(id)
        if (host === null) { writeJson(res, 404, { error: '未找到主机 ' + id }); return }
        const connectJob = jobs.get(id)
        if (connectJob !== undefined && connectJob.stage !== 'ready' && connectJob.stage !== 'failed') {
          writeJson(res, 409, { error: '主机正在连接或安装，请等连接完成后再同步。' })
          return
        }
        const running = syncJobs.get(id)
        if (running !== undefined && running.stage !== 'failed' && running.stage !== 'done') {
          writeJson(res, 202, { job: describeSync(id) })
          return
        }
        const request = {
          profile: typeof body.profile === 'string' && body.profile !== '' ? body.profile : 'web',
          version: typeof body.version === 'string' ? body.version : '',
          plugins: Array.isArray(body.plugins) ? body.plugins.filter(value => typeof value === 'string') : [],
          providers: Array.isArray(body.providers) ? body.providers.filter(value => typeof value === 'string') : [],
          defaultModel: body.defaultModel !== null && typeof body.defaultModel === 'object' ? body.defaultModel : null,
          syncKeys: body.syncKeys !== false,
          restart: body.restart !== false,
          registry: typeof body.registry === 'string' ? body.registry.trim() : '',
          proxy: typeof body.proxy === 'string' ? body.proxy.trim() : '',
          dryRun: body.dryRun === true,
        }
        startSync(id, request)
        writeJson(res, 202, { job: describeSync(id) })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/sync/state',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const id = new URL(req.url ?? '/', 'http://local').searchParams.get('id') ?? ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        writeJson(res, 200, { job: describeSync(id) })
      },
    },
    createFsRoute('/api/remote-dsh/fs', (payload, query) => {
      const id = typeof payload.id === 'string' ? payload.id : (query.get('id') ?? '')
      const entry = sessions.get(id)
      if (entry === undefined) throw new Error('主机未连接，请先连接后再浏览文件')
      return entry.session.fs
    }),
    createFsRoute('/api/remote-dsh/local', () => localFs()),
  ]

  try {
    ctx.effect(() => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
        for (const id of [...sessions.keys()]) void closeSession(id)
      }
    }, 'remote-dsh: routes')
  } catch (error) {
    console.warn('[remote-dsh] route registration failed:', error)
  }
}
