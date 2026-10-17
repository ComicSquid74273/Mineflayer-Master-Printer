'use strict'

const { once } = require('node:events')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const {
  engageElytraHover,
  equipElytra,
  getElytraTickListenerCount,
  startElytraFlight,
  travelToAnchor
} = require('../src/elytra-flight')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function connectBot(config, label) {
  const bot = createBot(config)
  const timeout = setTimeout(() => bot.quit(`${label} spawn timeout`), 30000)
  try {
    await Promise.race([
      once(bot, 'spawn'),
      once(bot, 'end').then(([reason]) => { throw new Error(`${label} ended before spawn: ${reason}`) })
    ])
    await delay(1500)
    console.log(`[RECONNECT-LIVE] ${label} spawned at ${bot.entity.position}; onGround=${bot.entity.onGround}.`)
    return bot
  } finally {
    clearTimeout(timeout)
  }
}

async function launchAndHover(bot, climbBlocks = 12) {
  await equipElytra(bot)
  if (!bot.entity.onGround) {
    const hover = engageElytraHover(bot)
    console.log(`[RECONNECT-LIVE] Recovered existing airborne position at ${bot.entity.position}; targetY=${hover.targetY.toFixed(3)} listeners=${hover.listenerCount}.`)
    return
  }
  const startY = bot.entity.position.y
  startElytraFlight(bot)
  bot.setControlState('jump', true)
  await delay(250)
  bot.setControlState('jump', false)
  bot.elytrafly.sendStartStopPacket?.()
  bot.elytrafly.setControlState('up', true)
  const deadline = Date.now() + 15000
  while (bot.entity.position.y < startY + climbBlocks && Date.now() < deadline) {
    await delay(100)
  }
  bot.elytrafly.setControlState('up', false)
  engageElytraHover(bot)
  if (bot.entity.onGround) throw new Error('Elytra takeoff failed; bot remained on the ground.')
  console.log(`[RECONNECT-LIVE] Hover established at ${bot.entity.position}; listeners=${getElytraTickListenerCount(bot)}.`)
}

async function measureStableHover(bot, durationMs, label) {
  const samples = []
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (!bot.entity) throw new Error(`${label} lost its entity during hover.`)
    samples.push(bot.entity.position.y)
    const listenerCount = getElytraTickListenerCount(bot)
    if (listenerCount !== 1) throw new Error(`${label} has ${listenerCount} ElytraFly physics listeners; expected exactly 1.`)
    await delay(100)
  }
  const minimumY = Math.min(...samples)
  const maximumY = Math.max(...samples)
  const drift = maximumY - minimumY
  console.log(`[RECONNECT-LIVE] ${label} hover range=${minimumY.toFixed(3)}..${maximumY.toFixed(3)} drift=${drift.toFixed(3)} over ${(durationMs / 1000).toFixed(1)}s.`)
  if (drift > 1.5) throw new Error(`${label} altitude drifted ${drift.toFixed(3)} blocks.`)
  return { minimumY, maximumY, drift }
}

async function simulateCrash(bot) {
  const ended = once(bot, 'end')
  const socket = bot?._client?.socket
  if (socket && typeof socket.destroy === 'function') socket.destroy()
  else bot._client.end('Simulated mid-air crash')
  await Promise.race([
    ended,
    delay(10000).then(() => { throw new Error('Timed out waiting for simulated crash disconnect.') })
  ])
  await delay(1500)
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  const landingAnchor = config.storageRegistration?.anchor || { x: -326, y: 97, z: -100 }
  let activeBot = null

  try {
    activeBot = await connectBot(config, 'initial bot')
    await launchAndHover(activeBot)
    await measureStableHover(activeBot, 15000, 'pre-crash')
    const crashPosition = { ...activeBot.entity.position }
    console.log(`[RECONNECT-LIVE] Simulating a hard client crash in air at ${activeBot.entity.position}.`)
    await simulateCrash(activeBot)
    activeBot = null

    activeBot = await connectBot(config, 'restarted bot')
    const reconnectPosition = activeBot.entity.position
    const reconnectDistance = Math.hypot(
      reconnectPosition.x - crashPosition.x,
      reconnectPosition.y - crashPosition.y,
      reconnectPosition.z - crashPosition.z
    )
    console.log(`[RECONNECT-LIVE] Reconnected ${reconnectDistance.toFixed(3)} blocks from crash position; onGround=${activeBot.entity.onGround}; listeners=${getElytraTickListenerCount(activeBot)}.`)
    if (activeBot.entity.onGround) throw new Error('Restarted bot unexpectedly reached the ground before anti-fall recovery.')
    await measureStableHover(activeBot, 20000, 'post-reconnect')

    console.log(`[RECONNECT-LIVE] Landing with ElytraFly at anchor ${landingAnchor.x},${landingAnchor.y},${landingAnchor.z}.`)
    await travelToAnchor(activeBot, landingAnchor, { horizontalSpeed: 2, verticalSpeed: 2 })
    if (!activeBot.entity.onGround) throw new Error('Landing returned without onGround=true.')
    console.log(`[RECONNECT-LIVE] PASS: stable reconnect hover and safe landing at ${activeBot.entity.position}.`)
    activeBot.quit('Reconnect live test passed')
    await delay(500)
  } catch (error) {
    console.error(`[RECONNECT-LIVE-ERROR] ${error?.stack || error}`)
    if (activeBot?.entity?.onGround) {
      try { activeBot.quit('Reconnect live test failed on ground') } catch { }
    } else if (activeBot?.entity) {
      try {
        engageElytraHover(activeBot)
        console.error(`[RECONNECT-LIVE-SAFETY] Bot remains connected in hover at ${activeBot.entity.position}; it was not disconnected in air.`)
      } catch { }
    }
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`[RECONNECT-LIVE-FATAL] ${error?.stack || error}`)
  process.exitCode = 1
})
