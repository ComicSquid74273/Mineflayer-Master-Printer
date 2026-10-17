'use strict'

const fs = require('fs')
const path = require('path')
const { normalizeMeteorElytraSettings } = require('./meteor-elytra-controller')

const DEFAULT_CONFIG_FILE = path.resolve(process.cwd(), 'config', 'config.json')

function toNumber(value, fallback) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getCliValue(name, argv = process.argv.slice(2)) {
  const prefix = `${name}=`
  const entry = argv.find((argument) => argument.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : null
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function getSelectedConnectionProfileName(config, argv = process.argv.slice(2), env = process.env) {
  return (
    getCliValue('--connection', argv) ||
    getCliValue('--server', argv) ||
    env.NERV_CONNECTION ||
    config.connection?.active ||
    config.connectionProfile ||
    'testserver'
  )
}

function mergeConnectionProfileConfig(config, profile) {
  if (profile.bot) {
    config.bot = {
      ...(config.bot || {}),
      ...profile.bot,
      reconnect: {
        ...(config.bot?.reconnect || {}),
        ...(profile.bot.reconnect || {})
      }
    }
  }

  if (profile.multiUser) {
    config.multiUser = {
      ...(config.multiUser || {}),
      ...profile.multiUser,
      bots: Array.isArray(profile.multiUser.bots)
        ? profile.multiUser.bots
        : (config.multiUser?.bots || [])
    }
  }

  if (profile.printer) {
    config.printer = {
      ...(config.printer || {}),
      ...profile.printer,
      printOffset: {
        ...(config.printer?.printOffset || {}),
        ...(profile.printer.printOffset || {})
      }
    }
  }

  // Fallback defaults for TPS and TPS-scaled limits if omitted
  config.printer = {
    enabled: true,
    blocksPerSecond: 20,
    minimumTps: 10.0,
    staleTickSeconds: 1.5,
    perTickBurstCap: 2,
    range: 5.0,
    layerHoverOffsetY: 2,
    layersPerPass: 2,
    printWhileFlying: true,
    hotbarLookaheadBlocks: 512,
    debugLogging: false,
    ...(config.printer || {})
  }
  config.printer.range = Math.max(2, Math.min(5, toNumber(config.printer.range, 5)))
  config.printer.layersPerPass = Math.max(1, Math.min(3, Math.floor(toNumber(config.printer.layersPerPass, 2))))
  config.printer.printWhileFlying = config.printer.printWhileFlying !== false

  if (profile.advanced) {
    config.advanced = {
      ...(config.advanced || {}),
      ...profile.advanced
    }
  }

  if (profile.elytraFly) {
    config.elytraFly = {
      ...(config.elytraFly || {}),
      ...profile.elytraFly
    }
  }

  config.elytraFly = normalizeMeteorElytraSettings(config.elytraFly || {})
}

function applyConnectionProfile(config, argv = process.argv.slice(2), env = process.env) {
  const name = String(getSelectedConnectionProfileName(config, argv, env) || '').trim()
  const profiles = config.connection?.profiles || {}
  const profile = profiles[name]

  if (!profile) {
    const available = Object.keys(profiles).join(', ') || 'none'
    throw new Error(`Unknown connection profile "${name}". Available profiles: ${available}`)
  }

  mergeConnectionProfileConfig(config, profile)
  config.connection = {
    ...(config.connection || {}),
    active: name,
    selected: name
  }
  return config
}

function getAccountBotOverrides(entry) {
  if (!entry || typeof entry !== 'object') return {}
  const allowedKeys = [
    'auth',
    'profilesFolder',
    'loginPassword',
    'password',
    'chatLoginPassword',
    'proxy',
    'proxyId',
    'proxyType',
    'proxyHost',
    'proxyPort',
    'proxyUsername',
    'proxyPassword',
    'proxyConnectTimeoutMs',
    'proxyEnabled'
  ]
  const overrides = {}
  for (const key of allowedKeys) {
    if (entry[key] !== undefined) overrides[key] = entry[key]
  }
  return overrides
}

function selectAccount(config, argv = process.argv.slice(2), env = process.env) {
  const requestedUsername = String(
    getCliValue('--username', argv) ||
    env.MINECRAFT_USERNAME ||
    env.NERV_USERNAME ||
    config.bot?.username ||
    ''
  ).trim()
  const accounts = Array.isArray(config.bot?.usernames) ? config.bot.usernames : []
  const enabledAccounts = accounts.filter((entry) => entry && entry.enabled !== false && (entry.name || entry.username))
  const account = enabledAccounts.find((entry) => String(entry.name || entry.username).trim().toLowerCase() === requestedUsername.toLowerCase()) || enabledAccounts[0] || null
  const username = requestedUsername || String(account?.name || account?.username || '').trim()

  if (!username) throw new Error('No bot username is configured. Set bot.username, --username, or MINECRAFT_USERNAME.')

  config.bot = {
    ...(config.bot || {}),
    ...getAccountBotOverrides(account),
    username
  }
  return config
}

function applyRuntimeOverrides(config, argv = process.argv.slice(2), env = process.env) {
  const bot = config.bot || (config.bot = {})
  const dashboard = config.dashboard || (config.dashboard = {})
  const host = getCliValue('--host', argv) || env.MINECRAFT_HOST
  const port = getCliValue('--port', argv) || env.MINECRAFT_PORT
  const auth = getCliValue('--auth', argv) || env.MINECRAFT_AUTH
  const version = getCliValue('--version', argv) || env.MINECRAFT_VERSION
  const loginPassword = getCliValue('--password', argv) || env.MINECRAFT_LOGIN_PASSWORD || env.NERV_LOGIN_PASSWORD

  if (host) bot.host = String(host).trim()
  if (port) bot.port = toNumber(port, bot.port || 25565)
  if (auth) bot.auth = String(auth).trim()
  if (version) bot.version = String(version).trim()
  if (loginPassword) bot.loginPassword = String(loginPassword)

  if (env.NERV_DASHBOARD_URL) dashboard.serviceUrl = String(env.NERV_DASHBOARD_URL).trim()
  if (env.NERV_DASHBOARD_HOST_LABEL) dashboard.hostLabel = String(env.NERV_DASHBOARD_HOST_LABEL).trim()
  if (env.NERV_DASHBOARD_ENABLED) {
    dashboard.enabled = ['1', 'true', 'yes', 'on'].includes(String(env.NERV_DASHBOARD_ENABLED).toLowerCase())
  }

  // CLI speed & debug overrides
  const speedBps = getCliValue('--speed-bps', argv) || getCliValue('--bps', argv) || env.PRINTER_BPS
  if (speedBps) {
    config.printer = config.printer || {}
    config.printer.blocksPerSecond = Math.max(1, Math.min(30, toNumber(speedBps, config.printer.blocksPerSecond || 20)))
  }
  const isDebug = argv.includes('--debug') || argv.includes('--verbose') || ['1', 'true', 'yes'].includes(String(env.PRINTER_DEBUG || env.NERV_DEBUG).toLowerCase())
  if (isDebug) {
    config.printer = config.printer || {}
    config.printer.debugLogging = true
  }

  const elytraSpeed = getCliValue('--elytra-horizontal-speed', argv) || getCliValue('--elytra-speed', argv) || getCliValue('--fly-speed', argv) || env.ELYTRA_HORIZONTAL_SPEED || env.ELYTRA_SPEED_BPS
  if (elytraSpeed) {
    config.elytraFly = config.elytraFly || {}
    config.elytraFly.horizontalSpeed = Math.max(0, toNumber(elytraSpeed, config.elytraFly.horizontalSpeed || 2))
  }
  const elytraVertical = getCliValue('--elytra-vertical-speed', argv) || getCliValue('--elytra-vertical', argv) || getCliValue('--vertical-speed', argv) || env.ELYTRA_VERTICAL_SPEED || env.ELYTRA_VERTICAL_BPS
  if (elytraVertical) {
    config.elytraFly = config.elytraFly || {}
    config.elytraFly.verticalSpeed = Math.max(0, toNumber(elytraVertical, config.elytraFly.verticalSpeed || 2))
  }
  const glideHeight = getCliValue('--glide-height', argv) || env.ELYTRA_GLIDE_HEIGHT
  if (glideHeight) {
    config.elytraFly = config.elytraFly || {}
    config.elytraFly.glideHeight = Math.max(2, Math.min(20, toNumber(glideHeight, config.elytraFly.glideHeight || 5)))
  }

  config.elytraFly = normalizeMeteorElytraSettings(config.elytraFly || {})
  return config
}

function loadImportedMachineConfig(config) {
  const configuredPath = String(config.files?.machineConfigFile || '').trim()
  if (!configuredPath) return config
  const machineConfigFile = path.resolve(process.cwd(), configuredPath)
  if (!fs.existsSync(machineConfigFile)) return config
  config.machine = clone(readJson(machineConfigFile))
  config.__machineConfigFile = machineConfigFile
  return config
}

function loadConfig(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const env = options.env || process.env
  const explicitPath = getCliValue('--config', argv) || getCliValue('--config-file', argv) || env.NERV_CONFIG_FILE
  const configFile = path.resolve(process.cwd(), explicitPath || DEFAULT_CONFIG_FILE)
  if (!fs.existsSync(configFile)) throw new Error(`Missing config file: ${configFile}`)

  const config = clone(readJson(configFile))
  loadImportedMachineConfig(config)
  applyConnectionProfile(config, argv, env)
  selectAccount(config, argv, env)
  applyRuntimeOverrides(config, argv, env)
  config.__meta = {
    configFile,
    configFileName: path.basename(configFile)
  }
  return config
}

module.exports = {
  applyConnectionProfile,
  getCliValue,
  getSelectedConnectionProfileName,
  loadImportedMachineConfig,
  loadConfig,
  mergeConnectionProfileConfig,
  selectAccount,
  toNumber
}
