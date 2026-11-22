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
import { DEFAULT_SETTINGS, listHosts, resolveHost, saveSettings } from '../lib/hosts.js'

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
    assert.deepEqual(DEFAULT_SETTINGS, { webPort: 18080, profile: 'web', webLog: null, installProxy: '' })
  })
})

describe('listHosts', () => {
  it('merges saved settings over defaults and preserves alias order', async () => {
    writeStoreRaw(JSON.stringify({ version: 2, hosts: { alpha: { webPort: 19090, profile: 'dev' } } }))
    const hosts = await listHosts(makeDeps(['alpha', 'beta']))
    assert.deepEqual(hosts, [
      { id: 'openssh:alpha', alias: 'alpha', label: 'alpha', source: 'openssh', webPort: 19090, profile: 'dev', webLog: null, installProxy: '' },
      { id: 'openssh:beta', alias: 'beta', label: 'beta', source: 'openssh', webPort: 18080, profile: 'web', webLog: null, installProxy: '' },
    ])
  })

  it('returns all defaults when the store is missing', async () => {
    const hosts = await listHosts(makeDeps(['gamma']))
    assert.deepEqual(hosts, [
      { id: 'openssh:gamma', alias: 'gamma', label: 'gamma', source: 'openssh', ...DEFAULT_SETTINGS },
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
      webPort: 19001, profile: 'lab', webLog: null, installProxy: '',
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
    for (const webLog of ['', 'relative.log', '~x', 'http://x/y', 42]) {
      await assert.rejects(() => saveSettings('alpha', { webLog }, makeDeps(['alpha'])), error => {
        assert.equal(error.code, 'invalid-settings')
        return true
      })
    }
    const deps = makeDeps(['alpha'])
    assert.equal((await saveSettings('alpha', { webLog: null }, deps)).webLog, null)
    assert.equal((await saveSettings('alpha', { webLog: '/var/log/dsh.log' }, deps)).webLog, '/var/log/dsh.log')
    // ~/ is stored as-is; expansion happens remotely.
    assert.equal((await saveSettings('alpha', { webLog: '~/logs/dsh-web.log' }, deps)).webLog, '~/logs/dsh-web.log')
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
    assert.deepEqual(settings, { webPort: 19010, profile: 'dev', webLog: null, installProxy: '' })
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
    assert.deepEqual(stored.hosts.alpha, { webPort: 19020, profile: 'web', webLog: null, installProxy: '' })
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
})
