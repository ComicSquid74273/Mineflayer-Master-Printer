'use strict'

const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { createDashboardClient } = require('../src/dashboard-client')
const {
  claimQueueChunkById,
  downloadQueueFile,
  parseChunkSliceData,
  storeLocalChunkJson,
  reportQueueResult,
  completeChunkJob
} = require('../src/job-manager')
const { printChunkSlice } = require('../src/printer')
const { travelToAnchor } = require('../src/elytra-flight')
const {
  flyToCheckpoint,
  generateLandingTransitCheckpoints,
  getSkywayAltitude
} = require('../src/flight-trajectory-planner')

const PLATFORM_ANCHOR = { x: -326, y: 97, z: -100 }
const QUEUE_FILE = path.resolve(process.cwd(), 'dashboard-service', 'data', 'files.json')
const REG_FILE = path.resolve(process.cwd(), 'dashboard-service', 'data', 'storage-registrations.json')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getArgument(name, fallback = null) {
  const prefix = `${name}=`
  const entry = process.argv.slice(2).find((a) => a.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : fallback
}

function listEligiblePendingChunks(availableMaterials) {
  const records = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
  const pending = records.filter((r) => {
    if (r.queueStatus === 'pending') return true
    return r.claimedByBotName === 'ComicBot' && ['claimed', 'downloaded', 'printing', 'held'].includes(r.queueStatus)
  })
  const eligible = []

  for (const record of pending) {
    const payloadPath = path.resolve(process.cwd(), 'dashboard-service', 'data', 'files', record.storedName)
    if (!fs.existsSync(payloadPath)) continue
    const chunkData = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
    const mats = Object.keys(chunkData.materials || {})
    if (mats.length > 0 && mats.every((m) => availableMaterials.has(m))) {
      eligible.push({ record, chunkData })
    }
  }
  // Resume owned work first; otherwise start from North-West (minimum chunkX, then minimum chunkZ).
  const statusPriority = { printing: 0, held: 1, downloaded: 2, claimed: 3, pending: 4 }
  eligible.sort((a, b) => {
    const statusDelta = (statusPriority[a.record.queueStatus] ?? 4) - (statusPriority[b.record.queueStatus] ?? 4)
    return statusDelta || a.chunkData.chunkX - b.chunkData.chunkX || a.chunkData.chunkZ - b.chunkData.chunkZ
  })
  return eligible
}

async function main() {
  const maxChunks = Math.max(1, Number(getArgument('--max-chunks', '2')))
  const bps = Math.max(1, Math.min(30, Number(getArgument('--bps', getArgument('--speed-bps', '20')))))
  const targetFileId = String(getArgument('--file-id', '') || '').trim()
  const debugLogging = process.argv.includes('--debug') || process.argv.includes('--verbose')
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }

  console.log(`[MULTI-PRINT] Starting multi-chunk print run (target: up to ${maxChunks} chunk(s))...`)

  // Load storage registration
  if (!fs.existsSync(REG_FILE)) {
    throw new Error(`Storage registration file not found at ${REG_FILE}`)
  }
  const registrations = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'))
  const registration = registrations['ComicBot'] || Object.values(registrations)[0]
  if (!registration) throw new Error('No storage registration found for ComicBot')
  const availableMaterials = new Set(Object.keys(registration.materialIndex || {}))
  console.log(`[MULTI-PRINT] Available registered materials: ${Array.from(availableMaterials).join(', ')}`)

  const eligibleChunks = listEligiblePendingChunks(availableMaterials)
    .filter(({ record }) => !targetFileId || record.fileId === targetFileId)
  if (eligibleChunks.length === 0) {
    console.log('[MULTI-PRINT] No eligible pending chunks found in queue.')
    process.exit(0)
  }

  console.log(`[MULTI-PRINT] Found ${eligibleChunks.length} eligible chunk(s) in queue. Will process up to ${maxChunks}.`)

  // Connect ComicBot
  console.log(`[MULTI-PRINT] Connecting ComicBot to ${config.bot.host}:${config.bot.port}...`)
  const bot = createBot(config)

  const cleanup = () => {
    try { bot.quit('Process exit') } catch {}
    try { bot.__releaseRuntimeLock?.() } catch {}
  }
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  bot.once('spawn', async () => {
    let activeRecord = null
    try {
      await delay(2000)
      console.log(`[MULTI-PRINT] Spawned at ${bot.entity.position}; onGround=${bot.entity.onGround}`)

      const dashboard = createDashboardClient(bot, config, {
        runtimeInstanceId: `multi-print-${process.pid}`,
        runtimeStartedAt: new Date().toISOString(),
        sessionNumber: 1
      })
      dashboard.state.online = true
      dashboard.state.reconnectState = 'connected'
      await dashboard.postStatus()
      const heartbeat = setInterval(() => dashboard.postStatus().catch(() => {}), 3000)
      heartbeat.unref?.()

      let completedChunksCount = 0
      let lastPrintedChunk = null
      for (let i = 0; i < Math.min(maxChunks, eligibleChunks.length); i++) {
        const { record, chunkData } = eligibleChunks[i]
        activeRecord = record
        console.log(`\n========================================`)
        console.log(`[MULTI-PRINT] STARTING CHUNK [${i + 1}/${maxChunks}]: ${record.originalName} (${chunkData.blockCount} blocks, key: ${chunkData.key})`)
        console.log(`========================================`)

        // 1. Claim queue chunk
        dashboard.setPhase('claiming', `claiming chunk ${chunkData.key}`)
        await dashboard.postStatus()
        const claimed = await claimQueueChunkById(config, bot.username, record.fileId)
        if (!claimed) {
          console.log(`[MULTI-PRINT-WARN] Could not claim ${record.fileId}; skipping.`)
          continue
        }

        // 2. Download and store local chunk JSON
        const buffer = await downloadQueueFile(config, bot.username, record.fileId)
        const parsedChunk = parseChunkSliceData(buffer, record.originalName) || chunkData
        parsedChunk.fileId = record.fileId
        parsedChunk.fileName = record.originalName
        const localJsonPath = storeLocalChunkJson(parsedChunk)
        parsedChunk.localJsonPath = localJsonPath
        bot.activeChunkJob = parsedChunk
        await reportQueueResult(config, bot.username, record.fileId, 'printing')
        dashboard.setPhase('printing', `printing chunk ${parsedChunk.key}`)
        await dashboard.postStatus()

        // Print owns checkpoint recovery, inventory restock, and top-entry flight.
        dashboard.setPhase('printing', `placing blocks for chunk ${parsedChunk.key}`)
        await dashboard.postStatus()
        const printResult = await printChunkSlice(bot, config, parsedChunk, {
          confirmTimeoutMs: 6000,
          blocksPerSecond: bps,
          debug: debugLogging,
          storageRegistration: registration,
          completeChunkJob: false
        })
        lastPrintedChunk = parsedChunk

        console.log(`[MULTI-PRINT] Chunk ${parsedChunk.key} placed: ${printResult.placedCount}/${printResult.totalBlocks} blocks.`)

        // 7. Complete chunk and report
        await completeChunkJob(bot, config, parsedChunk.key, {
          fileId: record.fileId,
          localJsonPath
        })
        completedChunksCount++
        activeRecord = null
        console.log(`[MULTI-PRINT] Chunk ${parsedChunk.key} completed successfully!`)
      }

      // Return to platform and land safely
      console.log('\n[MULTI-PRINT] All requested chunks finished. Returning to storage platform...')
      dashboard.setPhase('returning', 'returning to storage platform with ElytraFly')
      await dashboard.postStatus()
      const horizontalSpeed = Number(config.elytraFly?.horizontalSpeed || 2)
      const verticalSpeed = Number(config.elytraFly?.verticalSpeed || 2)
      const skywayY = getSkywayAltitude(PLATFORM_ANCHOR, lastPrintedChunk, {
        ...config.elytraFly,
        stationMaxY: registration.platformBounds?.maxY
      })
      const stationTarget = { x: PLATFORM_ANCHOR.x + 0.5, y: PLATFORM_ANCHOR.y + 1, z: PLATFORM_ANCHOR.z + 0.5 }
      const returnCheckpoints = generateLandingTransitCheckpoints(bot.entity.position, stationTarget, skywayY, horizontalSpeed, { verticalSpeed })
      console.log(`[MULTI-PRINT] Safe return via Y${skywayY}; ${returnCheckpoints.length} transit checkpoint(s) before landing.`)
      for (const checkpoint of returnCheckpoints) {
        await flyToCheckpoint(bot, checkpoint, { horizontalTolerance: 0.75, verticalTolerance: 0.25 })
      }
      await travelToAnchor(bot, PLATFORM_ANCHOR, {
        horizontalSpeed,
        verticalSpeed,
        glideHeight: Number(config.elytraFly?.glideHeight || 5)
      })
      await delay(1000)

      console.log(`[MULTI-PRINT] Safely landed on platform at: ${bot.entity.position}; onGround=${bot.entity.onGround}; health=${bot.health}`)
      dashboard.setPhase('idle', `finished ${completedChunksCount} chunk(s); safely landed on platform`)
      await dashboard.postStatus()

      console.log(`\n[MULTI-PRINT] SUCCESS: Processed and verified ${completedChunksCount} chunk(s) live!`)
      clearInterval(heartbeat)
      bot.quit('Multi-chunk run complete')
      bot.__releaseRuntimeLock?.()
      process.exit(0)
    } catch (err) {
      console.error('[MULTI-PRINT-ERROR]', err)
      if (activeRecord?.fileId) {
        await reportQueueResult(config, bot.username, activeRecord.fileId, 'failed', err?.message || String(err)).catch(() => {})
      }
      try { bot.quit('Run failed') } catch {}
      try { bot.__releaseRuntimeLock?.() } catch {}
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
