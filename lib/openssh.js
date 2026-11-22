/**
 * OpenSSH-native host resolution, host-key verification and connection.
 *
 * Security model (fail closed):
 *  - aliases come from ~/.ssh/config only; no credentials are stored here
 *  - `ssh -G` resolves an alias; configurations we cannot honour safely
 *    (ProxyJump/ProxyCommand/certificates/known-hosts commands/revocation
 *    commands, or disabled known_hosts) are rejected instead of approximated
 *  - host keys are verified against the user's known_hosts via `ssh-keygen -F`
 *    before the ssh2 handshake is allowed to continue; revoked keys and CA
 *    markers are rejected; nothing is ever written to known_hosts
 *  - authentication reuses the user's agent and identity files; encrypted
 *    keys without a passphrase are skipped, never prompted for
 *
 * Every external effect (execFile/readFile/readdir/homedir, and the ssh2
 * Client itself) is injectable through a final `deps` argument so tests run
 * without touching the real ~/.ssh or opening real connections.
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Include nesting cap (root config counts as depth 0). */
const MAX_INCLUDE_DEPTH = 5
/** Total number of config files read in one scan. */
const MAX_CONFIG_FILES = 50
/** Alias charset accepted before `ssh -G` is ever spawned. */
const ALIAS_PATTERN = /^[A-Za-z0-9._@-]+$/

/**
 * Error with a stable machine-readable `code` and a Chinese user message.
 * Codes: invalid-alias, ssh-config-failed, ssh-unsupported, ssh-host-key,
 * ssh-auth-failed.
 */
export class SshError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message Chinese user-facing message
   */
  constructor(code, message) {
    super(message)
    this.name = 'SshError'
    this.code = code
  }
}

/** Merge injected deps over the real node builtins. */
function withDefaults(deps = {}) {
  return {
    execFile: execFileAsync,
    readFile: fs.readFile,
    readdir: fs.readdir,
    homedir: os.homedir,
    ...deps,
  }
}

/** Expand a leading ~ against the (possibly injected) home directory. */
function expandTilde(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/')) return path.join(home, value.slice(2))
  return value
}

/** Tilde-expand and make absolute so downstream code never guesses cwd. */
function absolutePath(value, home) {
  const expanded = expandTilde(value, home)
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
}

/** Split one config line into keyword and argument string. */
function splitDirective(line) {
  const match = /^([^\s=]+)[\s=]*(.*)$/.exec(line)
  if (match === null) return null
  return { keyword: match[1].toLowerCase(), rest: match[2].trim() }
}

/** Small glob matcher for Include patterns: * ? and [classes]. */
function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) out += '\\['
      else {
        let cls = pattern.slice(i + 1, end)
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        out += '[' + cls.replace(/\\/g, '\\\\') + ']'
        i = end
      }
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + out + '$')
}

/**
 * Enumerate candidate aliases from ~/.ssh/config, following Include
 * directives (relative paths resolve against ~/.ssh/, ~ and final-component
 * globs are supported). Wildcard/negated Host patterns and Match blocks are
 * skipped. Read-only: nothing is ever written.
 * @param {{ execFile?: Function, readFile?: Function, readdir?: Function, homedir?: Function }} [deps]
 * @returns {Promise<string[]>} deduplicated aliases in file order
 */
export async function listAliases(deps = {}) {
  const { readFile, readdir, homedir } = withDefaults(deps)
  const home = homedir()
  const sshDir = path.join(home, '.ssh')
  const aliases = []
  const seen = new Set()
  const visited = new Set()
  let files = 0

  /** Resolve one Include token to candidate file paths (glob-aware). */
  async function includeCandidates(token) {
    const expanded = expandTilde(token, home)
    const full = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded)
    const dir = path.dirname(full)
    const base = path.basename(full)
    if (!/[*?[]/.test(base)) return [full]
    // Only final-component globs are supported; a globbed directory part is
    // skipped rather than guessed.
    if (/[*?[]/.test(dir)) return []
    let names
    try { names = await readdir(dir) } catch { return [] }
    const matcher = globToRegExp(base)
    return names.filter(name => matcher.test(name)).sort().map(name => path.join(dir, name))
  }

  async function scan(file, depth) {
    if (files >= MAX_CONFIG_FILES || depth > MAX_INCLUDE_DEPTH) return
    const key = path.resolve(file)
    if (visited.has(key)) return
    visited.add(key)
    let text
    try { text = await readFile(file, 'utf8') } catch { return }
    files++
    for (const raw of String(text).split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const directive = splitDirective(line)
      if (directive === null) continue
      const { keyword, rest } = directive
      if (keyword === 'host') {
        for (const pattern of rest.split(/\s+/)) {
          if (pattern === '' || /[*?!]/.test(pattern)) continue
          if (!seen.has(pattern)) { seen.add(pattern); aliases.push(pattern) }
        }
      } else if (keyword === 'include') {
        // Include is a parse-time directive: follow it even inside Match.
        for (const token of rest.split(/\s+/)) {
          if (token === '') continue
          for (const candidate of await includeCandidates(token)) await scan(candidate, depth + 1)
        }
      }
      // Match criteria are never evaluated and every other keyword is an
      // option, so Match block contents are skipped by construction: only
      // Host/Include (stanza/parse-level directives) carry meaning here.
    }
  }

  await scan(path.join(sshDir, 'config'), 0)
  return aliases
}

/**
 * @typedef {object} ResolvedConfig
 * @property {string} alias
 * @property {string} hostname
 * @property {string} user
 * @property {number} port
 * @property {string[]} identityFiles expanded absolute paths
 * @property {string|null} identityAgent null means SSH_AUTH_SOCK fallback
 * @property {string[]} knownHostsFiles expanded absolute paths
 * @property {string|null} hostKeyAlias
 * @property {boolean} identitiesOnly
 * @property {string[]} unsupported always empty when returned (else we throw)
 */

/**
 * Resolve an alias through `ssh -G` and reject configurations that cannot be
 * honoured safely (fail closed).
 * @param {string} alias
 * @param {{ execFile?: Function, readFile?: Function, readdir?: Function, homedir?: Function }} [deps]
 * @returns {Promise<ResolvedConfig>}
 */
export async function resolveSshConfig(alias, deps = {}) {
  const { execFile, homedir } = withDefaults(deps)
  if (typeof alias !== 'string' || alias === '' || alias.startsWith('-') || !ALIAS_PATTERN.test(alias)) {
    throw new SshError('invalid-alias', '无效的 SSH 别名：' + String(alias) + '（只允许字母、数字和 ._@-，且不能以 - 开头）')
  }
  const home = homedir()
  let stdout
  try {
    const result = await execFile('ssh', ['-G', alias])
    stdout = String(result?.stdout ?? '')
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? '').trim()
    throw new SshError('ssh-config-failed', '读取 SSH 配置失败（ssh -G ' + alias + '）' + (detail === '' ? '' : '：' + detail))
  }

  const single = new Map()
  const identityFiles = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const space = line.search(/\s/)
    const key = (space === -1 ? line : line.slice(0, space)).toLowerCase()
    const value = space === -1 ? '' : line.slice(space + 1).trim()
    if (key === 'identityfile') { if (value !== '') identityFiles.push(value) }
    else single.set(key, value)
  }
  const get = key => single.get(key) ?? ''

  const unsupported = []
  if (get('proxyjump') !== '' && get('proxyjump') !== 'none') unsupported.push('ProxyJump')
  if (get('proxycommand') !== '' && get('proxycommand') !== 'none') unsupported.push('ProxyCommand')
  if (get('certificatefile') !== '') unsupported.push('CertificateFile')
  if (get('knownhostscommand') !== '' && get('knownhostscommand') !== 'none') unsupported.push('KnownHostsCommand')
  if (get('revokedhostkeys') !== '' && get('revokedhostkeys') !== 'none') unsupported.push('RevokedHostKeys')
  if (get('revokedhostkeyscommand') !== '' && get('revokedhostkeyscommand') !== 'none') unsupported.push('RevokedHostKeysCommand')
  if (unsupported.length > 0) {
    throw new SshError('ssh-unsupported', 'SSH 配置使用了本面板不支持的特性：' + unsupported.join('、') + '，请先在终端简化 ' + alias + ' 的配置')
  }

  const hostname = get('hostname')
  if (hostname === '') throw new SshError('ssh-config-failed', 'ssh -G 没有返回 ' + alias + ' 的主机名（hostname 为空）')

  const rawKnownHosts = get('userknownhostsfile').trim()
  const knownHostsFiles = rawKnownHosts === '' || rawKnownHosts === 'none'
    ? []
    : rawKnownHosts.split(/\s+/).filter(token => token !== '' && token !== 'none').map(token => absolutePath(token, home))
  if (knownHostsFiles.length === 0) {
    throw new SshError('ssh-unsupported', 'SSH 配置关闭了 known_hosts 校验（UserKnownHostsFile none），本面板要求校验主机密钥，已拒绝连接 ' + alias)
  }

  const rawAgent = single.get('identityagent')
  const identityAgent = rawAgent === undefined || rawAgent === '' || rawAgent === 'none' ? null : absolutePath(rawAgent, home)
  const port = Number.parseInt(get('port'), 10)

  return {
    alias,
    hostname,
    user: get('user'),
    port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22,
    identityFiles: identityFiles.map(value => absolutePath(value, home)),
    identityAgent,
    knownHostsFiles,
    hostKeyAlias: get('hostkeyalias') === '' ? null : get('hostkeyalias'),
    identitiesOnly: get('identitiesonly') === 'yes',
    unsupported: [],
  }
}

/** Constant-time-ish blob equality: length mismatch is never equal. */
function keyEqual(a, b) {
  if (a.length === 0 || a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Run `ssh-keygen -F <lookup> -f <file>` and normalise the outcome.
 * Exit 0 = found, 1 = not found, anything else = unreadable file.
 */
async function keygenFind(execFile, lookup, file) {
  let result
  try {
    result = await execFile('ssh-keygen', ['-F', lookup, '-f', file])
  } catch (error) {
    result = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: -1 })
  }
  if (result instanceof Error) {
    return { code: typeof result.code === 'number' ? result.code : -1, stdout: typeof result.stdout === 'string' ? result.stdout : '' }
  }
  return { code: 0, stdout: typeof result?.stdout === 'string' ? result.stdout : '' }
}

/**
 * Verify a raw host-key blob against the resolved known_hosts files using
 * `ssh-keygen -F` (which handles hashed hostnames). Read-only: never writes
 * known_hosts and never runs ssh-keyscan.
 * @param {ResolvedConfig} resolved
 * @param {Buffer} keyBuffer raw host key blob (ssh2 hostVerifier without hostHash)
 * @param {{ execFile?: Function, readFile?: Function, readdir?: Function, homedir?: Function }} [deps]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'unknown'|'changed'|'revoked'|'unsupported' }>}
 */
export async function verifyHostKey(resolved, keyBuffer, deps = {}) {
  const { execFile } = withDefaults(deps)
  const presented = Buffer.isBuffer(keyBuffer) ? keyBuffer : Buffer.from(keyBuffer ?? '')
  const name = resolved.hostKeyAlias ?? resolved.hostname
  const port = Number(resolved.port ?? 22)
  const lookup = port === 22 ? name : '[' + name + ']:' + port

  const revoked = []
  const normal = []
  let certAuthority = false
  for (const file of resolved.knownHostsFiles ?? []) {
    const { code, stdout } = await keygenFind(execFile, lookup, file)
    if (code !== 0 && code !== 1) continue // unreadable file: skip
    if (code === 1) continue // not found in this file
    for (const raw of stdout.split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const fields = line.split(/\s+/)
      let markers = ''
      if (fields[0].startsWith('@')) { markers = fields[0]; fields.shift() }
      // fields: [hostnames, keytype, base64key, ...]
      if (fields.length < 3) continue
      const blob = Buffer.from(fields[2], 'base64')
      if (blob.length === 0) continue
      if (markers.includes('@cert-authority')) { certAuthority = true; continue }
      if (markers.includes('@revoked')) { revoked.push(blob); continue }
      normal.push(blob)
    }
  }

  if (certAuthority) return { ok: false, reason: 'unsupported' }
  // Revocation is collected across ALL files before any match is accepted.
  if (revoked.some(blob => keyEqual(blob, presented))) return { ok: false, reason: 'revoked' }
  if (normal.some(blob => keyEqual(blob, presented))) return { ok: true }
  if (revoked.length + normal.length > 0) return { ok: false, reason: 'changed' }
  return { ok: false, reason: 'unknown' }
}

/** Chinese explanation for a failed host-key verification. */
function hostKeyMessage(reason, alias) {
  if (reason === 'changed') return '主机密钥已变更，可能被劫持'
  if (reason === 'revoked') return '主机密钥已被撤销'
  if (reason === 'unsupported') return '不支持的主机证书配置'
  return '未知主机密钥，请先在终端运行 ssh ' + alias + ' 核验'
}

/** Read a uint32-length-prefixed string out of an openssh-key-v1 blob. */
function opensshCipherName(body) {
  const magic = Buffer.from('openssh-key-v1\0', 'utf8')
  if (body.length < magic.length + 4 || !body.subarray(0, magic.length).equals(magic)) return null
  const length = body.readUInt32BE(magic.length)
  if (body.length < magic.length + 4 + length) return null
  return body.toString('utf8', magic.length + 4, magic.length + 4 + length)
}

/** Whether a private key file is encrypted (we never prompt for passphrases). */
function encryptedKey(data) {
  const text = data.toString('utf8')
  if (text.includes('ENCRYPTED')) return true
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text)
  if (match !== null) {
    const body = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
    const cipher = opensshCipherName(body)
    if (cipher !== null && cipher !== 'none') return true
  }
  return false
}

/** Lazy ssh2 load so the module stays importable when only tests inject Client. */
async function defaultClientClass() {
  const mod = await import('ssh2')
  const Client = mod.Client ?? mod.default?.Client
  if (typeof Client !== 'function') throw new SshError('ssh-auth-failed', '无法加载 ssh2 模块，请检查插件依赖安装')
  return Client
}

/**
 * Connect an ssh2 Client using only OpenSSH-resolved auth material.
 * Host keys are verified through verifyHostKey before the handshake is
 * accepted; verification failure aborts immediately with a Chinese reason.
 * Auth tries agent + first readable key, then each remaining readable key
 * (fresh Client per attempt, failed clients are ended).
 * @param {{ sshAlias: string }} entry
 * @param {{ readyTimeout?: number, keepaliveCountMax?: number }} [opts]
 * @param {object} [deps] builtins plus { Client, resolveSshConfig, verifyHostKey } overrides
 * @returns {Promise<object>} connected ssh2 Client; caller owns its lifecycle
 */
export async function connectClient(entry, opts = {}, deps = {}) {
  const { readyTimeout = 20_000, keepaliveCountMax = 3 } = opts
  const merged = withDefaults(deps)
  const resolve = deps.resolveSshConfig ?? resolveSshConfig
  const verify = deps.verifyHostKey ?? verifyHostKey
  const Client = deps.Client ?? await defaultClientClass()
  const alias = entry?.sshAlias
  const resolved = await resolve(alias, merged)

  // Agent selection: explicit IdentityAgent wins; otherwise SSH_AUTH_SOCK.
  // IdentitiesOnly suppresses the env agent but never an explicit one.
  const envSock = typeof process.env.SSH_AUTH_SOCK === 'string' && process.env.SSH_AUTH_SOCK !== '' ? process.env.SSH_AUTH_SOCK : null
  const explicitAgent = resolved.identityAgent ?? null
  const agentPath = explicitAgent ?? envSock
  const useAgent = agentPath !== null && (!resolved.identitiesOnly || explicitAgent !== null)

  // Readable, unencrypted identity files in config order.
  const readable = []
  const notes = []
  for (const file of resolved.identityFiles ?? []) {
    let data
    try { data = await merged.readFile(file) } catch { notes.push('密钥不可读，已跳过：' + file); continue }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (encryptedKey(buffer)) { notes.push('加密密钥缺少口令，已跳过：' + file); continue }
    readable.push({ file, data: buffer })
  }

  /** One connection attempt; resolves with the ready client. */
  function attempt(auth) {
    const client = new Client()
    // Lifetime no-op listener: no 'error' event from our clients is ever
    // unhandled, during attempts or after the caller takes ownership.
    client.on('error', () => {})
    let verifyFailure = null
    const config = {
      host: resolved.hostname,
      port: resolved.port,
      username: resolved.user,
      readyTimeout,
      keepaliveInterval: 15_000,
      keepaliveCountMax,
      hostVerifier: (key, callback) => {
        Promise.resolve(verify(resolved, key, merged)).then(result => {
          if (result && result.ok === true) { verifyFailure = null; callback(true) }
          else { verifyFailure = result && result.reason ? result.reason : 'unknown'; callback(false) }
        }, () => { verifyFailure = 'unknown'; callback(false) })
      },
    }
    if (auth.agent !== null) config.agent = auth.agent
    if (auth.key !== null) config.privateKey = auth.key.data
    return new Promise((resolvePromise, rejectPromise) => {
      const onError = error => rejectPromise(error)
      client.once('error', onError)
      client.once('ready', () => { client.removeListener('error', onError); resolvePromise(client) })
      client.connect(config)
    }).catch(error => {
      try { client.end() } catch { /* already gone */ }
      if (verifyFailure !== null) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new SshError('ssh-host-key', hostKeyMessage(verifyFailure, resolved.alias) + '（' + detail + '）')
      }
      throw error
    })
  }

  // Attempt 0 carries agent (when allowed) plus the first readable key; each
  // later attempt tries the next key alone. At most identityFiles.length + 1.
  const attempts = []
  if (useAgent || readable.length > 0) attempts.push({ agent: useAgent ? agentPath : null, key: readable[0] ?? null })
  for (let i = 1; i < readable.length; i++) attempts.push({ agent: null, key: readable[i] })
  if (attempts.length === 0) {
    throw new SshError('ssh-auth-failed', '没有可用的 SSH 认证方式（' + resolved.alias + '）：没有可读的未加密密钥，也没有 SSH agent。请先在终端运行 ssh ' + resolved.alias + ' 确认可以登录，或运行 ssh-add 加载密钥' + (notes.length === 0 ? '' : '。' + notes.join('；')))
  }

  let lastError = null
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await attempt(attempts[i])
    } catch (error) {
      if (error instanceof SshError && error.code === 'ssh-host-key') throw error
      lastError = error
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? '')
  throw new SshError('ssh-auth-failed', 'SSH 认证失败（' + resolved.alias + '）：已尝试 ' + attempts.length + ' 次认证。请先在终端运行 ssh ' + resolved.alias + ' 确认可以登录，或运行 ssh-add 加载密钥' + (notes.length === 0 ? '' : '。' + notes.join('；')) + (detail === '' ? '' : '（最后错误：' + detail + '）'))
}
