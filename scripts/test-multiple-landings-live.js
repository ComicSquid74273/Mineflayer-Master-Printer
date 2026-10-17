'use strict'

const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const {
  startElytraFlight,
  stopElytraFlight,
  clearElytraControls,
  createFlightTelemetry,
  resolveAnchorLandingTarget,
  moveToLandingApproach,
  descendOntoLandingPad
} = require('../src/elytra-flight')
const {
  flyToCheckpoint,
  generateLandingTransitCheckpoints,
  getSkywayAltitude
} = require('../src/flight-trajectory-planner')
const { ensureElytra, hasElytraEquipped } = require('../src/gear-restock')
const { getStorageRegistrationForBot } = require('../src/printer-runtime')

const QUEUE_FILE = path.resolve(process.cwd(), 'dashboard-service', 'data', 'files.json')
const QUEUE_PAYLOAD_DIR = path.resolve(process.cwd(), 'dashboard-service', 'data', 'files')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findChunkSliceAtPosition(position) {
  if (!fs.existsSync(QUEUE_FILE)) return null
  const chunkX = Math.floor(position.x / 16)
  const chunkZ = Math.floor(position.z / 16)
  const records = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
  for (const record of records) {
    if (!record.storedName) continue
    const payloadPath = path.join(QUEUE_PAYLOAD_DIR, record.storedName)
    if (!fs.existsSync(payloadPath)) continue
    const chunkSlice = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
    if (Number(chunkSlice.chunkX) === chunkX && Number(chunkSlice.chunkZ) === chunkZ) return chunkSlice
  }
  return null
}

async function runSingleLandingSequence(bot, landingTarget, stationAnchor, chunkSlice, config, sequenceNum) {
  console.log(`\n========================================`)
  console.log(`[LANDING-TEST] STARTING SEQUENCE #${sequenceNum}`)
  console.log(`========================================`)

  const limits = {
    horizontalBlocksPerSecond: Number(config.elytraFly?.horizontalSpeed || 2) * 20,
    verticalBlocksPerSecond: Number(config.elytraFly?.verticalSpeed || 2) * 10,
    absoluteHorizontalBlocksPerSecond: Math.max(40, Number(config.elytraFly?.horizontalSpeed || 2) * 20),
    glideHeight: Number(config.elytraFly?.glideHeight || 5)
  }

  // 1. Takeoff from ground
  stopElytraFlight(bot)
  clearElytraControls(bot)
  startElytraFlight(bot)

  const telemetry = createFlightTelemetry(bot, limits, {})

  try {
    if (bot.entity.onGround) {
      if (typeof bot.setControlState === 'function') {
        bot.setControlState('jump', true)
        await delay(200)
        bot.setControlState('jump', false)
      }
      try { bot.elytrafly.sendStartStopPacket?.() } catch {}
      await delay(200)
    }

    // 2. Climb vertically above the active chunk, then cruise horizontally above the station.
    const skywayY = getSkywayAltitude(stationAnchor, chunkSlice, config.elytraFly)
    const checkpoints = generateLandingTransitCheckpoints(bot.entity.position, landingTarget, skywayY, Number(config.elytraFly?.horizontalSpeed || 2), {
      verticalSpeed: Number(config.elytraFly?.verticalSpeed || 2)
    })
    console.log(`[LANDING-TEST #${sequenceNum}] Safe transit via Y${skywayY}; ${checkpoints.length} checkpoint(s).`)
    for (const checkpoint of checkpoints) {
      await flyToCheckpoint(bot, checkpoint, { horizontalTolerance: 0.75, verticalTolerance: 0.25 })
    }

    // 3. Preserve safe altitude until horizontally aligned over the verified pad.
    await moveToLandingApproach(bot, landingTarget, telemetry, limits)
    console.log(`[LANDING-TEST #${sequenceNum}] Arrived overhead at ${bot.entity.position.y.toFixed(2)}; descending...`)

    // 4. Descend and enter glide mode at the configured height.
    await descendOntoLandingPad(bot, landingTarget, telemetry, limits)

    console.log(`[LANDING-TEST #${sequenceNum}] Landed! Pos: ${bot.entity.position}; onGround=${bot.entity.onGround}; health=${bot.health}/20`)

    if (bot.health < 20) {
      throw new Error(`Bot took damage during landing sequence #${sequenceNum}! Health: ${bot.health}/20`)
    }
    if (!bot.entity.onGround) {
      throw new Error(`Bot is not on ground after landing sequence #${sequenceNum}!`)
    }

    return { success: true, health: bot.health }
  } finally {
    clearElytraControls(bot)
    stopElytraFlight(bot)
    telemetry.stop()
  }
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  console.log('[LANDING-TEST] Connecting ComicBot to live test server...')

  const bot = createBot(config)

  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[LANDING-TEST] ComicBot spawned at ${bot.entity.position}; health=${bot.health}/20`)

      // Ensure Elytra
      const reg = getStorageRegistrationForBot(bot.username)
      await ensureElytra(bot, reg)
      if (!hasElytraEquipped(bot)) throw new Error('Elytra could not be equipped!')

      const anchor = config.storageRegistration?.anchor || { x: -326, y: 97, z: -100 }
      const landingTarget = resolveAnchorLandingTarget(bot, anchor)
      if (!landingTarget) throw new Error('Could not resolve landing target pad!')
      const chunkSlice = findChunkSliceAtPosition(bot.entity.position) || {
        bounds: { maxY: Math.ceil(bot.entity.position.y) }
      }

      console.log(`[LANDING-TEST] Landing pad target: ${landingTarget.x}, ${landingTarget.y}, ${landingTarget.z}`)
      console.log(`[LANDING-TEST] Departure chunk: ${chunkSlice.key || 'unknown'}; build max Y${chunkSlice.bounds?.maxY ?? 'unknown'}`)

      // Run multiple landing sequences (3 consecutive landings)
      const totalSequences = 3
      for (let s = 1; s <= totalSequences; s++) {
        await runSingleLandingSequence(bot, landingTarget, anchor, chunkSlice, config, s)
        await delay(2000)
      }

      console.log(`\n========================================`)
      console.log(`[LANDING-TEST] ALL ${totalSequences} LANDING SEQUENCES PASSED PERFECTLY WITH ZERO FALL DAMAGE!`)
      console.log(`[LANDING-TEST] Final health: ${bot.health}/20`)
      console.log(`========================================`)

      bot.quit('Landing tests complete')
      process.exit(0)
    } catch (err) {
      console.error('[LANDING-TEST-ERROR]', err)
      try { bot.quit('Test failed') } catch {}
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
