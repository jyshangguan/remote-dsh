/**
 * OpenSSH-backed host bookkeeping for the remote DSH panel.
 *
 * Aliases are enumerated from ~/.ssh/config by lib/openssh.js (read-only);
 * this module only owns the panel settings store:
 *
 *   $DSH_HOME/remote-dsh-openssh.json   (DSH_HOME defaults to ~/.dsh)
 *   { version: 2, hosts: { [alias]: { webPort, profile, webLog, installProxy } } }
 *
 * It never reads or writes ~/.dsh/dsh-ssh.json, ~/.ssh/* or any credentials:
 * authentication material stays with OpenSSH (agent + identity files).
 * Writes are atomic (tmp + rename), dir 0700 / file 0600. A corrupt store is
 * tolerated as empty and is only rewritten on the next successful save.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listAliases as scanAliases } from './openssh.js'

/** Settings applied to aliases without a saved entry. */
export const DEFAULT_SETTINGS = Object.freeze({
  webPort: 18080,
  profile: 'web',
  webLog: null,
  installProxy: '',
})

const STORE_NAME = 'remote-dsh-openssh.json'
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Merge injected deps over the real node builtins. */
function withDefaults(deps = {}) {
  return {
    listAliases: scanAliases,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    rename: fs.rename,
    homedir: os.homedir,
    ...deps,
  }
}

/** Store location honouring DSH_HOME, falling back to the injected home. */
function storePath(d) {
  const env = process.env.DSH_HOME
  const base = typeof env === 'string' && env !== '' ? env : path.join(d.homedir(), '.dsh')
  return path.join(base, STORE_NAME)
}

/** Error with code 'invalid-settings' and a Chinese user message. */
function invalidSettings(message) {
  const error = new Error(message)
  error.code = 'invalid-settings'
  return error
}

/** Coerce one stored entry into the documented settings shape. */
function normalizeSettings(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  return {
    webPort: Number.isInteger(raw.webPort) && raw.webPort >= 1 && raw.webPort <= 65535 ? raw.webPort : DEFAULT_SETTINGS.webPort,
    profile: typeof raw.profile === 'string' && PROFILE_PATTERN.test(raw.profile) ? raw.profile : DEFAULT_SETTINGS.profile,
    webLog: typeof raw.webLog === 'string' ? raw.webLog : DEFAULT_SETTINGS.webLog,
    installProxy: typeof raw.installProxy === 'string' ? raw.installProxy : DEFAULT_SETTINGS.installProxy,
  }
}

/** Read the store; missing or corrupt JSON is treated as empty (no write). */
async function readStore(d) {
  let raw
  try { raw = await d.readFile(storePath(d), 'utf8') } catch { return { version: 2, hosts: {} } }
  try {
    const value = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      value.hosts !== null && typeof value.hosts === 'object' && !Array.isArray(value.hosts)) {
      return { version: 2, hosts: value.hosts }
    }
  } catch { /* corrupt JSON: fall through to empty, never overwrite here */ }
  return { version: 2, hosts: {} }
}

/** Atomic write: mkdir 0700, tmp file 0600, rename over the store. */
async function writeStore(d, store) {
  const file = storePath(d)
  await d.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  await d.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  await d.rename(tmp, file)
}

/** Build the picker entry for one alias. */
function entryFor(alias, settings) {
  return {
    id: 'openssh:' + alias,
    alias,
    label: alias,
    source: 'openssh',
    ...settings,
  }
}

/**
 * All connectable hosts: ~/.ssh/config aliases merged with saved settings,
 * in the order listAliases() returns them. Unsaved aliases get defaults.
 * @param {{ listAliases?: Function, readFile?: Function, writeFile?: Function, mkdir?: Function, rename?: Function, homedir?: Function }} [deps]
 * @returns {Promise<Array<{ id: string, alias: string, label: string, source: 'openssh', webPort: number, profile: string, webLog: string|null, installProxy: string }>>}
 */
export async function listHosts(deps = {}) {
  const d = withDefaults(deps)
  const aliases = await d.listAliases({ homedir: d.homedir })
  const store = await readStore(d)
  return aliases.map(alias => entryFor(alias, normalizeSettings(store.hosts[alias])))
}

/**
 * Resolve one 'openssh:<alias>' id. Fail closed: the alias must still exist
 * in ~/.ssh/config, otherwise null (a removed config means a removed host).
 * @param {string} id
 * @param {object} [deps] same injection surface as listHosts
 * @returns {Promise<object|null>}
 */
export async function resolveHost(id, deps = {}) {
  if (typeof id !== 'string' || !id.startsWith('openssh:')) return null
  const alias = id.slice('openssh:'.length)
  if (alias === '') return null
  const d = withDefaults(deps)
  const aliases = await d.listAliases({ homedir: d.homedir })
  if (!aliases.includes(alias)) return null
  const store = await readStore(d)
  return entryFor(alias, normalizeSettings(store.hosts[alias]))
}

/** Validate one patch field; throws invalid-settings with a Chinese message. */
function validateField(key, value) {
  if (key === 'webPort') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw invalidSettings('webPort 必须是 1..65535 的整数')
    }
    return value
  }
  if (key === 'profile') {
    if (typeof value !== 'string' || !PROFILE_PATTERN.test(value)) {
      throw invalidSettings('profile 只能包含字母、数字、. _ -，且必须以字母或数字开头')
    }
    return value
  }
  if (key === 'webLog') {
    if (value !== null && (typeof value !== 'string' || !(value.startsWith('/') || value.startsWith('~/')))) {
      throw invalidSettings('webLog 必须是 null、绝对路径（/ 开头）或 ~/ 开头的远端路径')
    }
    return value
  }
  if (key === 'installProxy') {
    if (typeof value !== 'string') throw invalidSettings('installProxy 必须是字符串（http/https 代理地址或空字符串）')
    const trimmed = value.trim()
    if (trimmed === '') return ''
    let url
    try { url = new URL(trimmed) } catch { throw invalidSettings('installProxy 不是合法的 URL：' + trimmed) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw invalidSettings('installProxy 只支持 http/https 代理：' + trimmed)
    }
    return trimmed
  }
  return value
}

/**
 * Validate and merge a settings patch for one alias, then persist atomically.
 * Only the four documented fields are accepted; absent fields keep their
 * current (or default) values.
 * @param {string} alias
 * @param {{ webPort?: number, profile?: string, webLog?: string|null, installProxy?: string }} patch
 * @param {object} [deps] same injection surface as listHosts
 * @returns {Promise<{ webPort: number, profile: string, webLog: string|null, installProxy: string }>}
 */
export async function saveSettings(alias, patch, deps = {}) {
  if (typeof alias !== 'string' || alias === '' || alias.startsWith('-') || !/^[A-Za-z0-9._@-]+$/.test(alias)) {
    throw invalidSettings('别名不合法：只允许字母、数字和 ._@-，且不能以 - 开头')
  }
  const d = withDefaults(deps)
  const store = await readStore(d)
  const next = normalizeSettings(store.hosts[alias])
  const fields = patch !== null && typeof patch === 'object' ? patch : {}
  for (const key of ['webPort', 'profile', 'webLog', 'installProxy']) {
    if (fields[key] !== undefined) next[key] = validateField(key, fields[key])
  }
  store.hosts[alias] = next
  await writeStore(d, store)
  return next
}
