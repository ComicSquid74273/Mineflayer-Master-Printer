'use strict'

const crypto = require('crypto')
const mineflayer = require('mineflayer')
const elytraFlyModule = require('mineflayer-elytrafly')
const { pathfinder } = require('mineflayer-pathfinder')
const { installChatLogin } = require('./chat-login')
const { toNumber } = require('./config')
const { createDashboardClient } = require('./dashboard-client')
const { applyProxyToOptions, formatProxyForLog } = require('./shared/proxy-connect')
const { repairSetSlotPacket, repairWindowItemsPacket } = require('./shared/window-items-compat')
const { acquireBotRuntimeLock } = require('./runtime-lock')
const { engageElytraHover, equipElytra, escapeWaterForFlight, installElytraFlightLifecycle, stopElytraFlight } = require('./elytra-flight')
const { startPrinting, stopPrinting, checkAutoStartPrinting } = require('./printer-runtime')

function readPacketId(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  let value = 0
  let shift = 0
  for (let index = 0; index < Math.min(buffer.length, 5); index += 1) {
    const byte = buffer[index]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value >>> 0
    shift += 7
  }
  return null
}

function installWindowItemsCompat(client) {
  const wrappedParsers = new Map()
  const wrap = () => {
    const parser = client?.deserializer
    if (!parser || typeof parser.parsePacketBuffer !== 'function' || wrappedParsers.has(parser)) return
    const original = parser.parsePacketBuffer.bind(parser)
    parser.parsePacketBuffer = (buffer) => {
      const packetId = readPacketId(buffer)
      if (packetId === 0x12 || packetId === 0x13) {
        try {
          const repaired = repairWindowItemsPacket(parser, buffer)
          if (repaired) return repaired.packet
        } catch { }
      } else if (packetId === 0x14 || packetId === 0x15) {
        try {
          const repaired = repairSetSlotPacket(parser, buffer)
          if (repaired) return repaired.packet
        } catch { }
      }
      try {
        return original(buffer)
      } catch (error) {
        if (error?.name === 'PartialReadError') {
          return { data: { name: 'unknown' }, metadata: { size: buffer.length }, buffer }
        }
        throw error
      }
    }
    wrappedParsers.set(parser, original)
  }

  wrap()
  client?.on?.('state', wrap)
  let _deserializer = client?.deserializer
  wrap()
  try {
    Object.defineProperty(client, 'deserializer', {
      configurable: true,
      enumerable: true,
      get: () => _deserializer,
      set: (val) => {
        _deserializer = val
        wrap()
      }
    })
  } catch { }
}

const elytraFlyPlugin = elytraFlyModule.elytrafly || elytraFlyModule.plugin || elytraFlyModule.default || elytraFlyModule

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function uniqueHosts(config) {
  const values = [config.bot?.host, ...(Array.isArray(config.bot?.hosts) ? config.bot.hosts : [])]
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function getReconnectConfig(config) {
  const reconnect = config.bot?.reconnect || {}
  const delayMs = Math.max(0, toNumber(reconnect.delayMs, 5000))
  return {
    enabled: reconnect.enabled === true,
    delayMs,
    throttledDelayMs: Math.max(delayMs, toNumber(reconnect.throttledDelayMs, 30000)),
    maxAttempts: Math.max(1, toNumber(reconnect.maxAttempts, 50))
  }
}

function getReconnectDelayMs(reconnect, session = {}) {
  if (session.manualAction === 'reconnect') return 1000
  return /connection throttled|too many connections|wait before reconnecting/i.test(String(session.endReason || ''))
    ? reconnect.throttledDelayMs
    : reconnect.delayMs
}

function createBot(config, callbacks = {}) {
  const botConfig = config.bot || {}
  const username = botConfig.username || 'ComicBot'
  const options = {
    host: botConfig.host || '127.0.0.1',
    port: toNumber(botConfig.port, 25565),
    username,
    auth: botConfig.auth || 'offline',
    version: botConfig.version === 'auto' ? false : (botConfig.version || false),
    profilesFolder: botConfig.profilesFolder || './auth-cache',
    viewDistance: botConfig.viewDistance || 'normal',
    checkTimeoutInterval: toNumber(botConfig.checkTimeoutInterval, 60000),
    onMsaCode: (data) => {
      const code = data?.user_code || data?.code || ''
      const url = data?.verification_uri || 'https://www.microsoft.com/link'
      console.log(`[MICROSOFT-AUTH] ${username} -> ${code || 'code-unavailable'}`)
      console.log(`[MICROSOFT-AUTH] Open ${url}${code ? ` and enter code ${code}` : ''}.`)
      callbacks.onVerification?.({ code, url })
    }
  }

  const proxy = applyProxyToOptions(options, botConfig, { timeoutMs: botConfig.proxyConnectTimeoutMs })
  const proxyText = proxy ? ` proxy=${formatProxyForLog(proxy)}` : ''
  console.log(`[BOT] username=${username} target=${options.host}:${options.port} auth=${options.auth} version=${botConfig.version || 'auto'}${proxyText}`)

  const runtimeLock = callbacks.runtimeLock === false
    ? null
    : acquireBotRuntimeLock({ username, host: options.host, port: options.port })
  let bot
  try {
    bot = mineflayer.createBot(options)
  } catch (error) {
    runtimeLock?.release()
    throw error
  }
  bot.config = config
  bot.__releaseRuntimeLock = () => runtimeLock?.release()
  bot.once('end', bot.__releaseRuntimeLock)
  installWindowItemsCompat(bot._client)
  bot._client.on('state', () => installWindowItemsCompat(bot._client))
  bot.loadPlugin(pathfinder)
  const { installDigTimeFix } = require('./gear-restock')
  installDigTimeFix(bot)
  installChatLogin(bot, config)
  bot.once('spawn', () => {
    if (config.elytraFly?.enabled === false) return
    try {
      bot.loadPlugin(elytraFlyPlugin)
      installElytraFlightLifecycle(bot)
      bot.elytrafly.sendStartStopPacket = () => {
        bot._client.write('entity_action', {
          entityId: bot.entity.id,
          actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
          jumpBoost: 0
        })
      }
      if (bot.elytrafly?.options && config.elytraFly?.options) Object.assign(bot.elytrafly.options, config.elytraFly.options)
      console.log('[ELYTRAFLY] Plugin loaded; travel commands are ready for the next phase.')
    } catch (error) {
      console.log(`[ELYTRAFLY-WARN] ${error?.message || error}`)
    }
  })

  bot.on('spawn', () => {
    if (config.elytraFly?.enabled === false) return
    const pos = bot.entity?.position
    if (!pos) return
    bot.__waterEscapeActive = true
    void delay(250)
      .then(() => escapeWaterForFlight(bot, 20000))
      .then(async () => {
        const airborne = bot.entity?.onGround === false
        if (!airborne) {
          try { stopElytraFlight(bot) } catch { }
          return
        }

        const engage = () => {
          const hover = engageElytraHover(bot)
          console.log(`[ELYTRAFLY] Anti-fall hover engaged on spawn/reconnect at ${bot.entity?.position || pos} (listeners=${hover.listenerCount}, onGround=${bot.entity?.onGround}).`)
        }
        const torsoSlot = bot.getEquipmentDestSlot?.('torso')
        const torsoItem = Number.isInteger(torsoSlot) ? bot.inventory?.slots?.[torsoSlot] : null
        if (torsoItem?.name === 'elytra') engage()
        else await equipElytra(bot).then(engage)
      })
      .catch((err) => {
        console.log(`[ELYTRAFLY-WARN] Anti-fall recovery failed: ${err.message}`)
      })
      .finally(() => {
        bot.__waterEscapeActive = false
      })
  })
  return bot
}

function runSession(config, sessionNumber, runtime) {
  return new Promise((resolve) => {
    let ended = false
    let spawned = false
    let endReason = 'connection-ended'
    let manualAction = null
    let bot = null
    const dashboardOptions = {
      runtimeInstanceId: runtime.runtimeInstanceId,
      runtimeStartedAt: runtime.runtimeStartedAt,
      sessionNumber,
      onStart: () => startPrinting(bot, config, dashboard),
      onStop: (cmd) => stopPrinting(bot, dashboard, cmd?.reason),
      checkAutoStart: () => checkAutoStartPrinting(bot, config, dashboard),
      onDisconnect: () => {
        manualAction = 'disconnect'
        endReason = 'dashboard-disconnect'
        bot?.quit('Dashboard disconnect requested')
      },
      onReconnect: () => {
        manualAction = 'reconnect'
        endReason = 'dashboard-reconnect'
        bot?.quit('Dashboard reconnect requested')
      }
    }
    bot = createBot(config)
    runtime.currentBot = bot
    const dashboard = createDashboardClient(bot, config, dashboardOptions)
    runtime.currentDashboard = dashboard

    function finish(reason) {
      if (ended) return
      ended = true
      if (!/^(kicked|error):/i.test(endReason)) endReason = reason || endReason
      runtime.currentBot = null
      runtime.currentDashboard = null
      void dashboard.stop(false).finally(() => resolve({ endReason, manualAction, spawned }))
    }

    bot.on('login', () => {
      dashboard.state.online = true
      dashboard.state.reconnectState = 'connected'
      dashboard.setPhase('joining', 'authenticated; waiting for spawn')
      void dashboard.start()
      console.log(`[LOGIN] ${bot.username} authenticated to ${config.bot.host}:${config.bot.port}.`)
    })

    bot.on('spawn', () => {
      spawned = true
      dashboard.state.online = true
      dashboard.state.reconnectState = 'connected'
      dashboard.setPhase('idle', 'connected')
      void dashboard.postStatus()
      const position = bot.entity?.position
      const positionText = position ? ` at ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : ''
      console.log(`[SPAWN] ${bot.username} joined${positionText}.`)

      // Auto-start printing if inside restock station bounding box with pending chunks
      const autoStartWhenSafe = () => {
        if (bot.__waterEscapeActive || bot.entity?.isInWater) {
          if (!bot.__waterEscapeActive && bot.entity?.isInWater) {
            bot.__waterEscapeActive = true
            void escapeWaterForFlight(bot, 20000)
              .catch((error) => console.log(`[ELYTRAFLY-WARN] Deferred water recovery failed: ${error.message}`))
              .finally(() => { bot.__waterEscapeActive = false })
          }
          return setTimeout(autoStartWhenSafe, 1000)
        }
        checkAutoStartPrinting(bot, config, dashboard)
      }
      setTimeout(autoStartWhenSafe, 3000)
    })

    let lastHealth = Number(bot.health || 20)
    bot.on('health', () => {
      const currentHealth = Number(bot.health)
      if (currentHealth < lastHealth && bot.__landingState) {
        const landing = bot.__landingState
        const message = `Landing damage ${lastHealth.toFixed(1)} -> ${currentHealth.toFixed(1)} health; phase=${landing.phase} remaining=${Number(landing.remainingHeight ?? -1).toFixed(2)} drift=${Number(landing.drift ?? -1).toFixed(2)}.`
        dashboard.addChat(`[SYSTEM] ${message}`)
        console.log(`[LANDING-DAMAGE] ${message}`)
        if (config.printer?.debugLogging === true) console.log(`[LANDING-DAMAGE-DEBUG] ${JSON.stringify(landing)}`)
      }
      lastHealth = currentHealth
    })

    bot.on('death', () => {
      const position = bot.entity?.position
      const landing = bot.__landingState
      const location = position ? `${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}` : 'unknown'
      const message = `ComicBot died in ${bot.game?.gameMode || 'unknown'} mode at ${location}${landing ? ` during ${landing.phase}` : ''}.`
      dashboard.setError(message)
      dashboard.setPhase('dead', message)
      dashboard.addChat(`[SYSTEM] ${message}`)
      void dashboard.postStatus().catch(() => {})
      console.log(`[DEATH] ${message}`)
    })

    bot.on('messagestr', (message) => {
      dashboard.addChat(message)
      console.log(`[CHAT] ${message}`)
    })

    bot.on('chat', (username, message) => {
      dashboard.addChat(`<${username}> ${message}`)
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      endReason = `kicked: ${text}`
      dashboard.setError(endReason)
      console.log(`[KICKED] ${text}`)
    })

    bot.on('error', (error) => {
      endReason = `error: ${error?.message || error}`
      dashboard.setError(error)
      console.log(`[ERROR] ${error?.stack || error}`)
    })

    bot.on('end', (reason) => finish(reason || endReason))
  })
}

async function runConnectionManager(config) {
  const reconnect = getReconnectConfig(config)
  const runtime = {
    runtimeInstanceId: crypto.randomUUID(),
    runtimeStartedAt: new Date().toISOString(),
    currentBot: null,
    currentDashboard: null,
    stopRequested: false
  }
  const hosts = config.connection?.active === '6b6t' ? uniqueHosts(config) : [config.bot.host]
  let hostIndex = 0
  let attempt = 1

  const stop = () => {
    if (runtime.stopRequested) return
    runtime.stopRequested = true
    runtime.currentBot?.quit('Process stop requested')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  while (!runtime.stopRequested) {
    const sessionConfig = JSON.parse(JSON.stringify(config))
    sessionConfig.__meta = config.__meta
    sessionConfig.bot.host = hosts[hostIndex] || config.bot.host
    if (attempt > 1) console.log(`[RECONNECT] Starting attempt ${attempt}/${reconnect.maxAttempts}.`)

    const session = await runSession(sessionConfig, attempt, runtime)
    console.log(`[SESSION] attempt=${attempt} host=${sessionConfig.bot.host} end=${session.endReason} spawned=${session.spawned}`)

    if (runtime.stopRequested || session.manualAction === 'disconnect') break
    if (!reconnect.enabled && session.manualAction !== 'reconnect') break
    if (!session.spawned && attempt >= reconnect.maxAttempts && session.manualAction !== 'reconnect') {
      console.log(`[RECONNECT] Stopping after ${attempt} failed startup attempts.`)
      break
    }

    if (!session.spawned && hosts.length > 1) {
      const previousHost = hosts[hostIndex]
      hostIndex = (hostIndex + 1) % hosts.length
      console.log(`[6B6T-HOSTS] Switching host after failed startup: ${previousHost} -> ${hosts[hostIndex]}`)
    }

    const retryDelayMs = getReconnectDelayMs(reconnect, session)
    console.log(`[RECONNECT] Retrying in ${retryDelayMs}ms.`)
    await delay(retryDelayMs)
    attempt = session.spawned ? 1 : attempt + 1
  }
}

module.exports = { createBot, getReconnectConfig, getReconnectDelayMs, runConnectionManager, uniqueHosts }




