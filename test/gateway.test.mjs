/**
 * Tests for lib/gateway.js port binding — the stable per-host ORIGIN that
 * lets the remote web app's localStorage (session selection) survive
 * reconnects. Real loopback sockets: a mini "remote" answering the token
 * exchange, plus blockers proving the EADDRINUSE scan.
 */
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGateway } from '../lib/gateway.js'

/** Mini remote: 303 + cookie for the token exchange, a page for everything else. */
async function miniRemote() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: '/', 'set-cookie': ['dsh_auth=gwtest; Path=/; HttpOnly'] })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>remote-page</body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/** One free loopback port (bound then released). */
async function freePort() {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

const make = (upstream, preferredPort, log) => createGateway({
  connectHost: '127.0.0.1',
  connectPort: upstream.port,
  authority: '127.0.0.1:' + upstream.port,
  tokenProvider: async () => 'gwtest-token',
  ...(preferredPort === undefined ? {} : { preferredPort }),
  log: log ?? (() => {}),
})

test('gateway binds the preferred port when free and proxies through it', async () => {
  const upstream = await miniRemote()
  const preferred = await freePort()
  const gateway = await make(upstream, preferred)
  assert.equal(gateway.port, preferred, 'did not bind the preferred port')

  const response = await fetch('http://127.0.0.1:' + gateway.port + '/')
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.ok(body.includes('remote-page'), 'page not proxied')
  assert.ok(body.includes('dsh-remote-esc'), 'esc bridge not injected')

  await gateway.close()
  upstream.server.close()
})

test('gateway scans forward when the preferred port is taken', async () => {
  const upstream = await miniRemote()
  const preferred = await freePort()
  const blocker = net.createServer()
  await new Promise(resolve => blocker.listen(preferred, '127.0.0.1', resolve))
  const gateway = await make(upstream, preferred)
  assert.ok(gateway.port > preferred && gateway.port < preferred + 10, 'did not scan forward: ' + gateway.port)

  await gateway.close()
  await new Promise(resolve => blocker.close(resolve))
  upstream.server.close()
})

test('gateway without a preferred port takes a random one', async () => {
  const upstream = await miniRemote()
  const gateway = await make(upstream)
  assert.ok(Number.isInteger(gateway.port) && gateway.port > 0)
  await gateway.close()
  upstream.server.close()
})

test('rebinding the same preferred port after close works (reconnect keeps the origin)', async () => {
  const upstream = await miniRemote()
  const preferred = await freePort()
  const first = await make(upstream, preferred)
  assert.equal(first.port, preferred)
  const response = await fetch('http://127.0.0.1:' + first.port + '/')
  await response.text()
  await first.close()

  const second = await make(upstream, preferred)
  assert.equal(second.port, preferred, 'same preferred port not rebound after close')
  await second.close()
  upstream.server.close()
})
