/**
 * API-surface tests for the OpenSSH panel host half.
 *
 * Everything runs through createApp with injected fakes: no SSH module, no
 * ssh2, no real filesystem. Requests are Readable streams and responses are
 * plain capture objects, matching what the webserver hands to route handlers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createApp, SUPPORTED_DSH, name, inject } from '../lib/index.js'

const API = '/api/remote-dsh-openssh'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const waitFor = async (fn, label, timeoutMs = 3000) => {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Fake request: a Readable carrying the JSON body, plus method/url/headers. */
const makeReq = (method, url, body) => {
  const payload = body === undefined
    ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  return req
}

/** Fake response: captures writeHead/end; headersSent starts false. */
const makeRes = () => ({
  statusCode: 0,
  headers: null,
  headersSent: false,
  body: '',
  destroyed: false,
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers ?? {}
    this.headersSent = true
    return this
  },
  end(chunk) { this.body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8') },
  destroy() { this.destroyed = true },
})

/** Dispatch one request against the app's route table, exactly like the server. */
const call = async (app, method, url, body) => {
  const pathname = url.split('?')[0]
  const route = app.routes.find(r => (r.kind === 'exact'
    ? r.path === pathname
    : pathname === r.path || pathname.startsWith(r.path + '/')))
  assert.ok(route !== undefined, 'no route matches ' + method + ' ' + url)
  const res = makeRes()
  await route.handler(makeReq(method, url, body), res)
  let json = null
  try { json = res.body === '' ? null : JSON.parse(res.body) } catch { json = null }
  return { status: res.statusCode, json, res }
}

const hostRow = async (app, id) => {
  const { json } = await call(app, 'GET', API + '/state')
  return (json.hosts ?? []).find(host => host.id === id)
}

const waitStage = (app, id, stage) => waitFor(async () => {
  const row = await hostRow(app, id)
  return row !== undefined && row.stage === stage ? row : null
}, id + ' to reach stage ' + stage)

const fakeFs = (home, fileName) => ({
  list: async dir => ({
    path: dir === '' ? home : dir,
    parent: '/parent',
    entries: [{ name: fileName, dir: false, link: false, size: 3, mtime: 1, mode: 0o600 }],
  }),
  read: async target => ({ path: target, text: 'hi', binary: false, size: 2, truncated: false, mtime: 1 }),
  write: async (target, text) => ({ path: target, size: Buffer.byteLength(text) }),
  mkdir: async target => ({ path: target }),
  rename: async (from, to) => ({ from, to }),
  remove: async (target, recursive) => ({ path: target, removed: recursive === true ? 'tree' : 'file' }),
  upload: async target => ({ path: target, size: 0 }),
  download: async target => ({ stream: Readable.from([Buffer.from('x')]), size: 1, mtime: 1 }),
})

/** One harness = fresh hosts, spies and an app built from injected fakes. */
const makeHarness = (overrides = {}) => {
  const state = {
    hosts: [
      { id: 'openssh:alpha', alias: 'alpha', label: 'alpha', source: 'openssh', webPort: 18080, profile: 'web', webLog: '', installProxy: '' },
      { id: 'openssh:beta', alias: 'beta', label: 'beta', source: 'openssh', webPort: 18081, profile: 'web', webLog: '', installProxy: '' },
    ],
    sessions: [],
    hidden: new Set(),
    openCalls: [],
    probeCalls: [],
    saveCalls: [],
    openImpl: null,
    probeImpl: null,
    saveImpl: null,
    listImpl: null,
    setHiddenImpl: null,
  }
  const makeSession = (entry) => {
    const record = { entry, closeCalls: 0, dead: [], proxyUrl: 'http://127.0.0.1:41234/' }
    record.session = {
      proxyUrl: record.proxyUrl,
      fs: fakeFs('/remote/home', 'notes.txt'),
      close: async () => { record.closeCalls += 1 },
      onDead: cb => { record.dead.push(cb) },
    }
    state.sessions.push(record)
    return record
  }
  const deps = {
    version: SUPPORTED_DSH,
    log: () => {},
    localFs: () => fakeFs('/local/home', 'local.txt'),
    listHosts: async () => {
      if (state.listImpl !== null) return state.listImpl()
      return state.hosts.map(host => ({ ...host, hidden: state.hidden.has(host.alias) }))
    },
    resolveHost: async id => {
      const host = state.hosts.find(item => item.id === id)
      return host === undefined ? null : { ...host, hidden: state.hidden.has(host.alias) }
    },
    saveSettings: async (alias, patch) => {
      state.saveCalls.push({ alias, patch })
      if (state.saveImpl !== null) return state.saveImpl(alias, patch)
      const host = state.hosts.find(item => item.alias === alias)
      if (host === undefined) throw Object.assign(new Error('未知主机别名 ' + alias), { code: 'invalid-settings' })
      if (patch.webPort !== undefined && (!Number.isInteger(patch.webPort) || patch.webPort < 1 || patch.webPort > 65535)) {
        throw Object.assign(new Error('webPort 必须是 1-65535 的整数'), { code: 'invalid-settings' })
      }
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) host[key] = value
      return { ...host }
    },
    setHidden: async (alias, hidden) => {
      if (state.setHiddenImpl !== null) return state.setHiddenImpl(alias, hidden)
      if (hidden === true) state.hidden.add(alias)
      else state.hidden.delete(alias)
      return [...state.hidden]
    },
    probeHost: async (entry, version) => {
      state.probeCalls.push({ entry, version })
      if (state.probeImpl !== null) return state.probeImpl(entry, version)
      return {
        ok: true,
        ms: 12,
        node: 'v22.19.0',
        sideRuntime: { installed: true, version: SUPPORTED_DSH },
        web: { alive: true, code: 200, pids: [4242] },
        profile: entry.profile,
        action: 'attach',
        reason: '',
        tokenReadable: true,
      }
    },
    openSession: async (entry, options) => {
      state.openCalls.push({ entry, options })
      if (state.openImpl !== null) return state.openImpl(entry, options, makeSession)
      options.stage('ssh')
      options.stage('checking')
      options.stage('gateway')
      return makeSession(entry).session
    },
    ...overrides,
  }
  const app = createApp(deps)
  return { app, state, makeSession }
}

test('plugin identity and exact route table, no sync routes', async () => {
  assert.equal(name, 'remote-dsh-openssh')
  assert.deepEqual(inject, ['webServer'])
  const { app } = makeHarness()
  const expected = [
    ['exact', API + '/hosts'],
    ['exact', API + '/connect'],
    ['exact', API + '/disconnect'],
    ['exact', API + '/hide'],
    ['exact', API + '/state'],
    ['exact', API + '/test'],
    ['prefix', API + '/fs'],
    ['prefix', API + '/local'],
  ]
  assert.deepEqual(app.routes.map(route => [route.kind, route.path]).sort(), expected.sort())
  for (const route of app.routes) {
    assert.ok(!route.path.includes('/sync'), 'no sync route: ' + route.path)
    assert.ok(!route.path.includes('restart'), 'no restart route: ' + route.path)
  }
  await app.closeAll()
})

test('GET /hosts merges host settings with idle job state', async () => {
  const { app } = makeHarness()
  const { status, json } = await call(app, 'GET', API + '/hosts')
  assert.equal(status, 200)
  assert.equal(json.hosts.length, 2)
  const row = json.hosts[0]
  assert.equal(row.id, 'openssh:alpha')
  assert.equal(row.alias, 'alpha')
  assert.equal(row.source, 'openssh')
  assert.equal(row.webPort, 18080)
  assert.equal(row.profile, 'web')
  assert.equal(row.connected, false)
  assert.equal(row.proxyUrl, null)
  assert.equal(row.stage, 'idle')
  assert.equal(row.error, null)
  assert.equal(row.detail, null)
  assert.equal(row.sinceMs, 0)
  await app.closeAll()
})

test('POST /hosts: validation error -> 400, valid save -> 201 with merged hosts', async () => {
  const { app, state } = makeHarness()
  const bad = await call(app, 'POST', API + '/hosts', { alias: 'alpha', webPort: 70000 })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /webPort/)
  const missing = await call(app, 'POST', API + '/hosts', { webPort: 18080 })
  assert.equal(missing.status, 400)
  const ok = await call(app, 'POST', API + '/hosts', { alias: 'alpha', webPort: 19090, profile: 'lab', webLog: '~/logs/web.log', installProxy: '' })
  assert.equal(ok.status, 201)
  const row = ok.json.hosts.find(host => host.id === 'openssh:alpha')
  assert.equal(row.webPort, 19090)
  assert.equal(row.profile, 'lab')
  assert.equal(row.webLog, '~/logs/web.log')
  // The missing-alias request is rejected before saveSettings is reached.
  assert.equal(state.saveCalls.length, 2)
  assert.equal(state.saveCalls[1].alias, 'alpha')
  await app.closeAll()
})

test('version gate: /test and /connect answer 409 on a mismatched host version', async () => {
  const { app, state } = makeHarness({ version: '0.2.2-rc.2' })
  const expected = '本插件首版仅支持 DSH 0.2.2-rc.3（当前 0.2.2-rc.2）'
  const probe = await call(app, 'POST', API + '/test', { id: 'openssh:alpha' })
  assert.equal(probe.status, 409)
  assert.equal(probe.json.error, expected)
  const connect = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(connect.status, 409)
  assert.equal(connect.json.error, expected)
  assert.equal(state.probeCalls.length, 0)
  assert.equal(state.openCalls.length, 0)
  await app.closeAll()
})

test('POST /test: unknown id 404, probe result passthrough, probe throw -> 200 ok:false', async () => {
  const { app, state } = makeHarness()
  const unknown = await call(app, 'POST', API + '/test', { id: 'openssh:nope' })
  assert.equal(unknown.status, 404)
  const ok = await call(app, 'POST', API + '/test', { id: 'openssh:alpha' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.action, 'attach')
  assert.equal(ok.json.sideRuntime.version, SUPPORTED_DSH)
  assert.equal(state.probeCalls[0].version, SUPPORTED_DSH)
  state.probeImpl = async () => { throw new Error('SSH 握手失败') }
  const failed = await call(app, 'POST', API + '/test', { id: 'openssh:alpha' })
  assert.equal(failed.status, 200)
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error, 'SSH 握手失败')
  await app.closeAll()
})

test('connect: unknown id 404; success publishes a ready session in /state', async () => {
  const { app, state } = makeHarness()
  const unknown = await call(app, 'POST', API + '/connect', { id: 'openssh:nope' })
  assert.equal(unknown.status, 404)
  const started = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(started.status, 202)
  assert.equal(started.json.stage, 'connecting')
  assert.ok(Array.isArray(started.json.hosts))
  const row = await waitStage(app, 'openssh:alpha', 'ready')
  assert.equal(row.connected, true)
  assert.equal(row.proxyUrl, state.sessions[0].proxyUrl)
  assert.equal(row.error, null)
  assert.ok(row.sinceMs >= 0)
  assert.equal(state.openCalls[0].options.version, SUPPORTED_DSH)
  await app.closeAll()
})

test('connect: ManualActionRequired lands in manual-action-required with detail, retry works', async () => {
  const { app, state } = makeHarness()
  const detail = { pids: [31337], hint: '请人工确认并处理占用端口的进程，再重试连接。' }
  state.openImpl = async () => {
    throw Object.assign(new Error('远端 18080 端口被非 DSH 进程占用'), { code: 'manual-action-required', detail })
  }
  const started = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(started.status, 202)
  const row = await waitStage(app, 'openssh:alpha', 'manual-action-required')
  assert.equal(row.error, '远端 18080 端口被非 DSH 进程占用')
  assert.deepEqual(row.detail, detail)
  assert.equal(row.connected, false)
  assert.equal(row.proxyUrl, null)
  // A retry after the user resolved the situation starts a fresh job.
  state.openImpl = null
  const retry = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(retry.status, 202)
  await waitStage(app, 'openssh:alpha', 'ready')
  await app.closeAll()
})

test('connect: a generic openSession error lands in failed with the message', async () => {
  const { app, state } = makeHarness()
  state.openImpl = async () => { throw new Error('known_hosts 校验失败') }
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const row = await waitStage(app, 'openssh:alpha', 'failed')
  assert.equal(row.error, 'known_hosts 校验失败')
  assert.equal(row.connected, false)
  assert.equal(row.proxyUrl, null)
  await app.closeAll()
})

test('connect: a second connect for the same in-flight host returns the existing job', async () => {
  const { app, state } = makeHarness()
  const gate = deferred()
  state.openImpl = (entry, options, makeSession) => gate.promise.then(() => makeSession(entry).session)
  const first = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(first.status, 202)
  const second = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(second.status, 202)
  assert.equal(second.json.stage, 'connecting')
  assert.equal(state.openCalls.length, 1)
  gate.resolve()
  await waitStage(app, 'openssh:alpha', 'ready')
  await app.closeAll()
})

test('connect: starting host B closes host A first (single active session)', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'ready')
  const recordA = state.sessions[0]
  await call(app, 'POST', API + '/connect', { id: 'openssh:beta' })
  await waitStage(app, 'openssh:beta', 'ready')
  assert.equal(recordA.closeCalls, 1)
  const rowA = await hostRow(app, 'openssh:alpha')
  assert.equal(rowA.connected, false)
  assert.equal(rowA.stage, 'idle')
  assert.equal(rowA.proxyUrl, null)
  const rowB = await hostRow(app, 'openssh:beta')
  assert.equal(rowB.connected, true)
  await app.closeAll()
})

test('connect: a superseded job closes its late session and never publishes it', async () => {
  const { app, state } = makeHarness()
  const gate = deferred()
  state.openImpl = (entry, options, makeSession) => gate.promise.then(() => makeSession(entry).session)
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const disconnected = await call(app, 'POST', API + '/disconnect', { id: 'openssh:alpha' })
  assert.equal(disconnected.status, 200)
  // The disconnect superseded the in-flight connect; now let it complete late.
  gate.resolve()
  await waitFor(() => state.sessions.length === 1 && state.sessions[0].closeCalls === 1, 'late session to be closed')
  const row = await hostRow(app, 'openssh:alpha')
  assert.equal(row.stage, 'idle')
  assert.equal(row.connected, false)
  assert.equal(row.proxyUrl, null)
  assert.equal(row.error, null)
  await app.closeAll()
})

test('session onDead marks the job failed with the reconnect message', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'ready')
  const record = state.sessions[0]
  assert.equal(record.dead.length, 1)
  record.dead[0]()
  const row = await hostRow(app, 'openssh:alpha')
  assert.equal(row.stage, 'failed')
  assert.equal(row.error, '远端连接已断开，请重新连接')
  assert.equal(row.connected, false)
  assert.equal(row.proxyUrl, null)
  await app.closeAll()
})

test('fs: remote pane without a session answers 400 主机未连接', async () => {
  const { app } = makeHarness()
  const { status, json } = await call(app, 'GET', API + '/fs/list?path=/tmp&id=openssh:alpha')
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.match(json.error, /主机未连接/)
  await app.closeAll()
})

test('fs: remote pane with a session uses the session fs', async () => {
  const { app } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'ready')
  const listed = await call(app, 'GET', API + '/fs/list?path=/srv/app&id=openssh:alpha')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.ok, true)
  assert.equal(listed.json.path, '/srv/app')
  assert.equal(listed.json.entries[0].name, 'notes.txt')
  const wrote = await call(app, 'POST', API + '/fs/write', { id: 'openssh:alpha', path: '/srv/app/a.txt', text: 'hello' })
  assert.equal(wrote.status, 200)
  assert.equal(wrote.json.ok, true)
  assert.equal(wrote.json.size, 5)
  await app.closeAll()
})

test('fs: local pane lists through the injected localFs', async () => {
  const { app } = makeHarness()
  const { status, json } = await call(app, 'GET', API + '/local/list')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.path, '/local/home')
  assert.equal(json.entries[0].name, 'local.txt')
  await app.closeAll()
})

test('fs: write over 2 MB is rejected on both panes', async () => {
  const { app } = makeHarness()
  const text = 'a'.repeat(2 * 1024 * 1024 + 1)
  const local = await call(app, 'POST', API + '/local/write', { path: '/tmp/big.txt', text })
  assert.equal(local.status, 400)
  assert.equal(local.json.ok, false)
  assert.equal(local.json.error, '文件超过 2 MB，请用上传')
  const remote = await call(app, 'POST', API + '/fs/write', { id: 'openssh:alpha', path: '/tmp/big.txt', text })
  assert.equal(remote.status, 400)
  assert.match(remote.json.error, /主机未连接/)
  await app.closeAll()
})

test('fs: relative paths are rejected', async () => {
  const { app } = makeHarness()
  const wrote = await call(app, 'POST', API + '/local/write', { path: 'notes.txt', text: 'x' })
  assert.equal(wrote.status, 400)
  assert.equal(wrote.json.error, 'path must be absolute: notes.txt')
  const read = await call(app, 'GET', API + '/local/read?path=notes.txt')
  assert.equal(read.status, 400)
  assert.equal(read.json.error, 'path must be absolute: notes.txt')
  await app.closeAll()
})

test('disconnect closes the session and clears the job', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'ready')
  const { status, json } = await call(app, 'POST', API + '/disconnect', { id: 'openssh:alpha' })
  assert.equal(status, 200)
  assert.equal(state.sessions[0].closeCalls, 1)
  const row = json.hosts.find(host => host.id === 'openssh:alpha')
  assert.equal(row.stage, 'idle')
  assert.equal(row.connected, false)
  assert.equal(row.proxyUrl, null)
  assert.equal(row.sinceMs, 0)
  await app.closeAll()
})

test('closeAll closes every live session and clears jobs', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'ready')
  await app.closeAll()
  assert.equal(state.sessions[0].closeCalls, 1)
  const row = await hostRow(app, 'openssh:alpha')
  assert.equal(row.stage, 'idle')
  assert.equal(row.connected, false)
  await app.closeAll()
})

test('handlers never leak thrown errors: listHosts failure becomes a 500 JSON', async () => {
  const { app, state } = makeHarness()
  state.listImpl = () => { throw new Error('ssh config 读取失败') }
  const { status, json } = await call(app, 'GET', API + '/hosts')
  assert.equal(status, 500)
  assert.equal(json.error, 'ssh config 读取失败')
  await app.closeAll()
})

test('method and body validation: 405 for wrong methods, 400 for invalid JSON', async () => {
  const { app } = makeHarness()
  const wrongMethod = await call(app, 'GET', API + '/connect')
  assert.equal(wrongMethod.status, 405)
  const deleteHosts = await call(app, 'DELETE', API + '/hosts')
  assert.equal(deleteHosts.status, 405)
  const badJson = await call(app, 'POST', API + '/connect', Buffer.from('{definitely not json'))
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error, 'invalid JSON body')
  const noId = await call(app, 'POST', API + '/connect', {})
  assert.equal(noId.status, 400)
  assert.equal(noId.json.error, 'id is required')
  await app.closeAll()
})

test('connect: repeat connect on a ready host is idempotent (200, same session)', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const ready = await waitStage(app, 'openssh:alpha', 'ready')
  const again = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(again.status, 200)
  assert.equal(again.json.stage, 'ready')
  assert.equal(again.json.alreadyConnected, true)
  assert.equal(again.json.proxyUrl, ready.proxyUrl)
  assert.equal(again.json.sessionId, ready.sessionId)
  assert.equal(again.json.sinceMs, 0)
  assert.ok(Array.isArray(again.json.hosts))
  // The healthy session was neither reopened nor torn down.
  assert.equal(state.openCalls.length, 1)
  assert.equal(state.sessions.length, 1)
  assert.equal(state.sessions[0].closeCalls, 0)
  await app.closeAll()
})

test('state: rows carry a numeric sessionId when connected and null otherwise', async () => {
  const { app } = makeHarness()
  const idle = await hostRow(app, 'openssh:alpha')
  assert.equal(idle.sessionId, null)
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const ready = await waitStage(app, 'openssh:alpha', 'ready')
  assert.equal(typeof ready.sessionId, 'number')
  assert.ok(ready.sessionId > 0)
  const other = await hostRow(app, 'openssh:beta')
  assert.equal(other.sessionId, null)
  await app.closeAll()
})

test('connect: after session death a new connect starts a job with a new sessionId', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const first = await waitStage(app, 'openssh:alpha', 'ready')
  state.sessions[0].dead[0]()
  const restarted = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(restarted.status, 202)
  const second = await waitStage(app, 'openssh:alpha', 'ready')
  assert.equal(typeof second.sessionId, 'number')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(state.openCalls.length, 2)
  await app.closeAll()
})

test('connect: after /disconnect a new connect starts a fresh job (202)', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const first = await waitStage(app, 'openssh:alpha', 'ready')
  await call(app, 'POST', API + '/disconnect', { id: 'openssh:alpha' })
  const restarted = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(restarted.status, 202)
  assert.equal(restarted.json.alreadyConnected, undefined)
  const second = await waitStage(app, 'openssh:alpha', 'ready')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(state.openCalls.length, 2)
  await app.closeAll()
})

test('hide: an idle host becomes hidden:true and stays listed with the flag', async () => {
  const { app, state } = makeHarness()
  const { status, json } = await call(app, 'POST', API + '/hide', { id: 'openssh:beta', hidden: true })
  assert.equal(status, 200)
  assert.equal(json.hosts.length, 2) // describe() never filters hidden rows
  assert.equal(json.hosts.find(host => host.id === 'openssh:beta').hidden, true)
  assert.equal(json.hosts.find(host => host.id === 'openssh:alpha').hidden, false)
  assert.ok(state.hidden.has('beta'))
  assert.equal((await hostRow(app, 'openssh:beta')).hidden, true)
  await app.closeAll()
})

test('hide: a connected host is refused with 409', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'ready')
  const { status, json } = await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: true })
  assert.equal(status, 409)
  assert.equal(json.error, '主机已连接或正在连接，请先断开再隐藏')
  assert.equal(state.hidden.size, 0)
  await app.closeAll()
})

test('hide: an in-flight connect is refused with 409', async () => {
  const { app, state } = makeHarness()
  const gate = deferred()
  state.openImpl = (entry, options, makeSession) => gate.promise.then(() => makeSession(entry).session)
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  const refused = await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: true })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error, '主机已连接或正在连接，请先断开再隐藏')
  assert.equal(state.hidden.size, 0)
  gate.resolve()
  await waitStage(app, 'openssh:alpha', 'ready')
  await app.closeAll()
})

test('hide: a settled failed job does not block hiding', async () => {
  const { app, state } = makeHarness()
  state.openImpl = async () => { throw new Error('known_hosts 校验失败') }
  await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  await waitStage(app, 'openssh:alpha', 'failed')
  const { status, json } = await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: true })
  assert.equal(status, 200)
  assert.equal(json.hosts.find(host => host.id === 'openssh:alpha').hidden, true)
  await app.closeAll()
})

test('hide: restoring with hidden:false clears the flag and allows connect again', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: true })
  const restored = await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: false })
  assert.equal(restored.status, 200)
  assert.equal(restored.json.hosts.find(host => host.id === 'openssh:alpha').hidden, false)
  assert.equal(state.hidden.size, 0)
  const started = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(started.status, 202)
  await waitStage(app, 'openssh:alpha', 'ready')
  await app.closeAll()
})

test('hide: unknown id -> 404', async () => {
  const { app } = makeHarness()
  const { status, json } = await call(app, 'POST', API + '/hide', { id: 'openssh:nope', hidden: true })
  assert.equal(status, 404)
  assert.equal(json.error, '未找到主机 openssh:nope')
  await app.closeAll()
})

test('hide: body and method validation (400 / 405)', async () => {
  const { app, state } = makeHarness()
  const wrongMethod = await call(app, 'GET', API + '/hide')
  assert.equal(wrongMethod.status, 405)
  const badJson = await call(app, 'POST', API + '/hide', Buffer.from('{not json'))
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error, 'invalid JSON body')
  const badBodies = [
    { hidden: true },
    { id: 42, hidden: true },
    { id: '', hidden: true },
    { id: 'openssh:alpha' },
    { id: 'openssh:alpha', hidden: 'true' },
    { id: 'openssh:alpha', hidden: 1 },
    { id: 'openssh:alpha', hidden: null },
  ]
  for (const body of badBodies) assert.equal((await call(app, 'POST', API + '/hide', body)).status, 400)
  assert.equal(state.hidden.size, 0)
  await app.closeAll()
})

test('hide: a store failure becomes a 400 with the message', async () => {
  const { app, state } = makeHarness()
  state.setHiddenImpl = async () => {
    throw Object.assign(new Error('别名不合法：只允许字母、数字和 ._@-，且不能以 - 开头'), { code: 'invalid-settings' })
  }
  const { status, json } = await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: true })
  assert.equal(status, 400)
  assert.match(json.error, /别名不合法/)
  assert.equal(state.hidden.size, 0)
  await app.closeAll()
})

test('connect: a hidden host is refused with 409 until restored', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/hide', { id: 'openssh:alpha', hidden: true })
  const refused = await call(app, 'POST', API + '/connect', { id: 'openssh:alpha' })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error, '主机已隐藏，请先在面板中恢复')
  assert.equal(state.openCalls.length, 0)
  await app.closeAll()
})

test('hosts: settings save round-trip preserves the hidden list', async () => {
  const { app, state } = makeHarness()
  await call(app, 'POST', API + '/hide', { id: 'openssh:beta', hidden: true })
  const saved = await call(app, 'POST', API + '/hosts', { alias: 'alpha', webPort: 19090 })
  assert.equal(saved.status, 201)
  assert.equal(saved.json.hosts.find(host => host.id === 'openssh:beta').hidden, true)
  assert.equal(saved.json.hosts.find(host => host.id === 'openssh:alpha').hidden, false)
  assert.ok(state.hidden.has('beta'))
  await app.closeAll()
})