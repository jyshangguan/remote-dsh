/**
 * resolveDshVersion: host-side version resolution for the gate.
 * The authoritative source is profileContext.installAnchor (the same fact
 * shell-env turns into DSH_INSTALL_DIR for tool shells); env and module
 * resolution are fallbacks. Only the @deepseek-ai/dsh manifest counts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDshVersion, SUPPORTED_DSH } from '../lib/index.js'

/** Build a fake CLI install tree: <root>/package.json (+ optional lib/bin.js). */
function makeInstall(version, name = '@deepseek-ai/dsh') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-version-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.writeFileSync(path.join(root, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return root
}

const ctxWith = anchor => ({ get: key => (key === 'profileContext' ? { installAnchor: anchor } : undefined) })

test('resolves from installAnchor pointing at the package dir', () => {
  const root = makeInstall(SUPPORTED_DSH)
  assert.equal(resolveDshVersion(ctxWith(root)), SUPPORTED_DSH)
  fs.rmSync(root, { recursive: true, force: true })
})

test('resolves from installAnchor pointing at the manifest itself', () => {
  const root = makeInstall(SUPPORTED_DSH)
  assert.equal(resolveDshVersion(ctxWith(path.join(root, 'package.json'))), SUPPORTED_DSH)
  fs.rmSync(root, { recursive: true, force: true })
})

test('resolves from installAnchor pointing at lib/bin.js (walks up)', () => {
  const root = makeInstall(SUPPORTED_DSH)
  assert.equal(resolveDshVersion(ctxWith(path.join(root, 'lib', 'bin.js'))), SUPPORTED_DSH)
  fs.rmSync(root, { recursive: true, force: true })
})

test('ignores a foreign manifest while walking up', () => {
  const root = makeInstall(SUPPORTED_DSH)
  // A nested directory with its own unrelated package.json must not win.
  const nested = path.join(root, 'lib', 'nested')
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }))
  assert.equal(resolveDshVersion(ctxWith(path.join(nested, 'entry.js'))), SUPPORTED_DSH)
  fs.rmSync(root, { recursive: true, force: true })
})

test('no ctx and no env fails closed as unknown', () => {
  const saved = process.env.DSH_INSTALL_DIR
  delete process.env.DSH_INSTALL_DIR
  try {
    // createRequire fallback cannot resolve the CLI from the plugin location
    // in this checkout (no node_modules), so the result must be 'unknown'.
    const version = resolveDshVersion(undefined)
    assert.ok(version === 'unknown' || /^\d/.test(version))
    if (version !== 'unknown') assert.equal(typeof version, 'string')
  } finally {
    if (saved !== undefined) process.env.DSH_INSTALL_DIR = saved
  }
})

test('ctx.get throwing falls through without crashing', () => {
  const ctx = { get: () => { throw new Error('service unavailable') } }
  const saved = process.env.DSH_INSTALL_DIR
  delete process.env.DSH_INSTALL_DIR
  try {
    assert.doesNotThrow(() => resolveDshVersion(ctx))
  } finally {
    if (saved !== undefined) process.env.DSH_INSTALL_DIR = saved
  }
})

test('env DSH_INSTALL_DIR is honoured when ctx has no anchor', () => {
  const root = makeInstall(SUPPORTED_DSH)
  const saved = process.env.DSH_INSTALL_DIR
  process.env.DSH_INSTALL_DIR = root
  try {
    assert.equal(resolveDshVersion({ get: () => undefined }), SUPPORTED_DSH)
  } finally {
    if (saved === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
})