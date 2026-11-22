/**
 * Pure text helpers for the profile sync: a small YAML writer, the managed
 * block in the remote profile patch, and `.env` merging.
 *
 * Nothing here talks to SSH or reads local configuration, so every function is
 * unit-testable on its own.
 */

/** Marker lines delimiting the part of the remote patch this plugin owns. */
export const BLOCK_START = '# >>> remote-dsh-sync (managed by dsh-remote-panel-ssh; this block is replaced on every sync)'
export const BLOCK_END = '# <<< remote-dsh-sync'

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
// Plain scalars must not contain `:`, `#`, quotes, or leading/trailing spaces;
// anything else is JSON-quoted (valid YAML double-quoted scalar).
const PLAIN_VALUE = /^[A-Za-z0-9_./][A-Za-z0-9_./@+-]*$/
const YAML_RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function scalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value)
  if (text === '') return "''"
  if (PLAIN_VALUE.test(text) && !YAML_RESERVED.test(text)) return text
  return JSON.stringify(text)
}

function key(value) {
  const text = String(value)
  return PLAIN_KEY.test(text) ? text : JSON.stringify(text)
}

function isEmptyCollection(value) {
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/**
 * Render one JSON-safe value as block YAML at the given indentation.
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {string}
 */
export function yamlBlock(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]\n'
    let out = ''
    for (const item of value) {
      if (Array.isArray(item)) {
        out += pad + '-\n' + yamlBlock(item, indent + 2)
        continue
      }
      if (isPlainObject(item)) {
        const keys = Object.keys(item).filter(name => item[name] !== undefined)
        if (keys.length === 0) { out += pad + '- {}\n'; continue }
        const first = keys[0]
        const rest = keys.slice(1)
        const firstValue = item[first]
        out += pad + '- ' + key(first) + ':'
        if (isEmptyCollection(firstValue)) out += ' ' + (Array.isArray(firstValue) ? '[]' : '{}') + '\n'
        else if (firstValue !== null && typeof firstValue === 'object') out += '\n' + yamlBlock(firstValue, indent + 4)
        else out += ' ' + scalar(firstValue) + '\n'
        for (const name of rest) {
          const child = item[name]
          out += pad + '  ' + key(name) + ':'
          if (isEmptyCollection(child)) out += ' ' + (Array.isArray(child) ? '[]' : '{}') + '\n'
          else if (child !== null && typeof child === 'object') out += '\n' + yamlBlock(child, indent + 4)
          else out += ' ' + scalar(child) + '\n'
        }
        continue
      }
      out += pad + '- ' + scalar(item) + '\n'
    }
    return out
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter(name => value[name] !== undefined)
    if (keys.length === 0) return pad + '{}\n'
    let out = ''
    for (const name of keys) {
      const child = value[name]
      out += pad + key(name) + ':'
      if (isEmptyCollection(child)) out += ' ' + (Array.isArray(child) ? '[]' : '{}') + '\n'
      else if (child !== null && typeof child === 'object') out += '\n' + yamlBlock(child, indent + 2)
      else out += ' ' + scalar(child) + '\n'
    }
    return out
  }
  return pad + scalar(value) + '\n'
}

/**
 * Wrap entries in the marker block the remote sync replaces in place.
 * @param {object[]} entries loader patch entries
 * @returns {string}
 */
export function renderSyncBlock(entries) {
  return BLOCK_START + '\n' + yamlBlock(entries).replace(/\s+$/, '') + '\n' + BLOCK_END + '\n'
}

/**
 * Replace the managed block in an existing patch file, or append one.
 * Text outside the markers is preserved verbatim.
 * @param {string} existing current patch file ('' when absent)
 * @param {string} block output of renderSyncBlock
 * @returns {string}
 */
export function mergeManagedBlock(existing, block) {
  const text = typeof existing === 'string' ? existing : ''
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  const body = String(block).replace(/\s+$/, '') + '\n'
  if (start >= 0 && end > start) {
    const before = text.slice(0, start)
    let after = text.slice(end + BLOCK_END.length)
    after = after.replace(/^[ \t]*\r?\n/, '')
    const prefix = before === '' || before.endsWith('\n') ? before : before + '\n'
    const suffix = after === '' ? '' : (prefix === '' ? '' : '\n') + after
    return prefix + body + suffix
  }
  // A fresh profile starts with an empty sequence (`[]`), which cannot be
  // followed by block-sequence items. Drop that placeholder, keep the header
  // comments, then append the managed block.
  const base = text
    .replace(/^[ \t]*(?:\[\]|null)[ \t]*\r?$/gm, '')
    .replace(/\s+$/, '')
  return (base === '' ? '' : base + '\n\n') + body
}

/**
 * Pick selected provider ids while keeping the configuration's own order.
 * @param {Record<string, unknown>} providers
 * @param {string[]} ids
 * @returns {Record<string, unknown>}
 */
export function pickProviders(providers, ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : [])
  const out = Object.create(null)
  for (const [id, value] of Object.entries(providers ?? {})) {
    if (wanted.has(id)) out[id] = value
  }
  return out
}

function envValue(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text)) return text
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"'
}

/**
 * Merge KEY=value pairs into a dotenv file, replacing only those keys and
 * preserving every other line (comments included).
 * @param {string} existing
 * @param {Array<[string, string]>} pairs
 * @returns {string}
 */
export function mergeEnvText(existing, pairs) {
  for (const [name] of pairs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid environment variable name: ' + name)
  }
  const keys = new Set(pairs.map(([name]) => name))
  const lines = String(existing ?? '').replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    return match === null || !keys.has(match[1])
  })
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  for (const [name, value] of pairs) kept.push(name + '=' + envValue(value))
  return kept.join('\n') + '\n'
}

/**
 * Decide what a remote profile needs for one local plugin.
 * @param {{name: string, version: string}} plugin
 * @param {{ installed?: Record<string, string|null>, bundles?: string[] }} remote
 * @returns {{ action: 'install'|'skip', version: string|null, active: boolean }}
 */
export function pluginAction(plugin, remote) {
  const version = remote.installed?.[plugin.name] ?? null
  const active = Array.isArray(remote.bundles) && remote.bundles.includes(plugin.name)
  return {
    action: version === plugin.version && active ? 'skip' : 'install',
    version,
    active,
  }
}
