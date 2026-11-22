/**
 * Tests for lib/openssh.js — everything is dependency-injected: no real ssh
 * connections, no real ~/.ssh access (homedir points at a temp directory).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { SshError, connectClient, listAliases, resolveSshConfig, verifyHostKey } from '../lib/openssh.js'

let home

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'openssh-test-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

/** Write a fixture under the temp ~/.ssh. */
function sshFile(name, content) {
  const file = path.join(home, '.ssh', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** Deps for config scanning: real fs, but scoped to the temp home. */
function scanDeps(overrides = {}) {
  return {
    execFile: async () => { throw new Error('execFile must not be called while scanning') },
    readFile: fsp.readFile,
    readdir: fsp.readdir,
    homedir: () => home,
    ...overrides,
  }
}

const KEY_A = Buffer.from('host-key-blob-A')
const KEY_B = Buffer.from('host-key-blob-B-different')

/** One known_hosts line as ssh-keygen -F would print it. */
function khLine(key, marker = '', host = 'example.com') {
  return (marker === '' ? '' : marker + ' ') + host + ' ssh-ed25519 ' + key.toString('base64')
}

/** execFile stub simulating ssh-keygen -F per file. */
function keygenStub(responses, calls = []) {
  return async (cmd, args) => {
    assert.equal(cmd, 'ssh-keygen')
    assert.equal(args[0], '-F')
    assert.equal(args[2], '-f')
    calls.push({ lookup: args[1], file: args[3] })
    const reply = responses.get(args[3]) ?? { code: 1, stdout: '' }
    if (reply.code === 0) return { stdout: reply.stdout ?? '', stderr: '' }
    throw Object.assign(new Error('ssh-keygen exit ' + reply.code), { code: reply.code, stdout: reply.stdout ?? '' })
  }
}

function verifyFixture(overrides = {}) {
  return {
    alias: 'alpha',
    hostname: 'example.com',
    user: 'deploy',
    port: 22,
    identityFiles: [],
    identityAgent: null,
    knownHostsFiles: [path.join(home, '.ssh', 'known_hosts'), path.join(home, '.ssh', 'known_hosts2')],
    hostKeyAlias: null,
    identitiesOnly: false,
    unsupported: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------- listAliases

describe('listAliases', () => {
  it('parses Host patterns, ignores options and comments, case-insensitive keywords', async () => {
    sshFile('config', [
      '# comment line',
      'Host alpha beta',
      '  User deploy',
      '  HostName example.com',
      '',
      'host gamma',
      'Host=delta',
      'HostName not-an-alias',
    ].join('\n'))
    assert.deepEqual(await listAliases(scanDeps()), ['alpha', 'beta', 'gamma', 'delta'])
  })

  it('skips wildcard patterns and negations', async () => {
    sshFile('config', 'Host * ?q !neg alpha foo* bar? !evil beta\nHost gamma\n')
    assert.deepEqual(await listAliases(scanDeps()), ['alpha', 'beta', 'gamma'])
  })

  it('skips Match blocks entirely (criteria are not aliases)', async () => {
    sshFile('config', [
      'Host alpha',
      'Match host matched-only',
      '  User somebody',
      '  ProxyJump jumper',
      'Host beta',
    ].join('\n'))
    assert.deepEqual(await listAliases(scanDeps()), ['alpha', 'beta'])
  })

  it('deduplicates and preserves file order', async () => {
    sshFile('config', 'Host alpha\nHost alpha beta\nHost beta\n')
    assert.deepEqual(await listAliases(scanDeps()), ['alpha', 'beta'])
  })

  it('follows Include: globs, relative paths, ~ paths, missing files', async () => {
    sshFile('config', [
      'Host alpha',
      'Include conf.d/*.conf',
      'Include extra',
      'Include ~/elsewhere/conf',
      'Include missing.conf',
      'Host beta',
    ].join('\n'))
    sshFile('conf.d/a.conf', 'Host incA\n')
    sshFile('conf.d/b.conf', 'Host incB\n')
    sshFile('conf.d/skip.txt', 'Host incTxt\n')
    sshFile('extra', 'Host incExtra\n')
    fs.mkdirSync(path.join(home, 'elsewhere'), { recursive: true })
    fs.writeFileSync(path.join(home, 'elsewhere', 'conf'), 'Host incHome\n')
    assert.deepEqual(await listAliases(scanDeps()), ['alpha', 'incA', 'incB', 'incExtra', 'incHome', 'beta'])
  })

  it('supports ? and [class] globs in Include', async () => {
    sshFile('config', 'Include conf.d/ho?-[ab].conf\n')
    sshFile('conf.d/hos-a.conf', 'Host ga\n')
    sshFile('conf.d/hos-b.conf', 'Host gb\n')
    sshFile('conf.d/hos-c.conf', 'Host gc\n')
    sshFile('conf.d/host-a.conf', 'Host tooLong\n')
    assert.deepEqual(await listAliases(scanDeps()), ['ga', 'gb'])
  })

  it('enforces the include depth limit (5)', async () => {
    sshFile('config', 'Host level0\nInclude inc1\n')
    for (let i = 1; i <= 8; i++) {
      sshFile('inc' + i, 'Host level' + i + (i < 8 ? '\nInclude inc' + (i + 1) : '') + '\n')
    }
    assert.deepEqual(await listAliases(scanDeps()), ['level0', 'level1', 'level2', 'level3', 'level4', 'level5'])
  })

  it('enforces the total file limit (50)', async () => {
    const includes = []
    for (let i = 0; i < 60; i++) {
      const name = 'f' + String(i).padStart(2, '0')
      includes.push('Include ' + name)
      sshFile(name, 'Host ' + name + '\n')
    }
    sshFile('config', 'Host root\n' + includes.join('\n') + '\n')
    const aliases = await listAliases(scanDeps())
    assert.equal(aliases.length, 50)
    assert.equal(aliases[0], 'root')
    assert.equal(aliases[49], 'f48')
    assert.ok(!aliases.includes('f49'))
  })

  it('returns [] when the config file is missing', async () => {
    assert.deepEqual(await listAliases(scanDeps()), [])
  })

  it('terminates on Include cycles', async () => {
    sshFile('config', 'Host a\nInclude cycle1\n')
    sshFile('cycle1', 'Host b\nInclude cycle2\n')
    sshFile('cycle2', 'Host c\nInclude cycle1\n')
    assert.deepEqual(await listAliases(scanDeps()), ['a', 'b', 'c'])
  })
})

// ------------------------------------------------------------ resolveSshConfig

/** execFile stub returning a fixed ssh -G stdout. */
function sshGStub(stdout, alias = 'alpha') {
  return async (cmd, args) => {
    assert.equal(cmd, 'ssh')
    assert.deepEqual(args, ['-G', alias])
    return { stdout, stderr: '' }
  }
}

const G_BASE = 'user deploy\nhostname example.com\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\n'

describe('resolveSshConfig', () => {
  it('parses the full output: multiple identityfile, multi-path known_hosts, ~ expansion', async () => {
    const stdout = [
      'user deploy',
      'hostname example.com',
      'port 2222',
      'identitiesonly yes',
      'identityfile ~/.ssh/id_ed25519',
      'identityfile /abs/id_rsa',
      'identityagent ~/.ssh/agent.sock',
      'userknownhostsfile ~/.ssh/known_hosts /etc/ssh/known_hosts2',
      'hostkeyalias bastion-alias',
    ].join('\n')
    const resolved = await resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(stdout) }))
    assert.deepEqual(resolved, {
      alias: 'alpha',
      hostname: 'example.com',
      user: 'deploy',
      port: 2222,
      identityFiles: [path.join(home, '.ssh', 'id_ed25519'), '/abs/id_rsa'],
      identityAgent: path.join(home, '.ssh', 'agent.sock'),
      knownHostsFiles: [path.join(home, '.ssh', 'known_hosts'), '/etc/ssh/known_hosts2'],
      hostKeyAlias: 'bastion-alias',
      identitiesOnly: true,
      unsupported: [],
    })
  })

  it('identityagent none / empty / absent all mean SSH_AUTH_SOCK fallback (null)', async () => {
    for (const line of ['identityagent none\n', 'identityagent\n', '']) {
      const resolved = await resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(G_BASE + line) }))
      assert.equal(resolved.identityAgent, null)
      assert.equal(resolved.hostKeyAlias, null)
      assert.equal(resolved.identitiesOnly, false)
    }
  })

  it('rejects invalid aliases before spawning ssh', async () => {
    const execFile = async () => { throw new Error('ssh must not be spawned for an invalid alias') }
    for (const alias of ['', '-oProxyCommand=touch /tmp/pwn', '-x', 'foo bar', 'foo;rm', 'a\tb', 'héllo', null, undefined, 42]) {
      await assert.rejects(() => resolveSshConfig(alias, scanDeps({ execFile })), error => {
        assert.ok(error instanceof Error)
        assert.equal(error.code, 'invalid-alias')
        assert.match(error.message, /[\u4e00-\u9fff]/)
        return true
      })
    }
  })

  it('throws ssh-unsupported naming each unsupported feature', async () => {
    const cases = [
      ['proxyjump jump.example.com', 'ProxyJump'],
      ['proxycommand nc %h %p', 'ProxyCommand'],
      ['certificatefile ~/.ssh/id_cert', 'CertificateFile'],
      ['knownhostscommand /usr/bin/echo', 'KnownHostsCommand'],
      ['revokedhostkeys /etc/ssh/revoked', 'RevokedHostKeys'],
      ['revokedhostkeyscommand /usr/bin/echo r', 'RevokedHostKeysCommand'],
    ]
    for (const [line, name] of cases) {
      await assert.rejects(() => resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(G_BASE + line + '\n') })), error => {
        assert.equal(error.code, 'ssh-unsupported')
        assert.ok(error.message.includes(name))
        assert.match(error.message, /[\u4e00-\u9fff]/)
        return true
      })
    }
  })

  it('names every unsupported feature when several are set', async () => {
    const stdout = G_BASE + 'proxyjump jj\ncertificatefile /tmp/cert\n'
    await assert.rejects(() => resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(stdout) })), error => {
      assert.equal(error.code, 'ssh-unsupported')
      assert.ok(error.message.includes('ProxyJump'))
      assert.ok(error.message.includes('CertificateFile'))
      return true
    })
  })

  it('accepts explicit none for proxyjump/proxycommand/knownhostscommand', async () => {
    const stdout = G_BASE + 'proxyjump none\nproxycommand none\nknownhostscommand none\n'
    const resolved = await resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(stdout) }))
    assert.equal(resolved.hostname, 'example.com')
  })

  it('fails closed when userknownhostsfile is none or absent', async () => {
    for (const stdout of ['user deploy\nhostname example.com\nport 22\nuserknownhostsfile none\n', 'user deploy\nhostname example.com\nport 22\n']) {
      await assert.rejects(() => resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(stdout) })), error => {
        assert.equal(error.code, 'ssh-unsupported')
        assert.match(error.message, /[\u4e00-\u9fff]/)
        return true
      })
    }
  })

  it('throws ssh-config-failed when ssh -G exits non-zero', async () => {
    const execFile = async () => { throw Object.assign(new Error('ssh exit 255'), { code: 255, stderr: 'bad configuration' }) }
    await assert.rejects(() => resolveSshConfig('alpha', scanDeps({ execFile })), error => {
      assert.equal(error.code, 'ssh-config-failed')
      assert.ok(error.message.includes('bad configuration'))
      return true
    })
  })

  it('throws ssh-config-failed when hostname is empty', async () => {
    const stdout = 'user deploy\nhostname\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\n'
    await assert.rejects(() => resolveSshConfig('alpha', scanDeps({ execFile: sshGStub(stdout) })), error => {
      assert.equal(error.code, 'ssh-config-failed')
      return true
    })
  })
})

// -------------------------------------------------------------- verifyHostKey

describe('verifyHostKey', () => {
  it('accepts a plain match and looks up the bare name on port 22', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const calls = []
    const execFile = keygenStub(new Map([[f1, { code: 0, stdout: '# Host example.com found: line 1\n' + khLine(KEY_A) + '\n' }]]), calls)
    const result = await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile }))
    assert.deepEqual(result, { ok: true })
    assert.equal(calls[0].lookup, 'example.com')
    assert.equal(calls[0].file, f1)
  })

  it('looks up [name]:port for non-22 ports', async () => {
    const calls = []
    const execFile = keygenStub(new Map(), calls)
    await verifyHostKey(verifyFixture({ port: 2222 }), KEY_A, scanDeps({ execFile }))
    assert.deepEqual(calls.map(call => call.lookup), ['[example.com]:2222', '[example.com]:2222'])
  })

  it('prefers hostKeyAlias over hostname in the lookup', async () => {
    const calls = []
    const execFile = keygenStub(new Map(), calls)
    await verifyHostKey(verifyFixture({ hostKeyAlias: 'bastion-name', port: 2222 }), KEY_A, scanDeps({ execFile }))
    assert.equal(calls[0].lookup, '[bastion-name]:2222')
    await verifyHostKey(verifyFixture({ hostKeyAlias: 'bastion-name' }), KEY_A, scanDeps({ execFile: keygenStub(new Map(), calls) }))
    assert.equal(calls[2].lookup, 'bastion-name')
  })

  it('accepts hashed-host lines (ssh-keygen already matched the host)', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const hashed = '|1|abcdef=|ghijkl= ssh-ed25519 ' + KEY_A.toString('base64')
    const execFile = keygenStub(new Map([[f1, { code: 0, stdout: hashed + '\n' }]]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: true })
  })

  it('returns unknown when no file has entries', async () => {
    const execFile = keygenStub(new Map())
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'unknown' })
  })

  it('returns changed when entries exist but none matches', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const execFile = keygenStub(new Map([[f1, { code: 0, stdout: khLine(KEY_B) + '\n' }]]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'changed' })
  })

  it('returns revoked when the key is revoked in the second file', async () => {
    const f2 = path.join(home, '.ssh', 'known_hosts2')
    const execFile = keygenStub(new Map([[f2, { code: 0, stdout: khLine(KEY_A, '@revoked') + '\n' }]]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'revoked' })
  })

  it('revocation in any file beats a normal match in another', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const f2 = path.join(home, '.ssh', 'known_hosts2')
    const execFile = keygenStub(new Map([
      [f1, { code: 0, stdout: khLine(KEY_A) + '\n' }],
      [f2, { code: 0, stdout: khLine(KEY_A, '@revoked') + '\n' }],
    ]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'revoked' })
  })

  it('returns unsupported for @cert-authority entries, even with a match elsewhere', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const f2 = path.join(home, '.ssh', 'known_hosts2')
    const execFile = keygenStub(new Map([
      [f1, { code: 0, stdout: khLine(KEY_A) + '\n' }],
      [f2, { code: 0, stdout: khLine(KEY_B, '@cert-authority') + '\n' }],
    ]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'unsupported' })
  })

  it('skips unreadable files (exit codes other than 0/1) and matches in the rest', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const f2 = path.join(home, '.ssh', 'known_hosts2')
    const execFile = keygenStub(new Map([
      [f1, { code: 2, stdout: '' }],
      [f2, { code: 0, stdout: khLine(KEY_A) + '\n' }],
    ]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: true })
  })

  it('returns unknown when every file is unreadable', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const f2 = path.join(home, '.ssh', 'known_hosts2')
    const execFile = keygenStub(new Map([[f1, { code: 2 }], [f2, { code: 255 }]]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'unknown' })
  })

  it('ignores comment-only output', async () => {
    const f1 = path.join(home, '.ssh', 'known_hosts')
    const execFile = keygenStub(new Map([[f1, { code: 0, stdout: '# nothing here\n' }]]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: false, reason: 'unknown' })
  })

  it('matches in the second file when the first has no entry', async () => {
    const f2 = path.join(home, '.ssh', 'known_hosts2')
    const execFile = keygenStub(new Map([[f2, { code: 0, stdout: khLine(KEY_A) + '\n' }]]))
    assert.deepEqual(await verifyHostKey(verifyFixture(), KEY_A, scanDeps({ execFile })), { ok: true })
  })
})

// -------------------------------------------------------------- connectClient

/** Fake ssh2 Client: connect() runs the test-provided script asynchronously. */
function makeFakeClient(script) {
  const instances = []
  class FakeClient extends EventEmitter {
    constructor() {
      super()
      this.ended = false
      this.config = null
      instances.push(this)
    }
    connect(config) {
      this.config = config
      setImmediate(() => script(this, config))
    }
    end() { this.ended = true }
  }
  return { FakeClient, instances }
}

/** Run hostVerifier first, then decide ready/auth-error. */
function verifyThen(client, config, decide) {
  config.hostVerifier(KEY_A, ok => {
    if (!ok) {
      client.emit('error', Object.assign(new Error('Host key verification failed'), { level: 'client-host-key' }))
      return
    }
    decide(client, config)
  })
}

const readyScript = (client, config) => verifyThen(client, config, c => c.emit('ready'))
const authFailScript = (client, config) => verifyThen(client, config, c => {
  c.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))
})
const acceptKey = target => (client, config) => verifyThen(client, config, (c, cfg) => {
  if (cfg.privateKey !== undefined && Buffer.from(cfg.privateKey).toString('utf8') === target) c.emit('ready')
  else c.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))
})

const keyReader = keys => async file => {
  if (keys.has(file)) return keys.get(file)
  throw Object.assign(new Error('ENOENT ' + file), { code: 'ENOENT' })
}

function connectDeps(FakeClient, resolved, overrides = {}) {
  return {
    Client: FakeClient,
    resolveSshConfig: async () => resolved,
    verifyHostKey: async () => ({ ok: true }),
    readFile: keyReader(new Map()),
    homedir: () => home,
    execFile: async () => { throw new Error('execFile must not be called with overrides') },
    ...overrides,
  }
}

/** Control SSH_AUTH_SOCK for one test body, restoring it afterwards. */
async function withSock(value, fn) {
  const prev = process.env.SSH_AUTH_SOCK
  if (value === null) delete process.env.SSH_AUTH_SOCK
  else process.env.SSH_AUTH_SOCK = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = prev
  }
}

function sshString(value) {
  const body = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  return Buffer.concat([length, body])
}

/** openssh-key-v1 PEM fixture with a chosen cipher name. */
function opensshKey(cipher) {
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshString(cipher),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 0]),
  ])
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n')
  return '-----BEGIN OPENSSH PRIVATE KEY-----\n' + b64 + '\n-----END OPENSSH PRIVATE KEY-----\n'
}

const ENCRYPTED_PEM = '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123\n\nYWJj\n-----END RSA PRIVATE KEY-----\n'

describe('connectClient', () => {
  it('connects through the env agent and builds the documented ssh2 config', async () => {
    await withSock('/tmp/agent.sock', async () => {
      const { FakeClient, instances } = makeFakeClient(readyScript)
      const resolved = verifyFixture()
      const client = await connectClient({ sshAlias: 'alpha' }, {}, connectDeps(FakeClient, resolved))
      assert.equal(client, instances[0])
      const cfg = client.config
      assert.equal(cfg.host, 'example.com')
      assert.equal(cfg.port, 22)
      assert.equal(cfg.username, 'deploy')
      assert.equal(cfg.readyTimeout, 20000)
      assert.equal(cfg.keepaliveInterval, 15000)
      assert.equal(cfg.keepaliveCountMax, 3)
      assert.equal(cfg.agent, '/tmp/agent.sock')
      assert.equal(typeof cfg.hostVerifier, 'function')
      assert.equal(cfg.privateKey, undefined)
    })
  })

  it('uses an explicit IdentityAgent even with identitiesOnly', async () => {
    await withSock('/tmp/env.sock', async () => {
      const { FakeClient, instances } = makeFakeClient(readyScript)
      const resolved = verifyFixture({ identityAgent: '/explicit/agent.sock', identitiesOnly: true })
      await connectClient({ sshAlias: 'alpha' }, {}, connectDeps(FakeClient, resolved))
      assert.equal(instances[0].config.agent, '/explicit/agent.sock')
    })
  })

  it('identitiesOnly suppresses the env agent and uses the first readable key', async () => {
    await withSock('/tmp/env.sock', async () => {
      const k1 = path.join(home, '.ssh', 'id_one')
      const { FakeClient, instances } = makeFakeClient(readyScript)
      const resolved = verifyFixture({ identitiesOnly: true, identityFiles: [k1] })
      const deps = connectDeps(FakeClient, resolved, { readFile: keyReader(new Map([[k1, 'KEY1']])) })
      await connectClient({ sshAlias: 'alpha' }, {}, deps)
      assert.equal(instances[0].config.agent, undefined)
      assert.equal(Buffer.from(instances[0].config.privateKey).toString('utf8'), 'KEY1')
    })
  })

  it('falls back to the next key after an auth failure, ending failed clients', async () => {
    await withSock('/tmp/agent.sock', async () => {
      const k1 = path.join(home, '.ssh', 'id_one')
      const k2 = path.join(home, '.ssh', 'id_two')
      const k3 = path.join(home, '.ssh', 'id_missing')
      const { FakeClient, instances } = makeFakeClient(acceptKey('KEY2'))
      const resolved = verifyFixture({ identityFiles: [k1, k2, k3] })
      const deps = connectDeps(FakeClient, resolved, { readFile: keyReader(new Map([[k1, 'KEY1'], [k2, 'KEY2']])) })
      const client = await connectClient({ sshAlias: 'alpha' }, {}, deps)
      assert.equal(instances.length, 2)
      assert.equal(client, instances[1])
      assert.equal(instances[0].ended, true)
      assert.equal(instances[1].ended, false)
      assert.equal(instances[0].config.agent, '/tmp/agent.sock')
      assert.equal(Buffer.from(instances[0].config.privateKey).toString('utf8'), 'KEY1')
      assert.equal(instances[1].config.agent, undefined)
      assert.equal(Buffer.from(instances[1].config.privateKey).toString('utf8'), 'KEY2')
    })
  })

  it('skips missing keys before the first attempt', async () => {
    await withSock(null, async () => {
      const k1 = path.join(home, '.ssh', 'id_missing')
      const k2 = path.join(home, '.ssh', 'id_two')
      const { FakeClient, instances } = makeFakeClient(acceptKey('KEY2'))
      const resolved = verifyFixture({ identityFiles: [k1, k2] })
      const deps = connectDeps(FakeClient, resolved, { readFile: keyReader(new Map([[k2, 'KEY2']])) })
      await connectClient({ sshAlias: 'alpha' }, {}, deps)
      assert.equal(instances.length, 1)
      assert.equal(Buffer.from(instances[0].config.privateKey).toString('utf8'), 'KEY2')
    })
  })

  it('throws ssh-auth-failed with ssh/ssh-add guidance after exhausting attempts', async () => {
    await withSock('/tmp/agent.sock', async () => {
      const k1 = path.join(home, '.ssh', 'id_one')
      const k2 = path.join(home, '.ssh', 'id_two')
      const { FakeClient, instances } = makeFakeClient(authFailScript)
      const resolved = verifyFixture({ identityFiles: [k1, k2] })
      const deps = connectDeps(FakeClient, resolved, { readFile: keyReader(new Map([[k1, 'KEY1'], [k2, 'KEY2']])) })
      await assert.rejects(() => connectClient({ sshAlias: 'alpha' }, {}, deps), error => {
        assert.ok(error instanceof SshError)
        assert.equal(error.code, 'ssh-auth-failed')
        assert.ok(error.message.includes('ssh-add'))
        assert.ok(error.message.includes('ssh alpha'))
        assert.ok(error.message.includes('2'))
        assert.match(error.message, /[\u4e00-\u9fff]/)
        return true
      })
      assert.equal(instances.length, 2) // agent+key1 combined, then key2 (<= keys+1)
      assert.ok(instances.every(client => client.ended))
    })
  })

  it('skips encrypted keys with a note surfaced on exhaustion', async () => {
    await withSock(null, async () => {
      const k1 = path.join(home, '.ssh', 'id_encrypted')
      const { FakeClient, instances } = makeFakeClient(authFailScript)
      const resolved = verifyFixture({ identityFiles: [k1] })
      const deps = connectDeps(FakeClient, resolved, { readFile: keyReader(new Map([[k1, ENCRYPTED_PEM]])) })
      await assert.rejects(() => connectClient({ sshAlias: 'alpha' }, {}, deps), error => {
        assert.equal(error.code, 'ssh-auth-failed')
        assert.ok(error.message.includes('加密'))
        assert.ok(error.message.includes(k1))
        return true
      })
      assert.equal(instances.length, 0)
    })
  })

  it('detects encrypted openssh-format keys and accepts cipher none', async () => {
    await withSock(null, async () => {
      const k1 = path.join(home, '.ssh', 'id_enc_openssh')
      const k2 = path.join(home, '.ssh', 'id_plain_openssh')
      const plain = opensshKey('none')
      const { FakeClient, instances } = makeFakeClient(acceptKey(plain))
      const resolved = verifyFixture({ identityFiles: [k1, k2] })
      const deps = connectDeps(FakeClient, resolved, { readFile: keyReader(new Map([[k1, opensshKey('aes256-ctr')], [k2, plain]])) })
      await connectClient({ sshAlias: 'alpha' }, {}, deps)
      assert.equal(instances.length, 1)
      assert.equal(Buffer.from(instances[0].config.privateKey).toString('utf8'), plain)
    })
  })

  it('wires hostVerifier to verifyHostKey with the resolved config and raw key', async () => {
    const calls = []
    const { FakeClient } = makeFakeClient(readyScript)
    const resolved = verifyFixture()
    const deps = connectDeps(FakeClient, resolved, {
      verifyHostKey: async (received, key) => { calls.push([received, key]); return { ok: true } },
    })
    await connectClient({ sshAlias: 'alpha' }, {}, deps)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], resolved)
    assert.equal(Buffer.compare(calls[0][1], KEY_A), 0)
  })

  it('aborts with the Chinese reason on host-key failure, without retrying keys', async () => {
    const cases = [
      ['unknown', '未知主机密钥，请先在终端运行 ssh alpha 核验'],
      ['changed', '主机密钥已变更，可能被劫持'],
      ['revoked', '主机密钥已被撤销'],
      ['unsupported', '不支持的主机证书配置'],
    ]
    for (const [reason, message] of cases) {
      const k1 = path.join(home, '.ssh', 'id_one')
      const k2 = path.join(home, '.ssh', 'id_two')
      const { FakeClient, instances } = makeFakeClient(readyScript)
      const resolved = verifyFixture({ identityFiles: [k1, k2] })
      const deps = connectDeps(FakeClient, resolved, {
        readFile: keyReader(new Map([[k1, 'KEY1'], [k2, 'KEY2']])),
        verifyHostKey: async () => ({ ok: false, reason }),
      })
      await assert.rejects(() => connectClient({ sshAlias: 'alpha' }, {}, deps), error => {
        assert.equal(error.code, 'ssh-host-key')
        assert.ok(error.message.includes(message))
        return true
      })
      assert.equal(instances.length, 1)
      assert.equal(instances[0].ended, true)
    }
  })

  it('never leaves unhandled error events, even after ready', async () => {
    const { FakeClient } = makeFakeClient(readyScript)
    const client = await connectClient({ sshAlias: 'alpha' }, {}, connectDeps(FakeClient, verifyFixture()))
    // Would crash the process as an unhandled 'error' without our listener.
    client.emit('error', new Error('post-ready socket hiccup'))
    assert.equal(client.ended, false)
  })

  it('propagates resolveSshConfig failures without creating a client', async () => {
    const { FakeClient, instances } = makeFakeClient(readyScript)
    const deps = connectDeps(FakeClient, verifyFixture(), {
      resolveSshConfig: async () => { throw new SshError('ssh-unsupported', '不支持') },
    })
    await assert.rejects(() => connectClient({ sshAlias: 'alpha' }, {}, deps), error => {
      assert.equal(error.code, 'ssh-unsupported')
      return true
    })
    assert.equal(instances.length, 0)
  })

  it('fails closed when there is no auth material at all', async () => {
    await withSock(null, async () => {
      const { FakeClient, instances } = makeFakeClient(readyScript)
      await assert.rejects(() => connectClient({ sshAlias: 'alpha' }, {}, connectDeps(FakeClient, verifyFixture())), error => {
        assert.equal(error.code, 'ssh-auth-failed')
        assert.match(error.message, /[\u4e00-\u9fff]/)
        return true
      })
      assert.equal(instances.length, 0)
    })
  })

  it('honours custom readyTimeout and keepaliveCountMax', async () => {
    const { FakeClient, instances } = makeFakeClient(readyScript)
    await connectClient({ sshAlias: 'alpha' }, { readyTimeout: 5000, keepaliveCountMax: 7 }, connectDeps(FakeClient, verifyFixture()))
    assert.equal(instances[0].config.readyTimeout, 5000)
    assert.equal(instances[0].config.keepaliveCountMax, 7)
  })

  it('integrates real resolveSshConfig + verifyHostKey through injected execFile', async () => {
    const keyFile = sshFile('id_test', 'PLAINKEYDATA')
    const gStdout = [
      'user deploy',
      'hostname example.com',
      'port 22',
      'identityfile ' + keyFile,
      'userknownhostsfile ' + path.join(home, '.ssh', 'known_hosts'),
    ].join('\n')
    const execFile = async (cmd, args) => {
      if (cmd === 'ssh') {
        assert.deepEqual(args, ['-G', 'alpha'])
        return { stdout: gStdout, stderr: '' }
      }
      assert.equal(cmd, 'ssh-keygen')
      assert.deepEqual(args, ['-F', 'example.com', '-f', path.join(home, '.ssh', 'known_hosts')])
      return { stdout: khLine(KEY_A) + '\n', stderr: '' }
    }
    const { FakeClient, instances } = makeFakeClient(readyScript)
    const client = await connectClient({ sshAlias: 'alpha' }, {}, {
      Client: FakeClient,
      execFile,
      readFile: fsp.readFile,
      readdir: fsp.readdir,
      homedir: () => home,
    })
    assert.equal(client, instances[0])
    assert.equal(Buffer.from(client.config.privateKey).toString('utf8'), 'PLAINKEYDATA')
    assert.equal(client.config.username, 'deploy')
  })
})
