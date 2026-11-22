/**
 * Local half of the configuration sync: which profile plugins the desktop app
 * has, which model providers its live `llm-pi-ai` entry carries, and what the
 * current default model is.
 *
 * The live configuration comes from `ctx.configEditor`, not from parsing
 * `cordis.patch.yml`, so values edited through the UI are included and the
 * sync never has to implement the Loader's YAML dialect.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Directory of the profile this plugin is installed in. */
export function resolveLocalProfileDir() {
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function isWindowsOnly(manifest) {
  if (Array.isArray(manifest.os) && manifest.os.length > 0 && !manifest.os.includes('linux')) return true
  const words = Array.isArray(manifest.keywords) ? manifest.keywords : []
  return words.some(word => /^(?:windows|win32)$/i.test(String(word)))
}

/**
 * Plugins installed as profile dependencies that declare a bundle.
 * @param {string} profileDir
 * @returns {object[]}
 */
export function listLocalPlugins(profileDir = resolveLocalProfileDir()) {
  const manifest = readJson(path.join(profileDir, 'package.json'))
  const dependencies = manifest?.dependencies ?? {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const active = new Set(bundles)
  const out = []
  for (const name of Object.keys(dependencies)) {
    const packageFile = path.join(profileDir, 'node_modules', name, 'package.json')
    const pkg = readJson(packageFile)
    if (pkg === null) continue
    if (pkg.dsh?.bundle === undefined) continue
    const windowsOnly = isWindowsOnly(pkg)
    // `link:` / `file:` dependencies point at a local checkout that the remote
    // machine does not have; the registry version of the same name is usually a
    // different (older) build, so syncing one would silently install the wrong code.
    const localPath = /^(?:link|file):/i.test(String(dependencies[name] ?? ''))
    const self = name === 'dsh-remote-panel-ssh'
    const enabled = active.has(name)
    let reason = ''
    if (windowsOnly) reason = '仅支持 Windows，远端 Linux 无法加载'
    else if (localPath) reason = '本地 link:/file: 依赖，远端没有对应源码，无法同步'
    else if (!enabled) reason = '本地未启用（不在 bundles 中）'
    else if (self) reason = '当前插件自身，远端通常不需要'
    out.push({
      name,
      version: String(pkg.version ?? ''),
      spec: String(dependencies[name] ?? ''),
      active: enabled,
      supported: !windowsOnly && !localPath,
      self,
      reason,
      defaultSelected: !windowsOnly && !localPath && enabled && !self,
    })
  }
  return out
}

function isLoopback(baseURL) {
  if (typeof baseURL !== 'string' || baseURL === '') return false
  try {
    const host = new URL(baseURL).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/**
 * Enumerate providers of the live `llm-pi-ai` entry and the current default
 * model selection.
 * @param {{ configEditor?: any, credentials?: any, agentDefaultModel?: any }} services
 */
export async function readLocalModelConfig(services = {}) {
  const { configEditor, credentials, agentDefaultModel } = services
  let rows = []
  if (configEditor !== undefined && typeof configEditor.configuration === 'function') {
    const raw = configEditor.configuration()
    rows = Array.isArray(raw) ? raw : (raw !== null && typeof raw === 'object' && typeof raw.then === 'function' ? await raw : [])
  }
  const row = rows.find(item => {
    const entry = item?.entry
    const name = entry?.options?.name ?? entry?.name
    const id = entry?.options?.id ?? entry?.id
    return name === '@deepseek-ai/dsh-llm-pi-ai' || id === 'llm-pi-ai'
  })
  const config = { ...(row?.inherited ?? {}), ...(row?.override ?? {}) }
  const providers = config.providers !== null && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? config.providers
    : {}

  let defaultModel = null
  try {
    const selection = agentDefaultModel?.currentSelection?.()
    if (selection?.provider !== undefined && selection?.model !== undefined) {
      defaultModel = { provider: selection.provider, model: selection.model }
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') defaultModel.reasoningEffort = selection.reasoningEffort
    }
  } catch { /* fall through to the entry config */ }
  if (defaultModel === null) {
    const modelRow = rows.find(item => {
      const entry = item?.entry
      const name = entry?.options?.name ?? entry?.name
      const id = entry?.options?.id ?? entry?.id
      return name === '@deepseek-ai/dsh-agent-default-model' || id === 'agent-default-model'
    })
    const modelConfig = { ...(modelRow?.inherited ?? {}), ...(modelRow?.override ?? {}) }
    if (modelConfig.provider !== undefined && modelConfig.model !== undefined) {
      defaultModel = { provider: modelConfig.provider, model: modelConfig.model }
      if (typeof modelConfig.reasoningEffort === 'string' && modelConfig.reasoningEffort !== '') defaultModel.reasoningEffort = modelConfig.reasoningEffort
    }
  }

  const list = []
  for (const [id, value] of Object.entries(providers)) {
    const provider = value !== null && typeof value === 'object' ? value : {}
    const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
    let keyConfigured = null
    if (apiKeyEnv !== '' && credentials !== undefined && typeof credentials.resolve === 'function') {
      try { keyConfigured = (await credentials.resolve(apiKeyEnv)) !== undefined } catch { keyConfigured = null }
    }
    const models = Array.isArray(provider.models)
      ? provider.models.map(model => ({ id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') })).filter(model => model.id !== '')
      : []
    list.push({
      id,
      displayName: String(provider.displayName ?? id),
      api: String(provider.api ?? ''),
      baseURL: String(provider.baseURL ?? ''),
      apiKeyEnv,
      keyConfigured,
      loopback: isLoopback(provider.baseURL),
      models,
      modelCount: models.length,
      defaultSelected: !isLoopback(provider.baseURL) || id === defaultModel?.provider,
    })
  }
  if (defaultModel !== null) {
    const provider = list.find(item => item.id === defaultModel.provider)
    if (provider === undefined || (provider.models.length > 0 && !provider.models.some(model => model.id === defaultModel.model))) defaultModel = null
  }
  return { providers: list, providerConfig: providers, defaultModel }
}

/**
 * Everything the sync form needs from this machine.
 * @param {object} services host services (configEditor, credentials, agentDefaultModel)
 */
export async function buildLocalPlan(services = {}) {
  const profileDir = resolveLocalProfileDir()
  const manifest = readJson(path.join(profileDir, 'package.json'))
  const model = await readLocalModelConfig(services)
  return {
    profileDir,
    profile: process.env.DSH_PROFILE ?? path.basename(profileDir),
    dshVersion: typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION !== '' ? process.env.DSH_VERSION : null,
    plugins: listLocalPlugins(profileDir),
    providers: model.providers,
    providerConfig: model.providerConfig,
    defaultModel: model.defaultModel,
    bundles: Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [],
  }
}
