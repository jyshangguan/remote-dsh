/**
 * SFTP operations over one live SSH connection.
 *
 * Everything here rides the connection the panel already holds, so the remote
 * needs nothing extra: `sshd`'s sftp subsystem, which every Linux install has.
 * The channel is opened lazily and cached per SSH client, because a connect
 * that never touches files must not pay for it.
 *
 * Paths are POSIX paths on the remote; callers pass absolute paths and an empty
 * string means "the remote home directory".
 */
import path from 'node:path'

/** client -> Promise<sftp>, so concurrent calls share one channel. */
const channels = new WeakMap()

const DIRECTORY = 0o040000
const SYMLINK = 0o120000
const TYPE_MASK = 0o170000

/** Directory entries read in one remove() walk before giving up. */
const MAX_WALK_ENTRIES = 20000

/**
 * Open (or reuse) the SFTP channel for a connected SSH client.
 * @param {import('ssh2').Client} client
 * @returns {Promise<any>} the ssh2 SFTP session
 */
export function sftpFor(client) {
  const cached = channels.get(client)
  if (cached !== undefined) return cached
  const pending = new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error !== undefined && error !== null) {
        channels.delete(client)
        reject(new Error('无法打开 SFTP 通道：' + error.message + '（远端 sshd 可能没有启用 sftp 子系统）'))
        return
      }
      sftp.once('close', () => channels.delete(client))
      resolve(sftp)
    })
  })
  pending.catch(() => channels.delete(client))
  channels.set(client, pending)
  return pending
}

/** Drop the cached channel for a client (used on disconnect). */
export function closeSftp(client) {
  const cached = channels.get(client)
  channels.delete(client)
  if (cached === undefined) return
  cached.then(sftp => { try { sftp.end() } catch { /* already gone */ } }).catch(() => {})
}

const fileType = attrs => (Number(attrs?.mode ?? 0) & TYPE_MASK)
const isDirectory = attrs => fileType(attrs) === DIRECTORY
const isSymlink = attrs => fileType(attrs) === SYMLINK

/** Seconds since epoch -> milliseconds, matching the browser's Date. */
const millis = seconds => Number(seconds ?? 0) * 1000

function describe(entry) {
  const attrs = entry.attrs ?? {}
  return {
    name: entry.filename,
    dir: isDirectory(attrs),
    link: isSymlink(attrs),
    size: Number(attrs.size ?? 0),
    mtime: millis(attrs.mtime),
    mode: Number(attrs.mode ?? 0),
  }
}

const call = (target, method, ...args) => new Promise((resolve, reject) => {
  target[method](...args, (error, value) => {
    if (error !== undefined && error !== null) reject(error)
    else resolve(value)
  })
})

/** Remote home directory (the realpath of `.`), cached per call site. */
export async function homeDir(client) {
  const sftp = await sftpFor(client)
  try {
    return await call(sftp, 'realpath', '.')
  } catch {
    return '/'
  }
}

/**
 * List one directory.
 * @param {import('ssh2').Client} client
 * @param {string} dir absolute path, or '' for the home directory
 */
export async function listDir(client, dir) {
  const sftp = await sftpFor(client)
  const target = dir === '' ? await homeDir(client) : path.posix.resolve(dir)
  const entries = await call(sftp, 'readdir', target)
  return {
    path: target,
    parent: path.posix.dirname(target),
    entries: entries
      .filter(entry => entry.filename !== '.' && entry.filename !== '..')
      .map(describe)
      .sort((left, right) => {
        if (left.dir !== right.dir) return left.dir ? -1 : 1
        return left.name.localeCompare(right.name)
      }),
  }
}

/** Stat a path; returns null when it does not exist. */
export async function statPath(client, target) {
  const sftp = await sftpFor(client)
  try {
    return describe({ filename: path.posix.basename(target), attrs: await call(sftp, 'lstat', target) })
  } catch (error) {
    if (error?.code === 2) return null
    throw error
  }
}

/**
 * Read a text file, capped at `maxBytes`. Binary content is reported as such
 * instead of being mangled into a string.
 */
export async function readText(client, target, maxBytes = 512 * 1024) {
  const sftp = await sftpFor(client)
  const info = await statPath(client, target)
  if (info === null) throw new Error('文件不存在：' + target)
  if (info.dir) throw new Error('这是一个目录：' + target)
  const limit = Math.min(info.size, maxBytes)
  const chunks = []
  await new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(target, { start: 0, end: Math.max(0, limit - 1) })
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  const buffer = Buffer.concat(chunks)
  const binary = buffer.includes(0)
  return {
    path: target,
    text: binary ? '' : buffer.toString('utf8'),
    binary,
    size: info.size,
    truncated: info.size > buffer.length,
    mtime: info.mtime,
  }
}

/** Write UTF-8 text to a remote file, creating or truncating it. */
export async function writeText(client, target, text) {
  const sftp = await sftpFor(client)
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(target, { mode: 0o644 })
    stream.on('error', reject)
    stream.on('close', resolve)
    stream.end(Buffer.from(String(text), 'utf8'))
  })
  const info = await statPath(client, target)
  return { path: target, size: info === null ? 0 : info.size }
}

/** Create one directory (the parent must exist). */
export async function makeDir(client, target) {
  const sftp = await sftpFor(client)
  await call(sftp, 'mkdir', target, { mode: 0o755 })
  return { path: target }
}

/** Rename / move a path. */
export async function renamePath(client, from, to) {
  const sftp = await sftpFor(client)
  await call(sftp, 'rename', from, to)
  return { from, to }
}

/** Remove a file, or a directory tree when `recursive` is true. */
export async function removePath(client, target, recursive = false) {
  const sftp = await sftpFor(client)
  const info = await statPath(client, target)
  if (info === null) throw new Error('路径不存在：' + target)
  if (!info.dir) {
    await call(sftp, 'unlink', target)
    return { path: target, removed: 'file' }
  }
  if (!recursive) {
    await call(sftp, 'rmdir', target)
    return { path: target, removed: 'dir' }
  }
  const stack = [target]
  let seen = 0
  while (stack.length > 0) {
    const current = stack.pop()
    const rows = await call(sftp, 'readdir', current)
    for (const row of rows) {
      if (row.filename === '.' || row.filename === '..') continue
      if (++seen > MAX_WALK_ENTRIES) throw new Error('目录条目超过 ' + MAX_WALK_ENTRIES + ' 个，已中止删除')
      const child = path.posix.join(current, row.filename)
      if (isDirectory(row.attrs)) stack.push(child)
      else await call(sftp, 'unlink', child)
    }
    await call(sftp, 'rmdir', current)
  }
  return { path: target, removed: 'tree' }
}

/**
 * Stream a request body into a remote file.
 * @param {import('ssh2').Client} client
 * @param {string} target absolute path (directories must already exist)
 * @param {import('node:stream').Readable} source request body
 */
export async function uploadTo(client, target, source) {
  const sftp = await sftpFor(client)
  const info = await statPath(client, target)
  if (info !== null && info.dir) throw new Error('目标是目录：' + target)
  await new Promise((resolve, reject) => {
    const sink = sftp.createWriteStream(target, { mode: 0o644 })
    sink.on('error', reject)
    sink.on('close', resolve)
    source.on('error', reject)
    source.pipe(sink)
  })
  const after = await statPath(client, target)
  return { path: target, size: after === null ? 0 : after.size }
}

/** Open a remote file for download. */
export async function downloadFrom(client, target) {
  const sftp = await sftpFor(client)
  const info = await statPath(client, target)
  if (info === null) throw new Error('文件不存在：' + target)
  if (info.dir) throw new Error('不能下载目录：' + target)
  return { stream: sftp.createReadStream(target), size: info.size, mtime: info.mtime }
}

/**
 * The file API one live session exposes to the host routes.
 * @param {import('ssh2').Client} client
 */
export function remoteFs(client) {
  return {
    home: () => homeDir(client),
    list: dir => listDir(client, dir),
    stat: target => statPath(client, target),
    read: (target, maxBytes) => readText(client, target, maxBytes),
    write: (target, text) => writeText(client, target, text),
    mkdir: target => makeDir(client, target),
    rename: (from, to) => renamePath(client, from, to),
    remove: (target, recursive) => removePath(client, target, recursive),
    upload: (target, source) => uploadTo(client, target, source),
    download: target => downloadFrom(client, target),
    close: () => closeSftp(client),
  }
}

