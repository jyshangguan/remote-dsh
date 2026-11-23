/**
 * One live "remote DSH" session — attach-only, never destructive.
 *
 * Security model of this fork (openssh-safe-panel):
 *  - NEVER kill, restart or signal a remote process *automatically*. An
 *    existing instance is attached to exactly as it is; anything ambiguous
 *    raises ManualActionRequired and the user decides. The SINGLE deliberate
 *    exception: openSession({ restart: true }) — the user pressed 重启 in the
 *    panel — SIGTERMs the port-matching, uid-scoped dsh web processes (each
 *    /proc cmdline re-verified just before the signal) and respawns; see
 *    stopRemoteWeb. Never SIGKILL, never a signal outside that scan.
 *  - NEVER truncate or overwrite an existing remote log. A server WE start
 *    logs to a brand-new 0600 file under our own logs directory; every other
 *    log is read-only.
 *  - NEVER write ~/.local/bin/dsh or a global npm prefix. The side runtime is
 *    installed only under
 *    ~/.local/share/dsh-remote-panel-openssh/runtime/<version>/ via
 *    `npm i --prefix <dir> @deepseek-ai/dsh@<version> --no-audit --no-fund`.
 *  - Remote data stays the server's own: the start command sets
 *    DSH_HOME="$HOME/.dsh" explicitly and passes --profile <profile>; remote
 *    profiles/.env are never touched here.
 *
 * Flow: ssh connect (lib/openssh.js, dynamically imported so tests never load
 * ssh2) -> read-only inspection -> attach when a DSH web already answers,
 * otherwise install the side runtime + spawn under a short-lived lock ->
 * local TCP tunnel -> gateway (lib/gateway.js, unchanged) holding the cookie.
 *
 * Every await path ends with either a returned session or full local cleanup:
 * no tunnel, gateway, SFTP channel or SSH client is ever leaked on a throw.
 */
import http from 'node:http'
import net from 'node:net'

/** Version assumed when the caller does not report one (fork's supported release). */
const FALLBACK_VERSION = '0.2.2-rc.3'

/** Everything this fork owns on the remote lives under this directory. */
const BASE_DIR = '$HOME/.local/share/dsh-remote-panel-openssh'
const LOGS_DIR = BASE_DIR + '/logs'
const LOCKS_DIR = BASE_DIR + '/locks'

/**
 * Defensive shapes for UI-supplied values. profile/webPort/installProxy mirror
 * the lib/hosts.js contract; alias mirrors lib/openssh.js. webLog is stricter
 * than hosts' prefix-only check: it is embedded in a double-quoted shell word
 * (so $HOME expands), therefore shell metacharacters are rejected outright.
 */
const ALIAS_PATTERN = /^[A-Za-z0-9._@-]+$/
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_PATTERN = /^[0-9A-Za-z.-]+$/
const WEBLOG_PATTERN = /^(?:~\/|\/)[A-Za-z0-9_./-]+$/
/** Basename charset accepted from a remote `ls` before it re-enters a command. */
const LOG_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Conservative pgrep ERE for a live `dsh web` process, used for REPORTING and
 * for the same-profile guard only — never to signal anything.
 *
 * It matches a whole executable token ending in `dsh`, `dsh.js`, `dsh.mjs` or
 * a bin script under the package's `.../dsh/...` directory, an optional
 * `--profile <name>`, and then EITHER the legacy `web` subcommand (a whole
 * word) OR the rc.3 form where the web app's own `--host`/`--port` flag follows
 * directly (`dsh --profile <p> --host ... --port ...`). The port is matched in
 * JS after reading /proc/<pid>/cmdline, so the listing shell's own command text
 * (which contains this pattern literally) can never satisfy it: the pattern
 * requires a space right after the `dsh` token, while the literal text
 * continues with `(`. Rows whose cmdline still contains `pgrep -f` or `nohup`
 * are dropped as belt-and-braces against transient wrapper shells.
 */
const DSH_WEB_PATTERN = '(^| )[^ ]*dsh(\\.js|\\.mjs|/[^ ]*)? (--profile [^ ]+ )?(web( |$)|--(host|port)( |=))'

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/**
 * The remote needs manual attention: this fork refuses to self-heal by
 * restarting, killing or overwriting anything. `detail` carries optional pids
 * (for reporting) and a Chinese hint telling the user what to do by hand.
 */
export class ManualActionRequired extends Error {
  /**
   * @param {string} reason Chinese user-facing reason
   * @param {{ pids?: number[], hint?: string }} [detail]
   */
  constructor(reason, detail = {}) {
    super(reason)
    this.name = 'ManualActionRequired'
    this.code = 'manual-action-required'
    this.detail = { ...detail }
  }
}

/** Quote one value for a POSIX shell command line. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Run one command over the session and collect its output. Command strings are
 * built ONLY from validated/quoted values (see the patterns above).
 * @param {object} client connected ssh2 client
 * @param {string} command
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
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

/** Whether an HTTP status means a DSH web server answered. */
function webAlive(code) {
  return code === '200' || code === '303' || code === '401'
}

/**
 * HTTP status of the remote loopback web server, or '' when unreachable.
 * Read-only.
 * @param {object} client connected ssh2 client
 * @param {number} webPort
 * @returns {Promise<string>}
 */
export async function probeWebPort(client, webPort) {
  const result = await run(client, 'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:' + Number(webPort) + '/ 2>/dev/null || true')
  return result.stdout.trim()
}

/**
 * True when anything listens on the port, including a server still booting
 * that does not answer HTTP yet. Read-only (ss/netstat).
 * @param {object} client connected ssh2 client
 * @param {number} webPort
 * @returns {Promise<boolean>}
 */
export async function portInUse(client, webPort) {
  const command = '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c "127.0.0.1:' + Number(webPort) + '" || true'
  const result = await run(client, command)
  return Number(result.stdout.trim()) > 0
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

/** Compare two [major, minor, patch] arrays numerically. */
function compareVersion(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

/** Parse a node version STRING ('v24.22.2') into [major, minor, patch], or null. */
function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Version hint parsed from a candidate PATH (nvm/fnm/asdf dirs carry it). */
function pathVersion(path) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(path)
  if (match === null) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Candidate node binaries of the common version managers plus ~/.local/bin.
 * These managers hook into ~/.bashrc/.zshrc, which a NON-interactive SSH
 * exec never sources (Ubuntu's stock .bashrc returns early for them), so
 * their node is invisible to the default PATH even though the user's login
 * shell has it — exactly the "远端 Node v18.19.1 不满足要求" report on an
 * nvm box. One read-only listing: the first output line is $HOME, then every
 * existing candidate. Implemented with find (NOT shell globs: zsh aborts a
 * whole command when a glob has no matches, bash passes it through, and the
 * remote login shell is whatever the user set).
 */
const NODE_DISCOVERY_LIST = 'printf \'%s\\n\' "$HOME"; find ' +
  '"$HOME/.nvm/versions/node" ' +
  '"$HOME/.local/share/fnm/node-versions" ' +
  '"$HOME/.fnm/node-versions" ' +
  '"$HOME/.asdf/installs/nodejs" ' +
  '"$HOME/.volta/bin" ' +
  '"$HOME/n/bin" ' +
  '"$HOME/.local/bin" ' +
  '-maxdepth 4 -path \'*/bin/node\' 2>/dev/null'

/**
 * A discovered path may only contain this conservative charset: it ends up
 * embedded in double-quoted shell words (env PATH="..." and the spawn PATH)
 * and persisted to the settings store.
 */
const DISCOVERED_NODE_PATTERN = /^\/[A-Za-z0-9_./-]*\/bin\/node$/

/** How many candidates are probed with `node -v` at most. */
const DISCOVERY_PROBE_LIMIT = 8

/**
 * Discover a supported Node under the common version managers when the
 * default PATH node is missing or too old. Strictly read-only: one listing
 * plus `node -v` on each surviving candidate (newest-looking dirs first, so
 * the probe limit cannot crowd out the best). Returns { bin, version,
 * setting } for the highest supported candidate — `bin` is the absolute bin
 * dir used for PATH prefixes, `setting` the ~/ form for the settings store —
 * or null when nothing usable exists. Never installs Node.
 */
async function discoverNode(client) {
  const result = await run(client, NODE_DISCOVERY_LIST)
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return null
  const home = lines[0].endsWith('/bin/node') ? '' : lines[0]
  const seen = []
  for (const line of lines) {
    if (!line.endsWith('/bin/node') || line.includes('..') || !DISCOVERED_NODE_PATTERN.test(line)) continue
    if (!seen.includes(line)) seen.push(line)
  }
  const candidates = seen
    .sort((a, b) => compareVersion(pathVersion(b), pathVersion(a)))
    .slice(0, DISCOVERY_PROBE_LIMIT)
  let best = null
  for (const candidate of candidates) {
    const version = (await run(client, '"' + candidate + '" -v 2>/dev/null')).stdout.trim()
    const parsed = parseNodeVersion(version)
    if (parsed === null || !nodeSupported(version)) continue
    if (best === null || compareVersion(parsed, best.parsed) > 0) {
      best = { parsed, bin: candidate.slice(0, -'/node'.length), version }
    }
  }
  if (best === null) return null
  const setting = home !== '' && best.bin.startsWith(home + '/') ? '~' + best.bin.slice(home.length) : best.bin
  return { bin: best.bin, version: best.version, setting }
}

/** Pull --profile / --port values out of a /proc cmdline (args joined by spaces). */
function parseWebArgs(args) {
  const profileMatch = /(?:^|\s)--profile(?:=|\s+)([^\s]+)/.exec(args)
  const portMatch = /(?:^|\s)--port(?:=|\s+)(\d+)(?=\s|$)/.exec(args)
  return {
    // A bare `dsh web` runs the CLI's default profile, which is `web` (the
    // baseline omitted --profile exactly for that value). Treating absence as
    // 'web' errs toward blocking a conflicting start, never toward allowing one.
    profile: profileMatch === null ? 'web' : profileMatch[1],
    port: portMatch === null ? null : Number(portMatch[1]),
  }
}

/**
 * Every live `dsh web` process with its parsed profile/port and /proc start
 * time. One read-only pgrep + /proc read; nothing is signalled.
 */
async function dshWebProcesses(client) {
  // -u "$(id -u)" scopes the scan to the CONNECTING user. DSH_HOME defaults to
  // the owner's $HOME/.dsh, so only same-owner instances can share a profile's
  // state. On a multi-user server another user's `dsh web` (own DSH_HOME) must
  // NOT block us — a system-wide scan produced false same-profile conflicts.
  const command = 'for pid in $(pgrep -f -u "$(id -u)" ' + shellQuote(DSH_WEB_PATTERN) + ' 2>/dev/null); do ' +
    'args=$(tr "\\000" " " < /proc/$pid/cmdline 2>/dev/null); ' +
    'started=$(stat -c %Y /proc/$pid 2>/dev/null); ' +
    'printf "%s|%s|%s\\n" "$pid" "$started" "$args"; done'
  const result = await run(client, command)
  const rows = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const first = trimmed.indexOf('|')
    const second = trimmed.indexOf('|', first + 1)
    if (first < 1 || second < 0) continue
    const pid = Number(trimmed.slice(0, first))
    const startedAt = Number(trimmed.slice(first + 1, second))
    const args = trimmed.slice(second + 1)
    if (!Number.isFinite(pid) || pid <= 0) continue
    if (args.includes('pgrep -f') || args.includes('nohup')) continue
    const parsed = parseWebArgs(args)
    rows.push({ pid, startedAt: Number.isFinite(startedAt) ? startedAt : 0, args, profile: parsed.profile, port: parsed.port })
  }
  return rows
}

/**
 * Live `dsh web` servers bound to `webPort`: [{ pid, startedAt }]. Read-only,
 * pgrep-based, matches `--profile` variants too. Used for reporting only.
 * @param {object} client connected ssh2 client
 * @param {number} webPort
 * @returns {Promise<Array<{ pid: number, startedAt: number }>>}
 */
export async function webServers(client, webPort) {
  const port = Number(webPort)
  const rows = await dshWebProcesses(client)
  return rows.filter(row => row.port === port).map(row => ({ pid: row.pid, startedAt: row.startedAt }))
}

/**
 * A live dsh web of the SAME profile on a DIFFERENT port would share one
 * DSH_HOME/profile with the instance we are about to start and corrupt its
 * state. Returns the conflicting pids, or null. Read-only.
 *
 * Only the CONNECTING user's processes are considered (dshWebProcesses scopes
 * pgrep by uid): another user's instance has its own DSH_HOME and cannot share
 * state, so it is not a conflict.
 *
 * Conservative: a same-profile process whose --port we cannot parse is treated
 * as conflicting (ambiguous -> manual action), and a bare `dsh web` counts as
 * profile 'web' (see parseWebArgs).
 */
async function sameProfileConflict(client, profile, webPort) {
  const rows = await dshWebProcesses(client)
  const conflicts = rows.filter(row => row.profile === profile && row.port !== Number(webPort))
  return conflicts.length === 0 ? null : { pids: conflicts.map(row => row.pid) }
}

/** Validate a dsh version string before it ever enters a path or command. */
function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error('dsh 版本号不合法：' + String(version))
  }
  return version
}

/** Remote-side side-runtime directory for one exact version ($HOME unexpanded). */
function sideRuntimeDir(version) {
  assertVersion(version)
  return BASE_DIR + '/runtime/' + version
}

/** Installed side-runtime version ('' when missing), read-only. */
async function sideRuntimeVersion(client, version, nodeBin = '') {
  const bin = sideRuntimeDir(version) + '/node_modules/.bin/dsh'
  const result = await run(client, withNodeBin(nodeBin, '"' + bin + '" --version 2>/dev/null'))
  return result.stdout.trim()
}

/** Validate an install proxy is an http(s) URL (mirrors hosts.js). */
function validateProxy(proxy) {
  let url
  try { url = new URL(proxy) } catch { throw new Error('installProxy 不是合法的 URL：' + proxy) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('installProxy 只支持 http/https 代理：' + proxy)
  }
  return proxy
}

/**
 * Wrap a remote command with an explicit PATH prefix when the host configured
 * nodeBin (e.g. an nvm bin dir) or one was auto-discovered. With no prefix the
 * command stays bare, so the remote login PATH decides — unchanged behavior.
 */
function withNodeBin(nodeBin, command) {
  if (typeof nodeBin !== 'string' || nodeBin === '') return command
  return 'env PATH="' + nodeBin + ':$PATH" ' + command
}

/**
 * Install the side runtime into OUR prefix only — never ~/.local/bin, never a
 * global npm prefix. Checks node/npm, mkdir -p the version dir, npm install,
 * then re-checks the version and throws with the output tail on failure.
 */
async function installSideRuntime(client, version, { installProxy = '', nodeBin = '', log = () => {}, stage = () => {} } = {}) {
  stage('installing')
  const nodeVersion = (await run(client, withNodeBin(nodeBin, 'node -v 2>/dev/null'))).stdout.trim()
  if (nodeVersion === '') throw new Error('远端没有 Node.js（需要 ^22.19 或 >=24）')
  if (!nodeSupported(nodeVersion)) throw new Error('远端 Node ' + nodeVersion + ' 版本不满足要求（需要 ^22.19 或 >=24）')
  const npmPath = (await run(client, withNodeBin(nodeBin, "sh -c 'command -v npm' 2>/dev/null"))).stdout.trim()
  if (npmPath === '') throw new Error('远端没有 npm，无法安装 dsh 运行时')

  const dir = sideRuntimeDir(version)
  const made = await run(client, 'mkdir -p "' + dir + '"')
  if (made.code !== 0) {
    throw new Error('无法创建运行时目录：' + dir + (made.stderr.trim() === '' ? '' : '：' + made.stderr.trim()))
  }

  let proxyEnv = ''
  const proxy = String(installProxy ?? '').trim()
  if (proxy !== '') {
    validateProxy(proxy)
    proxyEnv = 'HTTP_PROXY=' + shellQuote(proxy) + ' HTTPS_PROXY=' + shellQuote(proxy) + ' '
    log('installing through proxy ' + proxy)
  }
  const command = withNodeBin(nodeBin, proxyEnv + 'npm i --prefix "' + dir + '" @deepseek-ai/dsh@' + version + ' --no-audit --no-fund')
  const install = await run(client, command)
  log('install exit ' + install.code)
  const after = await sideRuntimeVersion(client, version, nodeBin)
  if (after !== version) {
    const tail = (install.stdout || install.stderr || '').trim().split('\n').slice(-3).join(' / ')
    throw new Error('安装 dsh@' + version + ' 失败（当前 ' + (after === '' ? '仍缺失' : after) + '）' + (tail === '' ? '' : '：' + tail))
  }
  log('installed side runtime dsh ' + after)
  return after
}

/** Exact lock directory for one profile+port ($HOME unexpanded). */
function lockDir(profile, webPort) {
  return LOCKS_DIR + '/' + profile + '-' + Number(webPort) + '.lock'
}

/**
 * Atomically acquire the spawn lock: `mkdir` (no -p) of the exact lock dir
 * succeeds (exit 0) only for the creator. The parent locks dir is created
 * idempotently first. Returns the lock dir on success, null on contention.
 * Never removes an existing lock.
 */
async function acquireLock(client, profile, webPort) {
  const dir = lockDir(profile, webPort)
  const command = 'mkdir -p "' + LOCKS_DIR + '" 2>/dev/null && mkdir "' + dir + '" 2>/dev/null'
  const result = await run(client, command)
  return result.code === 0 ? dir : null
}

/** Remove ONLY the exact lock dir we created. Never touches any other lock. */
async function releaseLock(client, dir) {
  if (dir === null || dir === undefined) return
  await run(client, 'rm -rf "' + dir + '"')
}

/** DSH_WEB_PATTERN as a JS RegExp for the pre-signal cmdline re-verification. */
const DSH_WEB_REGEX = new RegExp(DSH_WEB_PATTERN)

/**
 * Stable loopback gateway port per host (alias-hashed into 41000..41899). The
 * embedded iframe's ORIGIN must survive reconnects and remote restarts: the
 * remote web app keeps its session selection (`dsh.sessions.current`) and
 * per-session drafts in per-origin localStorage, so a fresh origin on every
 * login made it open a NEW blank session instead of the previously used one.
 * The gateway scans forward on EADDRINUSE; see gateway.js. Exported for tests.
 */
export function gatewayPortFor(alias) {
  let hash = 0
  for (let index = 0; index < alias.length; index++) {
    hash = (hash * 31 + alias.charCodeAt(index)) >>> 0
  }
  return 41000 + (hash % 900)
}

/**
 * Restart-only stop: SIGTERM every live `dsh web` of the CONNECTING user bound
 * to webPort, re-verifying each /proc/<pid>/cmdline against DSH_WEB_PATTERN
 * immediately before the signal (PID-reuse guard). Waits, bounded, until none
 * of them survives — a survivor raises ManualActionRequired, we NEVER send
 * SIGKILL. Afterwards removes OUR OWN lock dir when its pid file points at a
 * terminated (or already gone) process, so the respawn can re-acquire it.
 *
 * This is the fork's SINGLE deliberate exception to "never signal a remote
 * process": it only runs because the user pressed 重启. Automatic paths never
 * call it.
 */
async function stopRemoteWeb(client, profile, webPort, log, sleepFn) {
  const port = Number(webPort)
  const rows = (await dshWebProcesses(client)).filter(row => row.port === port)
  const pids = []
  for (const row of rows) {
    // Re-read and re-match the cmdline right before signalling: the scan and
    // the kill are two SSH round trips, and a recycled PID must not be hit.
    const args = (await run(client, 'tr "\\000" " " < /proc/' + row.pid + '/cmdline 2>/dev/null')).stdout.trim()
    if (args === '' || !DSH_WEB_REGEX.test(args)) {
      log('pid ' + row.pid + ' no longer matches the dsh web pattern, not signalling')
      continue
    }
    const killed = await run(client, 'kill ' + row.pid)
    if (killed.code === 0) pids.push(row.pid)
    else log('SIGTERM to pid ' + row.pid + ' failed: ' + (killed.stderr.trim() === '' ? 'exit ' + killed.code : killed.stderr.trim()))
  }
  if (pids.length > 0) {
    log('sent SIGTERM to ' + pids.join(' '))
    let alive = true
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleepFn(500)
      const still = (await dshWebProcesses(client)).filter(row => pids.includes(row.pid))
      if (still.length === 0) { alive = false; break }
    }
    if (alive) {
      throw new ManualActionRequired('远端 dsh web 未在 20 秒内退出', {
        pids,
        hint: '已发送 SIGTERM（PID ' + pids.join(', ') + '）但进程没有退出。请在服务器上手动检查后重试；本插件不会发送 SIGKILL',
      })
    }
  } else {
    log('no live dsh web on port ' + port + ' to stop')
  }
  // Our lock dir is stale after a restart: drop it when its pid is one we
  // terminated, or when that pid no longer exists at all. Never another lock.
  const dir = lockDir(profile, port)
  const pid = Number((await run(client, 'cat "' + dir + '/pid" 2>/dev/null')).stdout.trim())
  if (Number.isFinite(pid) && pid > 0) {
    const gone = pids.includes(pid) || (await run(client, 'kill -0 ' + pid + ' 2>/dev/null')).code !== 0
    if (gone) {
      await run(client, 'rm -rf "' + dir + '"')
      log('removed stale lock ' + dir)
    }
  }
  return pids
}

/**
 * Read-only token candidates, newest-first, deduplicated. Sources in priority
 * order: the host's configured webLog, our own newest logs for this
 * profile+port, then the two conventional DSH log locations. NOTHING here is
 * ever written.
 */
async function readTokenCandidates(client, entry) {
  const paths = []
  if (entry.webLog !== null && entry.webLog !== '') paths.push(entry.webLog)

  const listing = await run(client, 'ls -1t "' + LOGS_DIR + '" 2>/dev/null')
  const prefix = entry.profile + '-' + Number(entry.webPort) + '-'
  const names = listing.stdout.split('\n')
    .map(line => line.trim())
    .filter(name => name.startsWith(prefix) && name.endsWith('.log') && LOG_NAME_PATTERN.test(name))
    .slice(0, 3)
  for (const name of names) paths.push(LOGS_DIR + '/' + name)

  paths.push('$HOME/.dsh/logs/dsh-web.log')
  paths.push('$HOME/.dsh/dsh-web.log')

  const candidates = []
  for (const path of paths) {
    const result = await run(client, 'grep -o "token=[A-Za-z0-9_-]*" "' + path + '" 2>/dev/null | tail -n 5 | cut -d= -f2')
    const tokens = result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '').reverse()
    for (const token of tokens) if (!candidates.includes(token)) candidates.push(token)
  }
  return candidates
}

/**
 * Default validation transport: one GET through the local tunnel keeping the
 * remote authority as Host. Resolves { statusCode, headers }; injectable via
 * deps.httpRequest so tests never open a socket.
 */
function defaultHttpRequest({ host, port, path, headers }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, method: 'GET', path, headers }, response => {
      response.resume()
      resolve({ statusCode: response.statusCode, headers: response.headers })
    })
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('token validation timeout')))
    request.end()
  })
}

/**
 * Build the gateway's tokenProvider. Each call re-reads candidates fresh and
 * tries each ONE at a time with its own validation request through the tunnel
 * (GET /?token=... expecting 303 AND a set-cookie) before returning it. The
 * last validated token is cached and tried first on the next call (gateway
 * refresh after a 401). No loops: one attempt per candidate per call. When
 * none validate, ManualActionRequired — never a restart.
 */
function makeTokenProvider({ client, entry, webPort, authority, tunnelPort, httpRequest, log = () => {} }) {
  let cached = null
  return async () => {
    const candidates = await readTokenCandidates(client, entry)
    const ordered = cached !== null && candidates.includes(cached)
      ? [cached, ...candidates.filter(token => token !== cached)]
      : candidates
    for (const token of ordered) {
      let response
      try {
        response = await httpRequest({
          host: '127.0.0.1',
          port: tunnelPort,
          path: '/?token=' + encodeURIComponent(token),
          headers: { host: authority, accept: 'text/html' },
        })
      } catch {
        continue // transport failure: this candidate is not usable, try the next
      }
      const raw = response?.headers?.['set-cookie']
      const hasCookie = Array.isArray(raw) ? raw.length > 0 : typeof raw === 'string' && raw !== ''
      if (response?.statusCode === 303 && hasCookie) {
        cached = token
        log('launch token validated')
        return token
      }
    }
    cached = null
    const servers = await webServers(client, webPort)
    throw new ManualActionRequired('无法从日志取得有效启动令牌', {
      pids: servers.map(server => server.pid),
      hint: '该实例可能由其他方式启动。请在服务器上以其日志可见的方式重启，或在主机设置中指定 webLog；本插件不会自动重启实例',
    })
  }
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

/**
 * Classify the remote web port. Read-only. `patient` waits out a booting
 * server that holds the port but does not answer HTTP yet (openSession); the
 * probe path passes false to stay quick.
 * Returns { code, alive, busy, servers }: busy means the port is NOT free.
 */
async function inspectWeb(client, webPort, sleepFn, patient) {
  let code = await probeWebPort(client, webPort)
  let servers = await webServers(client, webPort)
  if (webAlive(code)) return { code, alive: true, busy: true, servers }
  if (code !== '' && code !== '000') return { code, alive: false, busy: true, servers }
  const busy = servers.length > 0 || (await portInUse(client, webPort))
  if (!busy) return { code, alive: false, busy: false, servers }
  if (patient) {
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleepFn(1000)
      code = await probeWebPort(client, webPort)
      if (webAlive(code)) {
        servers = await webServers(client, webPort)
        return { code, alive: true, busy: true, servers }
      }
      if (code !== '' && code !== '000') return { code, alive: false, busy: true, servers }
    }
  }
  return { code, alive: false, busy: true, servers }
}

/** Coerce + validate one host entry defensively (UI input flows here). */
function validateEntry(entry) {
  if (entry === null || typeof entry !== 'object') throw new Error('主机配置不合法')
  const alias = String(entry.alias ?? entry.sshAlias ?? '').trim()
  if (alias === '' || alias.startsWith('-') || !ALIAS_PATTERN.test(alias)) {
    throw new Error('SSH 别名不合法：' + alias)
  }
  const webPort = Number(entry.webPort ?? 18080)
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
    throw new Error('webPort 必须是 1..65535 的整数')
  }
  const profile = String(entry.profile ?? 'web').trim()
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error('profile 只能包含字母、数字、. _ -，且必须以字母或数字开头')
  }
  const webLogRaw = entry.webLog === null || entry.webLog === undefined ? '' : String(entry.webLog).trim()
  if (webLogRaw !== '' && !WEBLOG_PATTERN.test(webLogRaw)) {
    throw new Error('webLog 必须是绝对路径或 ~/ 开头的远端路径，且只含安全字符：' + webLogRaw)
  }
  const webLog = webLogRaw === '' ? null : webLogRaw.replace(/^~/, '$HOME')
  const nodeBinRaw = entry.nodeBin === null || entry.nodeBin === undefined ? '' : String(entry.nodeBin).trim()
  if (nodeBinRaw !== '' && !WEBLOG_PATTERN.test(nodeBinRaw)) {
    throw new Error('nodeBin 必须是绝对路径或 ~/ 开头的远端目录，且只含安全字符：' + nodeBinRaw)
  }
  const nodeBin = nodeBinRaw === '' ? '' : nodeBinRaw.replace(/^~/, '$HOME')
  const installProxy = typeof entry.installProxy === 'string' ? entry.installProxy.trim() : ''
  if (installProxy !== '') validateProxy(installProxy)
  return { id: entry.id, alias, webPort, profile, webLog, nodeBin, installProxy }
}

/** Resolve injectable deps, dynamically importing the real modules lazily. */
async function resolveDeps(deps = {}) {
  return {
    connectClient: deps.connectClient ?? (await import('./openssh.js')).connectClient,
    createGateway: deps.createGateway ?? (await import('./gateway.js')).createGateway,
    remoteFs: deps.remoteFs ?? (await import('./sftp.js')).remoteFs,
    sleep: deps.sleep ?? sleep,
    httpRequest: deps.httpRequest ?? defaultHttpRequest,
  }
}

/** Bound a close promise so cleanup can never hang on a lingering socket. */
function bounded(factory, milliseconds) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(finish, milliseconds)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve().then(factory).then(finish, finish)
  })
}

/**
 * Connect, attach to (or carefully start) the remote DSH web, and build the
 * gateway. Never kills/restarts a remote process; never overwrites a remote
 * log; installs only into the side-runtime prefix.
 *
 * @param {object} entry host entry ({ id, alias, webPort, profile, webLog, nodeBin, installProxy })
 * @param {object} [options]
 * @param {string} [options.version] exact dsh version the local client runs
 * @param {(message: string) => void} [options.log]
 * @param {(stage: string) => void} [options.stage]
 * @param {(nodeBin: string) => Promise<void>|void} [options.onNodeBinResolved] called with the
 *   ~/ form of a Node auto-discovered on this connect, so the caller can persist it.
 *   Best-effort: a rejecting callback is logged, never fatal to the session.
 * @param {boolean} [options.restart] user pressed 重启: stop the port-matching remote
 *   dsh web first (SIGTERM, see stopRemoteWeb), then boot it again via the normal
 *   install-and-start path. The only path that ever signals a remote process.
 * @param {object} [options.deps] injectable { connectClient, createGateway, remoteFs, sleep, httpRequest }
 * @returns {Promise<{ proxyUrl: string, fs: object, close: () => Promise<void>, onDead: (cb: () => void) => void }>}
 */
export async function openSession(entry, { version = FALLBACK_VERSION, log = () => {}, stage = () => {}, onNodeBinResolved = null, restart = false, deps = {} } = {}) {
  const host = validateEntry(entry)
  assertVersion(version)
  const { connectClient, createGateway, remoteFs, sleep: sleepFn, httpRequest } = await resolveDeps(deps)
  const { alias, webPort, profile } = host
  const authority = '127.0.0.1:' + webPort

  stage('ssh')
  let client
  try {
    client = await connectClient({ sshAlias: alias })
  } catch (error) {
    throw new Error('SSH 连接失败：' + (error instanceof Error ? error.message : String(error)))
  }
  log('ssh ready ' + alias)

  // ------------------------------------------------------- lifecycle / cleanup
  let gateway = null
  let tunnel = null
  let fsApi = null
  let dead = false
  const deadListeners = []
  let cleanupPromise = null

  const doCleanup = async () => {
    try { if (fsApi !== null) fsApi.close() } catch { /* channel already gone */ }
    if (gateway !== null) {
      await bounded(() => gateway.close(), 2000)
    }
    try { client.end() } catch { /* already gone */ }
    if (tunnel !== null) {
      await bounded(() => new Promise(resolve => {
        try { tunnel.server.close(() => resolve()) } catch { resolve() }
      }), 2000)
    }
  }
  const cleanup = () => {
    if (cleanupPromise === null) cleanupPromise = doCleanup()
    return cleanupPromise
  }
  const markDead = () => {
    if (dead) return
    dead = true
    for (const listener of deadListeners) { try { listener() } catch { /* listener error */ } }
    void cleanup()
  }
  client.on('error', markDead)
  client.on('close', markDead)

  /** Build tunnel + gateway + fs and return the live session (shared by both paths). */
  const buildSession = async () => {
    stage('gateway')
    tunnel = await startTunnel(client, webPort)
    log('tunnel 127.0.0.1:' + tunnel.port + ' -> remote 127.0.0.1:' + webPort)
    const tokenProvider = makeTokenProvider({ client, entry: host, webPort, authority, tunnelPort: tunnel.port, httpRequest, log })
    gateway = await createGateway({ connectHost: '127.0.0.1', connectPort: tunnel.port, authority, tokenProvider, preferredPort: gatewayPortFor(alias), log })
    fsApi = remoteFs(client)
    stage('ready')
    return {
      proxyUrl: 'http://127.0.0.1:' + gateway.port + '/',
      /** SFTP operations on the same SSH connection (see lib/sftp.js). */
      fs: fsApi,
      close: cleanup,
      onDead(cb) { if (typeof cb === 'function') deadListeners.push(cb) },
    }
  }

  try {
    // ------------------------------------------------------------- restart
    if (restart) {
      // The user pressed 重启 (e.g. a plugin was installed inside the remote
      // GUI): stop the remote dsh web, then let the normal path boot it again.
      stage('restarting')
      log('restarting: stopping the remote dsh web on 127.0.0.1:' + webPort)
      const stopped = await stopRemoteWeb(client, profile, webPort, log, sleepFn)
      log('remote dsh web stopped' + (stopped.length === 0 ? ' (nothing was running)' : ' (pid ' + stopped.join(',') + ')'))
    }

    // ------------------------------------------------------------- inspect
    stage('checking')
    const web = await inspectWeb(client, webPort, sleepFn, true)
    if (web.alive) {
      // Attach-only: no version enforcement, no restart, no kill. The remote's
      // default `node` is irrelevant here — the running server already has its
      // own runtime (e.g. nvm), so no Node check gates the attach path.
      log('attaching to existing dsh web on 127.0.0.1:' + webPort + (web.servers.length === 0 ? '' : ' (pid ' + web.servers.map(s => s.pid).join(',') + ')'))
      return await buildSession()
    }
    if (web.busy) {
      throw new ManualActionRequired('端口被非 DSH 服务占用', {
        pids: web.servers.map(server => server.pid),
        hint: '端口 ' + webPort + ' 被其他服务占用，或实例一直没有响应。请在服务器上确认该端口的进程；本插件不会结束或重启任何进程',
      })
    }

    // ------------------------------------------------------- port free: start
    const conflict = await sameProfileConflict(client, profile, webPort)
    if (conflict !== null) {
      throw new ManualActionRequired('同一 profile「' + profile + '」已在其他端口运行 dsh web', {
        pids: conflict.pids,
        hint: '两个 web 实例共用一个 DSH_HOME/profile 会损坏状态。请先在服务器上手动停止其中一个，或为本主机改用不同 profile；本插件不会结束任何进程',
      })
    }

    // Only the install-and-start path needs a supported remote Node.
    let nodeBin = host.nodeBin
    const nodeVersion = (await run(client, withNodeBin(nodeBin, 'node -v 2>/dev/null'))).stdout.trim()
    if (nodeVersion === '' || !nodeSupported(nodeVersion)) {
      // Version managers hook into .bashrc, which a non-interactive SSH exec
      // never sources: the PATH node is then an old system one (or missing)
      // even though the user's login shell has a supported Node. Search the
      // managers before giving up — read-only; we never install Node.
      stage('resolving-node')
      log('remote node ' + (nodeVersion === '' ? 'missing' : nodeVersion + ' unsupported') + ', searching version managers')
      const found = await discoverNode(client)
      if (found === null) {
        const searched = '已自动搜索 nvm/fnm/asdf/volta/n 等常见位置未找到满足要求的 Node；可在主机设置 nodeBin 指定'
        if (nodeVersion === '') throw new Error('远端没有 Node.js（需要 ^22.19 或 >=24；' + searched + '）')
        throw new Error('远端 Node ' + nodeVersion + ' 版本不满足要求（需要 ^22.19 或 >=24；' + searched + '）')
      }
      nodeBin = found.bin
      log('discovered node ' + found.version + ' at ' + found.bin + ', using it for this session')
      if (typeof onNodeBinResolved === 'function') {
        try { await onNodeBinResolved(found.setting) } catch (error) {
          log('could not persist discovered nodeBin: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } else {
      log('remote node ' + nodeVersion)
    }

    const installed = await sideRuntimeVersion(client, version, nodeBin)
    if (installed !== version) {
      log('side runtime is ' + (installed === '' ? 'missing' : installed) + ', installing ' + version)
      await installSideRuntime(client, version, { installProxy: host.installProxy, nodeBin, log, stage })
    }

    const lock = await acquireLock(client, profile, webPort)
    if (lock === null) {
      // Contention: another connection may have started the server meanwhile.
      const code = await probeWebPort(client, webPort)
      if (webAlive(code)) {
        log('another connection started the web server, attaching')
        return await buildSession()
      }
      throw new ManualActionRequired('另一连接正在准备该实例或存在残留锁', {
        hint: '稍后重试；若确认无连接在进行，可手动删除远端 ~/.local/share/dsh-remote-panel-openssh/locks/ 下对应锁目录',
      })
    }

    let held = lock
    const release = async () => {
      if (held === null) return
      const dir = held
      held = null
      await releaseLock(client, dir)
    }
    try {
      // Re-probe after the lock: a racing connection may have started it.
      const code = await probeWebPort(client, webPort)
      if (webAlive(code)) {
        await release()
        log('web server appeared after locking, attaching')
        return await buildSession()
      }
      if (await portInUse(client, webPort)) {
        await release()
        throw new ManualActionRequired('端口被非 DSH 服务占用', {
          hint: '加锁后端口 ' + webPort + ' 被占用但没有 DSH 响应。请在服务器上确认该端口的进程；本插件不会结束或重启任何进程',
        })
      }

      stage('starting')
      const runtimeDir = sideRuntimeDir(version)
      const bin = runtimeDir + '/node_modules/.bin/dsh'
      const logPath = await newLogPath(client, profile, webPort)
      log('starting remote dsh web on 127.0.0.1:' + webPort + ' (profile ' + profile + ', log ' + logPath + ')')
      const spawnPath = runtimeDir + '/node_modules/.bin:' + (nodeBin === '' ? '' : nodeBin + ':') + '$PATH'
      // rc.3 CLI: `dsh --profile <p>` boots that profile's app directly; the
      // web app's own flags (--host/--port/--no-open) pass through as app-args.
      // A `web` positional after --profile is rejected ("too many arguments"),
      // so it must NOT be added here.
      const spawn = 'mkdir -p "' + LOGS_DIR + '" && umask 077 && nohup env DSH_HOME="$HOME/.dsh" PATH="' + spawnPath + '" "' + bin + '" --profile ' + profile + ' --host 127.0.0.1 --port ' + webPort + ' --no-open > "' + logPath + '" 2>&1 & echo $!'
      const spawned = await run(client, spawn)
      const pid = Number(spawned.stdout.trim())
      if (Number.isFinite(pid) && pid > 0) {
        await run(client, 'umask 077 && printf "%s\\n" ' + pid + ' > "' + lock + '/pid"')
      }

      let up = false
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleepFn(1000)
        if (webAlive(await probeWebPort(client, webPort))) { up = true; break }
      }
      if (!up) {
        const tail = (await run(client, 'tail -n 5 "' + logPath + '" 2>/dev/null')).stdout.trim()
        throw new ManualActionRequired('远端 dsh web 启动后没有监听端口 ' + webPort, {
          pids: Number.isFinite(pid) && pid > 0 ? [pid] : [],
          hint: '请检查日志 ' + logPath + (tail === '' ? '' : '（末尾：' + tail + '）') + '；本插件不会自动重启实例',
        })
      }
      await release()
      return await buildSession()
    } catch (error) {
      await release()
      throw error
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * Pick a brand-new log path under our logs dir. The name carries a millisecond
 * UTC timestamp plus a random suffix, and a read-only `test -e` confirms it
 * does not already exist, so the spawn's `>` can never truncate an existing
 * log. Throws rather than reuse a name.
 */
async function newLogPath(client, profile, webPort) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '')
    const rand = Math.random().toString(36).slice(2, 8)
    const name = profile + '-' + Number(webPort) + '-' + stamp + '-' + rand + '.log'
    const path = LOGS_DIR + '/' + name
    const exists = await run(client, 'test -e "' + path + '"')
    if (exists.code !== 0) return path
  }
  throw new Error('无法生成唯一的日志文件名，请稍后重试')
}

/**
 * Connectivity + environment check behind the panel's "测试" button. Strictly
 * READ-ONLY: connects, inspects, disconnects. No install, no start, no mkdir,
 * no lock, no writes of any kind.
 *
 * @param {object} entry host entry
 * @param {string} [version] exact dsh version the local client runs
 * @param {object} [deps] injectable { connectClient, sleep }
 * @returns {Promise<{ ok: true, ms: number, node: string, nodeSource: 'path'|'configured'|'discovered', nodeBin: string, sideRuntime: { installed: boolean, version: string }, web: { alive: boolean, code: string, pids: number[] }, profile: string, action: 'attach'|'install-and-start'|'manual-action-required', reason: string|null, tokenReadable: boolean }>}
 */
export async function probeHost(entry, version = FALLBACK_VERSION, deps = {}) {
  const started = Date.now()
  const host = validateEntry(entry)
  assertVersion(version)
  const connectClient = deps.connectClient ?? (await import('./openssh.js')).connectClient
  const sleepFn = deps.sleep ?? sleep

  let client
  try {
    client = await connectClient({ sshAlias: host.alias })
  } catch (error) {
    throw new Error('SSH 连接失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const pathNode = (await run(client, withNodeBin(host.nodeBin, 'node -v 2>/dev/null'))).stdout.trim()
    // Same resolution openSession applies on connect: report the node a
    // connect would actually use, so the 测试 line matches reality. The
    // discovery itself is read-only and nothing is persisted from a probe.
    let node = pathNode
    let nodeBin = host.nodeBin
    let nodeSource = host.nodeBin === '' ? 'path' : 'configured'
    if (pathNode === '' || !nodeSupported(pathNode)) {
      const found = await discoverNode(client)
      if (found !== null) {
        node = found.version
        nodeBin = found.bin
        nodeSource = 'discovered'
      }
    }
    const sideVersion = await sideRuntimeVersion(client, version, nodeBin)
    const web = await inspectWeb(client, host.webPort, sleepFn, false)
    const candidates = await readTokenCandidates(client, host)
    const tokenReadable = candidates.length > 0

    let action
    let reason = null
    if (web.alive) {
      if (tokenReadable) {
        action = 'attach'
      } else {
        action = 'manual-action-required'
        reason = '无法从日志取得有效启动令牌'
      }
    } else {
      const conflict = await sameProfileConflict(client, host.profile, host.webPort)
      if (conflict !== null) {
        action = 'manual-action-required'
        reason = '同一 profile「' + host.profile + '」已在其他端口运行 dsh web'
      } else if (web.busy) {
        action = 'manual-action-required'
        reason = web.code !== '' && web.code !== '000' ? '端口被非 DSH 服务占用' : '端口被占用但服务没有响应'
      } else {
        action = 'install-and-start'
      }
    }

    return {
      ok: true,
      ms: Date.now() - started,
      node,
      nodeSource,
      nodeBin,
      sideRuntime: { installed: sideVersion !== '', version: sideVersion },
      web: { alive: web.alive, code: web.code === '' ? '000' : web.code, pids: web.servers.map(server => server.pid) },
      profile: host.profile,
      action,
      reason,
      tokenReadable,
    }
  } finally {
    try { client.end() } catch { /* already gone */ }
  }
}
