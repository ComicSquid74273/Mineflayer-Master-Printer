'use strict'

const { toNumber } = require('./config')

function getChatLoginPassword(config) {
  const botConfig = config.bot || {}
  return String(
    botConfig.loginPassword ||
    botConfig.password ||
    botConfig.chatLoginPassword ||
    process.env.MINECRAFT_LOGIN_PASSWORD ||
    process.env.NERV_LOGIN_PASSWORD ||
    ''
  ).trim()
}

function normalizePatterns(value, fallback) {
  return (Array.isArray(value) && value.length ? value : fallback)
    .map((entry) => String(entry).toLowerCase())
    .filter(Boolean)
}

function installChatLogin(bot, config) {
  const botConfig = config.bot || {}
  const login = botConfig.chatLogin || config.chatLogin || {}
  const offlineAuth = String(botConfig.auth || 'offline').toLowerCase() === 'offline'
  const required = login.enabled !== false && (login.offlineOnly === false || offlineAuth)
  const password = getChatLoginPassword(config)
  const state = {
    enabled: login.enabled !== false && required && Boolean(password),
    loggedIn: false,
    attempts: 0,
    lastSentAt: 0,
    password,
    loginCommand: String(login.command || '/login').trim() || '/login',
    registrationCommand: String(login.registrationCommand || '/register').trim() || '/register',
    promptPatterns: normalizePatterns(login.promptPatterns, ['please login', '/login <password>', 'use /login']),
    registrationPromptPatterns: normalizePatterns(login.registrationPromptPatterns, ['please register', '/register <password> <password>', 'use /register']),
    successPatterns: normalizePatterns(login.successPatterns, ['you are now logged in', 'successfully logged in', 'logged in successfully', 'successfully registered']),
    minDelayMs: Math.max(0, toNumber(login.minDelayMs, 750)),
    retryMs: Math.max(1000, toNumber(login.retryMs, 5000)),
    maxAttempts: Math.max(1, toNumber(login.maxAttempts, 5)),
    autoSendOnSpawn: login.autoSendOnSpawn === true
  }
  bot.__masterPrinterChatLogin = state

  if (!state.enabled) {
    if (login.enabled !== false && required && !password) console.log('[CHAT-LOGIN] Login support is enabled, but no password is configured.')
    return state
  }

  function send(commandType, reason) {
    if (state.loggedIn || state.attempts >= state.maxAttempts) return false
    const now = Date.now()
    if (now - state.lastSentAt < state.retryMs) return false
    const registration = commandType === 'register'
    const command = registration ? state.registrationCommand : state.loginCommand
    const message = registration ? `${command} ${state.password} ${state.password}` : `${command} ${state.password}`
    state.attempts += 1
    state.lastSentAt = now
    console.log(`[CHAT-LOGIN] Sending ${command} attempt ${state.attempts}/${state.maxAttempts} reason=${reason}.`)
    const timer = setTimeout(() => {
      if (state.loggedIn || bot?._client?.state === 'disconnected') return
      try {
        bot.chat(message)
      } catch (error) {
        console.log(`[CHAT-LOGIN-WARN] ${error?.message || error}`)
      }
    }, state.minDelayMs)
    timer.unref?.()
    return true
  }

  bot.on('messagestr', (message) => {
    const text = String(message || '').toLowerCase()
    if (state.successPatterns.some((pattern) => text.includes(pattern))) {
      state.loggedIn = true
      console.log('[CHAT-LOGIN] Login confirmed by server message.')
      return
    }
    if (state.loggedIn) return
    if (state.registrationPromptPatterns.some((pattern) => text.includes(pattern))) {
      send('register', 'registration-prompt')
      return
    }
    if (state.promptPatterns.some((pattern) => text.includes(pattern))) send('login', 'login-prompt')
  })

  if (state.autoSendOnSpawn) bot.on('spawn', () => send('login', 'spawn-auto'))
  return state
}

module.exports = { installChatLogin }
