/**
 * Host side of the "sync local plugins and model configuration to a remote
 * DSH" feature.
 *
 * Everything rides one SSH connection:
 *
 *   inspect remote profile -> ensure pnpm -> `dsh plugin add` exact versions
 *     -> merge a managed block into the remote profile's cordis.patch.yml
 *     -> merge provider API keys into ~/.dsh/.env (0600)
 *     -> `dsh --profile <p> --dump-config` as a pre-flight check
 *     -> optionally restart the remote `dsh web`
 *
 * The remote profile patch is never rewritten wholesale: only the text between
 * the two marker lines belongs to this plugin, so hand-written remote entries
 * survive a sync.
 */
import { connectClient, detectProxy, probeWebPort, restartWebServer, run } from './remote.js'
import { mergeEnvText, mergeManagedBlock, pickProviders, pluginAction, renderSyncBlock } from './patch.js'
import { buildLocalPlan } from './plan.js'

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PNPM_MAJOR = '10'

/** Quote one value for a POSIX shell command line. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/** Remote `dsh` path, double-quoted so `$HOME` still expands. */
function binCommand(host) {
  const raw = String(host.dshBin ?? '~/.local/bin/dsh').replace(/^~/, '$HOME')
  return '"' + raw.replace(/"/g, '\\"') + '"'
}

function tail(text, lines = 8) {
  return String(text ?? '').trim().split('\n').slice(-lines).join('\n')
}

function timestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function sftpOf(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => { if (error) reject(error); else resolve(sftp) })
  })
}

function sftpWrite(sftp, path, content, mode) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, Buffer.from(content, 'utf8'), { mode }, error => {
      if (error) { reject(error); return }
      sftp.chmod(path, mode, chmodError => (chmodError ? reject(chmodError) : resolve()))
    })
  })
}

/** Atomically replace a remote text file through a sibling temporary file. */
async function writeRemoteText(client, path, content, mode = 0o600) {
  const sftp = await sftpOf(client)
  const temp = path + '.remote-dsh-' + Date.now() + '.tmp'
  try {
    await sftpWrite(sftp, temp, content, mode)
  } finally {
    try { sftp.end() } catch { /* channel already gone */ }
  }
  const moved = await run(client, 'mv -f ' + shellQuote(temp) + ' ' + shellQuote(path))
  if (moved.code !== 0) throw new Error('写入远端文件失败：' + path + '：' + (moved.stderr || moved.stdout || 'mv failed'))
}

async function readRemoteText(client, path) {
  const result = await run(client, 'cat ' + shellQuote(path) + ' 2>/dev/null || true')
  return result.stdout
}

function envPrefix({ proxy = '', registry = '' } = {}) {
  let prefix = 'env PATH="$HOME/.local/bin:$PATH"'
  const cleanProxy = String(proxy ?? '').trim()
  if (cleanProxy !== '') {
    prefix += ' HTTP_PROXY=' + shellQuote(cleanProxy) + ' HTTPS_PROXY=' + shellQuote(cleanProxy)
    prefix += ' http_proxy=' + shellQuote(cleanProxy) + ' https_proxy=' + shellQuote(cleanProxy)
  }
  const cleanRegistry = String(registry ?? '').trim()
  if (cleanRegistry !== '') prefix += ' npm_config_registry=' + shellQuote(cleanRegistry)
  return prefix
}

async function ensurePnpm(client, options) {
  const { log = () => {}, dryRun = false } = options
  const found = (await run(client, 'PATH="$HOME/.local/bin:$PATH" command -v pnpm 2>/dev/null')).stdout.trim()
  if (found !== '') {
    const version = (await run(client, 'env PATH="$HOME/.local/bin:$PATH" pnpm -v 2>/dev/null')).stdout.trim()
    log('远端已有 pnpm ' + (version === '' ? '(' + found + ')' : version))
    return { installed: false, version }
  }
  if (dryRun) {
    log('远端没有 pnpm；实同步时会先执行 npm i -g --prefix "$HOME/.local" pnpm@' + PNPM_MAJOR)
    return { installed: false, version: null, planned: true }
  }
  const npm = (await run(client, 'command -v npm 2>/dev/null')).stdout.trim()
  if (npm === '') throw new Error('远端没有 npm，无法安装 pnpm')
  log('远端没有 pnpm，安装到 ~/.local …')
  const command = envPrefix(options) + ' npm i -g --prefix "$HOME/.local" pnpm@' + PNPM_MAJOR + ' --no-audit --no-fund 2>&1'
  const result = await run(client, command)
  if (result.code !== 0) throw new Error('安装 pnpm 失败（exit ' + result.code + '）：' + tail(result.stdout || result.stderr))
  const version = (await run(client, 'env PATH="$HOME/.local/bin:$PATH" pnpm -v 2>/dev/null')).stdout.trim()
  if (version === '') throw new Error('pnpm 安装后仍不可用（~/.local/bin 不在 PATH？）')
  log('已安装 pnpm ' + version)
  return { installed: true, version }
}

/**
 * Read the parts of the remote profile the sync form and job need.
 * @param {import('ssh2').Client} client
 * @param {object} host host entry
 * @param {string} profile remote profile name
 * @param {string[]} pluginNames local plugin names to look up
 */
async function inspectRemote(client, host, profile, pluginNames = []) {
  if (!PROFILE_NAME.test(profile)) throw new Error('远端 profile 名称不合法：' + profile)
  const bin = binCommand(host)
  const webPort = Number(host.webPort ?? 18080)
  const home = (await run(client, 'printf %s "$HOME"')).stdout.trim()
  if (!home.startsWith('/')) throw new Error('无法确定远端 HOME 目录')

  const node = (await run(client, 'node -v 2>/dev/null')).stdout.trim()
  const dsh = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
  const manifestText = (await run(client, 'cat "$HOME/.dsh/profiles/' + profile + '/package.json" 2>/dev/null || true')).stdout
  let manifest = null
  try { manifest = JSON.parse(manifestText) } catch { manifest = null }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []

  const installed = {}
  if (pluginNames.length > 0) {
    const script = 'const fs=require("fs"),base=process.env.HOME+"/.dsh/profiles/' + profile + '/node_modules/";'
      + 'for(const n of process.argv.slice(1)){try{process.stdout.write(n+"|"+JSON.parse(fs.readFileSync(base+n+"/package.json","utf8")).version+"\\n")}catch{process.stdout.write(n+"|\\n")}}'
    const result = await run(client, 'node -e ' + shellQuote(script) + ' ' + pluginNames.map(shellQuote).join(' '))
    for (const line of result.stdout.split('\n')) {
      const index = line.lastIndexOf('|')
      if (index <= 0) continue
      const name = line.slice(0, index)
      const version = line.slice(index + 1).trim()
      installed[name] = version === '' ? null : version
    }
  }

  const pnpm = (await run(client, 'PATH="$HOME/.local/bin:$PATH" command -v pnpm 2>/dev/null')).stdout.trim()
  const pnpmVersion = pnpm === '' ? null : (await run(client, 'env PATH="$HOME/.local/bin:$PATH" pnpm -v 2>/dev/null')).stdout.trim()
  const web = await probeWebPort(client, webPort)
  const patchPath = home + '/.dsh/profiles/' + profile + '/cordis.patch.yml'
  const patchExists = (await run(client, 'test -f ' + shellQuote(patchPath) + ' && echo yes || echo no')).stdout.trim() === 'yes'
  const envExists = (await run(client, 'test -f "$HOME/.dsh/.env" && echo yes || echo no')).stdout.trim() === 'yes'

  return {
    home,
    profile,
    profileDir: home + '/.dsh/profiles/' + profile,
    profileExists: manifest !== null,
    manifest,
    bundles,
    node,
    dshVersion: dsh,
    installed,
    pnpm: pnpm !== '',
    pnpmVersion: pnpmVersion === '' ? null : pnpmVersion,
    webAlive: web === '200' || web === '303' || web === '401',
    webCode: web === '' ? '000' : web,
    patchPath,
    patchExists,
    envPath: home + '/.dsh/.env',
    envExists,
  }
}

/**
 * Build the plan shown before a sync: local plugins/providers plus what the
 * remote profile already has.
 * @param {object} host host entry
 * @param {{ profile?: string, version?: string, services?: object }} options
 */
export async function planSync(host, { profile = 'web', version = '', services = {} } = {}) {
  if (!PROFILE_NAME.test(profile)) throw new Error('远端 profile 名称不合法：' + profile)
  const local = await buildLocalPlan(services)
  const client = await connectClient(host, { readyTimeout: 20_000 })
  try {
    const remote = await inspectRemote(client, host, profile, local.plugins.map(plugin => plugin.name))
    const plugins = local.plugins.map(plugin => {
      const action = pluginAction(plugin, remote)
      return { ...plugin, remoteVersion: action.version, remoteActive: action.active, action: action.action }
    })
    const warnings = []
    if (version !== '' && remote.dshVersion !== '' && remote.dshVersion !== version) {
      warnings.push('远端 dsh 版本（' + remote.dshVersion + '）与本地（' + version + '）不一致；请先连接一次让插件升级远端，再同步。')
    }
    if (local.providers.length === 0) warnings.push('本地 llm-pi-ai 没有可同步的 provider。')
    if (remote.dshVersion === '') warnings.push('远端还没有 dsh；请先点「连接」让插件自动安装，再回来同步。')
    if (!remote.profileExists) warnings.push('远端还没有 profile「' + profile + '」；同步插件时会自动初始化。')
    return {
      host: {
        id: host.id,
        label: host.label ?? host.host,
        host: host.host,
        user: host.user,
        sshPort: host.sshPort,
        webPort: host.webPort,
        installProxy: typeof host.installProxy === 'string' ? host.installProxy : '',
      },
      local,
      remote,
      warnings,
    }
  } finally {
    try { client.end() } catch { /* already closed */ }
  }
}

/**
 * Run a sync job.
 * @param {object} options
 * @param {object} options.host host entry
 * @param {string} [options.profile] remote profile name (default web)
 * @param {string} [options.version] local DSH version, used as a pre-flight check
 * @param {string[]} [options.pluginNames] local plugin package names to install
 * @param {string[]} [options.providerIds] local provider ids to copy
 * @param {{provider: string, model: string, reasoningEffort?: string}|null} [options.defaultModel]
 * @param {boolean} [options.syncKeys] copy provider apiKeyEnv values into ~/.dsh/.env
 * @param {boolean} [options.restart] restart the remote dsh web afterwards
 * @param {string} [options.registry] npm registry override
 * @param {string} [options.proxy] HTTP(S) proxy for npm/pnpm
 * @param {boolean} [options.dryRun] plan only, write nothing
 * @param {object} [options.services] host services (configEditor, credentials, agentDefaultModel)
 * @param {(message: string) => void} [options.log]
 * @param {(stage: string) => void} [options.stage]
 * @param {(() => Promise<void>)|null} [options.onRestart] close local resources before the remote restarts
 */
export async function runSync({
  host,
  profile = 'web',
  version = '',
  pluginNames = [],
  providerIds = [],
  defaultModel = null,
  syncKeys = true,
  restart = true,
  registry = '',
  proxy = '',
  dryRun = false,
  services = {},
  log = () => {},
  stage = () => {},
  onRestart = null,
} = {}) {
  if (!PROFILE_NAME.test(profile)) throw new Error('远端 profile 名称不合法：' + profile)
  const started = Date.now()
  const notes = []
  const pluginResults = []

  stage('connecting')
  const local = await buildLocalPlan(services)
  const client = await connectClient(host, { readyTimeout: 20_000 })
  log('SSH 已连接 ' + (host.user ?? '') + '@' + host.host)

  try {
    stage('checking')
    const remote = await inspectRemote(client, host, profile, local.plugins.map(plugin => plugin.name))
    log('远端 dsh ' + (remote.dshVersion || '未安装') + ' · Node ' + (remote.node || '缺失') + ' · profile ' + profile)
    if (remote.node === '') throw new Error('远端没有 Node.js，无法安装/启动 dsh')
    if (remote.dshVersion === '') throw new Error('远端还没有可用的 dsh；请先点「连接」让插件自动安装，再回来同步。')
    if (version !== '' && remote.dshVersion !== '' && remote.dshVersion !== version) {
      throw new Error('远端 dsh 版本（' + remote.dshVersion + '）与本地（' + version + '）不一致。请先点「连接」让插件把远端升级到同一版本，再同步。')
    }

    const localPlugins = new Map(local.plugins.map(plugin => [plugin.name, plugin]))
    const selectedPlugins = []
    for (const name of pluginNames) {
      const plugin = localPlugins.get(name)
      if (plugin === undefined) throw new Error('本地没有插件 ' + name)
      if (!plugin.supported) throw new Error('插件 ' + name + ' 不能同步到 Linux 远端：' + (plugin.reason || '平台不兼容'))
      selectedPlugins.push(plugin)
    }

    const localProviders = Object.fromEntries((local.providers ?? []).map(provider => [provider.id, provider]))
    for (const id of providerIds) if (localProviders[id] === undefined) throw new Error('本地没有 provider ' + id)
    const selectedProviderConfig = pickProviders(local.providerConfig ?? {}, providerIds)
    if (providerIds.length > 0 && Object.keys(selectedProviderConfig).length === 0) {
      throw new Error('没有可同步的模型 provider 配置')
    }

    if (defaultModel !== null && defaultModel !== undefined) {
      if (typeof defaultModel.provider !== 'string' || typeof defaultModel.model !== 'string') throw new Error('默认模型参数不合法')
      if (providerIds.includes(defaultModel.provider) === false) throw new Error('默认模型所属 provider「' + defaultModel.provider + '」未被勾选')
    }

    const actions = selectedPlugins.map(plugin => ({ plugin, ...pluginAction(plugin, remote) }))
    const toInstall = actions.filter(item => item.action === 'install')
    for (const item of actions) {
      if (item.action === 'skip') log('跳过插件 ' + item.plugin.name + '（远端已是 ' + item.plugin.version + ' 且已启用）')
    }

    if (toInstall.length > 0) {
      stage('installing-pnpm')
      let effectiveProxy = String(proxy ?? '').trim()
      if (effectiveProxy === '' && typeof host.installProxy === 'string') effectiveProxy = host.installProxy.trim()
      if (effectiveProxy === '' && !dryRun) {
        effectiveProxy = await detectProxy(client)
        if (effectiveProxy !== '') log('探测到远端代理 ' + effectiveProxy)
      }
      const pnpm = await ensurePnpm(client, { proxy: effectiveProxy, registry, log, dryRun })
      stage('installing')
      for (const item of toInstall) {
        const plugin = item.plugin
        const spec = plugin.name + '@' + plugin.version
        if (dryRun) {
          log('会安装插件 ' + spec + '（远端当前 ' + (item.version ?? '未安装') + '）')
          pluginResults.push({ name: plugin.name, version: plugin.version, from: item.version, action: 'planned-install' })
          continue
        }
        log('安装插件 ' + spec + ' …')
        const command = envPrefix({ proxy: effectiveProxy, registry }) + ' ' + binCommand(host)
          + ' plugin --profile ' + shellQuote(profile) + ' add ' + shellQuote(spec) + ' 2>&1'
        const result = await run(client, command)
        if (result.code !== 0) {
          throw new Error('安装 ' + spec + ' 失败（exit ' + result.code + '）：' + tail(result.stdout || result.stderr, 10))
        }
        log('已安装 ' + spec)
        pluginResults.push({ name: plugin.name, version: plugin.version, from: item.version, action: 'installed' })
      }
      if (dryRun === false) {
        const after = JSON.parse((await run(client, 'cat "$HOME/.dsh/profiles/' + profile + '/package.json" 2>/dev/null || echo {}')).stdout || '{}')
        const activeBundles = Array.isArray(after?.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []
        const missing = toInstall.map(item => item.plugin.name).filter(name => activeBundles.includes(name) === false)
        if (missing.length > 0) notes.push('这些插件已安装但未出现在 bundles 中：' + missing.join(', '))
        log('远端 profile bundles：' + (activeBundles.length > 0 ? activeBundles.join(', ') : '(空)'))
      }
    }

    const patchEntries = []
    if (providerIds.length > 0) {
      patchEntries.push({
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: { providers: selectedProviderConfig },
      })
    }
    if (defaultModel !== null && defaultModel !== undefined) {
      const config = { provider: defaultModel.provider, model: defaultModel.model }
      if (typeof defaultModel.reasoningEffort === 'string' && defaultModel.reasoningEffort !== '') config.reasoningEffort = defaultModel.reasoningEffort
      patchEntries.push({ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config })
    }

    let patchInfo = null
    if (patchEntries.length > 0) {
      stage('writing-config')
      const existing = await readRemoteText(client, remote.patchPath)
      const block = renderSyncBlock(patchEntries)
      const next = mergeManagedBlock(existing, block)
      patchInfo = {
        path: remote.patchPath,
        backup: null,
        providers: providerIds,
        defaultModel: defaultModel ?? null,
        changed: existing !== next,
      }
      if (dryRun) {
        log('会写入远端 patch：' + remote.patchPath + '（provider ' + (providerIds.join(', ') || '无') + '）')
        patchInfo.preview = next
      } else if (patchInfo.changed === false) {
        log('远端 patch 已是最新，无需改写：' + remote.patchPath)
      } else {
        await run(client, 'mkdir -p ' + shellQuote(remote.profileDir) + ' 2>/dev/null || true')
        if (remote.patchExists) {
          const backup = remote.patchPath + '.bak-remote-dsh-' + timestamp()
          const copied = await run(client, 'cp -p ' + shellQuote(remote.patchPath) + ' ' + shellQuote(backup) + ' 2>/dev/null || true')
          if (copied.code === 0) patchInfo.backup = backup
        }
        await writeRemoteText(client, remote.patchPath, next, 0o600)
        log('已更新远端 patch：' + remote.patchPath + (patchInfo.backup === null ? '' : '（备份 ' + patchInfo.backup + '）'))
      }
    }

    let envInfo = null
    if (syncKeys && providerIds.length > 0) {
      stage('syncing-keys')
      const credentials = services.credentials
      const pairs = []
      for (const id of providerIds) {
        const ref = localProviders[id]?.apiKeyEnv
        if (typeof ref !== 'string' || ref === '') continue
        if (credentials === undefined || typeof credentials.resolve !== 'function') {
          notes.push('宿主没有 credentials 服务，无法同步 ' + ref)
          continue
        }
        let hit
        try { hit = await credentials.resolve(ref) } catch { hit = undefined }
        if (hit === undefined || typeof hit.value !== 'string' || hit.value === '') {
          notes.push('本地没有配置 ' + ref + '，远端会继续使用已有环境变量')
          continue
        }
        pairs.push([ref, hit.value])
      }
      envInfo = { path: remote.envPath, keys: pairs.map(([name]) => name), backup: null, changed: false }
      if (pairs.length === 0) {
        log('没有可写入的 API Key')
      } else {
        const existingEnv = await readRemoteText(client, remote.envPath)
        const nextEnv = mergeEnvText(existingEnv, pairs)
        envInfo.changed = existingEnv !== nextEnv
        if (dryRun) {
          log('会写入 ' + remote.envPath + '：' + envInfo.keys.join(', '))
        } else if (envInfo.changed === false) {
          log('远端 .env 已包含目标 Key，无需改写：' + envInfo.keys.join(', '))
        } else {
          if (remote.envExists) {
            const backup = remote.envPath + '.bak-remote-dsh-' + timestamp()
            const copied = await run(client, 'cp -p ' + shellQuote(remote.envPath) + ' ' + shellQuote(backup) + ' 2>/dev/null || true')
            if (copied.code === 0) envInfo.backup = backup
          }
          await writeRemoteText(client, remote.envPath, nextEnv, 0o600)
          log('已写入 ' + remote.envPath + '（0600）：' + envInfo.keys.join(', '))
        }
      }
    }

    if (dryRun) {
      stage('done')
      return {
        dryRun: true,
        profile,
        localProfile: local.profile,
        plugins: pluginResults,
        patch: patchInfo,
        env: envInfo,
        notes,
        ms: Date.now() - started,
      }
    }

    stage('validating')
    const bin = binCommand(host)
    const dump = await run(client, envPrefix({}) + ' ' + bin + ' --profile ' + shellQuote(profile) + ' --dump-config 2>&1')
    if (dump.code !== 0) {
      if (patchInfo !== null) {
        if (patchInfo.backup !== null) {
          await run(client, 'cp -p ' + shellQuote(patchInfo.backup) + ' ' + shellQuote(remote.patchPath) + ' 2>/dev/null || true')
          notes.push('配置校验失败，已恢复同步前的 patch 备份')
        } else if (remote.patchExists === false) {
          await run(client, 'rm -f ' + shellQuote(remote.patchPath) + ' 2>/dev/null || true')
          notes.push('配置校验失败，已删除本次新建的 patch')
        }
      }
      if (envInfo !== null) {
        if (envInfo.backup !== null) {
          await run(client, 'cp -p ' + shellQuote(envInfo.backup) + ' ' + shellQuote(remote.envPath) + ' 2>/dev/null || true')
        } else if (remote.envExists === false) {
          await run(client, 'rm -f ' + shellQuote(remote.envPath) + ' 2>/dev/null || true')
        }
      }
      throw new Error('远端配置校验失败（exit ' + dump.code + '）：' + tail(dump.stdout || dump.stderr, 8))
    }
    log('配置校验通过（dsh --dump-config）')

    let restarted = false
    if (restart) {
      if (typeof onRestart === 'function') {
        try { await onRestart() } catch { /* best effort */ }
      }
      await restartWebServer(client, host, { log, stage, profile })
      restarted = true
    } else {
      notes.push('未重启远端 dsh web；新配置会在下次启动时生效')
    }

    stage('done')
    return {
      dryRun: false,
      profile,
      localProfile: local.profile,
      plugins: pluginResults,
      patch: patchInfo,
      env: envInfo,
      restarted,
      notes,
      ms: Date.now() - started,
    }
  } finally {
    try { client.end() } catch { /* already closed */ }
  }
}
