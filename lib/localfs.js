/**
 * The desktop's own filesystem, exposed to the panel's transfer view.
 *
 * Mirrors lib/sftp.js so both panes speak the same protocol: list, read, write,
 * mkdir, rename, remove, upload stream, download stream. Paths are native
 * (Windows backslashes here), and the list response carries `parent` so the
 * browser never has to know which separator the host uses.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_WALK_ENTRIES = 20000

const call = async (fn) => fn()

function describe(target, stats) {
  return {
    name: path.basename(target),
    dir: stats.isDirectory(),
    link: stats.isSymbolicLink(),
    size: stats.isDirectory() ? 0 : Number(stats.size ?? 0),
    mtime: Number(stats.mtimeMs ?? 0),
    mode: Number(stats.mode ?? 0),
  }
}

/** List one directory; '' means the local home directory. */
export async function listDir(dir) {
  const target = dir === '' ? os.homedir() : path.resolve(dir)
  const entries = await fsp.readdir(target, { withFileTypes: true })
  const rows = []
  for (const entry of entries) {
    const full = path.join(target, entry.name)
    let stats = null
    try {
      stats = await fsp.lstat(full)
    } catch {
      continue
    }
    rows.push(describe(full, stats))
  }
  rows.sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return { path: target, parent: path.dirname(target), entries: rows }
}

/** Stat a path; null when it does not exist. */
export async function statPath(target) {
  try {
    return describe(target, await fsp.lstat(target))
  } catch {
    return null
  }
}

/** Read a text file, capped, refusing binary content. */
export async function readText(target, maxBytes = 512 * 1024) {
  const info = await statPath(target)
  if (info === null) throw new Error('文件不存在：' + target)
  if (info.dir) throw new Error('这是一个目录：' + target)
  const handle = await fsp.open(target, 'r')
  try {
    const limit = Math.min(info.size, maxBytes)
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    const slice = buffer.subarray(0, bytesRead)
    const binary = slice.includes(0)
    return {
      path: target,
      text: binary ? '' : slice.toString('utf8'),
      binary,
      size: info.size,
      truncated: info.size > bytesRead,
      mtime: info.mtime,
    }
  } finally {
    await handle.close()
  }
}

/** Write UTF-8 text, creating or truncating. */
export async function writeText(target, text) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, Buffer.from(String(text), 'utf8'))
  const info = await statPath(target)
  return { path: target, size: info === null ? 0 : info.size }
}

/** Create one directory. */
export async function makeDir(target) {
  await fsp.mkdir(target)
  return { path: target }
}

/** Rename / move. */
export async function renamePath(from, to) {
  await fsp.rename(from, to)
  return { from, to }
}

/** Remove a file, or a tree when `recursive` is true. */
export async function removePath(target, recursive = false) {
  const info = await statPath(target)
  if (info === null) throw new Error('路径不存在：' + target)
  if (!info.dir) {
    await fsp.unlink(target)
    return { path: target, removed: 'file' }
  }
  if (!recursive) {
    await fsp.rmdir(target)
    return { path: target, removed: 'dir' }
  }
  let seen = 0
  const walk = async current => {
    const rows = await fsp.readdir(current, { withFileTypes: true })
    for (const row of rows) {
      if (++seen > MAX_WALK_ENTRIES) throw new Error('目录条目超过 ' + MAX_WALK_ENTRIES + ' 个，已中止删除')
      const full = path.join(current, row.name)
      if (row.isDirectory()) await walk(full)
      else await fsp.unlink(full)
    }
    await fsp.rmdir(current)
  }
  await walk(target)
  return { path: target, removed: 'tree' }
}

/** Stream a request body into a local file. */
export async function uploadTo(target, source) {
  const info = await statPath(target)
  if (info !== null && info.dir) throw new Error('目标是目录：' + target)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await new Promise((resolve, reject) => {
    const sink = fs.createWriteStream(target)
    sink.on('error', reject)
    sink.on('close', resolve)
    source.on('error', reject)
    source.pipe(sink)
  })
  const after = await statPath(target)
  return { path: target, size: after === null ? 0 : after.size }
}

/** Open a local file for download. */
export async function downloadFrom(target) {
  const info = await statPath(target)
  if (info === null) throw new Error('文件不存在：' + target)
  if (info.dir) throw new Error('不能下载目录：' + target)
  return { stream: fs.createReadStream(target), size: info.size, mtime: info.mtime }
}

/** The file API the host routes expose for the local pane. */
export function localFs() {
  return {
    list: dir => listDir(dir),
    stat: target => statPath(target),
    read: (target, maxBytes) => readText(target, maxBytes),
    write: (target, text) => writeText(target, text),
    mkdir: target => makeDir(target),
    rename: (from, to) => renamePath(from, to),
    remove: (target, recursive) => removePath(target, recursive),
    upload: (target, source) => uploadTo(target, source),
    download: target => downloadFrom(target),
    close: () => call(() => {}),
  }
}
