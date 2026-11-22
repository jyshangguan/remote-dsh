/**
 * Tests for lib/hosts.js — the settings store lives in a temp DSH_HOME and
 * alias enumeration is injected, so no real ~/.ssh or ~/.dsh is touched.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_SETTINGS, listHosts, resolveHost, saveSettings, setHidden } from '../lib/hosts.js'

let home
let dshHome
let prevDshHome

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-test-'))
  dshHome = path.join(home, '.dsh')
  prevDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  fs.rmSync(home, { recursive: true, force: true })
})

const storeFile = () => path.join(dshHome, 'remote-dsh-openssh.json')

/** Deps with an injected alias list and real fs scoped to the temp home. */
function makeDeps(aliases, overrides = {}) {
  return {
    listAliases: async () => aliases,
    readFile: fsp.readFile,
    writeFile: fsp.writeFile,
    mkdir: fsp.mkdir,
    rename: fsp.rename,
    homedir: () => home,
    ...overrides,
  }
}

function writeStoreRaw(content) {
  fs.mkdirSync(dshHome, { recursive: true })
  fs.writeFileSync(storeFile(), content)
}

describe('DEFAULT_SETTINGS', () => {
  it('matches the documented defaults', () => {
    assert.deepEqual(DEFAULT_SETTINGS, { webPort: 18080, profile: 'web', webLog: null, nodeBin: '', installProxy: '' })
  })
})

describe('listHosts', () => {
  it('merges saved settings over defaults and preserves alias order', async () => {
    writeStoreRaw(JSON.stringify({ version: 2, hosts: { alpha: { webPort: 19090, profile: 'dev' } } }))
    const hosts = await listHosts(makeDeps(['alpha', 'beta']))
    assert.deepEqual(hosts, [
      { id: 'openssh:alpha', alias: 'alpha', label: 'alpha', source: 'openssh', webPort: 19090, profile: 'dev', webLog: null, nodeBin: '', installProxy: '', hidden: false },
      { id: 'openssh:beta', alias: 'beta', label: 'beta', source: 'openssh', webPort: 18080, profile: 'web', webLog: null, nodeBin: '', installProxy: '', hidden: false },
    ])
  })

  it('returns all defaults when the store is missing', async () => {
    const hosts = await listHosts(makeDeps(['gamma']))
    assert.deepEqual(hosts, [
      { id: 'openssh:gamma', alias: 'gamma', label: 'gamma', source: 'openssh', ...DEFAULT_SETTINGS, hidden: false },
    ])
  })

  it('ignores saved aliases that disappeared from the config', async () => {
    writeStoreRaw(JSON.stringify({ version: 2, hosts: { ghost: { webPort: 19999 } } }))
    const hosts = await listHosts(makeDeps(['alpha']))
    assert.deepEqual(hosts.map(host => host.alias), ['alpha'])
    assert.equal(hosts[0].webPort, 18080)
  })

  it('tolerates corrupt JSON without overwriting it', async () => {
    writeStoreRaw('{this is not json')
    const hosts = await listHosts(makeDeps(['alpha']))
    assert.equal(hosts[0].webPort, 18080)
    assert.equal(fs.readFileSync(storeFile(), 'utf8'), '{this is not json')
    const resolved = await resolveHost('openssh:alpha', makeDeps(['alpha']))
    assert.equal(resolved.webPort, 18080)
    assert.equal(fs.readFileSync(storeFile(), 'utf8'), '{this is not json')
  })

  it('never reads outside its own store (no dsh-ssh.json, no ~/.ssh, no credentials)', async () => {
    const seen = []
    const deps = makeDeps(['alpha'], {
      readFile: async (file, ...rest) => { seen.push(String(file)); return fsp.readFile(file, ...rest) },
    })
    await listHosts(deps)
    await resolveHost('openssh:alpha', deps)
    await saveSettings('alpha', { webPort: 19000 }, deps)
    assert.ok(seen.length > 0)
    for (const file of seen) assert.equal(file, storeFile())
  })
})

describe('resolveHost', () => {
  it('resolves openssh ids with saved settings', async () => {
    await saveSettings('alpha', { webPort: 19001, profile: 'lab' }, makeDeps(['alpha']))
    const entry = await resolveHost('openssh:alpha', makeDeps(['alpha']))
    assert.deepEqual(entry, {
      id: 'openssh:alpha', alias: 'alpha', label: 'alpha', source: 'openssh',
      webPort: 19001, profile: 'lab', webLog: null, nodeBin: '', installProxy: '', hidden: false,
    })
  })

  it('enforces the openssh: id prefix', async () => {
    const deps = makeDeps(['alpha'])
    for (const id of ['ssh:alpha', 'local:alpha', 'alpha', 'openssh:', '', null, undefined, 42]) {
      assert.equal(await resolveHost(id, deps), null)
    }
  })

  it('fails closed when the alias disappeared from the config', async () => {
    await saveSettings('alpha', { webPort: 19002 }, makeDeps(['alpha']))
    assert.equal(await resolveHost('openssh:alpha', makeDeps(['beta'])), null)
    assert.equal(await resolveHost('openssh:ghost', makeDeps(['alpha'])), null)
  })
})

describe('saveSettings', () => {
  it('validates webPort range and type', async () => {
    for (const webPort of [0, -1, 65536, 1.5, Number.NaN, '18080', null]) {
      await assert.rejects(() => saveSettings('alpha', { webPort }, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        assert.match(error.message, /[\u4e00-\u9fff]/)
        return true
      })
    }
    assert.equal(fs.existsSync(storeFile()), false) // invalid saves never write
  })

  it('accepts the webPort boundaries 1 and 65535', async () => {
    assert.equal((await saveSettings('alpha', { webPort: 1 }, makeDeps(['alpha']))).webPort, 1)
    assert.equal((await saveSettings('alpha', { webPort: 65535 }, makeDeps(['alpha']))).webPort, 65535)
  })

  it('validates profile shape', async () => {
    for (const profile of ['', '-web', '.web', 'has space', '../x', 'wéb', 42, null]) {
      await assert.rejects(() => saveSettings('alpha', { profile }, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        return true
      })
    }
    const settings = await saveSettings('alpha', { profile: 'web-2.x_y' }, makeDeps(['alpha']))
    assert.equal(settings.profile, 'web-2.x_y')
  })

  it('validates webLog: null, absolute, or ~/ paths only', async () => {
    for (const webLog of ['relative.log', '~x', 'http://x/y', 42]) {
      await assert.rejects(() => saveSettings('alpha', { webLog }, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        return true
      })
    }
    const deps = makeDeps(['alpha'])
    assert.equal((await saveSettings('alpha', { webLog: null }, deps)).webLog, null)
    // An empty UI input means "automatic" and normalizes to null.
    assert.equal((await saveSettings('alpha', { webLog: '' }, deps)).webLog, null)
    assert.equal((await saveSettings('alpha', { webLog: '/var/log/dsh.log' }, deps)).webLog, '/var/log/dsh.log')
    // ~/ is stored as-is; expansion happens remotely.
    assert.equal((await saveSettings('alpha', { webLog: '~/logs/dsh-web.log' }, deps)).webLog, '~/logs/dsh-web.log')
  })

  it('validates nodeBin: empty, absolute, or ~/ dir only', async () => {
    for (const nodeBin of ['relative/bin', '~x', 'http://x/y', 42]) {
      await assert.rejects(() => saveSettings('alpha', { nodeBin }, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        return true
      })
    }
    const deps = makeDeps(['alpha'])
    assert.equal((await saveSettings('alpha', { nodeBin: '' }, deps)).nodeBin, '')
    assert.equal((await saveSettings('alpha', { nodeBin: null }, deps)).nodeBin, '')
    assert.equal((await saveSettings('alpha', { nodeBin: '~/.nvm/versions/node/v24.13.0/bin' }, deps)).nodeBin, '~/.nvm/versions/node/v24.13.0/bin')
  })

  it('validates installProxy as a trimmed http(s) URL or empty string', async () => {
    for (const installProxy of ['ftp://x/y', 'not a url', 'http://', 'socks5://127.0.0.1:1080', 42]) {
      await assert.rejects(() => saveSettings('alpha', { installProxy }, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        return true
      })
    }
    const deps = makeDeps(['alpha'])
    assert.equal((await saveSettings('alpha', { installProxy: '  http://127.0.0.1:7890  ' }, deps)).installProxy, 'http://127.0.0.1:7890')
    assert.equal((await saveSettings('alpha', { installProxy: 'https://proxy.example.com:8443' }, deps)).installProxy, 'https://proxy.example.com:8443')
    assert.equal((await saveSettings('alpha', { installProxy: '   ' }, deps)).installProxy, '')
  })

  it('merges partial patches into existing settings', async () => {
    const deps = makeDeps(['alpha'])
    await saveSettings('alpha', { webPort: 19010 }, deps)
    const settings = await saveSettings('alpha', { profile: 'dev' }, deps)
    assert.deepEqual(settings, { webPort: 19010, profile: 'dev', webLog: null, nodeBin: '', installProxy: '' })
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.deepEqual(stored.hosts.alpha, settings)
  })

  it('writes atomically: mkdir 0700, tmp 0600, rename, no tmp left behind', async () => {
    const calls = []
    const deps = makeDeps(['alpha'], {
      mkdir: async (dir, options) => { calls.push(['mkdir', dir, options]); return fsp.mkdir(dir, options) },
      writeFile: async (file, data, options) => { calls.push(['write', file, options]); return fsp.writeFile(file, data, options) },
      rename: async (from, to) => { calls.push(['rename', from, to]); return fsp.rename(from, to) },
    })
    await saveSettings('alpha', { webPort: 19020 }, deps)
    assert.deepEqual(calls.map(call => call[0]), ['mkdir', 'write', 'rename'])
    assert.equal(calls[0][1], dshHome)
    assert.equal(calls[0][2].mode, 0o700)
    assert.equal(calls[1][1], storeFile() + '.tmp')
    assert.equal(calls[1][2].mode, 0o600)
    assert.deepEqual(calls[2].slice(1), [storeFile() + '.tmp', storeFile()])
    assert.equal(fs.existsSync(storeFile() + '.tmp'), false)
    assert.equal(fs.statSync(storeFile()).mode & 0o777, 0o600)
    assert.equal(fs.statSync(dshHome).mode & 0o777, 0o700)
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.equal(stored.version, 2)
    assert.deepEqual(stored.hosts.alpha, { webPort: 19020, profile: 'web', webLog: null, nodeBin: '', installProxy: '' })
  })

  it('rewrites a corrupt store only on the next successful save', async () => {
    writeStoreRaw('corrupt{{{')
    const settings = await saveSettings('alpha', { webPort: 19030 }, makeDeps(['alpha']))
    assert.equal(settings.webPort, 19030)
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.equal(stored.version, 2)
    assert.equal(stored.hosts.alpha.webPort, 19030)
  })

  it('rejects an empty alias', async () => {
    await assert.rejects(() => saveSettings('', { webPort: 19040 }, makeDeps([])), error => {
      assert.equal(error.code, 'invalid-settings')
      return true
    })
  })

  it('preserves an existing hidden list when saving settings', async () => {
    const deps = makeDeps(['alpha', 'beta'])
    await setHidden('beta', true, deps)
    await saveSettings('alpha', { webPort: 19050 }, deps)
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.deepEqual(stored.hidden, ['beta'])
    const hosts = await listHosts(deps)
    assert.equal(hosts.find(host => host.alias === 'beta').hidden, true)
    assert.equal(hosts.find(host => host.alias === 'alpha').hidden, false)
  })
})

describe('setHidden', () => {
  it('adds, dedupes and removes aliases, persisting across listHosts/resolveHost', async () => {
    const deps = makeDeps(['alpha', 'beta'])
    assert.deepEqual(await setHidden('alpha', true, deps), ['alpha'])
    // Adding the same alias again is a no-op, not a duplicate.
    assert.deepEqual(await setHidden('alpha', true, deps), ['alpha'])
    assert.deepEqual(await setHidden('beta', true, deps), ['alpha', 'beta'])
    let hosts = await listHosts(deps)
    assert.deepEqual(hosts.map(host => host.hidden), [true, true])
    assert.equal((await resolveHost('openssh:alpha', deps)).hidden, true)
    // Removing one alias keeps the other hidden.
    assert.deepEqual(await setHidden('alpha', false, deps), ['beta'])
    hosts = await listHosts(deps)
    assert.deepEqual(hosts.map(host => host.hidden), [false, true])
    assert.equal((await resolveHost('openssh:alpha', deps)).hidden, false)
    // Removing an absent alias is a no-op.
    assert.deepEqual(await setHidden('alpha', false, deps), ['beta'])
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.equal(stored.version, 2)
    assert.deepEqual(stored.hidden, ['beta'])
  })

  it('treats a corrupt store as an empty hidden list', async () => {
    writeStoreRaw('{corrupt')
    const deps = makeDeps(['alpha'])
    const hosts = await listHosts(deps)
    assert.equal(hosts[0].hidden, false)
    assert.deepEqual(await setHidden('alpha', true, deps), ['alpha'])
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.deepEqual(stored.hidden, ['alpha'])
  })

  it('sanitizes a stored hidden list to unique strings', async () => {
    writeStoreRaw(JSON.stringify({ version: 2, hosts: {}, hidden: ['alpha', 'alpha', 42, null, 'beta'] }))
    const hosts = await listHosts(makeDeps(['alpha', 'beta', 'gamma']))
    assert.deepEqual(hosts.map(host => host.hidden), [true, true, false])
    assert.deepEqual(await setHidden('gamma', true, makeDeps(['alpha', 'beta', 'gamma'])), ['alpha', 'beta', 'gamma'])
  })

  it('keeps a hidden alias out of listHosts once it leaves the ssh config', async () => {
    await setHidden('ghost', true, makeDeps(['ghost']))
    const hosts = await listHosts(makeDeps(['alpha']))
    assert.deepEqual(hosts.map(host => host.alias), ['alpha'])
    // The stored list keeps the alias (panel state), but nothing lists it.
    const stored = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    assert.deepEqual(stored.hidden, ['ghost'])
    assert.equal(await resolveHost('openssh:ghost', makeDeps(['alpha'])), null)
  })

  it('writes atomically: mkdir 0700, tmp 0600, rename, no tmp left behind', async () => {
    const calls = []
    const deps = makeDeps(['alpha'], {
      mkdir: async (dir, options) => { calls.push(['mkdir', dir, options]); return fsp.mkdir(dir, options) },
      writeFile: async (file, data, options) => { calls.push(['write', file, options]); return fsp.writeFile(file, data, options) },
      rename: async (from, to) => { calls.push(['rename', from, to]); return fsp.rename(from, to) },
    })
    await setHidden('alpha', true, deps)
    assert.deepEqual(calls.map(call => call[0]), ['mkdir', 'write', 'rename'])
    assert.equal(calls[0][1], dshHome)
    assert.equal(calls[0][2].mode, 0o700)
    assert.equal(calls[1][1], storeFile() + '.tmp')
    assert.equal(calls[1][2].mode, 0o600)
    assert.deepEqual(calls[2].slice(1), [storeFile() + '.tmp', storeFile()])
    assert.equal(fs.existsSync(storeFile() + '.tmp'), false)
    assert.equal(fs.statSync(storeFile()).mode & 0o777, 0o600)
    assert.equal(fs.statSync(dshHome).mode & 0o777, 0o700)
  })

  it('rejects invalid aliases with invalid-settings and never writes', async () => {
    for (const alias of ['', '-alpha', 'has space', '../x', 'al/phA', 'wéb', 42, null, undefined]) {
      await assert.rejects(() => setHidden(alias, true, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        assert.equal(error.message, '别名不合法：只允许字母、数字和 ._@-，且不能以 - 开头')
        return true
      })
    }
    assert.equal(fs.existsSync(storeFile()), false)
  })

  it('rejects a non-boolean hidden flag with invalid-settings', async () => {
    for (const hidden of ['true', 1, 0, null, undefined, {}]) {
      await assert.rejects(() => setHidden('alpha', hidden, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        assert.equal(error.message, 'hidden 必须是布尔值')
        return true
      })
    }
    assert.equal(fs.existsSync(storeFile()), false)
  })
})
