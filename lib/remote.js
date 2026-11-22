/**
 * One live "remote DSH" session.
 *
 * Everything happens over the SSH connection, so the remote keeps `dsh web`
 * bound to 127.0.0.1 (no LAN exposure, no helper process to install):
 *
 *   ssh2 connect
 *     -> inspect the remote (node version, installed dsh version)
 *     -> install the matching dsh when it is missing or mismatched
 *     -> ensure `dsh web` is listening (start it if not)
 *     -> read the launch token out of its log
 *     -> local TCP tunnel 127.0.0.1:<random> -> remote 127.0.0.1:<webPort>
 *     -> gateway on another 127.0.0.1 port (holds the auth cookie)
 *
 * The browser page embeds the gateway URL; the remote cookie never leaves this
 * process.
 */
import fs from 'node:fs'
import net from 'node:net'
import ssh2 from 'ssh2'
import { createGateway } from './gateway.js'
import { remoteFs } from './sftp.js'

const { Client } = ssh2

/** Version assumed when the page does not report one. */
const FALLBACK_VERSION = '0.2.1-rc.3'

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/** Quote one value for a POSIX shell command line. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/** Run one command over the session and collect its output. */
export function run(client, command) {
  return new Promise(resolve => {
    client.exec(command, (error, stream) => {
      if (error !== undefined && error !== null) {
        resolve({ code: -1, stdout: '', stderr: error.message })
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', chunk => { stdout += String(chunk) })
      stream.stderr.on('data', chunk => { stderr += String(chunk) })
      stream.on('close', code => resolve({ code: code ?? 0, stdout, stderr }))
      stream.on('error', err => resolve({ code: -1, stdout, stderr: err.message }))
    })
  })
}

/**
 * Open one SSH connection to a host entry.
 * @param {object} entry host entry from hosts.js
 * @param {{ readyTimeout?: number, keepaliveCountMax?: number }} [options]
 */
export async function connectClient(entry, { readyTimeout = 20_000, keepaliveCountMax = 3 } = {}) {
  const client = new Client()
  const auth = entry.auth ?? {}
  const config = {
    host: entry.host,
    port: Number(entry.sshPort ?? 22),
    username: entry.user,
    readyTimeout,
    keepaliveInterval: 15_000,
    keepaliveCountMax,
  }
  if (typeof auth.password === 'string' && auth.password !== '') config.password = auth.password
  if (typeof auth.privateKeyPath === 'string' && auth.privateKeyPath !== '') config.privateKey = fs.readFileSync(auth.privateKeyPath)
  if (typeof auth.passphrase === 'string' && auth.passphrase !== '') config.passphrase = auth.passphrase
  await new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect(config)
  })
  return client
}

/** Whether an HTTP status means a DSH web server answered. */
function webAlive(code) {
  return code === '200' || code === '303' || code === '401'
}

/** HTTP status of the remote loopback web server, or '' when unreachable. */
export async function probeWebPort(client, webPort) {
  const result = await run(client, 'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:' + Number(webPort) + '/ 2>/dev/null || true')
  return result.stdout.trim()
}

/**
 * Epoch seconds when the dsh package behind `bin` was written, i.e. when it was
 * installed or upgraded. Walk up from the resolved entry point to the nearest
 * package.json so the check works for npm's bin shim and for a plain lib/bin.js.
 */
export async function packageInstalledAt(client, bin) {
  const command = 'p=$(readlink -f ' + bin + ' 2>/dev/null); [ -n "$p" ] || exit 0; ' +
    'd=$(dirname "$p"); i=0; while [ $i -lt 3 ]; do ' +
    'if [ -f "$d/package.json" ]; then stat -c %Y "$d/package.json" 2>/dev/null; exit 0; fi; ' +
    'd=$(dirname "$d"); i=$((i+1)); done'
  const seconds = Number((await run(client, command)).stdout.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * Live `dsh web` servers bound to `webPort`, with their start time taken from
 * /proc (no procps required): [{ pid, startedAt }].
 */
export async function webServers(client, webPort) {
  const command = 'for pid in $(pgrep -f "dsh web .*--port[= ]' + webPort + '" 2>/dev/null); do ' +
    'started=$(stat -c %Y /proc/$pid 2>/dev/null); echo "$pid|$started"; done'
  const result = await run(client, command)
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const [pid, startedAt] = line.split('|')
      return { pid: Number(pid), startedAt: Number(startedAt) }
    })
    .filter(entry => Number.isFinite(entry.pid) && entry.pid > 0)
}

/**
 * True when anything listens on the port, including a server that is still
 * booting and does not answer HTTP yet. Spawning a second `dsh web` in that
 * window would fail with EADDRINUSE and truncate the log carrying its token.
 */
export async function portInUse(client, webPort) {
  const command = '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c "127.0.0.1:' + webPort + '" || true'
  const result = await run(client, command)
  return Number(result.stdout.trim()) > 0
}

/**
 * A server started before the package on disk was installed is running old
 * code: it keeps the plugin set it booted with, so the page it serves no longer
 * matches the installed client bundles. Those processes must be restarted.
 */
export async function staleWebServers(client, bin, webPort, reinstalled) {
  const servers = await webServers(client, webPort)
  if (servers.length === 0) return []
  if (reinstalled) return servers
  const installedAt = await packageInstalledAt(client, bin)
  if (installedAt === null) return []
  return servers.filter(entry => Number.isFinite(entry.startedAt) && entry.startedAt + 5 < installedAt)
}

/** Terminate the given servers, escalating to SIGKILL when the port stays busy. */
export async function stopWebServers(client, webPort, servers) {
  for (const entry of servers) await run(client, 'kill ' + entry.pid + ' 2>/dev/null || true')
  for (let attempt = 0; attempt < 24; attempt++) {
    await sleep(250)
    if ((await webServers(client, webPort)).length === 0) return
  }
  for (const entry of servers) await run(client, 'kill -9 ' + entry.pid + ' 2>/dev/null || true')
  await sleep(400)
}


/** Open one loopback tunnel port forwarded over the SSH connection. */
function startTunnel(client, remotePort) {
  const server = net.createServer(socket => {
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, stream) => {
      if (error !== undefined && error !== null) { socket.destroy(); return }
      socket.pipe(stream).pipe(socket)
      stream.on('close', () => socket.destroy())
      socket.on('error', () => stream.destroy())
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** Node ^22.19 || >=24 satisfies the CLI's engine range. */
function nodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 24) return true
  if (major === 24) return true
  return major === 22 && minor >= 19
}

/**
 * Best-effort install proxy: when the host runs a conventional local HTTP proxy
 * on 7890 (mihomo/clash) and it can reach the npm registry, install through it.
 * Registry traffic is often 5-10x faster that way on lab machines.
 */
export async function detectProxy(client) {
  const result = await run(client, 'curl -s -o /dev/null -w "%{http_code}" -m 4 -x http://127.0.0.1:7890 https://registry.npmjs.org/ 2>/dev/null || true')
  const code = result.stdout.trim()
  return code.startsWith('2') || code.startsWith('3') ? 'http://127.0.0.1:7890' : ''
}

/**
 * Connect, prepare the remote (install dsh if needed), and build the gateway.
 * @param {object} entry host entry from hosts.js
 * @param {object} [options]
 * @param {string} [options.version] exact dsh version the local client runs
 * @param {(message: string) => void} [options.log]
 * @param {(stage: string) => void} [options.stage]
 */
export async function openSession(entry, { version = FALLBACK_VERSION, log = () => {}, stage = () => {} } = {}) {
  stage('ssh')
  const client = await connectClient(entry)
  log('ssh ready ' + entry.user + '@' + entry.host)

  const webPort = Number(entry.webPort ?? 18080)
  const bin = String(entry.dshBin ?? '~/.local/bin/dsh').replace(/^~/, '$HOME')
  const logPath = String(entry.webLog ?? '~/.dsh/logs/dsh-web.log').replace(/^~/, '$HOME')

  // ---------------------------------------------------------------- inspect
  stage('checking')
  const nodeVersion = (await run(client, 'node -v 2>/dev/null')).stdout.trim()
  if (nodeVersion === '') {
    client.end()
    throw new Error('远端没有 Node.js（需要 ^22.19 或 >=24）')
  }
  if (!nodeSupported(nodeVersion)) {
    client.end()
    throw new Error('远端 Node ' + nodeVersion + ' 版本不满足要求（需要 ^22.19 或 >=24）')
  }
  log('remote node ' + nodeVersion)

  const installed = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
  let reinstalled = false
  if (installed !== version) {
    log('remote dsh is ' + (installed === '' ? 'missing' : installed) + ', installing ' + version)
    stage('installing')
    const npmPath = (await run(client, 'command -v npm 2>/dev/null')).stdout.trim()
    if (npmPath === '') {
      client.end()
      throw new Error('远端没有 npm，无法自动安装 dsh')
    }
    const proxy = typeof entry.installProxy === 'string' && entry.installProxy.trim() !== ''
      ? entry.installProxy.trim()
      : await detectProxy(client)
    if (proxy !== '') log('installing through proxy ' + proxy)
    const proxyEnv = proxy === '' ? '' : 'HTTP_PROXY=' + proxy + ' HTTPS_PROXY=' + proxy + ' '
    const command = proxyEnv + 'npm i -g --prefix "$HOME/.local" @deepseek-ai/dsh@' + version + ' --no-audit --no-fund 2>&1 | tail -n 6'
    const install = await run(client, command)
    log('install exit ' + install.code)
    const after = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
    if (after !== version) {
      client.end()
      const tail = (install.stdout || install.stderr || '').trim().split('\n').slice(-3).join(' / ')
      throw new Error('安装 dsh@' + version + ' 失败（当前 ' + (after === '' ? '仍缺失' : after) + '）' + (tail === '' ? '' : '：' + tail))
    }
    reinstalled = true
    log('installed dsh ' + after)
  }

  // ------------------------------------------------------------- web server
  const alive = async () => webAlive(await probeWebPort(client, webPort))

  /**
   * Read the launch token. It is printed once, when the server starts, so this
   * retries briefly: a freshly spawned server writes it a moment after it binds.
   */
  const readToken = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await run(client, 'grep -o "token=[A-Za-z0-9_-]*" ' + logPath + ' 2>/dev/null | tail -1 | cut -d= -f2')
      const token = result.stdout.trim()
      if (token !== '') return token
      await sleep(500)
    }
    return null
  }

  const logTail = async () => (await run(client, 'tail -n 3 ' + logPath + ' 2>/dev/null')).stdout.trim()

  /** Wait until the port answers, without spawning anything. */
  const waitWeb = async seconds => {
    for (let attempt = 0; attempt < seconds; attempt++) {
      await sleep(1000)
      if (await alive()) return true
    }
    return false
  }

  let spawnAttempted = false
  const ensureWeb = async () => {
    if (await alive()) return
    // Never race an existing server: it holds the port while it boots, and a
    // second `dsh web` would die with EADDRINUSE — truncating the very log the
    // launch token is read from.
    const busy = (await webServers(client, webPort)).length > 0 || (await portInUse(client, webPort))
    if (busy) {
      if (await waitWeb(40)) return
      const running = await webServers(client, webPort)
      throw new Error('远端 dsh web 没有响应（端口 ' + webPort + (running.length === 0 ? '' : '，pid ' + running.map(entry => entry.pid).join(',') + ' 在运行') + '）')
    }
    if (spawnAttempted) {
      const tail = await logTail()
      throw new Error('远端 dsh web 启动后退出（端口 ' + webPort + '）' + (tail === '' ? '' : '：' + tail))
    }
    stage('starting')
    spawnAttempted = true
    log('starting remote dsh web on 127.0.0.1:' + webPort)
    await run(client, 'mkdir -p "$(dirname ' + logPath + ')" 2>/dev/null; nohup env PATH=$HOME/.local/bin:$PATH ' + bin + ' web --host 127.0.0.1 --port ' + webPort + ' --no-open > ' + logPath + ' 2>&1 &')
    if (await waitWeb(40)) return
    const tail = await logTail()
    throw new Error('远端 dsh web 没有起来（端口 ' + webPort + '）' + (tail === '' ? '' : '：' + tail))
  }

  // ------------------------------------------------- stale server self-heal
  // Reusing a server that predates the package on disk leaves the page with the
  // plugin set it booted with: services such as contextMenus / fileDrag vanish
  // and every plugin that injects them stays pending. Restart it here instead of
  // asking the user to ssh in and kill it by hand.
  if (await alive()) {
    const stale = await staleWebServers(client, bin, webPort, reinstalled)
    if (stale.length > 0) {
      stage('restarting')
      log('dsh web ' + stale.map(entry => entry.pid).join(',') + ' predates the installed package, restarting')
      await stopWebServers(client, webPort, stale)
      const left = await staleWebServers(client, bin, webPort, reinstalled)
      if (left.length > 0) {
        client.end()
        throw new Error('远端 dsh web 是旧版本进程且无法结束（pid ' + left.map(entry => entry.pid).join(',') + '），请检查进程属主后手动重启')
      }
    }
  }

  await ensureWeb()

  // The launch token only exists in the server's own startup output. When the
  // log no longer carries one (an earlier run truncated it, or the server was
  // started by hand elsewhere), restarting is the only way to get a usable
  // token — do it once, never in a loop.
  let tokenRestart = false
  const tokenProvider = async () => {
    await ensureWeb()
    const token = await readToken()
    if (token !== null) return token
    if (!tokenRestart) {
      tokenRestart = true
      stage('restarting')
      log('no launch token in ' + logPath + ', restarting the remote server once')
      const running = await webServers(client, webPort)
      if (running.length > 0) await stopWebServers(client, webPort, running)
      spawnAttempted = false
      await ensureWeb()
      const again = await readToken()
      if (again !== null) return again
    }
    const tail = await logTail()
    throw new Error('远端日志里没有 token：' + logPath + (tail === '' ? '' : '（日志末尾：' + tail + '）'))
  }

  // ---------------------------------------------------------------- gateway
  stage('gateway')
  const tunnel = await startTunnel(client, webPort)
  log('tunnel 127.0.0.1:' + tunnel.port + ' -> remote 127.0.0.1:' + webPort)

  let gateway = null
  try {
    gateway = await createGateway({
      connectHost: '127.0.0.1',
      connectPort: tunnel.port,
      authority: '127.0.0.1:' + webPort,
      tokenProvider,
      log,
    })
  } catch (error) {
    await new Promise(resolve => tunnel.server.close(resolve))
    client.end()
    throw error
  }

  stage('ready')
  let closed = false
  const fsApi = remoteFs(client)
  return {
    proxyUrl: 'http://127.0.0.1:' + gateway.port + '/',
    webUrl: null,
    /** SFTP operations on the same SSH connection (see lib/sftp.js). */
    fs: fsApi,
    async close() {
      if (closed) return
      closed = true
      try { fsApi.close() } catch { /* channel already gone */ }
      try { await gateway.close() } catch { /* already closed */ }
      await new Promise(resolve => tunnel.server.close(() => resolve()))
      try { client.end() } catch { /* already gone */ }
    },
  }
}

/**
 * Connectivity + environment check behind the panel's "测试" button. Connects,
 * inspects and disconnects — it never installs anything and never starts the
 * remote web server.
 * @param {object} entry host entry from hosts.js
 * @param {string} [version] exact dsh version the local client runs
 */
export async function probeHost(entry, version = FALLBACK_VERSION) {
  const started = Date.now()
  let client
  try {
    client = await connectClient(entry, { readyTimeout: 15_000, keepaliveCountMax: 2 })
  } catch (error) {
    throw new Error('SSH 连接失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const bin = String(entry.dshBin ?? '~/.local/bin/dsh').replace(/^~/, '$HOME')
    const webPort = Number(entry.webPort ?? 18080)
    const node = (await run(client, 'node -v 2>/dev/null')).stdout.trim()
    const dsh = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
    const web = await probeWebPort(client, webPort)
    const servers = await webServers(client, webPort)
    const installedAt = await packageInstalledAt(client, bin)
    const stale = servers.some(entry => installedAt !== null &&
      Number.isFinite(entry.startedAt) && entry.startedAt + 5 < installedAt)
    return {
      ok: true,
      ms: Date.now() - started,
      node,
      dsh,
      needsInstall: node !== '' && dsh !== version,
      versionMatches: dsh === version,
      webAlive: webAlive(web),
      webCode: web === '' ? '000' : web,
      webPids: servers.map(entry => entry.pid),
      webStale: stale,
    }
  } finally {
    try { client.end() } catch { /* already gone */ }
  }
}

/**
 * Restart the remote `dsh web` process so it picks up new plugins and the
 * synchronized `~/.dsh/.env`. Waits for the port to answer again.
 * @param {import('ssh2').Client} client connected SSH client
 * @param {object} entry host entry from hosts.js
 * @param {{ log?: (message: string) => void, stage?: (stage: string) => void }} [options]
 */
export async function restartWebServer(client, entry, { log = () => {}, stage = () => {}, profile = 'web' } = {}) {
  const webPort = Number(entry.webPort ?? 18080)
  const bin = String(entry.dshBin ?? '~/.local/bin/dsh').replace(/^~/, '$HOME')
  const logPath = String(entry.webLog ?? '~/.dsh/logs/dsh-web.log').replace(/^~/, '$HOME')
  const invocation = profile === 'web'
    ? bin + ' web'
    : bin + ' --profile ' + shellQuote(profile) + ' web'
  stage('restarting')

  const servers = await webServers(client, webPort)
  const pids = servers.map(entry => String(entry.pid))
  if (pids.length > 0) {
    log('stopping remote dsh web (pid ' + pids.join(', ') + ')')
    await run(client, 'kill ' + pids.join(' ') + ' 2>/dev/null || true')
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(500)
      if (!(await portInUse(client, webPort))) break
    }
    if (await portInUse(client, webPort)) {
      log('remote dsh web ignored SIGTERM, sending SIGKILL')
      await run(client, 'kill -9 ' + pids.join(' ') + ' 2>/dev/null || true')
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(500)
        if (!(await portInUse(client, webPort))) break
      }
    }
  }

  // A port that is still bound would make the new server die with EADDRINUSE and
  // truncate the log carrying its launch token.
  if (await portInUse(client, webPort)) {
    throw new Error('远端 dsh web 端口仍被占用，无法重启（端口 ' + webPort + '）')
  }

  log('starting remote dsh web on 127.0.0.1:' + webPort)
  await run(client, 'mkdir -p "$(dirname ' + logPath + ')" 2>/dev/null; nohup env PATH=$HOME/.local/bin:$PATH ' + invocation + ' --host 127.0.0.1 --port ' + webPort + ' --no-open > ' + logPath + ' 2>&1 &')
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(1000)
    if (webAlive(await probeWebPort(client, webPort))) return { restarted: true, webPort, pids }
  }
  const tail = (await run(client, 'tail -n 5 ' + logPath + ' 2>/dev/null')).stdout.trim()
  throw new Error('远端 dsh web 没有重新起来（端口 ' + webPort + '）' + (tail === '' ? '' : '：' + tail))
}
