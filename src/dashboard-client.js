'use strict'

const http = require('http')
const https = require('https')
const os = require('os')
const { toNumber } = require('./config')
const { registerStorage } = require('./storage-registration')

function requestJson(urlValue, method, body = null, timeoutMs = 10000) {
  const target = new URL(urlValue)
  const transport = target.protocol === 'https:' ? https : http
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const headers = { accept: 'application/json' }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: Math.max(1000, toNumber(timeoutMs, 10000))
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let responseBody = null
        try {
          responseBody = text ? JSON.parse(text) : null
        } catch {
          responseBody = null
        }
        const result = { statusCode: Number(response.statusCode || 0), body: responseBody, text }
        if (result.statusCode >= 400) {
          reject(new Error(responseBody?.error || `dashboard request failed: ${method} ${target.pathname} (${result.statusCode})`))
          return
        }
        resolve(result)
      })
    })
    request.on('timeout', () => request.destroy(new Error(`dashboard request timeout: ${method} ${urlValue}`)))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function getDashboardConfig(config) {
  const raw = config.dashboard || {}
  return {
    enabled: raw.enabled === true,
    serviceUrl: String(raw.serviceUrl || 'http://127.0.0.1:4080').trim().replace(/\/$/, ''),
    hostLabel: String(raw.hostLabel || process.env.COMPUTERNAME || os.hostname() || 'unknown-host').trim(),
    heartbeatMs: Math.max(1000, toNumber(raw.heartbeatMs, 5000)),
    commandPollMs: Math.max(1000, toNumber(raw.commandPollMs, 3000))
  }
}

function summarizeInventory(bot) {
  const counts = {}
  for (const item of bot.inventory?.items?.() || []) {
    const key = item.name || item.displayName || String(item.type)
    counts[key] = (counts[key] || 0) + Number(item.count || 0)
  }
  return {
    capturedAt: new Date().toISOString(),
    itemCount: Object.values(counts).reduce((total, count) => total + count, 0),
    items: counts
  }
}

function createDashboardClient(bot, config, options = {}) {
  const dashboard = getDashboardConfig(config)
  const botName = String(config.bot?.username || bot.username || 'ComicBot').trim()
  const state = {
    stopped: false,
    online: false,
    phase: 'connecting',
    statusDetail: 'connecting',
    reconnectState: 'connecting',
    lastError: null,
    lastErrorAt: null,
    currentStructure: '',
    recentChat: [],
    heartbeatTimer: null,
    commandTimer: null,
    lastWarningAt: 0
  }

  function warn(message) {
    if (Date.now() - state.lastWarningAt < 30000) return
    state.lastWarningAt = Date.now()
    console.log(`[DASHBOARD-WARN] ${message}`)
  }

  function setPhase(phase, detail = phase) {
    state.phase = phase
    state.statusDetail = detail
  }

  function setError(error) {
    state.lastError = String(error?.message || error || '').trim() || null
    state.lastErrorAt = state.lastError ? new Date().toISOString() : null
  }

  function addChat(message) {
    const text = String(message || '').trim()
    if (!text) return
    const now = new Date().toISOString()
    state.recentChat.push({
      ts: now,
      at: now,
      text,
      message: text
    })
    state.recentChat = state.recentChat.slice(-30)
  }

  function buildStatus(onlineOverride = null) {
    const now = new Date().toISOString()
    const online = onlineOverride == null ? state.online : onlineOverride
    const position = bot.entity?.position
    const dimension = bot.game?.dimension || bot.game?.worldName || 'unknown'
    const ping = bot.players?.[bot.username]?.ping
    return {
      botName,
      runtime: 'mineflayer-master-printer',
      runtimeInstanceId: options.runtimeInstanceId || null,
      runtimeStartedAt: options.runtimeStartedAt || null,
      configFileName: config.__meta?.configFileName || null,
      hostLabel: dashboard.hostLabel,
      connection: config.connection?.selected || config.connection?.active || null,
      connectedHost: String(config.bot?.host || '').trim() || null,
      online,
      phase: state.phase,
      statusDetail: state.statusDetail,
      health: Number.isFinite(Number(bot.health)) ? Number(bot.health) : 0,
      hunger: Number.isFinite(Number(bot.food)) ? Number(bot.food) : 0,
      activeState: online ? (state.phase === 'paused' ? 'paused' : 'idle') : 'offline',
      location: dimension,
      locationDetail: position ? `${dimension} @ ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : dimension,
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      idle: state.phase !== 'printing',
      heartbeatAt: now,
      role: 'single',
      recoveryState: 'none',
      reconnectState: state.reconnectState,
      reconnectCount: Math.max(0, toNumber(options.sessionNumber, 1) - 1),
      reconnectStreak: state.reconnectState === 'reconnecting' ? Math.max(0, toNumber(options.sessionNumber, 1) - 1) : 0,
      currentNbt: bot.activeChunkJob ? (bot.activeChunkJob.fileName || `${bot.activeChunkJob.structureName} [chunk ${bot.activeChunkJob.key}]`) : state.currentStructure,
      statusDetail: bot.activeChunkJob ? `printing chunk ${bot.activeChunkJob.key} (${bot.placedBlocksCount || 0}/${bot.activeChunkJob.blockCount || 0} blocks)` : state.statusDetail,
      lastStatusAt: now,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      warnings: [],
      alerts: [],
      recentChat: state.recentChat,
      latencyMs: Number.isFinite(Number(ping)) ? Number(ping) : null,
      clientState: bot?._client?.state || null
    }
  }

  async function postStatus(onlineOverride = null) {
    if (!dashboard.enabled || !dashboard.serviceUrl) return
    try {
      await requestJson(`${dashboard.serviceUrl}/api/bots/status`, 'POST', buildStatus(onlineOverride))
    } catch (error) {
      warn(error?.message || error)
    }
  }

  async function reportCommand(commandId, status, resultMessage, extra = {}) {
    await requestJson(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(commandId)}/result`, 'POST', {
      status,
      resultMessage,
      ...extra
    })
  }

  async function executeCommand(command) {
    switch (command.commandType) {
      case 'chat':
        if (!command.message) throw new Error('chat command is missing a message')
        bot.chat(String(command.message))
        addChat(`[${bot.username}] ${command.message}`)
        return { message: 'chat message sent' }
      case 'start':
        if (typeof options.onStart === 'function') {
          const res = await options.onStart(command)
          return { message: res?.message || 'printing started' }
        }
        return { message: 'start command acknowledged' }
      case 'stop':
        if (typeof options.onStop === 'function') {
          const res = await options.onStop(command)
          return { message: res?.message || 'printing stopped' }
        }
        setPhase('paused', command.reason || 'paused from dashboard')
        return { message: 'runtime paused' }
      case 'inventory-snapshot':
        return { message: 'inventory snapshot captured', extra: { inventory: summarizeInventory(bot) } }
      case 'register-storage': {
        setPhase('registering-storage', 'travelling to anchor and scanning storage')
        try {
          const storageRegistration = await registerStorage(bot, config, command.payload || {})
          return {
            message: `registered ${storageRegistration.summary.registeredContainerCount} storage container(s), ${storageRegistration.summary.dumpContainerCount} dump chest(s), and ${storageRegistration.summary.materialTypeCount} material type(s)`,
            extra: { storageRegistration }
          }
        } finally {
          setPhase('idle', 'connected; waiting for schematic printer implementation')
        }
      }
      case 'disconnect':
        return { message: 'disconnect requested', after: () => options.onDisconnect?.() }
      case 'reconnect':
        return { message: 'reconnect requested', after: () => options.onReconnect?.() }
      case 'verify':
        return { message: 'verification command acknowledged' }
      default:
        throw new Error(`${command.commandType} is unavailable during the connection/dashboard-only phase`)
    }
  }

  async function pollCommands() {
    if (state.stopped || !state.online || !dashboard.enabled) return
    try {
      const pending = await requestJson(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands`, 'GET')
      for (const item of pending.body?.items || []) {
        const claimed = await requestJson(`${dashboard.serviceUrl}/api/bots/${encodeURIComponent(botName)}/commands/${encodeURIComponent(item.commandId)}/claim`, 'POST')
        const command = claimed.body?.command
        if (!command) continue
        try {
          const result = await executeCommand(command)
          await reportCommand(command.commandId, 'succeeded', result.message, result.extra)
          result.after?.()
        } catch (error) {
          await reportCommand(command.commandId, 'failed', error?.message || String(error))
        }
      }
      if (['idle', 'error', 'recovering'].includes(state.phase) && typeof options.checkAutoStart === 'function') {
        options.checkAutoStart()
      }
    } catch (error) {
      warn(error?.message || error)
    }
  }

  function schedule(key, delayMs, work) {
    const run = async () => {
      if (state.stopped) return
      await work()
      if (state.stopped) return
      state[key] = setTimeout(run, delayMs)
      state[key].unref?.()
    }
    state[key] = setTimeout(run, delayMs)
    state[key].unref?.()
  }

  async function start() {
    if (!dashboard.enabled) return
    const { recoverActiveJobsOnStartup } = require('./job-manager')
    bot.once('spawn', () => {
      recoverActiveJobsOnStartup(bot, config).catch(() => {})
    })
    await postStatus()
    schedule('heartbeatTimer', dashboard.heartbeatMs, () => postStatus())
    schedule('commandTimer', dashboard.commandPollMs, () => pollCommands())
  }

  async function stop(online = false) {
    if (state.stopped) return
    state.stopped = true
    if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
    if (state.commandTimer) clearTimeout(state.commandTimer)
    state.online = online
    state.reconnectState = online ? state.reconnectState : 'disconnected'
    await postStatus(online)
  }

  return { addChat, postStatus, setError, setPhase, start, state, stop }
}

module.exports = { createDashboardClient, getDashboardConfig, requestJson }

