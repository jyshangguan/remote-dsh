/**
 * Tests for lib/remote.js — the attach-only, never-destructive remote session.
 *
 * A fake ssh2 client (EventEmitter with exec/end/forwardOut) scripts responses
 * by regex on the command text, so every assertion is about the COMMANDS issued
 * and the lifecycle, with no real SSH, no ssh2 import and no remote effects.
 * The gateway, SFTP, sleep and token-validation transport are all injected.
 */
import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ManualActionRequired, openSession, probeHost, run, probeWebPort, webServers, portInUse } from '../lib/remote.js'

const BASE = '$HOME/.local/share/dsh-remote-panel-openssh'
const LOCK = BASE + '/locks/web-18080.lock'
const RUNTIME = BASE + '/runtime/0.3.0'
const COOKIE = { statusCode: 303, headers: { 'set-cookie': ['dsh_auth=abc; Path=/; HttpOnly; SameSite=Strict'] } }
const REJECT = { statusCode: 401, headers: {} }

const ENTRY = { id: 'openssh:myhost', alias: 'myhost', webPort: 18080, profile: 'web', webLog: null, installProxy: '' }

/** The fork's cardinal rule: no command may ever contain `kill`. */
function assertNoKill(commands) {
  for (const command of commands) {
    assert.ok(!/kill/i.test(command), 'kill command issued: ' + command)
  }
}

/** Assert a probe Host run issued no mutating commands at all. */
function assertReadOnly(commands) {
  for (const command of commands) {
    assert.ok(!/mkdir|npm |nohup|rm -rf|test -e|\.lock|kill/i.test(command), 'mutating command in probe: ' + command)
  }
}

/**
 * Fake ssh2 client. `script` is an ordered list of [regex, reply] where reply is
 * { code, stdout, stderr } or a function(command) returning one. First match
 * wins; unmatched commands resolve empty/success.
 */
function fakeClient(script) {
  const client = new EventEmitter()
  const commands = []
  client.commands = commands
  client.ended = 0
  client.exec = (command, cb) => {
    commands.push(command)
    let reply = { code: 0, stdout: '', stderr: '' }
    for (const [pattern, value] of script) {
      if (pattern.test(command)) {
        reply = typeof value === 'function' ? value(command) : value
        break
      }
    }
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    queueMicrotask(() => {
      cb(null, stream)
      if (reply.stdout) stream.emit('data', reply.stdout)
      if (reply.stderr) stream.stderr.emit('data', reply.stderr)
      stream.emit('close', reply.code ?? 0)
    })
  }
  client.end = () => { client.ended++ }
  client.forwardOut = (srcHost, srcPort, dstHost, dstPort, cb) => cb(new Error('fake: no forward'))
  return client
}

/** Injected deps + observable state. `verdicts` is mutable between calls. */
function makeDeps(client, { verdicts = {}, defaultVerdict = REJECT } = {}) {
  const state = { connectArgs: [], gatewayOptions: [], gatewayClosed: 0, fsClosed: 0, fsCreated: 0, httpCalls: [], tokensReturned: [] }
  let gatewayPort = 41000
  const deps = {
    connectClient: async entry => { state.connectArgs.push(entry); return client },
    createGateway: async options => {
      state.gatewayOptions.push(options)
      const token = await options.tokenProvider()
      state.tokensReturned.push(token)
      return { port: gatewayPort++, refresh: async () => {}, close: async () => { state.gatewayClosed++ } }
    },
    remoteFs: () => { state.fsCreated++; return { close: () => { state.fsClosed++ }, list: async () => ({ entries: [] }) } },
    sleep: async () => {},
    httpRequest: async request => {
      state.httpCalls.push(request)
      const token = new URL('http://local' + request.path).searchParams.get('token')
      const verdict = verdicts[token] ?? defaultVerdict
      return typeof verdict === 'function' ? verdict(request) : verdict
    },
  }
  return { deps, state }
}

// Convenience reply builders (ordered most-specific first where it matters).
const nodeReply = (v = 'v24.13.1') => [/^node -v/, { code: 0, stdout: v + '\n', stderr: '' }]
const probeReply = code => [/^curl /, { code: 0, stdout: code, stderr: '' }]
const pgrepReply = (stdout = '') => [/pgrep -f/, { code: 0, stdout, stderr: '' }]
const portReply = (count = '0') => [/ss -ltn/, { code: 0, stdout: count + '\n', stderr: '' }]
const sideReply = v => [/node_modules\/\.bin\/dsh" --version/, { code: 0, stdout: v === '' ? '' : v + '\n', stderr: '' }]
const lsReply = (names = []) => [/^ls -1t/, { code: 0, stdout: names.length ? names.join('\n') + '\n' : '', stderr: '' }]
const npmPathReply = () => [/^command -v npm/, { code: 0, stdout: '/usr/bin/npm\n', stderr: '' }]
const installMkdirReply = () => [/^mkdir -p "[^"]*\/runtime\//, { code: 0, stdout: '', stderr: '' }]
const npmReply = () => [/npm i --prefix/, { code: 0, stdout: 'added 1 package in 2s\n', stderr: '' }]
const lockReply = (code = 0) => [/&& mkdir ".*\.lock"/, { code, stdout: '', stderr: '' }]
const testEReply = (code = 1) => [/^test -e/, { code, stdout: '', stderr: '' }]
const pidMarkerReply = () => [/\.lock\/pid"/, { code: 0, stdout: '', stderr: '' }]
const rmReply = () => [/^rm -rf ".*\.lock"/, { code: 0, stdout: '', stderr: '' }]
const tailReply = (text = '') => [/^tail -n 5/, { code: 0, stdout: text === '' ? '' : text + '\n', stderr: '' }]

/** grep reply: tokenFn(path) -> token values in file order (oldest first). */
const grepReply = tokenFn => [/^grep -o "token=/, command => {
  const match = /"([^"]+)" 2>/.exec(command)
  const path = match === null ? '' : match[1]
  const tokens = tokenFn(path) ?? []
  return { code: 0, stdout: tokens.length ? tokens.join('\n') + '\n' : '', stderr: '' }
}]

/** One /proc row as the listing command would print it. */
const row = (pid, started, args) => pid + '|' + started + '|' + args

const OUR_LOG = 'web-18080-20261122T000000000Z-abc123.log'
const OUR_LOG_PATH = BASE + '/logs/' + OUR_LOG
const LIVE_ARGS = 'node /home/u/.local/share/dsh-remote-panel-openssh/runtime/0.3.0/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web web --host 127.0.0.1 --port 18080 --no-open'

// ---------------------------------------------------------------------------
test('run collects stdout, stderr and exit code', async () => {
  const client = fakeClient([[/^echo/, { code: 3, stdout: 'out\n', stderr: 'err\n' }]])
  const result = await run(client, 'echo hi')
  assert.deepEqual(result, { code: 3, stdout: 'out\n', stderr: 'err\n' })
  assertNoKill(client.commands)
})

test('run reports exec errors as code -1', async () => {
  const client = new EventEmitter()
  client.exec = (command, cb) => cb(new Error('boom'))
  const result = await run(client, 'anything')
  assert.equal(result.code, -1)
  assert.equal(result.stderr, 'boom')
})

test('probeWebPort builds a loopback curl and trims the status', async () => {
  const client = fakeClient([probeReply('303')])
  assert.equal(await probeWebPort(client, 18080), '303')
  assert.match(client.commands[0], /curl .*http:\/\/127\.0\.0\.1:18080\//)
  assertNoKill(client.commands)
})

test('portInUse reads the ss/netstat count', async () => {
  assert.equal(await portInUse(fakeClient([portReply('2')]), 18080), true)
  assert.equal(await portInUse(fakeClient([portReply('0')]), 18080), false)
})

test('webServers parses --profile variants and respects the port boundary', async () => {
  const stdout = [
    row(100, 1700000000, 'node /x/dsh --profile web web --host 127.0.0.1 --port 18080 --no-open'),
    row(200, 1700000001, 'node /x/dsh web --port=18080'),
    row(300, 1700000002, 'node /x/dsh --profile other web --port 19090'),
    row(400, 1700000003, 'node /x/dsh --profile web web --port 180801'),
    row(500, 1700000004, 'sh -c pgrep -f dsh web --port 18080'),
  ].join('\n') + '\n'
  const client = fakeClient([pgrepReply(stdout)])
  const servers = await webServers(client, 18080)
  assert.deepEqual(servers.map(s => s.pid), [100, 200])
  assert.equal(servers[0].startedAt, 1700000000)
  assertNoKill(client.commands)
})

// ---------------------------------------------------------------------------
test('attach: alive port + valid token builds the gateway with no install/spawn', async () => {
  const client = fakeClient([
    nodeReply(),
    probeReply('200'),
    pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'),
    portReply('1'),
    lsReply([OUR_LOG]),
    grepReply(path => path === OUR_LOG_PATH ? ['attachtok'] : []),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { attachtok: COOKIE } })
  const session = await openSession(ENTRY, { version: '0.3.0', deps })

  assert.equal(state.gatewayOptions.length, 1)
  assert.equal(state.gatewayOptions[0].authority, '127.0.0.1:18080')
  assert.equal(state.gatewayOptions[0].connectHost, '127.0.0.1')
  assert.ok(Number.isInteger(state.gatewayOptions[0].connectPort) && state.gatewayOptions[0].connectPort > 0)
  assert.deepEqual(state.tokensReturned, ['attachtok'])
  assert.deepEqual(state.connectArgs, [{ sshAlias: 'myhost' }])
  assert.match(session.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.ok(session.fs)

  // Attach is read-only: no install, no spawn, no lock, no version probe, no kill.
  for (const command of client.commands) {
    assert.ok(!/npm|nohup|mkdir|rm -rf|test -e|--version|\.lock/i.test(command), 'mutating command in attach: ' + command)
  }
  assertNoKill(client.commands)
  await session.close()
  assert.equal(state.gatewayClosed, 1)
  assert.equal(state.fsClosed, 1)
  assert.ok(client.ended >= 1)
})

test('existing web + no valid token -> ManualActionRequired, never a restart', async () => {
  const client = fakeClient([
    nodeReply(),
    probeReply('200'),
    pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'),
    portReply('1'),
    lsReply([OUR_LOG]),
    grepReply(path => path === OUR_LOG_PATH ? ['badtok'] : []),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { badtok: REJECT } })
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.equal(error.code, 'manual-action-required')
    assert.equal(error.message, '无法从日志取得有效启动令牌')
    assert.deepEqual(error.detail.pids, [1234])
    assert.match(error.detail.hint, /本插件不会自动重启实例/)
    return true
  })
  for (const command of client.commands) {
    assert.ok(!/nohup|npm|mkdir|rm -rf/i.test(command), 'restart/install attempted: ' + command)
  }
  assertNoKill(client.commands)
  assert.equal(state.gatewayOptions.length, 1)
  assert.equal(state.gatewayClosed, 0)
  assert.ok(client.ended >= 1)
})

test('port answering non-DSH (404) -> ManualActionRequired', async () => {
  const client = fakeClient([nodeReply(), probeReply('404'), pgrepReply(), portReply('1')])
  const { deps } = makeDeps(client)
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.equal(error.message, '端口被非 DSH 服务占用')
    return true
  })
  assert.ok(!client.commands.some(c => /nohup|npm|mkdir/i.test(c)))
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})

test('port occupied but silent after retries -> ManualActionRequired', async () => {
  const client = fakeClient([nodeReply(), probeReply('000'), pgrepReply(), portReply('1')])
  const { deps } = makeDeps(client)
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.equal(error.message, '端口被非 DSH 服务占用')
    return true
  })
  assert.ok(!client.commands.some(c => /nohup|npm/i.test(c)))
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})

test('same-profile instance on another port -> ManualActionRequired, no spawn', async () => {
  const other = row(777, 1700000000, 'node /x/dsh --profile web web --host 127.0.0.1 --port 19090 --no-open')
  const client = fakeClient([nodeReply(), probeReply('000'), pgrepReply(other + '\n'), portReply('0')])
  const { deps } = makeDeps(client)
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.match(error.message, /profile「web」/)
    assert.deepEqual(error.detail.pids, [777])
    return true
  })
  assert.ok(!client.commands.some(c => /nohup|npm|mkdir|\.lock/i.test(c)), 'spawn/lock attempted despite conflict')
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})

test('fresh start: missing side runtime installs ONLY into our prefix, spawns safely, locks then releases', async () => {
  let spawned = false
  let spawnedLogPath = ''
  let sideCalls = 0
  const client = fakeClient([
    nodeReply(),
    [/^curl /, () => ({ code: 0, stdout: spawned ? '200' : '000', stderr: '' })],
    pgrepReply(),
    portReply('0'),
    [/node_modules\/\.bin\/dsh" --version/, () => { sideCalls++; return { code: 0, stdout: sideCalls === 1 ? '' : '0.3.0\n', stderr: '' } }],
    npmPathReply(),
    installMkdirReply(),
    npmReply(),
    lockReply(0),
    testEReply(1),
    [/nohup env/, command => {
      spawned = true
      const match = /> "([^"]+)" 2>&1/.exec(command)
      spawnedLogPath = match === null ? '' : match[1]
      return { code: 0, stdout: '4242\n', stderr: '' }
    }],
    pidMarkerReply(),
    rmReply(),
    [/^ls -1t/, () => ({ code: 0, stdout: spawnedLogPath === '' ? '' : spawnedLogPath.split('/').pop() + '\n', stderr: '' })],
    grepReply(path => path === spawnedLogPath ? ['freshtok'] : []),
    tailReply(),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { freshtok: COOKIE } })
  const session = await openSession(ENTRY, { version: '0.3.0', deps })
  const commands = client.commands

  // Install targets only the side-runtime prefix; never a global/bin install.
  const npm = commands.find(c => /npm i --prefix/.test(c))
  assert.ok(npm, 'npm install issued')
  assert.ok(npm.includes('--prefix "' + RUNTIME + '"'), 'prefix is our runtime dir: ' + npm)
  assert.ok(npm.includes('@deepseek-ai/dsh@0.3.0'))
  assert.ok(npm.includes('--no-audit --no-fund'))
  assert.ok(!/\.local\/bin/.test(commands.join('\n')), 'wrote ~/.local/bin')
  assert.ok(!/npm i -g|npm install -g|--global/.test(commands.join('\n')), 'global npm install')
  const installMkdir = commands.find(c => /^mkdir -p "[^"]*\/runtime\//.test(c))
  assert.ok(installMkdir.includes('"' + RUNTIME + '"'))

  // Spawn command shape.
  const spawn = commands.find(c => /nohup env/.test(c))
  assert.ok(spawn.includes('DSH_HOME="$HOME/.dsh"'), 'DSH_HOME not pinned')
  assert.ok(spawn.includes('--profile web'))
  assert.ok(spawn.includes('umask 077'))
  assert.ok(spawn.includes('--host 127.0.0.1'))
  assert.ok(spawn.includes('--port 18080'))
  assert.ok(spawn.includes('--no-open'))
  assert.ok(spawn.includes('"' + RUNTIME + '/node_modules/.bin/dsh"'))
  assert.ok(spawn.includes('> "' + spawnedLogPath + '" 2>&1'))
  assert.match(spawnedLogPath, /\/logs\/web-18080-\d{8}T\d{9}Z-[a-z0-9]{6}\.log$/)

  // The log is brand-new: a read-only test -e preceded the spawn and said absent.
  const testIndex = commands.findIndex(c => c === 'test -e "' + spawnedLogPath + '"')
  const spawnIndex = commands.indexOf(spawn)
  assert.ok(testIndex >= 0 && testIndex < spawnIndex, 'log existence not checked before spawn')

  // Lock acquired (atomic mkdir) before spawn, released (exact rm) after.
  const lockIndex = commands.findIndex(c => c.includes('&& mkdir "' + LOCK + '"'))
  const rmIndex = commands.findIndex(c => c === 'rm -rf "' + LOCK + '"')
  assert.ok(lockIndex >= 0 && lockIndex < spawnIndex, 'lock not acquired before spawn')
  assert.ok(rmIndex > spawnIndex, 'lock not released after spawn')
  assert.equal(commands.filter(c => /^rm -rf/.test(c)).length, 1)

  assert.deepEqual(state.tokensReturned, ['freshtok'])
  assertNoKill(commands)
  await session.close()
  assert.ok(client.ended >= 1)
})

test('lock contention + web now alive -> attach, never removes the lock', async () => {
  let probeCalls = 0
  const client = fakeClient([
    nodeReply(),
    [/^curl /, () => { probeCalls++; return { code: 0, stdout: probeCalls === 1 ? '000' : '200', stderr: '' } }],
    pgrepReply(),
    portReply('0'),
    sideReply('0.3.0'),
    lockReply(1),
    lsReply([OUR_LOG]),
    grepReply(path => path === OUR_LOG_PATH ? ['contok'] : []),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { contok: COOKIE } })
  const session = await openSession(ENTRY, { version: '0.3.0', deps })
  assert.deepEqual(state.tokensReturned, ['contok'])
  assert.ok(!client.commands.some(c => /^rm -rf/.test(c)), 'auto-removed a contended lock')
  assert.ok(!client.commands.some(c => /nohup|npm/.test(c)))
  assertNoKill(client.commands)
  await session.close()
})

test('lock contention + nothing alive -> ManualActionRequired, no lock removal', async () => {
  const client = fakeClient([
    nodeReply(), probeReply('000'), pgrepReply(), portReply('0'), sideReply('0.3.0'), lockReply(1),
  ])
  const { deps } = makeDeps(client)
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.equal(error.message, '另一连接正在准备该实例或存在残留锁')
    assert.match(error.detail.hint, /locks\//)
    return true
  })
  assert.ok(!client.commands.some(c => /^rm -rf/.test(c)), 'removed a lock it did not create')
  assert.ok(!client.commands.some(c => /nohup/.test(c)))
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})

test('token validation: first candidate rejected (401), next accepted (303+cookie)', async () => {
  const client = fakeClient([
    nodeReply(), probeReply('200'), pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'), portReply('1'),
    lsReply([OUR_LOG]),
    grepReply(path => path === '/custom/web.log' ? ['bad'] : path === OUR_LOG_PATH ? ['good'] : []),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { bad: REJECT, good: COOKIE } })
  const session = await openSession({ ...ENTRY, webLog: '/custom/web.log' }, { version: '0.3.0', deps })
  assert.equal(state.httpCalls.length, 2)
  assert.equal(new URL('http://l' + state.httpCalls[0].path).searchParams.get('token'), 'bad')
  assert.equal(new URL('http://l' + state.httpCalls[1].path).searchParams.get('token'), 'good')
  assert.equal(state.httpCalls[0].headers.host, '127.0.0.1:18080')
  assert.deepEqual(state.tokensReturned, ['good'])
  assertNoKill(client.commands)
  await session.close()
})

test('token validation: all candidates rejected -> ManualActionRequired, one attempt each', async () => {
  const client = fakeClient([
    nodeReply(), probeReply('200'), pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'), portReply('1'),
    lsReply([OUR_LOG]),
    grepReply(path => path === OUR_LOG_PATH ? ['t1', 't2'] : []),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { t1: REJECT, t2: REJECT } })
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.equal(error.message, '无法从日志取得有效启动令牌')
    assert.deepEqual(error.detail.pids, [1234])
    return true
  })
  assert.equal(state.httpCalls.length, 2, 'must try each candidate exactly once, no loops')
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})

test('token provider caches the last good token and re-reads fresh on refresh', async () => {
  let tokens = ['good']
  const client = fakeClient([
    nodeReply(), probeReply('200'), pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'), portReply('1'),
    lsReply([OUR_LOG]),
    grepReply(path => path === OUR_LOG_PATH ? tokens : []),
  ])
  const verdicts = { good: COOKIE }
  const { deps, state } = makeDeps(client, { verdicts })
  const session = await openSession(ENTRY, { version: '0.3.0', deps })
  const provider = state.gatewayOptions[0].tokenProvider
  assert.equal(state.tokensReturned[0], 'good')

  // Simulate a 401 refresh: the old token now fails, a newer one appears.
  verdicts.good = REJECT
  verdicts.fresh = COOKIE
  tokens = ['good', 'fresh']
  const grepCountBefore = client.commands.filter(c => /^grep -o/.test(c)).length
  const again = await provider()
  assert.equal(again, 'fresh')
  const grepCountAfter = client.commands.filter(c => /^grep -o/.test(c)).length
  assert.ok(grepCountAfter > grepCountBefore, 'candidates were not re-read fresh')
  // Cached 'good' tried first, then 'fresh'; one attempt each.
  const lastTwo = state.httpCalls.slice(-2).map(r => new URL('http://l' + r.path).searchParams.get('token'))
  assert.deepEqual(lastTwo, ['good', 'fresh'])
  assertNoKill(client.commands)
  await session.close()
})

test('client error after ready -> onDead fires once, close is idempotent, no throw', async () => {
  const client = fakeClient([
    nodeReply(), probeReply('200'), pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'), portReply('1'),
    lsReply([OUR_LOG]), grepReply(path => path === OUR_LOG_PATH ? ['tok'] : []),
  ])
  const { deps, state } = makeDeps(client, { verdicts: { tok: COOKIE } })
  const session = await openSession(ENTRY, { version: '0.3.0', deps })
  let deadCount = 0
  session.onDead(() => { deadCount++ })
  client.emit('error', new Error('connection lost'))
  await session.close()
  client.emit('close')
  await session.close()
  assert.equal(deadCount, 1)
  assert.equal(state.gatewayClosed, 1)
  assert.equal(state.fsClosed, 1)
  assert.ok(client.ended >= 1)
  assertNoKill(client.commands)
})

test('spawn dies before serving -> ManualActionRequired with our-log tail, lock released, client ended', async () => {
  let spawnedLogPath = ''
  const client = fakeClient([
    nodeReply(), probeReply('000'), pgrepReply(), portReply('0'), sideReply('0.3.0'),
    lockReply(0), testEReply(1),
    [/nohup env/, command => {
      const match = /> "([^"]+)" 2>&1/.exec(command)
      spawnedLogPath = match === null ? '' : match[1]
      return { code: 0, stdout: '4242\n', stderr: '' }
    }],
    pidMarkerReply(), rmReply(),
    tailReply('Error: listen EADDRINUSE 127.0.0.1:18080'),
    lsReply(), grepReply(() => []),
  ])
  const { deps } = makeDeps(client)
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), error => {
    assert.ok(error instanceof ManualActionRequired)
    assert.match(error.message, /启动后没有监听端口 18080/)
    assert.deepEqual(error.detail.pids, [4242])
    assert.match(error.detail.hint, /EADDRINUSE/)
    assert.ok(error.detail.hint.includes(spawnedLogPath))
    return true
  })
  assert.ok(client.commands.some(c => c === 'tail -n 5 "' + spawnedLogPath + '" 2>/dev/null'), 'did not tail OUR log')
  assert.equal(client.commands.filter(c => c === 'rm -rf "' + LOCK + '"').length, 1, 'lock not released exactly once')
  assert.ok(!client.commands.some(c => /kill/i.test(c)))
  assert.ok(client.ended >= 1)
})

// ---------------------------------------------------------------------------
test('probeHost is read-only and reports attach when alive with a token', async () => {
  const client = fakeClient([
    nodeReply(), sideReply('0.3.0'), probeReply('200'),
    pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'), portReply('1'),
    lsReply([OUR_LOG]), grepReply(path => path === OUR_LOG_PATH ? ['tok'] : []),
  ])
  const { deps } = makeDeps(client)
  const result = await probeHost(ENTRY, '0.3.0', deps)
  assert.equal(result.ok, true)
  assert.equal(typeof result.ms, 'number')
  assert.equal(result.node, 'v24.13.1')
  assert.deepEqual(result.sideRuntime, { installed: true, version: '0.3.0' })
  assert.deepEqual(result.web, { alive: true, code: '200', pids: [1234] })
  assert.equal(result.profile, 'web')
  assert.equal(result.action, 'attach')
  assert.equal(result.reason, null)
  assert.equal(result.tokenReadable, true)
  assertReadOnly(client.commands)
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})

test('probeHost reports install-and-start when the port is free (even without the runtime)', async () => {
  const client = fakeClient([
    nodeReply(), sideReply(''), probeReply('000'), pgrepReply(), portReply('0'),
    lsReply(), grepReply(() => []),
  ])
  const { deps } = makeDeps(client)
  const result = await probeHost(ENTRY, '0.3.0', deps)
  assert.equal(result.action, 'install-and-start')
  assert.equal(result.reason, null)
  assert.equal(result.tokenReadable, false)
  assert.deepEqual(result.sideRuntime, { installed: false, version: '' })
  assertReadOnly(client.commands)
  assertNoKill(client.commands)
})

test('probeHost reports manual-action-required for a same-profile conflict', async () => {
  const other = row(777, 1700000000, 'node /x/dsh --profile web web --port 19090')
  const client = fakeClient([
    nodeReply(), sideReply('0.3.0'), probeReply('000'), pgrepReply(other + '\n'), portReply('0'),
    lsReply(), grepReply(() => []),
  ])
  const { deps } = makeDeps(client)
  const result = await probeHost(ENTRY, '0.3.0', deps)
  assert.equal(result.action, 'manual-action-required')
  assert.match(result.reason, /profile「web」/)
  assertReadOnly(client.commands)
  assertNoKill(client.commands)
})

test('probeHost reports manual-action-required when alive but no token is readable', async () => {
  const client = fakeClient([
    nodeReply(), sideReply('0.3.0'), probeReply('200'),
    pgrepReply(row(1234, 1700000000, LIVE_ARGS) + '\n'), portReply('1'),
    lsReply(), grepReply(() => []),
  ])
  const { deps } = makeDeps(client)
  const result = await probeHost(ENTRY, '0.3.0', deps)
  assert.equal(result.action, 'manual-action-required')
  assert.equal(result.reason, '无法从日志取得有效启动令牌')
  assert.equal(result.tokenReadable, false)
  assertReadOnly(client.commands)
  assertNoKill(client.commands)
})

test('probeHost reports manual-action-required for a non-DSH port answer', async () => {
  const client = fakeClient([
    nodeReply(), sideReply('0.3.0'), probeReply('404'), pgrepReply(), portReply('1'),
    lsReply(), grepReply(() => []),
  ])
  const { deps } = makeDeps(client)
  const result = await probeHost(ENTRY, '0.3.0', deps)
  assert.equal(result.action, 'manual-action-required')
  assert.equal(result.reason, '端口被非 DSH 服务占用')
  assertReadOnly(client.commands)
  assertNoKill(client.commands)
})

// ---------------------------------------------------------------------------
test('openSession validates entry shape before connecting', async () => {
  const client = fakeClient([])
  const { deps, state } = makeDeps(client)
  const bad = [
    { ...ENTRY, alias: 'bad alias' },
    { ...ENTRY, alias: '-leading' },
    { ...ENTRY, profile: 'web;rm' },
    { ...ENTRY, webPort: 0 },
    { ...ENTRY, webPort: 70000 },
    { ...ENTRY, webLog: '/tmp/$(evil).log' },
    { ...ENTRY, installProxy: 'ftp://x' },
  ]
  for (const entry of bad) {
    await assert.rejects(openSession(entry, { version: '0.3.0', deps }), /不合法|必须|只支持|安全字符/)
  }
  await assert.rejects(openSession(ENTRY, { version: '0.3.0;evil', deps }), /版本号不合法/)
  assert.equal(state.connectArgs.length, 0, 'connected despite invalid input')
  assert.equal(client.commands.length, 0)
})

test('openSession rejects an unsupported remote node without spawning', async () => {
  const client = fakeClient([nodeReply('v20.10.0'), probeReply('000')])
  const { deps } = makeDeps(client)
  await assert.rejects(openSession(ENTRY, { version: '0.3.0', deps }), /版本不满足要求/)
  assert.ok(!client.commands.some(c => /nohup|npm/i.test(c)))
  assertNoKill(client.commands)
  assert.ok(client.ended >= 1)
})
