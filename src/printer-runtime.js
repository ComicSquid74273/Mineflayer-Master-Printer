'use strict'

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { isInsidePlatformBounds, DEFAULT_ANCHOR } = require('./storage-registration')
const {
  hasPickaxe,
  hasElytraEquipped,
  getElytraRemainingDurability,
  isElytraLowDurability,
  getGoldenAppleCount,
  prepareEssentialGear
} = require('./gear-restock')
const {
  claimQueueChunkById,
  downloadQueueFile,
  parseChunkSliceData,
  storeLocalChunkJson,
  reportQueueResult,
  completeChunkJob,
  loadPrintProgress
} = require('./job-manager')
const { printChunkSlice, isAboveStationLandingColumn, returnLowDurabilityElytraToStation } = require('./printer')
const { getSkywayAltitude, generateLandingTransitCheckpoints, flyToCheckpoint } = require('./flight-trajectory-planner')
const { travelToAnchor } = require('./elytra-flight')

const storedChunkCache = new Map()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startEmergencyElytraMonitor(bot, stationAnchor, dashboard, options = {}) {
  const intervalMs = Math.max(50, Number(options.intervalMs || 100))
  const returnToStation = options.returnToStation || returnLowDurabilityElytraToStation
  const check = () => {
    if (!bot.__printingChunkActive || bot.__elytraEmergencyRestockRequested || !isElytraLowDurability(bot)) return
    bot.__elytraEmergencyRestockRequested = true
    bot.__interruptPrintRequested = true
    const remaining = getElytraRemainingDurability(bot)
    console.error(`[ELYTRA-EMERGENCY] Durability=${remaining}; interrupting flight/printing immediately and returning to restock.`)
    dashboard?.setPhase('emergency-restock', `Elytra durability ${remaining}; returning for replacement`)
    void dashboard?.postStatus().catch(() => {})
    bot.__elytraEmergencyReturnPromise = Promise.resolve(returnToStation(bot, stationAnchor, {}, {
      warn: (message) => console.error(`[ELYTRA-EMERGENCY] ${message}`),
      info: (message) => console.log(`[ELYTRA-EMERGENCY] ${message}`),
      debug: () => {}
    })).catch((error) => {
      bot.__elytraEmergencyReturnError = error
      console.error(`[ELYTRA-EMERGENCY] Return failed: ${error.message}`)
      return false
    })
  }
  const timer = setInterval(check, intervalMs)
  timer.unref?.()
  check()
  return () => clearInterval(timer)
}

function readStoredChunk(payloadPath) {
  const modifiedAt = fs.statSync(payloadPath).mtimeMs
  const cached = storedChunkCache.get(payloadPath)
  if (cached?.modifiedAt === modifiedAt) return cached.chunk
  const chunk = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
  storedChunkCache.set(payloadPath, { modifiedAt, chunk })
  return chunk
}

function buildStructureBoundsByName(chunks) {
  const boundsByName = new Map()
  for (const chunk of chunks) {
    const structureName = String(chunk?.structureName || '').trim()
    const bounds = chunk?.structureBounds || chunk?.bounds
    if (!structureName || !bounds) continue
    const current = boundsByName.get(structureName) || {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY
    }
    current.minX = Math.min(current.minX, Number(bounds.minX))
    current.maxX = Math.max(current.maxX, Number(bounds.maxX))
    current.minY = Math.min(current.minY, Number(bounds.minY))
    current.maxY = Math.max(current.maxY, Number(bounds.maxY))
    current.minZ = Math.min(current.minZ, Number(bounds.minZ))
    current.maxZ = Math.max(current.maxZ, Number(bounds.maxZ))
    boundsByName.set(structureName, current)
  }
  return boundsByName
}

function restoreChunkPlanningMetadata(chunk, queuedChunk) {
  return {
    ...chunk,
    bounds: chunk?.bounds || queuedChunk?.bounds || null,
    structureBounds: chunk?.structureBounds || queuedChunk?.structureBounds || null
  }
}

function getDashboardDataDir(cwd = process.cwd(), configuredDataDir = process.env.DASHBOARD_DATA_DIR) {
  const candidates = [
    configuredDataDir ? path.resolve(configuredDataDir) : null,
    path.resolve(cwd, "..", "Mineflayer-Master-Printer", "dashboard-service", "data"),
    path.resolve(cwd, "dashboard-service", "data"),
    "D:\\Project\\Mineflayer-Master-Printer\\dashboard-service\\data"
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

function getStorageRegistrationForBot(botName) {
  const regFile = path.resolve(getDashboardDataDir(), 'storage-registrations.json')
  if (!fs.existsSync(regFile)) return null
  try {
    const registrations = JSON.parse(fs.readFileSync(regFile, 'utf8'))
    return registrations[botName] || Object.values(registrations)[0] || null
  } catch {
    return null
  }
}

function queueRecordMatchesBot(record, botName) {
  const normalizedBot = String(botName || '').trim()
  const claimedBot = String(record?.claimedByBotName || '').trim()
  if (claimedBot && ['claimed', 'downloaded', 'printing', 'held'].includes(record?.queueStatus)) {
    return claimedBot === normalizedBot
  }
  const assignedBot = String(record?.targetBotName || record?.assignedBotName || '').trim()
  if (assignedBot && assignedBot !== normalizedBot) return false
  return true
}

function listEligiblePendingChunks(botName, availableMaterials) {
  const queueFile = path.resolve(getDashboardDataDir(), 'files.json')
  if (!fs.existsSync(queueFile)) return []
  try {
    const records = JSON.parse(fs.readFileSync(queueFile, 'utf8'))
    const chunksByStoredName = new Map()
    for (const record of records) {
      const payloadPath = path.resolve(getDashboardDataDir(), 'files', record.storedName)
      if (!fs.existsSync(payloadPath)) continue
      chunksByStoredName.set(record.storedName, readStoredChunk(payloadPath))
    }
    const structureBoundsByName = buildStructureBoundsByName(chunksByStoredName.values())
    const pending = records.filter((r) => {
      if (!queueRecordMatchesBot(r, botName)) return false
      if (r.queueStatus === 'pending') return true
      return r.claimedByBotName === botName && ['claimed', 'downloaded', 'printing', 'held'].includes(r.queueStatus)
    })
    const eligible = []
    for (const record of pending) {
      const chunkData = chunksByStoredName.get(record.storedName)
      if (!chunkData) continue
      if (!chunkData.structureBounds) chunkData.structureBounds = structureBoundsByName.get(chunkData.structureName) || null
      const mats = Object.keys(chunkData.materials || {})
      if (mats.length === 0 || mats.every((m) => availableMaterials.has(m))) {
        eligible.push({ record, chunkData })
      }
    }
    const statusPriority = { printing: 0, downloaded: 1, claimed: 2, pending: 3 }
    eligible.sort((a, b) => {
      const aAssigned = (a.record.targetBotName === botName || a.record.assignedBotName === botName) ? 0 : 1
      const bAssigned = (b.record.targetBotName === botName || b.record.assignedBotName === botName) ? 0 : 1
      const assignDelta = aAssigned - bAssigned
      if (assignDelta !== 0) return assignDelta
      const statusDelta = (statusPriority[a.record.queueStatus] ?? 4) - (statusPriority[b.record.queueStatus] ?? 4)
      return statusDelta || a.chunkData.chunkX - b.chunkData.chunkX || a.chunkData.chunkZ - b.chunkData.chunkZ
    })
    return eligible
  } catch {
    return []
  }
}

function selectNextChunkForPrinting(bot, eligibleChunks, options = {}) {
  const activeChunk = bot?.activeChunkJob
  if (!activeChunk) return eligibleChunks[0] || null
  const match = eligibleChunks.find(({ record, chunkData }) => {
    return (activeChunk.fileId && record.fileId === activeChunk.fileId) ||
      (activeChunk.key && chunkData.key === activeChunk.key)
  })
  if (match) return match
  const completedList = options.completedChunks || (Array.isArray(bot?.completedChunks) ? bot.completedChunks : null)
  if (completedList && completedList.some((c) => (c.key || c) === activeChunk.key)) {
    return eligibleChunks[0] || null
  }
  return null
}

async function ensureBotGears(bot, registration, config) {
  const pickaxe = hasPickaxe(bot)
  const elytra = hasElytraEquipped(bot)
  const elytraRemaining = getElytraRemainingDurability(bot)
  const elytraReady = elytra && !isElytraLowDurability(bot)
  const gapples = getGoldenAppleCount(bot)

  if (pickaxe && elytraReady && gapples >= 64) {
    console.log(`[GEAR-CHECK] All essential gear verified: pickaxe=present, elytra=equipped (${elytraRemaining ?? 'unknown'} durability), goldenApples=${gapples}/64.`)
    return { ready: true }
  }

  console.log(`[GEAR-CHECK] Essential gear needs restock (pickaxe=${pickaxe}, elytra=${elytra}, elytraRemaining=${elytraRemaining ?? 'none'}, goldenApples=${gapples}/64).`)
  if (!registration) {
    console.log('[GEAR-CHECK-WARN] No storage registration found to retrieve missing gear.')
    return { ready: false, reason: 'missing-registration' }
  }
  const anchor = registration.anchor || { x: -326, y: 97, z: -100 }
  const horizontalDist = bot.entity?.position ? Math.hypot(bot.entity.position.x - anchor.x, bot.entity.position.z - anchor.z) : Infinity
  if (!bot.entity?.position || (!isInsidePlatformBounds(bot.entity.position, anchor) && horizontalDist > 16)) {
    if (!elytraReady && await teleportMissingGearBotToStation(bot, anchor)) {
      console.log('[GEAR-CHECK] Missing-gear recovery arrived inside the restock platform.')
    } else {
      console.log('[GEAR-CHECK] Bot is outside the restock platform; deferring gear replacement to the chunk top-exit restock route.')
      return { ready: false, reason: 'deferred-to-print-restock' }
    }
  }

  const gearResult = await prepareEssentialGear(bot, registration, config)
  console.log('[GEAR-CHECK] Essential gear retrieved successfully:', JSON.stringify(gearResult))
  return {
    ready: hasPickaxe(bot) && hasElytraEquipped(bot) && !isElytraLowDurability(bot) && getGoldenAppleCount(bot) >= 64,
    gearResult
  }
}

async function startPrinting(bot, config, dashboard, options = {}) {
  if (bot.__printingActive) {
    console.log('[PRINTER-RUNTIME] Print loop is already active.')
    return { started: false, message: 'printing is already active' }
  }

  bot.__printingActive = true
  bot.__stopPrintingRequested = false
  bot.__interruptPrintRequested = false
  bot.__elytraEmergencyRestockRequested = false
  bot.__elytraEmergencyReturnPromise = null
  bot.__elytraEmergencyReturnError = null

  try {
    const registration = getStorageRegistrationForBot(bot.username)
    if (!registration) {
      console.log(`[PRINTER-RUNTIME] Warning: No storage registration found for ${bot.username}.`)
    }
    const anchor = registration?.anchor || DEFAULT_ANCHOR
    if (bot.entity?.position && isAboveStationLandingColumn(bot.entity.position, anchor, 16) && !isInsidePlatformBounds(bot.entity.position, anchor)) {
      console.log('[PRINTER-RUNTIME] Above restock platform column; descending directly onto pad...')
      await travelToAnchor(bot, anchor, {
        horizontalSpeed: Number(config.elytraFly?.horizontalSpeed || 2),
        verticalSpeed: Number(config.elytraFly?.verticalSpeed || 2),
        glideHeight: Number(config.elytraFly?.glideHeight || 5)
      })
    }
    const availableMaterials = new Set(Object.keys(registration?.materialIndex || {}))

    // 1. User requirement: if bot has no gear (pickaxe, enchanted golden apple, elytra), get them before starting printing!
    dashboard?.setPhase('gear-prep', 'ensuring pickaxe, enchanted golden apples, and elytra')
    await dashboard?.postStatus().catch(() => {})
    await ensureBotGears(bot, registration, config)

    // 2. Loop through eligible chunks
    let completedCount = 0
    let lastChunk = null
    const maxChunks = Number(options.maxChunks || 100)

    while (!bot.__stopPrintingRequested && completedCount < maxChunks) {
      const eligibleChunks = listEligiblePendingChunks(bot.username, availableMaterials)
      if (eligibleChunks.length === 0) {
        console.log('[PRINTER-RUNTIME] No more eligible pending chunks in queue.')
        dashboard?.setPhase('idle', 'no pending chunks in queue')
        await dashboard?.postStatus().catch(() => {})
        break
      }

      const completedList = Array.isArray(loadPrintProgress()?.completedChunks) ? loadPrintProgress().completedChunks : []
      const selectedChunk = selectNextChunkForPrinting(bot, eligibleChunks, { completedChunks: completedList })
      if (!selectedChunk) {
        throw new Error(`Recovered chunk ${bot.activeChunkJob?.key || 'unknown'} is not available in the queue; refusing to claim a different chunk.`)
      }
      const { record, chunkData } = selectedChunk
      const isRecoveredChunk = Boolean(bot.activeChunkJob) && (
        (bot.activeChunkJob.fileId && bot.activeChunkJob.fileId === record.fileId) ||
        bot.activeChunkJob.key === chunkData.key
      )
      console.log(`\n========================================`)
      console.log(`[PRINTER-RUNTIME] ${isRecoveredChunk ? 'Resuming' : 'Claiming'} chunk: ${record.originalName} (${chunkData.blockCount} blocks, key: ${chunkData.key})`)
      console.log(`========================================`)

      dashboard?.setPhase(isRecoveredChunk ? 'recovering' : 'claiming', `${isRecoveredChunk ? 'resuming' : 'claiming'} chunk ${chunkData.key}`)
      await dashboard?.postStatus().catch(() => {})
      let parsedChunk
      if (isRecoveredChunk) {
        parsedChunk = {
          ...chunkData,
          ...bot.activeChunkJob
        }
      } else {
        const claimed = await claimQueueChunkById(config, bot.username, record.fileId)
        if (!claimed) {
          console.log(`[PRINTER-RUNTIME-WARN] Could not claim ${record.fileId}; retrying next.`)
          await delay(1000)
          continue
        }
        const buffer = await downloadQueueFile(config, bot.username, record.fileId)
        parsedChunk = parseChunkSliceData(buffer, record.originalName) || chunkData
      }
      parsedChunk = restoreChunkPlanningMetadata(parsedChunk, chunkData)
      lastChunk = parsedChunk
      parsedChunk.fileId = record.fileId
      parsedChunk.fileName = record.originalName
      const localJsonPath = storeLocalChunkJson(parsedChunk) || parsedChunk.localJsonPath
      parsedChunk.localJsonPath = localJsonPath
      bot.activeChunkJob = parsedChunk
      await reportQueueResult(config, bot.username, record.fileId, 'printing')

      // Print chunk slice at configured printing speed (default 30 blocks/sec, distinct from flight speed!)
      const printBps = Number(config.printer?.blocksPerSecond || 30)
      console.log(`[PRINTER-RUNTIME] Starting printing chunk ${parsedChunk.key} at ${printBps} blocks/sec...`)
      dashboard?.setPhase('printing', `printing chunk ${parsedChunk.key} at ${printBps}bps`)
      await dashboard?.postStatus().catch(() => {})
      bot.__printingChunkActive = true
      const stopElytraMonitor = startEmergencyElytraMonitor(bot, registration?.anchor || DEFAULT_ANCHOR, dashboard)
      let printResult
      try {
        printResult = await printChunkSlice(bot, config, parsedChunk, {
          blocksPerSecond: printBps,
          storageRegistration: registration,
          completeChunkJob: false,
          skipUnconfirmed: true
        })
      } finally {
        bot.__printingChunkActive = false
        stopElytraMonitor()
      }

      if (printResult.interruptedReason === 'elytra-restock') {
        const returnPromise = bot.__elytraEmergencyReturnPromise || returnLowDurabilityElytraToStation(
          bot,
          registration?.anchor || DEFAULT_ANCHOR,
          {},
          {
            warn: (message) => console.error(`[ELYTRA-EMERGENCY] ${message}`),
            info: (message) => console.log(`[ELYTRA-EMERGENCY] ${message}`),
            debug: () => {}
          }
        )
        const returned = await returnPromise
        const returnError = bot.__elytraEmergencyReturnError
        if (returnError) throw returnError
        if (!returned && !isInsidePlatformBounds(bot.entity?.position, registration?.anchor || DEFAULT_ANCHOR)) {
          throw new Error('Emergency Elytra replacement could not reach the restock platform.')
        }
        bot.__interruptPrintRequested = false
        await ensureBotGears(bot, registration, config)
        bot.__elytraEmergencyRestockRequested = false
        bot.__elytraEmergencyReturnPromise = null
        bot.__elytraEmergencyReturnError = null
        dashboard?.setPhase('recovering', `Elytra replaced; resuming chunk ${parsedChunk.key}`)
        await dashboard?.postStatus().catch(() => {})
        continue
      }

      if (printResult.placedCount !== printResult.totalBlocks) {
        throw new Error(`Chunk ${parsedChunk.key} stopped incomplete at ${printResult.placedCount}/${printResult.totalBlocks}; completion was not reported.`)
      }

      // Complete chunk
      await completeChunkJob(bot, config, parsedChunk.key, {
        fileId: record.fileId,
        localJsonPath
      })
      completedCount++
      bot.__printingAutoRetryFailures = 0
      bot.__printingAutoRetryAt = 0
      console.log(`[PRINTER-RUNTIME] Chunk ${parsedChunk.key} completed successfully! Placed ${printResult.placedCount}/${printResult.totalBlocks} blocks.`)
    }

    // If finished all chunks or stopped, safely return to restock station via skyway top-exit
    if (registration?.anchor) {
      console.log('[PRINTER-RUNTIME] Returning to restock station platform via skyway...')
      dashboard?.setPhase('returning', 'returning to restock platform via skyway')
      await dashboard?.postStatus().catch(() => {})
      const skywayY = getSkywayAltitude(registration.anchor, lastChunk, {
        ...(config.elytraFly || {}),
        stationMaxY: registration.platformBounds?.maxY
      })
      const stationTarget = new Vec3(registration.anchor.x + 0.5, registration.anchor.y + 1, registration.anchor.z + 0.5)
      const horizontalSpeed = Number(config.elytraFly?.horizontalSpeed || 2)
      const verticalSpeed = Number(config.elytraFly?.verticalSpeed || 2)
      const stationCheckpoints = generateLandingTransitCheckpoints(bot.entity.position, stationTarget, skywayY, horizontalSpeed, { verticalSpeed })
      for (const checkpoint of stationCheckpoints) await flyToCheckpoint(bot, checkpoint)
      // Final soft landing on station pad with 5-block glide mode
      await travelToAnchor(bot, registration.anchor, {
        horizontalSpeed,
        verticalSpeed,
        glideHeight: Number(config.elytraFly?.glideHeight || 5)
      })
      dashboard?.setPhase('idle', `completed ${completedCount} chunk(s); landed safely at restock platform`)
      await dashboard?.postStatus().catch(() => {})
    }

    return { started: true, completedCount }
  } catch (err) {
    const retryFailures = Math.min(6, Number(bot.__printingAutoRetryFailures || 0) + 1)
    const retryDelayMs = Math.min(60000, 5000 * (2 ** (retryFailures - 1)))
    bot.__printingAutoRetryFailures = retryFailures
    bot.__printingAutoRetryAt = Date.now() + retryDelayMs
    console.error('[PRINTER-RUNTIME-ERROR]', err)
    console.error(`[PRINTER-RUNTIME] Automatic retry delayed ${retryDelayMs}ms after failure ${retryFailures}.`)
    dashboard?.setError(err.message)
    dashboard?.setPhase('error', `printer error: ${err.message}`)
    await dashboard?.postStatus().catch(() => {})
    return { started: false, error: err.message }
  } finally {
    bot.__printingActive = false
  }
}

function stopPrinting(bot, dashboard, reason = 'stopped by dashboard') {
  bot.__stopPrintingRequested = true
  bot.__interruptPrintRequested = true
  dashboard?.setPhase('paused', reason)
  console.log(`[PRINTER-RUNTIME] Printing stopped: ${reason}`)
  return { stopped: true }
}

function canAutoStartAtCurrentPosition(bot, anchor) {
  return Boolean(bot.activeChunkJob) || isInsidePlatformBounds(bot.entity?.position, anchor) || isAboveStationLandingColumn(bot.entity?.position, anchor, 16)
}

async function teleportMissingGearBotToStation(bot, anchor, timeoutMs = 12000) {
  if (!bot.entity?.position || !bot.entity.onGround || typeof bot.chat !== 'function') return false
  bot.pathfinder?.setGoal?.(null)
  bot.clearControlStates?.()
  if (bot.entity.velocity?.set) bot.entity.velocity.set(0, 0, 0)
  console.log('[GEAR-CHECK] Elytra is unavailable outside the station; requesting stationary /home platform recovery.')
  bot.chat('/home platform')
  const deadline = Date.now() + Math.max(3000, Number(timeoutMs || 12000))
  while (Date.now() < deadline) {
    if (isInsidePlatformBounds(bot.entity?.position, anchor)) return true
    await delay(100)
  }
  return false
}

function checkAutoStartPrinting(bot, config, dashboard) {
  if (bot.__printingActive || bot.__stopPrintingRequested) return false
  if (dashboard?.state?.phase === 'paused') return false
  if (Date.now() < Number(bot.__printingAutoRetryAt || 0)) return false

  const anchor = config.storageRegistration?.anchor || DEFAULT_ANCHOR
  const recovering = Boolean(bot.activeChunkJob)
  if (!canAutoStartAtCurrentPosition(bot, anchor)) return false

  const registration = getStorageRegistrationForBot(bot.username)
  const availableMaterials = new Set(Object.keys(registration?.materialIndex || {}))
  const eligibleChunks = listEligiblePendingChunks(bot.username, availableMaterials)

  if (eligibleChunks.length > 0) {
    console.log(`[AUTO-START] ${bot.username} ${recovering ? `has recovered chunk ${bot.activeChunkJob.key}` : 'is inside restock station bounding box'} and has ${eligibleChunks.length} eligible chunk(s) in queue. Auto-starting print...`)
    void startPrinting(bot, config, dashboard)
    return true
  }

  return false
}

module.exports = {
  buildStructureBoundsByName,
  canAutoStartAtCurrentPosition,
  checkAutoStartPrinting,
  ensureBotGears,
  getDashboardDataDir,
  getStorageRegistrationForBot,
  listEligiblePendingChunks,
  queueRecordMatchesBot,
  restoreChunkPlanningMetadata,
  selectNextChunkForPrinting,
  startEmergencyElytraMonitor,
  startPrinting,
  stopPrinting,
  teleportMissingGearBotToStation
}
