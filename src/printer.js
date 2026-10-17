'use strict'

const { Vec3 } = require('vec3')
const {
  updateChunkPlacementProgress,
  completeChunkJob,
  loadPrintProgress,
  savePrintProgress
} = require('./job-manager')
const {
  getGoldenAppleCount,
  getElytraRemainingDurability,
  hasElytraEquipped,
  hasPickaxe,
  isElytraLowDurability,
  prepareEssentialGear,
  setSneaking,
  walkNear
} = require('./gear-restock')
const { isInsidePlatformBounds } = require('./storage-registration')
const {
  MAX_FLIGHT_ALTITUDE_Y,
  disableElytraHover,
  engageElytraHover,
  setElytraVerticalControl,
  startElytraFlight,
  stopElytraFlight,
  travelToAnchor
} = require('./elytra-flight')
const { TpsScaledActionBudget } = require('./tps-budget')
const { getPrintingHotbarCoverage, isAirBlock, prefetchPrintingHotbar } = require('./inventory-manager')
const {
  FlightCheckpoint,
  getSkywayAltitude,
  generateLandingTransitCheckpoints,
  generateObstacleAwareReentryCheckpoints,
  generateLayerPrintPlan,
  generateMacroTransitCheckpoints,
  findVerticalShaftEscapePath,
  flyToCheckpoint,
  isDirectFlightClear,
  resolveSafeLayerCheckpoint
} = require('./flight-trajectory-planner')

const LAYER_PATH_PLAN_VERSION = 3
const CLIENT_TICK_MS = 50
const DEFAULT_EYE_HEIGHT = 1.62
const MIN_PLACEMENT_BODY_CLEARANCE = 0.75
const LAYER_VERTICAL_TOLERANCE = 0.1
const VERIFICATION_FAIRNESS_PACKET_INTERVAL = 6

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForCheckpointChunk(bot, checkpoint, timeoutMs = 8000) {
  const target = new Vec3(Math.floor(checkpoint.x), Math.floor(checkpoint.y), Math.floor(checkpoint.z))
  if (bot.blockAt(target)) return true
  const deadline = Date.now() + Math.max(250, Number(timeoutMs || 8000))
  if (typeof bot.waitForChunksToLoad === 'function') {
    await Promise.race([
      bot.waitForChunksToLoad().catch(() => {}),
      delay(Math.min(1000, Math.max(0, deadline - Date.now())))
    ])
  }
  while (Date.now() < deadline) {
    if (bot.blockAt(target)) return true
    await delay(50)
  }
  throw new Error(`Chunk data did not load around checkpoint ${target} within ${timeoutMs}ms.`)
}

const ADJACENT_FACES = [
  { dir: new Vec3(0, -1, 0), opposite: new Vec3(0, 1, 0), faceId: 0 },
  { dir: new Vec3(0, 1, 0), opposite: new Vec3(0, -1, 0), faceId: 1 },
  { dir: new Vec3(0, 0, -1), opposite: new Vec3(0, 0, 1), faceId: 2 },
  { dir: new Vec3(0, 0, 1), opposite: new Vec3(0, 0, -1), faceId: 3 },
  { dir: new Vec3(-1, 0, 0), opposite: new Vec3(1, 0, 0), faceId: 4 },
  { dir: new Vec3(1, 0, 0), opposite: new Vec3(-1, 0, 0), faceId: 5 }
]

let globalDebugLogging = false

function setDebugLogging(enabled) {
  globalDebugLogging = Boolean(enabled)
}

function isDebugLogging() {
  return globalDebugLogging
}

function createPrinterLogger(options = {}, config = {}) {
  const isDebug = options.debug === true ||
    options.verbose === true ||
    config?.printer?.debugLogging === true ||
    config?.printer?.debugLogs === true ||
    globalDebugLogging

  return {
    isDebug,
    info: (msg) => console.log(`[PRINTER] ${msg}`),
    debug: (msg) => { if (isDebug) console.log(`[PRINTER-DEBUG] ${msg}`) },
    warn: (msg) => console.log(`[PRINTER-WARN] ${msg}`),
    error: (msg) => console.error(`[PRINTER-ERROR] ${msg}`)
  }
}

function normalizeBlockName(name) {
  return String(name || '').replace(/^minecraft:/, '')
}

function isUsableItemStack(item, itemName) {
  return normalizeBlockName(item?.name) === normalizeBlockName(itemName) && Number(item?.count ?? 1) > 0
}

function createBlockWaiter(bot, targetVec, predicate, expectedDescription, timeoutMs = 5000) {
  const eventName = `blockUpdate:${targetVec}`
  let cancel = () => {}
  const promise = new Promise((resolve, reject) => {
    let settled = false
    let timeout = null
    let poll = null
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      if (poll) clearInterval(poll)
      bot.removeListener?.(eventName, onUpdate)
    }
    const finish = (error, block) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(block)
    }
    const check = (block) => {
      if (!predicate(block)) return false
      finish(null, block)
      return true
    }
    const onUpdate = (_oldBlock, newBlock) => check(newBlock)

    if (check(bot.blockAt(targetVec))) return
    bot.on?.(eventName, onUpdate)
    poll = setInterval(() => check(bot.blockAt(targetVec)), 50)
    poll.unref?.()
    timeout = setTimeout(() => {
      const actual = bot.blockAt(targetVec)
      finish(new Error(`Server did not confirm ${expectedDescription} at ${targetVec}; actual block is ${actual?.name || 'unloaded'}.`))
    }, Math.max(250, Number(timeoutMs) || 5000))
    cancel = (error) => finish(error || new Error(`Cancelled block confirmation at ${targetVec}.`))
  })
  return { promise, cancel }
}

function waitForExpectedBlock(bot, targetVec, targetName, timeoutMs = 5000) {
  const expectedName = normalizeBlockName(targetName)
  return createBlockWaiter(
    bot,
    targetVec,
    (block) => normalizeBlockName(block?.name) === expectedName,
    expectedName,
    timeoutMs
  ).promise
}

function installServerTpsTracker(bot) {
  if (bot.__printerTpsTracker) return bot.__printerTpsTracker
  const tracker = {
    sampledTps: 20,
    hasMeasurement: false,
    lastPacketAt: Date.now(),
    lastServerAge: null
  }
  bot._client?.on?.('time', (packet) => {
    const now = Date.now()
    const serverAge = Number(packet?.age)
    if (Number.isFinite(serverAge) && Number.isFinite(tracker.lastServerAge) && serverAge > tracker.lastServerAge) {
      const elapsedSeconds = Math.max(0.001, (now - tracker.lastPacketAt) / 1000)
      const measuredTps = Math.max(0.1, Math.min(20, (serverAge - tracker.lastServerAge) / elapsedSeconds))
      tracker.sampledTps = tracker.hasMeasurement
        ? (tracker.sampledTps * 0.7) + (measuredTps * 0.3)
        : measuredTps
      tracker.hasMeasurement = true
    }
    tracker.lastServerAge = Number.isFinite(serverAge) ? serverAge : tracker.lastServerAge
    tracker.lastPacketAt = now
  })
  bot.__printerTpsTracker = tracker
  return tracker
}

function readServerTpsSample(bot) {
  const explicitTps = Number(bot.time?.tps)
  if (Number.isFinite(explicitTps) && explicitTps > 0) {
    return { tps: Math.min(20, explicitTps), secondsSinceServerTick: 0 }
  }
  const tracker = installServerTpsTracker(bot)
  return {
    tps: tracker.sampledTps,
    secondsSinceServerTick: tracker.hasMeasurement ? Math.max(0, (Date.now() - tracker.lastPacketAt) / 1000) : 0
  }
}

async function waitForPlacementCredits(bot, budget, logger) {
  while (!bot.__interruptPrintRequested) {
    const now = Date.now()
    const elapsedWindowMs = bot.__printerBudgetWindowAt ? now - bot.__printerBudgetWindowAt : CLIENT_TICK_MS
    if (budget.remainingThisTick > 0 && elapsedWindowMs < CLIENT_TICK_MS) return budget.remainingThisTick
    if (elapsedWindowMs < CLIENT_TICK_MS) {
      await delay(CLIENT_TICK_MS - elapsedWindowMs)
      continue
    }
    const sample = readServerTpsSample(bot)
    const granted = budget.beginTick(sample.tps, sample.secondsSinceServerTick)
    bot.__printerBudgetWindowAt = Date.now()
    if (budget.paused && bot.__printerBudgetPauseReason !== budget.pauseReason) {
      logger.warn(`Placement budget paused: ${budget.pauseReason}; TPS=${sample.tps.toFixed(2)}, tickAge=${sample.secondsSinceServerTick.toFixed(2)}s.`)
    } else if (!budget.paused && bot.__printerBudgetPauseReason && bot.__printerBudgetPauseReason !== 'NONE') {
      logger.info(`Placement budget resumed; TPS=${sample.tps.toFixed(2)}.`)
    }
    bot.__printerBudgetPauseReason = budget.pauseReason
    if (granted > 0) return granted
  }
  return 0
}

async function waitForPlacementPacketSlots(packetTimes, requested, options = {}) {
  const limit = Math.max(1, Math.min(30, Math.floor(Number(options.limit || 30))))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const sleep = typeof options.delay === 'function' ? options.delay : delay
  const wanted = Math.max(1, Math.floor(Number(requested || 1)))
  while (true) {
    const currentTime = now()
    const cutoff = currentTime - 1000
    while (packetTimes.length > 0 && packetTimes[0] <= cutoff) packetTimes.shift()
    const available = limit - packetTimes.length
    if (available > 0) return Math.min(wanted, available)
    await sleep(Math.max(1, packetTimes[0] + 1000 - currentTime))
  }
}

function getEyeToBlockCenterDistance(bot, block) {
  const eyeHeight = Number(bot.entity?.eyeHeight ?? DEFAULT_EYE_HEIGHT)
  const eyePosition = bot.entity.position.offset(0, eyeHeight, 0)
  const blockCenter = new Vec3(Number(block.x) + 0.5, Number(block.y) + 0.5, Number(block.z) + 0.5)
  return eyePosition.distanceTo(blockCenter)
}

function canDispatchVerificationRepair(bot, target, maxPlacementReach) {
  return isPlacementTargetBelowBot(bot, target) && getEyeToBlockCenterDistance(bot, target) <= maxPlacementReach
}

function shouldDispatchVerificationBeforePrimary(options = {}) {
  if (options.hasReachableVerification !== true) return false
  if (options.primaryRemaining === false) return true
  if (Number(options.primaryPacketsSinceVerification || 0) >= VERIFICATION_FAIRNESS_PACKET_INTERVAL) return true
  return Boolean(
    options.currentCheckpointKey &&
    options.nextCheckpointKey &&
    options.currentCheckpointKey !== options.nextCheckpointKey
  )
}

function requiresSerialConfirmation(itemName) {
  return normalizeBlockName(itemName) === 'beacon'
}

function isPlacementTargetBelowBot(bot, block, minimumClearance = MIN_PLACEMENT_BODY_CLEARANCE) {
  const botY = Number(bot.entity?.position?.y)
  const blockTopY = Number(block?.y) + 1
  return Number.isFinite(botY) && Number.isFinite(blockTopY) && blockTopY <= botY - Math.max(0, Number(minimumClearance || 0))
}

function assertPlacementTargetBelowBot(bot, block) {
  if (isPlacementTargetBelowBot(bot, block)) return
  const error = new Error(`Placement target ${block.x},${block.y},${block.z} is not below bot Y${Number(bot.entity?.position?.y).toFixed(2)}.`)
  error.code = 'PLACEMENT_TARGET_NOT_BELOW_BOT'
  throw error
}

function isAboveStationLandingColumn(position, target, maxHorizontalDistance = 8) {
  if (![position?.x, position?.y, position?.z, target?.x, target?.y, target?.z].every((value) => Number.isFinite(Number(value)))) return false
  return Number(position.y) >= Number(target.y) && Math.hypot(Number(position.x) - Number(target.x), Number(position.z) - Number(target.z)) <= Math.max(0, Number(maxHorizontalDistance))
}

function isInsideChunkColumn(position, chunkX, chunkZ) {
  if (![position?.x, position?.z, chunkX, chunkZ].every((value) => Number.isFinite(Number(value)))) return false
  return Math.floor(Number(position.x) / 16) === Number(chunkX) && Math.floor(Number(position.z) / 16) === Number(chunkZ)
}

function getLocalRecoveryEnvelope(currentY, targetY, maxPathingY = 322) {
  const current = Number(currentY)
  const target = Number(targetY)
  const maximum = Number(maxPathingY)
  const verticalMarginY = Math.max(4, Math.min(8, maximum - Math.max(current, target)))
  return {
    verticalMarginY,
    ceilingY: Math.min(maximum, Math.max(current, target) + verticalMarginY)
  }
}

function countInventoryItem(bot, itemName) {
  const targetName = normalizeBlockName(itemName)
  return (bot.inventory?.items?.() || []).reduce((count, item) => {
    return normalizeBlockName(item.name) === targetName ? count + Number(item.count || 0) : count
  }, 0)
}

function sameBlockIdentity(left, right) {
  if (!left || !right) return false
  return Number(left.x) === Number(right.x) &&
    Number(left.y) === Number(right.y) &&
    Number(left.z) === Number(right.z) &&
    normalizeBlockName(left.name) === normalizeBlockName(right.name)
}

function getEyePosition(bot) {
  return bot.entity.position.offset(0, Number(bot.entity.eyeHeight ?? DEFAULT_EYE_HEIGHT), 0)
}

function getBlockCenter(block) {
  return new Vec3(Number(block.x) + 0.5, Number(block.y) + 0.5, Number(block.z) + 0.5)
}

function enableAntiFallHover(bot) {
  if (!bot || bot.__antiFallInstalled) return
  bot.__antiFallInstalled = true

  const checkAndHover = () => {
    const isPrinting = Boolean(bot.activeChunkJob || loadPrintProgress()?.activeChunk)
    const inAir = bot.entity?.onGround === false

    if (inAir && isPrinting && !bot.__checkpointFlightActive) {
      if (bot.elytrafly) {
    try {
          const checkpointY = Number(bot.elytrafly?.__meteorController?.goal?.y)
          const hover = engageElytraHover(bot, Number.isFinite(checkpointY) ? { targetY: checkpointY } : {})
          console.log(`[ANTI-FALL] Engaged elytra hover at ${bot.entity?.position}; targetY=${hover.targetY}, listeners=${hover.listenerCount}, isPrinting=${isPrinting}.`)
        } catch (err) {
          console.log(`[ANTI-FALL-WARN] Failed engaging hover: ${err.message}`)
        }
      }
    }
  }

  bot.on('spawn', () => {
    setTimeout(checkAndHover, 1000)
  })
}

async function flyCheckpointSequence(bot, checkpoints, logger, options = {}) {
  const checkpointFlight = typeof options.flyToCheckpoint === 'function' ? options.flyToCheckpoint : flyToCheckpoint
  const flightOptions = { ...options }
  delete flightOptions.flyToCheckpoint
  for (const checkpoint of checkpoints) {
    logger.debug(`Flying ${checkpoint.phase} checkpoint at ${checkpoint.x.toFixed(1)},${checkpoint.y.toFixed(1)},${checkpoint.z.toFixed(1)} Meteor horizontal-speed=${checkpoint.horizontalSpeed}.`)
    const attempts = Math.max(1, Math.floor(Number(options.checkpointAttempts || 2)))
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
        await checkpointFlight(bot, checkpoint, flightOptions)
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < attempts) {
          logger.warn(`Checkpoint ${checkpoint.phase} stalled on attempt ${attempt}/${attempts}: ${error.message}. Retrying flight controls.`)
          await delay(250)
        }
      }
    }
    if (lastError) throw lastError
  }
}

function getMissingPrintingGear(bot) {
  const missing = []
  if (!hasPickaxe(bot)) missing.push('pickaxe')
  if (!hasElytraEquipped(bot)) missing.push('elytra')
  else if (isElytraLowDurability(bot)) missing.push(`Elytra durability below 10 (${getElytraRemainingDurability(bot)} remaining)`)
  if (getGoldenAppleCount(bot) < 1) missing.push('golden apple')
  return missing
}

async function ensurePrintingGear(bot, storageRegistration, config, options, logger) {
  const missingBefore = getMissingPrintingGear(bot)
  if (missingBefore.length === 0) return
  logger.info(`Missing printing gear: ${missingBefore.join(', ')}; retrieving at restock station.`)
  await prepareEssentialGear(bot, storageRegistration, config, options)
  const missingAfter = getMissingPrintingGear(bot)
  if (missingAfter.length > 0) throw new Error(`Printing gear is still missing after restock: ${missingAfter.join(', ')}.`)
}

async function returnLowDurabilityElytraToStation(bot, stationAnchor, options = {}, logger = createPrinterLogger(options)) {
  if (!isElytraLowDurability(bot) || isInsidePlatformBounds(bot.entity?.position, stationAnchor)) return false
  if (typeof bot.chat !== 'function') throw new Error('Low-durability Elytra cannot reach restock station and /home platform is unavailable.')

  const timeoutMs = Math.max(3000, Number(options.homePlatformTimeoutMs || 8000))
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let nextRequestAt = 0
  let homeNotSet = false
  const onChat = (message) => {
    const text = String(message || '')
    if (text.includes('Error: You have not set a home') || text.includes('not set a home with the name "platform"')) {
      homeNotSet = true
    }
  }
  bot.on?.('messagestr', onChat)
  logger.warn(`Elytra durability is ${getElytraRemainingDurability(bot)}; using /home platform instead of risking a flight failure.`)

  try {
    while (Date.now() < deadline && !homeNotSet) {
      if (isInsidePlatformBounds(bot.entity?.position, stationAnchor)) {
        stopElytraFlight(bot)
        bot.clearControlStates?.()
        logger.info('Arrived inside restock platform bounds through /home platform.')
        return true
      }
      if (Date.now() >= nextRequestAt && attempts < 2) {
        attempts += 1
        bot.chat('/home platform')
        nextRequestAt = Date.now() + 4000
      }
      await delay(100)
    }
  } finally {
    bot.removeListener?.('messagestr', onChat)
  }

  logger.warn('Home "platform" did not teleport bot; falling back to flight detour to station.')
  return false
}

async function executeRestockDetour(bot, config, chunkSlice, restockPlan, storageRegistration, resumeCheckpoint, options = {}, logger = createPrinterLogger(options, config)) {
  const { executeMaterialRestock, organizePrintingHotbar } = require('./inventory-manager')
  const stationAnchor = storageRegistration.anchor || { x: -326, y: 97, z: -100 }
  const stationTarget = new Vec3(stationAnchor.x + 0.5, stationAnchor.y + 1, stationAnchor.z + 0.5)
  await returnLowDurabilityElytraToStation(bot, stationAnchor, options, logger)
  const horizontalSpeed = Number(config?.elytraFly?.horizontalSpeed || 2)
  const verticalSpeed = Number(config?.elytraFly?.verticalSpeed || 2)
  const skywayY = getSkywayAltitude(stationAnchor, chunkSlice, {
    ...(config?.elytraFly || {}),
    stationMaxY: storageRegistration?.platformBounds?.maxY
  })
  const stationDistance = bot.entity?.position?.distanceTo(new Vec3(stationAnchor.x, stationAnchor.y, stationAnchor.z)) ?? Number.POSITIVE_INFINITY
  const insideStation = Boolean(bot.entity?.position) && isInsidePlatformBounds(bot.entity.position, stationAnchor)
  const aboveLandingColumn = isAboveStationLandingColumn(bot.entity?.position, stationTarget)

  if (insideStation) {
    stopElytraFlight(bot)
    bot.clearControlStates?.()
    try { bot.chat('/sethome platform') } catch {}
    const landingTarget = storageRegistration?.landingTarget || {}
    const centerPad = new Vec3(
      Number(landingTarget.x ?? stationAnchor.x + 0.5),
      Number(landingTarget.y ?? stationAnchor.y + 1),
      Number(landingTarget.z ?? stationAnchor.z + 0.5)
    )
    const centerTolerance = Math.max(2, Number(config?.printer?.emergencyRestockReturnRange || 3))
    const reachedCenter = await walkNear(bot, centerPad, centerTolerance, 5000)
    if (!reachedCenter) logger.warn(`Restock center is path-blocked; departing from reachable platform position ${bot.entity?.position || 'unknown'}.`)
  } else if (aboveLandingColumn) {
    logger.info(`Already above restock landing column at Y${bot.entity.position.y.toFixed(1)}; descending directly without climbing to skyway Y${skywayY}.`)
    await travelToAnchor(bot, stationAnchor, {
      horizontalSpeed,
      verticalSpeed,
      glideHeight: Number(config?.elytraFly?.glideHeight || 5),
      logger: (message) => logger.debug(message)
    })
  } else if (stationDistance > 8 || !bot.entity?.onGround) {
    logger.info(`Top-exit restock via Y${skywayY}; resume checkpoint=${resumeCheckpoint?.x.toFixed(1)},${resumeCheckpoint?.y.toFixed(1)},${resumeCheckpoint?.z.toFixed(1)}.`)
    const exitCheckpoints = generateLandingTransitCheckpoints(bot.entity.position, stationTarget, skywayY, horizontalSpeed, { verticalSpeed })
    await flyCheckpointSequence(bot, exitCheckpoints, logger, {
      horizontalTolerance: 2.5,
      verticalTolerance: 1.5,
      flyToCheckpoint: options.flyToCheckpoint
    })
    await travelToAnchor(bot, stationAnchor, {
      horizontalSpeed,
      verticalSpeed,
      glideHeight: Number(config?.elytraFly?.glideHeight || 5),
      logger: (message) => logger.debug(message)
    })
  }

  await ensurePrintingGear(bot, storageRegistration, config, options, logger)
  await executeMaterialRestock(bot, config, restockPlan, storageRegistration, {
    ...options,
    skipTravelToStation: true
  })
  await ensurePrintingGear(bot, storageRegistration, config, options, logger)
  await organizePrintingHotbar(bot).catch(() => {})

  if (resumeCheckpoint) {
    const overheadCheckpoints = generateLandingTransitCheckpoints(bot.entity.position, resumeCheckpoint.toVec3(), skywayY, horizontalSpeed, { verticalSpeed })
    await flyCheckpointSequence(bot, overheadCheckpoints, logger, { flyToCheckpoint: options.flyToCheckpoint })
    await waitForCheckpointChunk(bot, resumeCheckpoint, Number(options.chunkLoadTimeoutMs || 8000))
    const resolvedCheckpoint = typeof options.resolveResumeCheckpoint === 'function'
      ? await options.resolveResumeCheckpoint(resumeCheckpoint, skywayY)
      : resumeCheckpoint
    if (!resolvedCheckpoint) {
      logger.info('Destination verification found no remaining resume checkpoint.')
      return null
    }
    const reentryCheckpoints = generateObstacleAwareReentryCheckpoints(bot, bot.entity.position, resolvedCheckpoint, {
      chunkX: Number(chunkSlice.chunkX),
      chunkZ: Number(chunkSlice.chunkZ),
      horizontalSpeed,
      searchMargin: Number(config?.elytraFly?.pathEscapeSearchRadius || 24)
    })
    logger.info(`Restock return planned ${reentryCheckpoints.length} obstacle-aware top-entry checkpoint(s) to layer Y${resolvedCheckpoint.y.toFixed(1)}.`)
    await flyCheckpointSequence(bot, reentryCheckpoints, logger, {
      flyToCheckpoint: options.flyToCheckpoint,
      horizontalTolerance: 0.25,
      verticalTolerance: 0.25
    })
    return resolvedCheckpoint
  }
  return null
}

// Litematica Printer Range check (default 5.0 blocks range)
async function flyToTargetInAir(bot, targetPos, maxReach = 5.0, timeoutMs = 15000) {
  if (!bot.elytrafly) throw new Error('ElytraFly plugin is required for air printing')

  const currentStart = bot.entity?.position
  if (currentStart) {
    const startDist = currentStart.distanceTo(targetPos)
    const startVert = currentStart.y - targetPos.y
    // Range of 5: within reach distance and proper vertical clearance
    if (startDist <= Math.min(maxReach, 4.8) && startVert >= 1.4 && startVert <= 4.0) {
      engageElytraHover(bot, { targetY: currentStart.y })
      return true
    }
  }

  // Position to clearance position 2.2 blocks above target block
  const targetY = Math.min(MAX_FLIGHT_ALTITUDE_Y - 2, targetPos.y + 2.2)
  const targetPoint = { x: targetPos.x + 0.5, y: targetY, z: targetPos.z + 0.5 }
  await travelToAnchor(bot, targetPoint, {
    horizontalSpeed: 1,
    hoverInAir: true,
    noLanding: true
  })
  engageElytraHover(bot, { targetY: targetPoint.y })
  return true
}

// THM Addon & Staircase Silent Swap
async function waitForHeldItem(bot, itemName, timeoutMs = 3000) {
  const cleanTarget = normalizeBlockName(itemName)
  const ping = Number(bot.players?.[bot.username]?.ping || 0)
  const deadline = Date.now() + Math.max(timeoutMs, Number.isFinite(ping) ? (ping * 4) + 500 : timeoutMs)
  const stableMs = Math.max(50, Number(bot.config?.advanced?.scannerPostSwapDelayMs || 50))
  let stableSince = 0
  while (Date.now() < deadline) {
    const selectedItem = bot.inventory?.slots?.[36 + Number(bot.quickBarSlot || 0)]
    if (isUsableItemStack(selectedItem, cleanTarget)) {
      bot.updateHeldItem?.()
      if (typeof bot.updateHeldItem !== 'function' || isUsableItemStack(bot.heldItem, cleanTarget)) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince >= stableMs) return true
      } else stableSince = 0
    } else stableSince = 0
    await delay(25)
  }
  return false
}

async function selectConfirmedHotbarSlot(bot, hotbarSlot, itemName) {
  const timeoutMs = Math.max(50, Number(bot.config?.printer?.hotbarSelectionTimeoutMs || 250))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      bot.setQuickBarSlot(hotbarSlot === 0 ? 1 : 0)
      await delay(20)
    }
    bot.setQuickBarSlot(hotbarSlot)
    bot.updateHeldItem?.()
    if (isUsableItemStack(bot.heldItem, itemName)) return true
    if (await waitForHeldItem(bot, itemName, timeoutMs)) return true
  }
  return false
}

function hotbarSelectionError(message) {
  const error = new Error(message)
  error.code = 'HOTBAR_SELECTION_UNCONFIRMED'
  return error
}

async function silentSwapToItem(bot, itemName) {
  const cleanTarget = String(itemName || '').replace(/^minecraft:/, '')
  const held = bot.heldItem
  const selectedItem = bot.inventory?.slots?.[36 + Number(bot.quickBarSlot || 0)]
  if (isUsableItemStack(held, cleanTarget) && isUsableItemStack(selectedItem, cleanTarget)) {
    return { swapped: false, originalSlot: bot.quickBarSlot, mode: 'held' }
  }

  // 1. Search hotbar first (window slots 36..44, hotbar 0..8)
  for (let hb = 0; hb < 9; hb++) {
    const slotItem = bot.inventory?.slots?.[36 + hb]
    if (isUsableItemStack(slotItem, cleanTarget)) {
      const prev = bot.quickBarSlot
      if (!await selectConfirmedHotbarSlot(bot, hb, cleanTarget)) throw hotbarSelectionError(`Hotbar selection did not confirm held ${cleanTarget}.`)
      return { swapped: true, previousHotbarSlot: prev, mode: 'quickbar', slot: hb }
    }
  }

  const inventoryOnly = bot.inventory?.items?.()?.some((item) => isUsableItemStack(item, cleanTarget)) || false
  return { swapped: false, notFound: true, inventoryOnly }
}

async function silentSwapBack(bot, swapState) {
  if (!swapState || !swapState.swapped) return
  try {
    if (swapState.mode === 'quickbar' || swapState.mode === 'equip') {
      if (Number.isInteger(swapState.previousHotbarSlot)) {
        bot.setQuickBarSlot(swapState.previousHotbarSlot)
      }
    }
  } catch {}
}

function vectorToDirection(vector) {
  if (vector.y < 0) return 0
  if (vector.y > 0) return 1
  if (vector.z < 0) return 2
  if (vector.z > 0) return 3
  if (vector.x < 0) return 4
  if (vector.x > 0) return 5
  throw new Error(`Invalid placement face ${vector}.`)
}

function nextPlacementSequence(bot) {
  const sequence = (Number(bot.__printerPlacementSequence ?? -1) + 1) & 0x7fffffff
  bot.__printerPlacementSequence = sequence
  return sequence
}

function supportsRawPlacementPacket(bot) {
  return Boolean(
    bot.supportFeature?.('blockPlaceHasInsideBlock') ||
    bot.supportFeature?.('blockPlaceHasHandAndFloatCursor') ||
    bot.supportFeature?.('blockPlaceHasHandAndIntCursor')
  )
}

function sendPlacementPacket(bot, location, direction, cursor, targetVec, targetName) {
  assertPlacementTargetBelowBot(bot, targetVec)
  const selectedItem = bot.inventory?.slots?.[36 + Number(bot.quickBarSlot || 0)]
  if (!isUsableItemStack(bot.heldItem, targetName) || (bot.inventory?.slots && !isUsableItemStack(selectedItem, targetName))) {
    const error = new Error(`Refusing placement packet for ${normalizeBlockName(targetName)}: selected=${normalizeBlockName(selectedItem?.name) || 'empty'}x${Number(selectedItem?.count || 0)}, held=${normalizeBlockName(bot.heldItem?.name) || 'empty'}x${Number(bot.heldItem?.count || 0)}.`)
    error.code = 'PLACEMENT_HELD_ITEM_MISMATCH'
    throw error
  }
  const sequence = nextPlacementSequence(bot)
  if (bot.supportFeature?.('blockPlaceHasInsideBlock')) {
    bot._client.write('block_place', {
      location,
      direction,
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z,
      insideBlock: false,
      sequence,
      worldBorderHit: false
    })
    return sequence
  }
  if (bot.supportFeature?.('blockPlaceHasHandAndFloatCursor')) {
    bot._client.write('block_place', {
      location,
      direction,
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z
    })
    return sequence
  }
  if (bot.supportFeature?.('blockPlaceHasHandAndIntCursor')) {
    bot._client.write('block_place', {
      location,
      direction,
      hand: 0,
      cursorX: Math.floor(cursor.x * 16),
      cursorY: Math.floor(cursor.y * 16),
      cursorZ: Math.floor(cursor.z * 16)
    })
    return sequence
  }
  throw new Error('The connected Minecraft protocol does not support the required block placement packet.')
}

function findSupportPlacement(bot, targetVec, supportOffset = 0) {
  const supports = []
  for (const face of ADJACENT_FACES) {
    const neighbor = bot.blockAt(targetVec.plus(face.dir))
    if (neighbor && !isAirBlock(neighbor.name) && neighbor.boundingBox === 'block') {
      supports.push({ neighbor, faceVector: face.opposite })
    }
  }
  if (supports.length === 0) return null
  return supports[Math.abs(Math.floor(Number(supportOffset) || 0)) % supports.length]
}

function isInteractiveBlock(block) {
  return ['beacon', 'chest', 'trapped_chest', 'barrel', 'door', 'gate'].some((name) => String(block?.name || '').includes(name))
}

async function submitPlacementAttempt(bot, targetPos, options = {}) {
  const logger = options.logger || createPrinterLogger(options)
  const targetVec = new Vec3(Math.floor(targetPos.x), Math.floor(targetPos.y), Math.floor(targetPos.z))
  const targetName = normalizeBlockName(targetPos.name)
  const currentBlock = bot.blockAt(targetVec)
  const currentName = normalizeBlockName(currentBlock?.name)
  if (currentName === targetName) return true
  if (currentBlock && !isAirBlock(currentName)) {
    logger.debug(`Skipping placement at ${targetVec}: already occupied by ${currentName} (expected ${targetName}); breaking is disabled.`)
    return true
  }

  const support = options.forceDirect ? null : findSupportPlacement(bot, targetVec, options.supportAttemptOffset)
  const interactiveSupport = support && isInteractiveBlock(support.neighbor)
  if (interactiveSupport) await setSneaking(bot, true)

  let waiter = null
  try {
    assertPlacementTargetBelowBot(bot, targetVec)
    waiter = options.waitForConfirmation === false
      ? null
      : createBlockWaiter(
          bot,
          targetVec,
          (block) => normalizeBlockName(block?.name) === targetName,
          targetName,
          options.confirmTimeoutMs
        )
    if (support && supportsRawPlacementPacket(bot)) {
      const faceVector = support.faceVector
      const cursor = new Vec3(
        0.5 + faceVector.x * 0.499,
        0.5 + faceVector.y * 0.499,
        0.5 + faceVector.z * 0.499
      )
      const sequence = sendPlacementPacket(bot, support.neighbor.position, vectorToDirection(faceVector), cursor, targetVec, targetName)
      logger.debug(`Queued sequenced no-look support placement ${targetName} at ${targetVec} using ${support.neighbor.name} at ${support.neighbor.position}; sequence=${sequence}.`)
    } else if (support && typeof bot._genericPlace === 'function') {
      await bot._genericPlace(support.neighbor, support.faceVector, { forceLook: 'ignore' })
      logger.debug(`Queued legacy no-look support placement ${targetName} at ${targetVec} using ${support.neighbor.name} at ${support.neighbor.position}.`)
    } else {
      const sequence = sendPlacementPacket(bot, targetVec, 0, new Vec3(0.5, 0.5, 0.5), targetVec, targetName)
      logger.debug(`Queued direct placement ${targetName} at ${targetVec}; sequence=${sequence}.`)
    }
    if (waiter) await waiter.promise
    return true
  } catch (error) {
    waiter?.cancel(error)
    await waiter?.promise.catch(() => {})
    throw error
  } finally {
    if (interactiveSupport) await setSneaking(bot, false)
  }
}

async function clearMismatchedBlocks(bot, targets, options = {}) {
  const logger = options.logger || createPrinterLogger(options)
  const mismatches = []
  for (const target of targets) {
    const targetVec = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))
    const currentBlock = bot.blockAt(targetVec)
    if (currentBlock && !isAirBlock(currentBlock.name) && normalizeBlockName(currentBlock.name) !== normalizeBlockName(target.name)) {
      mismatches.push({ targetVec, currentBlock })
    }
  }
  for (const { targetVec, currentBlock } of mismatches) {
    logger.warn(`Skipping mismatched block at ${targetVec}: expected=${normalizeBlockName(targets.find((target) => Math.floor(target.x) === targetVec.x && Math.floor(target.y) === targetVec.y && Math.floor(target.z) === targetVec.z)?.name)}, actual=${normalizeBlockName(currentBlock.name)}; breaking is disabled.`)
  }
  return mismatches
}

async function placeBlockAirOrSupport(bot, targetPos, itemToPlace, options = {}) {
  const logger = options.logger || createPrinterLogger(options)
  const targetVec = new Vec3(Math.floor(targetPos.x), Math.floor(targetPos.y), Math.floor(targetPos.z))
  const targetName = normalizeBlockName(targetPos.name || itemToPlace?.name)
  if (!targetName) throw new Error(`Cannot place block at ${targetVec} without a target block name.`)

  const mismatches = await clearMismatchedBlocks(bot, [{ ...targetPos, name: targetName }], { ...options, logger })
  if (mismatches.length > 0) return false
  if (normalizeBlockName(bot.blockAt(targetVec)?.name) === targetName) return true

  if (!isUsableItemStack(bot.heldItem, targetName)) {
    const inventoryItem = bot.inventory?.items?.()?.find((item) => isUsableItemStack(item, targetName))
    if (!inventoryItem) throw new Error(`Required material ${targetName} is missing.`)
    await bot.equip(inventoryItem, 'hand')
  }

  const placementRetries = Math.max(1, Math.min(8, Number(options.placementRetries || 6)))
  let lastPlacementError = null
  for (let attempt = 1; attempt <= placementRetries; attempt += 1) {
    try {
      await submitPlacementAttempt(bot, { ...targetPos, name: targetName }, {
        ...options,
        logger,
        forceDirect: false,
        supportAttemptOffset: Math.max(0, Number(options.supportAttemptOffset || 0)) + attempt - 1
      })
      return true
    } catch (error) {
      if (normalizeBlockName(bot.blockAt(targetVec)?.name) === targetName) return true
      lastPlacementError = error
      if (attempt < placementRetries) {
        logger.warn(`Placement was not confirmed at ${targetVec}: ${error.message}. Retrying without rotation.`)
        await delay(Math.max(100, Number(options.placementRetryDelayMs || 300)))
      }
    }
  }
  throw lastPlacementError || new Error(`Server did not confirm ${targetName} at ${targetVec}.`)
}

async function placeBlockBatch(bot, targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return true
  const logger = options.logger || createPrinterLogger(options)
  const targetName = normalizeBlockName(targets[0].name)
  if (targets.some((target) => normalizeBlockName(target.name) !== targetName)) {
    throw new Error('A placement batch must use one material.')
  }

  const mismatches = await clearMismatchedBlocks(bot, targets, { ...options, logger })
  const mismatchKeys = new Set(mismatches.map(({ targetVec }) => `${targetVec.x},${targetVec.y},${targetVec.z}`))
  const placeableTargets = targets.filter((target) => !mismatchKeys.has(`${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`))
  if (placeableTargets.length === 0) return { placedTargets: [], skippedMismatches: mismatches }
  const swapState = await silentSwapToItem(bot, targetName)
  if (swapState.notFound) {
    const error = new Error(swapState.inventoryOnly
      ? `Required material ${targetName} is not staged in the hotbar.`
      : `Required material ${targetName} is missing after restock check.`)
    error.code = swapState.inventoryOnly ? 'HOTBAR_MATERIAL_NOT_READY' : 'REQUIRED_MATERIAL_MISSING'
    throw error
  }
  try {
    const selectedItem = bot.inventory?.slots?.[36 + Number(bot.quickBarSlot || 0)]
    const stackCount = Math.max(1, Number(selectedItem?.count || 1))
    const batchTargets = placeableTargets.slice(0, Math.min(placeableTargets.length, stackCount))
    const stackDeferred = placeableTargets.slice(batchTargets.length)
    logger.debug(`Submitting placement batch size=${batchTargets.length}, material=${targetName}.`)
    logger.debug(`Placement hand state: mode=${swapState.mode || 'unchanged'}, selectedHotbar=${bot.quickBarSlot}, selected=${normalizeBlockName(selectedItem?.name) || 'empty'}x${Number(selectedItem?.count || 0)}, held=${normalizeBlockName(bot.heldItem?.name) || 'empty'}x${Number(bot.heldItem?.count || 0)}, gameMode=${bot.game?.gameMode || bot.player?.gamemode || 'unknown'}, onGround=${Boolean(bot.entity?.onGround)}.`)
    const results = await Promise.allSettled(batchTargets.map((target) => submitPlacementAttempt(bot, target, { ...options, logger })))
    const deferredIndexes = new Set()
    if (options.waitForConfirmation === false) {
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        if (result.status !== 'rejected') continue
        if (result.reason?.code === 'PLACEMENT_TARGET_NOT_BELOW_BOT') {
          deferredIndexes.add(index)
          logger.debug(`${result.reason.message} Deferring packet until checkpoint correction.`)
          continue
        }
        throw result.reason
      }
      return {
        placedTargets: batchTargets.filter((_target, index) => !deferredIndexes.has(index)),
        skippedMismatches: mismatches,
        deferredTargets: [
          ...batchTargets.filter((_target, index) => deferredIndexes.has(index)),
          ...stackDeferred
        ]
      }
    }
    for (let index = 0; index < results.length; index += 1) {
      const target = batchTargets[index]
      if (results[index].status === 'rejected' && results[index].reason?.code === 'PLACEMENT_TARGET_NOT_BELOW_BOT') {
        deferredIndexes.add(index)
        logger.debug(`${results[index].reason.message} Deferring packet until checkpoint correction.`)
        continue
      }
      const targetVec = new Vec3(target.x, target.y, target.z)
      if (results[index].status === 'fulfilled' && normalizeBlockName(bot.blockAt(targetVec)?.name) === targetName) continue
      const reason = results[index].status === 'rejected' ? results[index].reason.message : 'server state changed after confirmation'
      logger.warn(`Batch placement retry for ${targetName} at ${target.x},${target.y},${target.z}: ${reason}`)
      await placeBlockAirOrSupport(bot, target, null, { ...options, logger })
    }
    return {
      placedTargets: batchTargets.filter((_target, index) => !deferredIndexes.has(index)),
      skippedMismatches: mismatches,
        deferredTargets: [
          ...batchTargets.filter((_target, index) => deferredIndexes.has(index)),
          ...stackDeferred
        ]
    }
  } finally {
    if (swapState.mode === 'equip') {
      await silentSwapBack(bot, swapState)
    }
  }
}

function isPlacementConfirmed(bot, target) {
  const targetVec = new Vec3(target.x, target.y, target.z)
  return normalizeBlockName(bot.blockAt(targetVec)?.name) === normalizeBlockName(target.name)
}

function getConfirmedPrefixEnd(bot, blocks, startIndex = 0) {
  let index = Math.max(0, Math.floor(Number(startIndex || 0)))
  while (index < blocks.length && isPlacementConfirmed(bot, blocks[index])) index += 1
  return index
}

function verifyLayerBlocks(bot, expectedBlocks) {
  const missing = []
  const ignoredMismatches = []
  for (const target of expectedBlocks || []) {
    const actual = bot.blockAt(new Vec3(target.x, target.y, target.z))
    const actualName = normalizeBlockName(actual?.name)
    if (actualName === normalizeBlockName(target.name)) continue
    if (!actual || isAirBlock(actualName)) missing.push(target)
    else ignoredMismatches.push({ target, actualName })
  }
  return { missing, ignoredMismatches }
}

function countPendingMaterial(pendingPlacements, itemName) {
  const targetName = normalizeBlockName(itemName)
  let count = 0
  for (const entry of pendingPlacements.values()) {
    if (entry.sent && normalizeBlockName(entry.target.name) === targetName) count += 1
  }
  return count
}

async function printChunkSlice(bot, config, chunkSlice, options = {}) {
  const logger = createPrinterLogger(options, config)
  const loadProgress = options.loadPrintProgress || loadPrintProgress
  const saveProgress = options.savePrintProgress || savePrintProgress
  const updatePlacementProgress = options.updateChunkPlacementProgress || updateChunkPlacementProgress
  const finishChunkJob = options.completeChunkJob === false ? null : (options.completeChunkJob || completeChunkJob)
  const targetBps = Math.max(1, Math.min(30, Number(options.blocksPerSecond || config?.printer?.blocksPerSecond || 30)))
  const configuredBurstCap = Math.max(1, Math.floor(Number(config?.printer?.perTickBurstCap || Math.ceil(targetBps / 20))))
  const effectiveBurstCap = Math.min(2, configuredBurstCap)
  const budget = options.budget || new TpsScaledActionBudget({
    blocksPerSecond: targetBps,
    minimumTps: Number(config?.printer?.minimumTps || 10.0),
    staleTickSeconds: Number(config?.printer?.staleTickSeconds || 1.5),
    perTickBurstCap: effectiveBurstCap
  })
  const placementIntervalMs = Math.max(0, Number(options.placementIntervalMs ?? 0))
  const confirmationTimeoutMs = Math.max(250, Number(options.confirmTimeoutMs || 5000))
  const placementRetryTimeoutMs = Math.max(250, Math.min(1500, Number(options.placementRetryTimeoutMs || confirmationTimeoutMs)))
  const placementRetries = Math.max(1, Math.min(8, Number(options.placementRetries || 6)))
  const maxPendingPlacements = Math.max(
    effectiveBurstCap,
    Math.min(256, Math.floor(Number(options.maxPendingPlacements || targetBps * 2)))
  )
  installServerTpsTracker(bot)

  const rawBlocks = chunkSlice.blocks || []
  const sortedBlocks = rawBlocks
    .filter((b) => !isAirBlock(b.name))
    .slice()
    .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)

  const chunkKey = chunkSlice.key || `${chunkSlice.chunkX},${chunkSlice.chunkZ}`
  const anchor = chunkSlice.anchor || { x: 0, y: 64, z: 0 }
  const chunkX = Number.isFinite(Number(chunkSlice.chunkX)) ? Number(chunkSlice.chunkX) : Math.floor(Number(sortedBlocks[0]?.x || 0) / 16)
  const chunkZ = Number.isFinite(Number(chunkSlice.chunkZ)) ? Number(chunkSlice.chunkZ) : Math.floor(Number(sortedBlocks[0]?.z || 0) / 16)
  const maxPlacementReach = Math.max(2.5, Math.min(5, Number(options.reach || config?.printer?.range || 5.0)))
  const layerHoverOffsetY = Math.max(2, Number(options.layerHoverOffsetY ?? config?.printer?.layerHoverOffsetY ?? 2))
  const layersPerPass = Math.max(1, Math.min(3, Math.floor(Number(options.layersPerPass ?? config?.printer?.layersPerPass ?? 2))))
  const printWhileFlying = options.printWhileFlying ?? config?.printer?.printWhileFlying !== false
  const horizontalSpeed = Number(config?.elytraFly?.horizontalSpeed || 2)
  const hotbarLookaheadBlocks = Math.max(1, Math.floor(Number(options.hotbarLookaheadBlocks || config?.printer?.hotbarLookaheadBlocks || 512)))
  const layerPlan = generateLayerPrintPlan(chunkX, chunkZ, sortedBlocks, {
    horizontalSpeed,
    maxReach: maxPlacementReach,
    hoverOffsetY: layerHoverOffsetY,
    layersPerPass,
    eyeHeight: Number(bot.entity?.eyeHeight ?? DEFAULT_EYE_HEIGHT)
  })
  const blocks = []
  const checkpointForBlock = []
  const layerPassForBlock = []
  for (const segment of layerPlan) {
    for (const block of segment.blocks) {
      blocks.push(block)
      checkpointForBlock.push(segment.checkpoint)
      layerPassForBlock.push(segment.layers || [segment.layerY])
    }
  }
  const checkpointIndexesByKey = new Map()
  let getDispatchIndex = () => (typeof startIdx === 'number' ? startIdx : Number(bot.placedBlocksCount || 0))
  const checkpointKeyOf = (checkpoint) => `${checkpoint.x},${checkpoint.y},${checkpoint.z}`
  for (let index = 0; index < checkpointForBlock.length; index += 1) {
    const key = checkpointKeyOf(checkpointForBlock[index])
    if (!checkpointIndexesByKey.has(key)) checkpointIndexesByKey.set(key, [])
    checkpointIndexesByKey.get(key).push(index)
  }
  const resolveCheckpoint = (checkpoint, resolveOptions = {}) => {
    const originalKey = checkpointKeyOf(checkpoint)
    const indexes = checkpointIndexesByKey.get(originalKey) || []
    const minIndex = getDispatchIndex()
    const pendingIndexes = indexes.filter((index) => index >= minIndex && !isPlacementConfirmed(bot, blocks[index]))
    const targetBlocksToReach = pendingIndexes.length > 0 ? pendingIndexes.map((index) => blocks[index]) : indexes.map((index) => blocks[index])
    const resolved = resolveSafeLayerCheckpoint(bot, checkpoint, targetBlocksToReach, {
      chunkX,
      chunkZ,
      maxReach: maxPlacementReach,
      eyeHeight: Number(bot.entity?.eyeHeight ?? DEFAULT_EYE_HEIGHT),
      ...resolveOptions
    })
    const resolvedKey = checkpointKeyOf(resolved)
    if (resolvedKey === originalKey) return checkpoint
    for (const index of indexes) checkpointForBlock[index] = resolved
    checkpointIndexesByKey.set(resolvedKey, indexes)
    logger.warn(`Relocated blocked ${checkpoint.phase} checkpoint from ${originalKey} to ${resolvedKey}.`)
    return resolved
  }
  const plannedChunk = {
    ...chunkSlice,
    blockCount: blocks.length,
    blocks,
    pathPlanVersion: LAYER_PATH_PLAN_VERSION
  }

  logger.info(`Starting print of chunk ${chunkKey} (${blocks.length} non-air blocks, ${layerPlan.length} flight checkpoints, layers/pass=${layersPerPass}, concurrentFlight=${printWhileFlying}, print=${targetBps}bps, burst=${effectiveBurstCap}/tick, pending=${maxPendingPlacements}, hover=+${layerHoverOffsetY}Y, Meteor horizontal-speed=${horizontalSpeed}) at anchor ${anchor.x},${anchor.y},${anchor.z}...`)
  bot.activeChunkJob = plannedChunk
  enableAntiFallHover(bot)

  const progress = loadProgress()
  const savedIndex = Number(progress?.activeChunk?.nextBlockIndex)
  const sameChunk = progress?.activeChunk?.key === chunkKey
  const savedPlanMatches = progress?.activeChunk?.pathPlanVersion === LAYER_PATH_PLAN_VERSION ||
    (Number.isFinite(savedIndex) && sameBlockIdentity(progress?.activeChunk?.nextBlock, blocks[savedIndex]))
  let startIdx = (sameChunk && savedPlanMatches && Number.isFinite(savedIndex))
    ? savedIndex
    : 0
  if (sameChunk && !savedPlanMatches && Number(progress.activeChunk.placedBlocks || 0) > 0) {
    logger.warn('Existing checkpoint uses the old block order; safely rescanning this chunk from index 0.')
  }
  let startCheckpoint = checkpointForBlock[startIdx] || null
  const advanceConfirmedPrefix = (reason) => {
    const previousIndex = startIdx
    startIdx = getConfirmedPrefixEnd(bot, blocks, startIdx)
    startCheckpoint = checkpointForBlock[startIdx] || null
    if (startIdx > previousIndex) {
      bot.placedBlocksCount = startIdx
      saveProgress(bot, { activeChunk: plannedChunk, placedBlocks: startIdx, status: 'printing' })
      logger.info(`Verified ${startIdx - previousIndex} already-correct block(s) ${reason}; next index ${startIdx}/${blocks.length}.`)
    }
    return startCheckpoint
  }
  if (isInsideChunkColumn(bot.entity?.position, chunkX, chunkZ)) advanceConfirmedPrefix('in the current chunk')
  bot.placedBlocksCount = startIdx
  saveProgress(bot, { activeChunk: plannedChunk, placedBlocks: startIdx, status: 'printing' })

  const storageRegistration = options.storageRegistration || bot.storageRegistration || null
  let positionedAtStartCheckpoint = false
  const missingGear = getMissingPrintingGear(bot)
  if (missingGear.length > 0 && !storageRegistration) {
    throw new Error(`Cannot start printing without ${missingGear.join(', ')} and a storage registration.`)
  }
  if (storageRegistration) {
    const { needsInventoryCleanup, planUpcomingChunkMaterials } = require('./inventory-manager')
    const restockPlan = options.autoRestock === false
      ? { needsRestock: false, neededItems: [] }
      : planUpcomingChunkMaterials(bot, plannedChunk, { startIndex: startIdx, preserveOrder: true })
    const inventoryCleanupNeeded = needsInventoryCleanup(bot)
    if (missingGear.length > 0 || restockPlan.needsRestock || inventoryCleanupNeeded) {
      if (restockPlan.needsRestock) {
        logger.info(`Inventory restock required before printing chunk ${chunkKey} (${restockPlan.neededItems.map((item) => `${item.name} x${item.countNeeded}`).join(', ')})...`)
      }
      if (inventoryCleanupNeeded) logger.info('Inventory cleanup required before printing (shulkers, duplicate tools, or no empty slot).')
      const resolvedStartCheckpoint = await executeRestockDetour(bot, config, plannedChunk, restockPlan, storageRegistration, startCheckpoint, {
        ...options,
        resolveResumeCheckpoint: () => {
          advanceConfirmedPrefix('after destination chunk load')
          return startCheckpoint ? resolveCheckpoint(startCheckpoint) : null
        }
      }, logger)
      if (resolvedStartCheckpoint) startCheckpoint = resolvedStartCheckpoint
      positionedAtStartCheckpoint = Boolean(startCheckpoint)
    }
  }

  if (sameChunk && startCheckpoint && !positionedAtStartCheckpoint && isInsideChunkColumn(bot.entity?.position, chunkX, chunkZ)) {
    startCheckpoint = resolveCheckpoint(startCheckpoint)
    const localDistance = bot.entity.position.distanceTo(startCheckpoint.toVec3())
    const verticalDistance = Math.abs(Number(bot.entity.position.y) - Number(startCheckpoint.y))
    if (bot.entity.onGround || verticalDistance > maxPlacementReach) {
      startCheckpoint = resolveCheckpoint(startCheckpoint)
      const maxPathingY = Number(config?.elytraFly?.maxPathingY ?? 322)
      const { verticalMarginY, ceilingY: localCeilingY } = getLocalRecoveryEnvelope(bot.entity.position.y, startCheckpoint.y, maxPathingY)
      logger.info(`Inside chunk ${chunkKey} but outside safe layer flight; routing locally to checkpoint Y${startCheckpoint.y.toFixed(1)} with ceiling Y${localCeilingY.toFixed(1)}.`)
      const localFlightOptions = {
        flyToCheckpoint: options.flyToCheckpoint,
        horizontalTolerance: 1.0,
        verticalTolerance: 0.5,
        elytraFly: {
          ...(config?.elytraFly || {}),
          maxAltitudeY: Math.min(Number(config?.elytraFly?.maxAltitudeY ?? 324), localCeilingY + 0.5)
        }
      }
      const reentryCheckpoints = generateObstacleAwareReentryCheckpoints(bot, bot.entity.position, startCheckpoint, {
        chunkX,
        chunkZ,
        horizontalSpeed,
        searchMargin: Number(config?.elytraFly?.pathEscapeSearchRadius || 24),
        verticalMarginY
      })
      logger.info(`Obstacle-aware local recovery planned ${reentryCheckpoints.length} checkpoint(s) to layer Y${startCheckpoint.y.toFixed(1)}.`)
      await flyCheckpointSequence(bot, reentryCheckpoints, logger, { ...localFlightOptions, horizontalTolerance: 0.8, verticalTolerance: 0.5, stallTimeoutMs: 4000 })
    }
    positionedAtStartCheckpoint = true
  }

  const { checkAndConsumeGoldenApple, getEmptyPlayerSlotCount } = require('./inventory-manager')
  const hotbarRefreshLeadBlocks = Math.min(hotbarLookaheadBlocks, Math.max(8, Math.ceil(targetBps * 2)))
  let nextHotbarRefreshIndex = startIdx
  const refreshPrintingHotbar = async (startIndex, reason, reservedMaterials = new Map(), maxSwaps = Number.POSITIVE_INFINITY) => {
    const result = await prefetchPrintingHotbar(bot, blocks, {
      startIndex,
      lookaheadBlocks: hotbarLookaheadBlocks,
      maxSwaps,
      reservedMaterials,
      logger
    })
    const coverage = getPrintingHotbarCoverage(bot, blocks, {
      startIndex,
      lookaheadBlocks: hotbarLookaheadBlocks,
      reservedMaterials
    })
    const retainedLead = Math.min(hotbarRefreshLeadBlocks, Math.max(1, Math.floor(coverage.coveredBlocks / 2)))
    nextHotbarRefreshIndex = startIndex + Math.max(1, coverage.coveredBlocks - retainedLead)
    logger.debug(`Hotbar plan ${reason}: swaps=${result.swaps}, coverage=${coverage.coveredBlocks}, nextMissing=${coverage.nextMissingMaterial || 'none'}, refreshAt=${nextHotbarRefreshIndex}.`)
    return result
  }
  await refreshPrintingHotbar(startIdx, 'initial')
  if (getEmptyPlayerSlotCount(bot) < 1) throw new Error('Printing requires one empty player inventory slot.')

  if (startCheckpoint && !positionedAtStartCheckpoint) {
    const stationAnchor = storageRegistration?.anchor || config?.storageRegistration?.anchor || { x: -326, y: 97, z: -100 }
    const skywayY = getSkywayAltitude(stationAnchor, plannedChunk, {
      ...(config?.elytraFly || {}),
      stationMaxY: storageRegistration?.platformBounds?.maxY
    })
    const verticalSpeed = Number(config?.elytraFly?.verticalSpeed || 2)
    logger.info(`Top-exit to Y${skywayY}, overhead cruise, then vertical top-entry.`)
    const overheadCheckpoints = generateLandingTransitCheckpoints(bot.entity.position, startCheckpoint.toVec3(), skywayY, horizontalSpeed, { verticalSpeed })
    await flyCheckpointSequence(bot, overheadCheckpoints, logger, { flyToCheckpoint: options.flyToCheckpoint })
    await waitForCheckpointChunk(bot, startCheckpoint, Number(options.chunkLoadTimeoutMs || 8000))
    startCheckpoint = resolveCheckpoint(startCheckpoint, { requireVerticalShaft: true, skywayY })
    await flyCheckpointSequence(bot, [new FlightCheckpoint(
      startCheckpoint.x,
      startCheckpoint.y,
      startCheckpoint.z,
      'chunk-top-entry',
      horizontalSpeed
    )], logger, { flyToCheckpoint: options.flyToCheckpoint })
    positionedAtStartCheckpoint = true
    logger.info(`Top-entry complete at ${startCheckpoint.x.toFixed(1)},${startCheckpoint.y.toFixed(1)},${startCheckpoint.z.toFixed(1)}; parallel layer printing enabled.`)
  }

  logger.info(`Resuming from block index ${startIdx}/${blocks.length}...`)

  let currentCheckpointKey = positionedAtStartCheckpoint && startCheckpoint
    ? `${startCheckpoint.x},${startCheckpoint.y},${startCheckpoint.z}`
    : null
  const checkpointFlight = typeof options.flyToCheckpoint === 'function' ? options.flyToCheckpoint : flyToCheckpoint
  let activeCheckpointFlight = null
  let groundedRecoveryAttempts = 0
  let groundedRecoveryProgress = -1
  let airborneRecoveryAttempts = 0
  let airborneRecoveryProgress = -1
  const recoverGroundedToCheckpoint = async (checkpoint, error = null) => {
    if (!bot.entity?.onGround) return false
    const progressIndex = Number(bot.placedBlocksCount || 0)
    if (groundedRecoveryProgress === progressIndex) groundedRecoveryAttempts += 1
    else {
      groundedRecoveryProgress = progressIndex
      groundedRecoveryAttempts = 1
    }
    if (groundedRecoveryAttempts > 3) {
      throw new Error(`Grounded recovery failed 3 times at block ${progressIndex}/${blocks.length}: ${error?.message || 'no flight error'}.`)
    }
    const localCheckpoint = resolveCheckpoint(checkpoint)
    let localRecoveryError = error
    try {
      logger.warn(`Grounded during airborne printing at ${bot.entity.position}; attempting local recovery to ${localCheckpoint.x.toFixed(1)},${localCheckpoint.y.toFixed(1)},${localCheckpoint.z.toFixed(1)}${error ? ` after ${error.message}` : ''}.`)
      await checkpointFlight(bot, localCheckpoint, {
        horizontalTolerance: 0.3,
        verticalTolerance: LAYER_VERTICAL_TOLERANCE,
        timeoutMs: Number(options.localRecoveryTimeoutMs || 8000)
      })
      if (bot.entity?.onGround) throw new Error('local checkpoint recovery remained grounded')
      currentCheckpointKey = `${localCheckpoint.x},${localCheckpoint.y},${localCheckpoint.z}`
      return true
    } catch (localError) {
      localRecoveryError = localError
    }

    const recoveryCeilingY = Number(localCheckpoint.y)
    const escapePath = findVerticalShaftEscapePath(bot, recoveryCeilingY, {
      searchRadius: Number(config?.elytraFly?.pathEscapeSearchRadius || 24)
    })
    if (escapePath === null) {
      throw new Error(`Local grounded recovery failed (${localRecoveryError.message}); no open shaft reaches capped layer Y${recoveryCeilingY}.`)
    }
    logger.warn(`Local grounded recovery retry stays capped at layer Y${recoveryCeilingY}; skyway fallback disabled.`)
    for (const point of escapePath) {
      await checkpointFlight(bot, new FlightCheckpoint(point.x, point.y, point.z, 'obstruction-escape', Math.min(1, horizontalSpeed)), {
        horizontalTolerance: 0.3,
        verticalTolerance: LAYER_VERTICAL_TOLERANCE,
        timeoutMs: Number(options.localRecoveryTimeoutMs || 8000)
      })
    }
    const shaftX = escapePath.at(-1)?.x ?? Math.floor(bot.entity.position.x) + 0.5
    const shaftZ = escapePath.at(-1)?.z ?? Math.floor(bot.entity.position.z) + 0.5
    await checkpointFlight(bot, new FlightCheckpoint(shaftX, recoveryCeilingY, shaftZ, 'layer-recovery-climb', Math.min(1, horizontalSpeed)), {
      horizontalTolerance: 0.3,
      verticalTolerance: LAYER_VERTICAL_TOLERANCE,
      timeoutMs: Number(options.localRecoveryTimeoutMs || 8000)
    })
    await checkpointFlight(bot, localCheckpoint, {
      horizontalTolerance: 0.3,
      verticalTolerance: LAYER_VERTICAL_TOLERANCE,
      timeoutMs: Number(options.localRecoveryTimeoutMs || 8000)
    })
    if (bot.entity?.onGround) throw new Error(`Capped local recovery remained grounded at layer Y${recoveryCeilingY}.`)
    currentCheckpointKey = `${localCheckpoint.x},${localCheckpoint.y},${localCheckpoint.z}`
    return true
  }
  const recoverAirborneToCheckpoint = async (checkpoint, error) => {
    const progressIndex = Number(bot.placedBlocksCount || 0)
    if (airborneRecoveryProgress === progressIndex) airborneRecoveryAttempts += 1
    else {
      airborneRecoveryProgress = progressIndex
      airborneRecoveryAttempts = 1
    }
    if (airborneRecoveryAttempts > 3) {
      throw new Error(`Airborne checkpoint recovery failed 3 times at block ${progressIndex}/${blocks.length}: ${error.message}.`)
    }
    logger.warn(`Airborne checkpoint stalled at ${bot.entity.position}; reacquiring local checkpoint ${checkpoint.x.toFixed(1)},${checkpoint.y.toFixed(1)},${checkpoint.z.toFixed(1)} after ${error.message}.`)
    let targetCheckpoint = checkpoint
    try {
      await checkpointFlight(bot, checkpoint, {
        horizontalTolerance: 0.3,
        verticalTolerance: LAYER_VERTICAL_TOLERANCE,
        timeoutMs: Number(options.moveTimeoutMs || 30000)
      })
    } catch (retryError) {
      targetCheckpoint = resolveCheckpoint(checkpoint)
      const maxPathingY = Number(config?.elytraFly?.maxPathingY ?? 322)
      const { verticalMarginY, ceilingY: localCeilingY } = getLocalRecoveryEnvelope(bot.entity.position.y, targetCheckpoint.y, maxPathingY)
      let recoveryCheckpoints = null
      try {
        recoveryCheckpoints = generateObstacleAwareReentryCheckpoints(bot, bot.entity.position, targetCheckpoint, {
          chunkX,
          chunkZ,
          horizontalSpeed,
          searchMargin: Number(config?.elytraFly?.pathEscapeSearchRadius || 24),
          verticalMarginY
        })
      } catch {}
      if (recoveryCheckpoints && recoveryCheckpoints.length > 0) {
        logger.warn(`Direct checkpoint retry failed (${retryError.message}); using ${recoveryCheckpoints.length} bounded 3D recovery checkpoint(s), ceiling Y${localCeilingY.toFixed(1)}.`)
        try {
          await flyCheckpointSequence(bot, recoveryCheckpoints, logger, {
            flyToCheckpoint: checkpointFlight,
            horizontalTolerance: 1.0,
            verticalTolerance: 0.5,
            stallTimeoutMs: 15000,
            timeoutMs: Number(options.moveTimeoutMs || 30000),
            elytraFly: {
              ...(config?.elytraFly || {}),
              maxAltitudeY: Math.min(Number(config?.elytraFly?.maxAltitudeY ?? 324), localCeilingY + 0.5)
            }
          })
          currentCheckpointKey = `${(targetCheckpoint || checkpoint).x},${(targetCheckpoint || checkpoint).y},${(targetCheckpoint || checkpoint).z}`
          return
        } catch (subError) {
          logger.warn(`Bounded 3D recovery failed (${subError.message}); attempting top-entry via skyway.`)
        }
      }
      const stationAnchor = storageRegistration?.anchor || { x: -326, y: 97, z: -100 }
      const skywayY = getSkywayAltitude(stationAnchor, plannedChunk, {
        ...(config?.elytraFly || {}),
        stationMaxY: storageRegistration?.platformBounds?.maxY
      })
      const verticalSpeed = Number(config?.elytraFly?.verticalSpeed || 2)
      logger.warn(`Direct checkpoint retry failed (${retryError.message}); executing top-entry via skyway Y${skywayY} to ${targetCheckpoint.x.toFixed(1)},${targetCheckpoint.y.toFixed(1)},${targetCheckpoint.z.toFixed(1)}.`)
      const overheadCheckpoints = generateMacroTransitCheckpoints(bot.entity.position, targetCheckpoint.toVec3(), skywayY, horizontalSpeed, { verticalSpeed })
      await flyCheckpointSequence(bot, overheadCheckpoints, logger, {
        flyToCheckpoint: checkpointFlight,
        horizontalTolerance: 0.8,
        verticalTolerance: 0.5,
        stallTimeoutMs: 15000,
        timeoutMs: Number(options.moveTimeoutMs || 30000)
      })
    }
    currentCheckpointKey = `${(targetCheckpoint || checkpoint).x},${(targetCheckpoint || checkpoint).y},${(targetCheckpoint || checkpoint).z}`
  }
  const flyLayerCheckpoint = async (checkpoint, flightOptions = {}) => {
    const fromPos = bot.entity?.position
    const targetVec = checkpoint.toVec3()
    const directClear = fromPos ? isDirectFlightClear(bot, fromPos, targetVec) : true
    if (!directClear && storageRegistration) {
      const stationAnchor = storageRegistration?.anchor || { x: -326, y: 97, z: -100 }
      const skywayY = getSkywayAltitude(stationAnchor, plannedChunk, {
        ...(config?.elytraFly || {}),
        stationMaxY: storageRegistration?.platformBounds?.maxY
      })
      const verticalSpeed = Number(config?.elytraFly?.verticalSpeed || 2)
      logger.warn(`Direct path to checkpoint ${checkpoint.x.toFixed(1)},${checkpoint.y.toFixed(1)},${checkpoint.z.toFixed(1)} is blocked by structures; routing top-entry via skyway Y${skywayY}.`)
      const overheadCheckpoints = generateMacroTransitCheckpoints(bot.entity.position, targetVec, skywayY, horizontalSpeed, { verticalSpeed })
      return await flyCheckpointSequence(bot, overheadCheckpoints, logger, {
        flyToCheckpoint: checkpointFlight,
        horizontalTolerance: 0.8,
        verticalTolerance: 0.5,
        stallTimeoutMs: 15000,
        timeoutMs: Number(options.moveTimeoutMs || 30000)
      })
    }
    try {
      await checkpointFlight(bot, checkpoint, flightOptions)
      return true
    } catch (error) {
      if (error?.code === 'PRINT_INTERRUPTED' && bot.__interruptPrintRequested) return false
      if (!await recoverGroundedToCheckpoint(checkpoint, error)) await recoverAirborneToCheckpoint(checkpoint, error)
      return true
    }
  }
  const startCheckpointFlight = (checkpoint, flightOptions = {}) => {
    const key = `${checkpoint.x},${checkpoint.y},${checkpoint.z}`
    if (currentCheckpointKey === key || activeCheckpointFlight) return activeCheckpointFlight
    const state = { checkpoint, done: false, error: null, key, promise: null }
    state.promise = Promise.resolve()
      .then(() => flyLayerCheckpoint(checkpoint, flightOptions))
      .then((reached) => { if (reached !== false) currentCheckpointKey = key })
      .catch((error) => { state.error = error })
      .finally(() => { state.done = true })
    activeCheckpointFlight = state
    logger.debug(`Checkpoint flight started: ${key} (${checkpoint.phase}).`)
    return state
  }
  const settleCheckpointFlight = async () => {
    const state = activeCheckpointFlight
    if (!state) return
    await state.promise
    if (activeCheckpointFlight === state) activeCheckpointFlight = null
    if (state.error?.code === 'PRINT_INTERRUPTED' && bot.__interruptPrintRequested) return false
    if (state.error) throw state.error
    logger.debug(`Checkpoint flight completed: ${state.key} (${state.checkpoint.phase}).`)
  }
  let currentLayerPassKey = null
  const telemetryStartedAt = Date.now()
  let telemetryPlaced = 0
  let committedIndex = startIdx
  let nextDispatchIndex = startIdx
  getDispatchIndex = () => nextDispatchIndex
  let nextHealthCheckAt = 0
  let nextElytraCheckAt = 0
  let checkpointDispatchKey = null
  let checkpointPacketCount = 0
  let primaryPacketsSinceVerification = 0
  const recentPlacementPacketTimes = []
  const pendingPlacements = new Map()
  const verificationLayerWindow = Math.max(1, Math.min(3, Math.floor(Number(options.verificationLayers ?? config?.printer?.verificationLayers ?? 3))))
  const layerYs = [...new Set(blocks.map((block) => Number(block.y)))].sort((left, right) => left - right)
  const layerIndexByY = new Map(layerYs.map((layerY, index) => [layerY, index]))
  const blocksByLayer = new Map(layerYs.map((layerY) => [layerY, blocks.filter((block) => Number(block.y) === layerY)]))
  const layerVerificationTasks = new Map()
  const verificationQueue = new Map()
  const verificationPending = new Map()
  const targetKey = (target) => `${target.x},${target.y},${target.z}`
  const blockIndexByTargetKey = new Map(blocks.map((block, index) => [targetKey(block), index]))
  const buildReachableVerificationBatch = () => {
    const candidate = [...verificationQueue.values()].find((entry) => {
      if (!canDispatchVerificationRepair(bot, entry.target, maxPlacementReach)) return false
      const reserved = countPendingMaterial(pendingPlacements, entry.target.name) + countPendingMaterial(verificationPending, entry.target.name)
      return countInventoryItem(bot, entry.target.name) > reserved
    })
    if (!candidate) return []
    const material = normalizeBlockName(candidate.target.name)
    const checkpoint = activeCheckpointFlight?.checkpoint || checkpointForBlock[Math.min(nextDispatchIndex, checkpointForBlock.length - 1)]
    if (!checkpoint) return []
    const checkpointKey = activeCheckpointFlight?.key || currentCheckpointKey || `${checkpoint.x},${checkpoint.y},${checkpoint.z}`
    return [...verificationQueue.values()]
      .filter((entry) => normalizeBlockName(entry.target.name) === material && canDispatchVerificationRepair(bot, entry.target, maxPlacementReach))
      .slice(0, effectiveBurstCap)
      .map((entry) => ({
        ...entry,
        index: blockIndexByTargetKey.get(entry.key) ?? -1,
        checkpoint,
        checkpointKey,
        confirmed: false,
        sent: true,
        verificationRepair: true
      }))
  }
  const scheduleLayerVerification = (layerY) => {
    if (!blocksByLayer.has(layerY) || layerVerificationTasks.has(layerY)) return
    const layerIndex = layerIndexByY.get(layerY)
    const task = new Promise((resolve) => setImmediate(() => {
      const result = verifyLayerBlocks(bot, blocksByLayer.get(layerY))
      for (const target of result.missing) {
        const key = targetKey(target)
        if (!verificationPending.has(key)) {
          verificationQueue.set(key, {
            key,
            target,
            layerY,
            expiresAfterLayerIndex: layerIndex + verificationLayerWindow,
            attempts: 0,
            lastSentAt: 0
          })
        }
      }
      for (const mismatch of result.ignoredMismatches) {
        logger.debug(`Layer verification ignored wrong block at ${mismatch.target.x},${mismatch.target.y},${mismatch.target.z}: expected=${mismatch.target.name}, actual=${mismatch.actualName}.`)
      }
      logger.debug(`Layer Y${layerY} verification: missing=${result.missing.length}, wrongIgnored=${result.ignoredMismatches.length}.`)
      resolve(result)
    }))
    layerVerificationTasks.set(layerY, task)
  }

  const startLayerIndex = layerIndexByY.get(Number(blocks[startIdx]?.y))
  if (Number.isInteger(startLayerIndex)) {
    for (let index = Math.max(0, startLayerIndex - verificationLayerWindow); index < startLayerIndex; index += 1) {
      scheduleLayerVerification(layerYs[index])
    }
  }

  const logCheckpointPacketCadence = () => {
    if (!checkpointDispatchKey || checkpointPacketCount < 1) return
    const cutoff = Date.now() - 1000
    while (recentPlacementPacketTimes[0] < cutoff) recentPlacementPacketTimes.shift()
    logger.debug(`Checkpoint ${checkpointDispatchKey}: ${checkpointPacketCount} placement packet(s); rolling1s=${recentPlacementPacketTimes.length}pps, target=${targetBps}bps.`)
    checkpointDispatchKey = null
    checkpointPacketCount = 0
  }

  const commitConfirmedPlacements = async () => {
    while (committedIndex < blocks.length) {
      const entry = pendingPlacements.get(committedIndex)
      if (!entry?.confirmed) break
      pendingPlacements.delete(committedIndex)
      const savedProgress = updatePlacementProgress(bot, committedIndex, entry.target, {
        force: typeof options.afterPlacement === 'function'
      })
      if (entry.sent) {
        const telemetryBeforePlacement = telemetryPlaced
        telemetryPlaced += 1
        logger.debug(`[${committedIndex + 1}/${blocks.length}] Confirmed ${entry.target.name} at ${entry.target.x},${entry.target.y},${entry.target.z} (chunk ${chunkKey}).`)
        if (typeof options.afterPlacement === 'function') {
          await options.afterPlacement({
            bot,
            block: entry.target,
            blockIndex: committedIndex,
            chunkKey,
            chunkSlice,
            progress: savedProgress
          })
        }
        if (Math.floor(telemetryBeforePlacement / 100) < Math.floor(telemetryPlaced / 100)) {
          const elapsedSeconds = Math.max(0.001, (Date.now() - telemetryStartedAt) / 1000)
          const sample = readServerTpsSample(bot)
          logger.info(`Placement rate: ${(telemetryPlaced / elapsedSeconds).toFixed(2)}bps over ${telemetryPlaced} confirmed blocks; target=${targetBps}bps; TPS=${sample.tps.toFixed(1)}; pending=${pendingPlacements.size}.`)
        }
      } else if (entry.skippedUnconfirmed) {
        logger.warn(`Skipped unconfirmed ${entry.target.name} at ${entry.target.x},${entry.target.y},${entry.target.z} after ${placementRetries} local attempts; actual=${entry.skippedUnconfirmed}; continuing without a repair flight.`)
      } else if (entry.skippedMismatch) {
        logger.warn(`Recorded skipped mismatch at ${entry.target.x},${entry.target.y},${entry.target.z}: expected=${entry.target.name}, actual=${entry.skippedMismatch}.`)
      } else {
        logger.debug(`Block at ${entry.target.x},${entry.target.y},${entry.target.z} is already ${entry.target.name}; skipping.`)
      }
      committedIndex += 1
      if (Number(blocks[committedIndex]?.y) !== Number(entry.target.y)) scheduleLayerVerification(Number(entry.target.y))
    }
  }

  while (committedIndex < blocks.length) {
    if (activeCheckpointFlight?.done) await settleCheckpointFlight()
    if (bot.entity?.onGround) {
      await settleCheckpointFlight()
      if (bot.entity?.onGround) {
        const recoveryCheckpoint = checkpointForBlock[Math.min(committedIndex, checkpointForBlock.length - 1)] || null
        if (!recoveryCheckpoint) throw new Error(`Grounded during chunk ${chunkKey} without a recovery checkpoint.`)
        await recoverGroundedToCheckpoint(recoveryCheckpoint)
        continue
      }
    }
    for (const entry of pendingPlacements.values()) {
      if (!entry.confirmed && isPlacementConfirmed(bot, entry.target)) entry.confirmed = true
    }
    await commitConfirmedPlacements()
    if (committedIndex >= blocks.length) break

    const verificationNow = Date.now()
    const activeLayerIndex = layerIndexByY.get(Number(blocks[Math.min(committedIndex, blocks.length - 1)]?.y)) ?? layerYs.length - 1
    for (const [key, entry] of verificationPending) {
      const actual = bot.blockAt(new Vec3(entry.target.x, entry.target.y, entry.target.z))
      const actualName = normalizeBlockName(actual?.name)
      if (actualName === normalizeBlockName(entry.target.name)) {
        verificationPending.delete(key)
        logger.debug(`Parallel layer verification confirmed ${entry.target.name} at ${key}.`)
      } else if (actual && !isAirBlock(actualName)) {
        verificationPending.delete(key)
        logger.debug(`Parallel layer verification ignored wrong block at ${key}: expected=${entry.target.name}, actual=${actualName}.`)
      } else if (verificationNow - entry.lastSentAt >= placementRetryTimeoutMs) {
        verificationPending.delete(key)
        if (entry.attempts < placementRetries && (activeLayerIndex <= entry.expiresAfterLayerIndex || canDispatchVerificationRepair(bot, entry.target, maxPlacementReach))) verificationQueue.set(key, entry)
        else logger.warn(`Layer verification left ${entry.target.name} missing at ${key} after ${entry.attempts} packet attempt(s).`)
      }
    }
    for (const [key, entry] of verificationQueue) {
      if (activeLayerIndex <= entry.expiresAfterLayerIndex || canDispatchVerificationRepair(bot, entry.target, maxPlacementReach)) continue
      verificationQueue.delete(key)
      logger.warn(`Layer verification window expired for missing ${entry.target.name} at ${key}; continuing without a repair task.`)
    }

    if (bot.__interruptPrintRequested) {
      logger.info('Print interrupted by operator or test request.')
      break
    }

    const now = Date.now()
    if (now >= nextHealthCheckAt) {
      const healed = await checkAndConsumeGoldenApple(bot).catch((error) => {
        logger.debug(`Golden-apple check failed: ${error.message}`)
        return false
      })
      if (healed) {
        await refreshPrintingHotbar(nextDispatchIndex, 'after-heal')
      }
      nextHealthCheckAt = now + 1000
    }

    if (now >= nextElytraCheckAt) {
      nextElytraCheckAt = now + 1000
      if (isElytraLowDurability(bot)) {
        if (!storageRegistration) throw new Error('Elytra durability is below 10, but no storage registration is available for replacement.')
        const remaining = getElytraRemainingDurability(bot)
        logger.warn(`Elytra durability is ${remaining}; interrupting immediately for emergency replacement.`)
        bot.__elytraEmergencyRestockRequested = true
        bot.__interruptPrintRequested = true
        break
      }
    }

    const dueRetries = [...pendingPlacements.values()]
      .filter((entry) => !entry.confirmed && now - entry.lastSentAt >= placementRetryTimeoutMs)
      .sort((left, right) => left.index - right.index)

    if (dueRetries.length === 0 && nextDispatchIndex < blocks.length && pendingPlacements.size > 0) {
      const nextCheckpoint = checkpointForBlock[nextDispatchIndex]
      const nextCheckpointKey = `${nextCheckpoint.x},${nextCheckpoint.y},${nextCheckpoint.z}`
      const pendingCheckpointKeys = new Set([...pendingPlacements.values()].map((entry) => entry.checkpointKey))
      if (!pendingCheckpointKeys.has(nextCheckpointKey)) {
        await delay(CLIENT_TICK_MS)
        continue
      }
    }

    if (nextDispatchIndex < blocks.length) {
      const mismatch = await clearMismatchedBlocks(bot, [blocks[nextDispatchIndex]], { ...options, logger })
      if (mismatch.length > 0) {
        const checkpoint = checkpointForBlock[nextDispatchIndex]
        pendingPlacements.set(nextDispatchIndex, {
          index: nextDispatchIndex,
          target: blocks[nextDispatchIndex],
          checkpoint,
          checkpointKey: `${checkpoint.x},${checkpoint.y},${checkpoint.z}`,
          attempts: 0,
          lastSentAt: 0,
          confirmed: true,
          sent: false,
          skippedMismatch: normalizeBlockName(mismatch[0].currentBlock.name)
        })
        nextDispatchIndex += 1
        continue
      }
    }

    if (nextDispatchIndex < blocks.length && pendingPlacements.size < maxPendingPlacements && isPlacementConfirmed(bot, blocks[nextDispatchIndex])) {
      const checkpoint = checkpointForBlock[nextDispatchIndex]
      pendingPlacements.set(nextDispatchIndex, {
        index: nextDispatchIndex,
        target: blocks[nextDispatchIndex],
        checkpoint,
        checkpointKey: `${checkpoint.x},${checkpoint.y},${checkpoint.z}`,
        attempts: 0,
        lastSentAt: 0,
        confirmed: true,
        sent: false
      })
      nextDispatchIndex += 1
      continue
    }

    const exhausted = dueRetries.find((entry) => entry.attempts >= placementRetries)
    if (exhausted) {
      const actualName = normalizeBlockName(bot.blockAt(new Vec3(exhausted.target.x, exhausted.target.y, exhausted.target.z))?.name) || 'unloaded'
      if (options.skipUnconfirmed === true) {
        logger.warn(`Skipping unconfirmed ${exhausted.target.name} at ${exhausted.target.x},${exhausted.target.y},${exhausted.target.z} after ${placementRetries} local attempts; actual=${actualName}; continuing print.`)
        exhausted.confirmed = true
        exhausted.skippedUnconfirmed = actualName
        continue
      }
      const error = new Error(`Placement remained unconfirmed for ${exhausted.target.name} at ${exhausted.target.x},${exhausted.target.y},${exhausted.target.z} after ${placementRetries} local attempts; actual=${actualName}.`)
      error.code = 'PLACEMENT_UNCONFIRMED'
      throw error
    }

    let dispatchEntries = []
    let retrying = false
    let verificationDispatch = false
    if (dueRetries.length > 0) {
      retrying = true
      const retryMaterial = normalizeBlockName(dueRetries[0].target.name)
      const retryCheckpointKey = dueRetries[0].checkpointKey
      dispatchEntries = dueRetries
        .filter((entry) => entry.checkpointKey === retryCheckpointKey && normalizeBlockName(entry.target.name) === retryMaterial)
        .slice(0, effectiveBurstCap)
    }
    if (!retrying) {
      const verificationEntries = buildReachableVerificationBatch()
      const nextCheckpoint = checkpointForBlock[Math.min(nextDispatchIndex, checkpointForBlock.length - 1)]
      const nextCheckpointKey = nextCheckpoint ? `${nextCheckpoint.x},${nextCheckpoint.y},${nextCheckpoint.z}` : null
      if (shouldDispatchVerificationBeforePrimary({
        hasReachableVerification: verificationEntries.length > 0,
        primaryRemaining: nextDispatchIndex < blocks.length,
        primaryPacketsSinceVerification,
        currentCheckpointKey: activeCheckpointFlight?.key || currentCheckpointKey,
        nextCheckpointKey
      })) {
        verificationDispatch = true
        dispatchEntries = verificationEntries
      }
    }
    if (!verificationDispatch && !retrying && nextDispatchIndex < blocks.length && pendingPlacements.size < maxPendingPlacements) {
      const blockData = blocks[nextDispatchIndex]
      const checkpoint = resolveCheckpoint(checkpointForBlock[nextDispatchIndex])
      const checkpointKey = `${checkpoint.x},${checkpoint.y},${checkpoint.z}`

      const reservedMaterials = new Map()
      for (const pending of pendingPlacements.values()) {
        if (!pending.sent || pending.confirmed) continue
        const name = normalizeBlockName(pending.target.name)
        reservedMaterials.set(name, (reservedMaterials.get(name) || 0) + 1)
      }
      const hotbarCoverage = getPrintingHotbarCoverage(bot, blocks, {
        startIndex: nextDispatchIndex,
        lookaheadBlocks: hotbarRefreshLeadBlocks + 1,
        reservedMaterials
      })
      if (pendingPlacements.size === 0 && (nextDispatchIndex >= nextHotbarRefreshIndex || hotbarCoverage.coveredBlocks === 0)) {
        await refreshPrintingHotbar(
          nextDispatchIndex,
          hotbarCoverage.coveredBlocks === 0 ? 'material-miss' : 'lookahead',
          reservedMaterials,
          1
        )
      }

      if (checkpointKey !== currentCheckpointKey) {
        logCheckpointPacketCadence()
        const layerPass = layerPassForBlock[nextDispatchIndex] || [blockData.y]
        const layerPassKey = layerPass.join(',')
        if (currentLayerPassKey !== layerPassKey) {
          currentLayerPassKey = layerPassKey
          const layerLabel = layerPass.length > 1 ? `Y${layerPass[0]}-${layerPass.at(-1)}` : `Y${layerPass[0]}`
          const checkpointCount = layerPlan.filter((segment) => (segment.layers || [segment.layerY]).join(',') === layerPassKey).length
          logger.info(`Layer pass ${layerLabel}: ${layerPass.length} layer(s), ${checkpointCount} airborne checkpoint(s), printing begins immediately when blocks enter ${maxPlacementReach}-block range.`)
        }
        if (!printWhileFlying) {
          await settleCheckpointFlight()
          const reached = await flyLayerCheckpoint(checkpoint, { horizontalTolerance: 0.5, verticalTolerance: LAYER_VERTICAL_TOLERANCE })
          if (reached === false) continue
          currentCheckpointKey = checkpointKey
        } else {
          startCheckpointFlight(checkpoint, { horizontalTolerance: 0.5, verticalTolerance: LAYER_VERTICAL_TOLERANCE })
        }
      }

      let availableMaterial = Math.max(0, countInventoryItem(bot, blockData.name) - countPendingMaterial(pendingPlacements, blockData.name))
      if (availableMaterial < 1 && pendingPlacements.size === 0 && options.autoRestock !== false && storageRegistration) {
        await settleCheckpointFlight()
        logger.info(`Depleted ${blockData.name} at block ${committedIndex}/${blocks.length}; executing top-exit restock...`)
        const { planUpcomingChunkMaterials } = require('./inventory-manager')
        const midPlan = planUpcomingChunkMaterials(bot, plannedChunk, { startIndex: committedIndex, preserveOrder: true })
        if (midPlan.needsRestock) {
          await executeRestockDetour(bot, config, plannedChunk, midPlan, storageRegistration, checkpoint, options, logger)
          currentCheckpointKey = checkpointKey
        }
        availableMaterial = Math.max(0, countInventoryItem(bot, blockData.name) - countPendingMaterial(pendingPlacements, blockData.name))
      }
      if (availableMaterial < 1) {
        if (pendingPlacements.size > 0) {
          await delay(CLIENT_TICK_MS)
          continue
        }
        throw new Error(`Required material ${blockData.name} is missing after restock check.`)
      }

      const batchLimit = Math.min(effectiveBurstCap, availableMaterial, maxPendingPlacements - pendingPlacements.size)
      for (let candidateIndex = nextDispatchIndex; candidateIndex < blocks.length && dispatchEntries.length < batchLimit; candidateIndex += 1) {
        const candidate = blocks[candidateIndex]
        const candidateCheckpoint = checkpointForBlock[candidateIndex]
        const candidateCheckpointKey = `${candidateCheckpoint.x},${candidateCheckpoint.y},${candidateCheckpoint.z}`
        if (candidateCheckpointKey !== checkpointKey || normalizeBlockName(candidate.name) !== normalizeBlockName(blockData.name)) break
        if (isPlacementConfirmed(bot, candidate)) break
        dispatchEntries.push({
          index: candidateIndex,
          target: candidate,
          checkpoint: candidateCheckpoint,
          checkpointKey: candidateCheckpointKey,
          attempts: 0,
          lastSentAt: 0,
          confirmed: false,
          sent: true
        })
      }
      if (printWhileFlying && activeCheckpointFlight?.key === checkpointKey) {
        while (dispatchEntries.length > 0 && getEyeToBlockCenterDistance(bot, dispatchEntries.at(-1).target) > maxPlacementReach) {
          dispatchEntries.pop()
        }
      }
    }

    if (!retrying && dispatchEntries.length === 0) {
      const verificationEntries = buildReachableVerificationBatch()
      if (verificationEntries.length > 0) {
        verificationDispatch = true
        dispatchEntries = verificationEntries
      }
    }

    if (dispatchEntries.length === 0) {
      await delay(CLIENT_TICK_MS)
      continue
    }

    const dispatchMaterial = dispatchEntries[0].target.name
    const serialConfirmation = requiresSerialConfirmation(dispatchMaterial)
    const verificationReservedMaterial = countPendingMaterial(verificationPending, dispatchMaterial)
    const reservedMaterial = retrying
      ? Math.max(0, countPendingMaterial(pendingPlacements, dispatchMaterial) - dispatchEntries.length) + verificationReservedMaterial
      : countPendingMaterial(pendingPlacements, dispatchMaterial) + verificationReservedMaterial
    const availableForDispatch = Math.max(0, countInventoryItem(bot, dispatchMaterial) - reservedMaterial)
    if (availableForDispatch < 1) {
      if (verificationDispatch) {
        await delay(CLIENT_TICK_MS)
        continue
      }
      if (options.autoRestock !== false && storageRegistration) {
        await settleCheckpointFlight()
        const retryCheckpoint = dispatchEntries[0].checkpoint
        const { planUpcomingChunkMaterials } = require('./inventory-manager')
        const midPlan = planUpcomingChunkMaterials(bot, plannedChunk, { startIndex: committedIndex, preserveOrder: true })
        await executeRestockDetour(bot, config, plannedChunk, midPlan, storageRegistration, retryCheckpoint, options, logger)
        currentCheckpointKey = dispatchEntries[0].checkpointKey
        continue
      }
      throw new Error(`Required material ${dispatchMaterial} is missing for ${retrying ? 'placement retry' : 'printing'}.`)
    }
    dispatchEntries = dispatchEntries.slice(0, availableForDispatch)
    if (serialConfirmation) dispatchEntries = dispatchEntries.slice(0, 1)

    const grantedCredits = await waitForPlacementCredits(bot, budget, logger)
    if (grantedCredits < 1 || bot.__interruptPrintRequested) break
    dispatchEntries = dispatchEntries.slice(0, grantedCredits)
    if (dispatchEntries.length === 0) continue

    const dispatchCheckpointKey = dispatchEntries[0].checkpointKey
    let furthestDistance = Math.max(...dispatchEntries.map((entry) => getEyeToBlockCenterDistance(bot, entry.target)))
    let targetsBelowBot = dispatchEntries.every((entry) => isPlacementTargetBelowBot(bot, entry.target))
    if (verificationDispatch && (furthestDistance > maxPlacementReach || !targetsBelowBot)) {
      logger.debug(`Deferred ${dispatchEntries.length} layer-verification packet(s) after checkpoint movement; eyeRange=${furthestDistance.toFixed(2)}, limit=${maxPlacementReach}, belowBot=${targetsBelowBot}.`)
      await delay(CLIENT_TICK_MS)
      continue
    }
    if (furthestDistance > maxPlacementReach || !targetsBelowBot) {
      if (activeCheckpointFlight) {
        if (printWhileFlying && !retrying && activeCheckpointFlight.key === dispatchCheckpointKey && !activeCheckpointFlight.done) {
          await delay(CLIENT_TICK_MS)
          continue
        }
        await settleCheckpointFlight()
        furthestDistance = Math.max(...dispatchEntries.map((entry) => getEyeToBlockCenterDistance(bot, entry.target)))
        targetsBelowBot = dispatchEntries.every((entry) => isPlacementTargetBelowBot(bot, entry.target))
      }
    }
    if (furthestDistance > maxPlacementReach || !targetsBelowBot) {
      const correctionCheckpoint = dispatchEntries[0].checkpoint
      logger.debug(`Checkpoint drift before batch at block ${dispatchEntries[0].index}: eyeRange=${furthestDistance.toFixed(2)}, belowBot=${targetsBelowBot}; correcting to ${dispatchEntries[0].checkpointKey}.`)
      const reached = await flyLayerCheckpoint(correctionCheckpoint, {
        horizontalTolerance: 0.3,
        verticalTolerance: LAYER_VERTICAL_TOLERANCE,
        timeoutMs: Number(options.moveTimeoutMs || 30000)
      })
      if (reached === false) continue
      currentCheckpointKey = dispatchEntries[0].checkpointKey
      furthestDistance = Math.max(...dispatchEntries.map((entry) => getEyeToBlockCenterDistance(bot, entry.target)))
      targetsBelowBot = dispatchEntries.every((entry) => isPlacementTargetBelowBot(bot, entry.target))
      if (furthestDistance > maxPlacementReach + 0.15) {
        throw new Error(`Layer checkpoint ${dispatchEntries[0].checkpointKey} cannot reach batch at block ${dispatchEntries[0].index}; eyeRange=${furthestDistance.toFixed(2)}, limit=${maxPlacementReach}.`)
      }
      if (!targetsBelowBot) {
        throw new Error(`Layer checkpoint ${dispatchEntries[0].checkpointKey} leaves block ${dispatchEntries[0].index} above the bot; refusing placement.`)
      }
    }

    const packetSlots = await waitForPlacementPacketSlots(recentPlacementPacketTimes, dispatchEntries.length)
    dispatchEntries = dispatchEntries.slice(0, packetSlots)
    if (!budget.tryConsume(dispatchEntries.length)) continue

    let batchResult
    try {
      batchResult = await placeBlockBatch(bot, dispatchEntries.map((entry) => entry.target), {
        ...options,
        logger,
        forceDirect: false,
        supportAttemptOffset: retrying ? dispatchEntries[0].attempts % 6 : 0,
        waitForConfirmation: serialConfirmation
      })
    } catch (error) {
      if (error?.code === 'HOTBAR_MATERIAL_NOT_READY') {
        const refreshIndex = Math.max(0, Number(dispatchEntries[0]?.index) >= 0 ? Number(dispatchEntries[0].index) : committedIndex)
        const reservedMaterials = new Map()
        for (const pending of [...pendingPlacements.values(), ...verificationPending.values()]) {
          if (!pending.sent || pending.confirmed) continue
          const name = normalizeBlockName(pending.target.name)
          reservedMaterials.set(name, (reservedMaterials.get(name) || 0) + 1)
        }
        logger.warn(`${error.message} Refreshing the route-ordered hotbar; no placement packets were sent.`)
        await refreshPrintingHotbar(refreshIndex, 'placement-hotbar-miss', reservedMaterials, 1)
        await delay(CLIENT_TICK_MS)
        continue
      }
      if (error?.code !== 'HOTBAR_SELECTION_UNCONFIRMED') throw error
      logger.warn(`${error.message} Retrying the same batch locally; no placement packets were sent.`)
      await delay(CLIENT_TICK_MS)
      continue
    }
    const skippedMismatches = new Map((batchResult?.skippedMismatches || []).map(({ targetVec, currentBlock }) => [
      `${targetVec.x},${targetVec.y},${targetVec.z}`,
      normalizeBlockName(currentBlock.name)
    ]))
    const deferredTargets = new Set((batchResult?.deferredTargets || []).map((target) => `${target.x},${target.y},${target.z}`))
    const sentAt = Date.now()
    if (checkpointDispatchKey !== dispatchEntries[0].checkpointKey) {
      logCheckpointPacketCadence()
      checkpointDispatchKey = dispatchEntries[0].checkpointKey
    }
    const sentEntries = dispatchEntries.filter((entry) => {
      const key = `${entry.target.x},${entry.target.y},${entry.target.z}`
      return !skippedMismatches.has(key) && !deferredTargets.has(key)
    })
    checkpointPacketCount += sentEntries.length
    if (verificationDispatch && sentEntries.length > 0) primaryPacketsSinceVerification = 0
    else primaryPacketsSinceVerification += sentEntries.length
    for (let packetIndex = 0; packetIndex < sentEntries.length; packetIndex += 1) recentPlacementPacketTimes.push(sentAt)
    for (const entry of dispatchEntries) {
      const skippedMismatch = skippedMismatches.get(`${entry.target.x},${entry.target.y},${entry.target.z}`)
      if (deferredTargets.has(`${entry.target.x},${entry.target.y},${entry.target.z}`)) continue
      if (entry.verificationRepair) {
        verificationQueue.delete(entry.key)
        if (skippedMismatch) {
          verificationPending.delete(entry.key)
          logger.debug(`Parallel layer verification ignored wrong block at ${entry.key}: expected=${entry.target.name}, actual=${skippedMismatch}.`)
        } else {
          entry.attempts += 1
          entry.lastSentAt = sentAt
          verificationPending.set(entry.key, entry)
        }
        continue
      }
      if (skippedMismatch) {
        if (retrying) {
          const pending = pendingPlacements.get(entry.index)
          pending.confirmed = true
          pending.sent = false
          pending.skippedMismatch = skippedMismatch
        } else {
          pendingPlacements.set(entry.index, { ...entry, confirmed: true, sent: false, skippedMismatch })
          nextDispatchIndex += 1
        }
        continue
      }
      if (retrying) {
        const pending = pendingPlacements.get(entry.index)
        pending.attempts += 1
        pending.lastSentAt = sentAt
        logger.warn(`Retry ${pending.attempts}/${placementRetries} queued for ${pending.target.name} at ${pending.target.x},${pending.target.y},${pending.target.z}.`)
      } else {
        entry.attempts = 1
        entry.lastSentAt = sentAt
        pendingPlacements.set(entry.index, entry)
        nextDispatchIndex += 1
      }
    }
    logger.debug(`Queued ${sentEntries.length} ${verificationDispatch ? 'layer-verification' : retrying ? 'retry' : 'placement'} packet(s); deferredAbove=${deferredTargets.size}, pending=${pendingPlacements.size}/${maxPendingPlacements}, verification=${verificationPending.size + verificationQueue.size}.`)
    if (placementIntervalMs > 0) await delay(placementIntervalMs)
  }

  await settleCheckpointFlight()
  logCheckpointPacketCadence()
  if (bot.__interruptPrintRequested) {
    return {
      chunkKey,
      placedCount: Number(bot.placedBlocksCount || 0),
      totalBlocks: blocks.length,
      interruptedReason: bot.__elytraEmergencyRestockRequested ? 'elytra-restock' : 'operator'
    }
  }
  const finalVerification = verifyLayerBlocks(bot, blocks)
  if (finalVerification.missing.length > 0) {
    const missingKeys = new Set(finalVerification.missing.map((block) => `${block.x},${block.y},${block.z}`))
    const earliestMissingIndex = blocks.findIndex((block) => missingKeys.has(`${block.x},${block.y},${block.z}`))
    const rewindIndex = earliestMissingIndex < 0 ? 0 : earliestMissingIndex
    bot.placedBlocksCount = rewindIndex
    saveProgress(bot, {
      activeChunk: plannedChunk,
      placedBlocks: rewindIndex,
      status: 'repairing',
      localJsonPath: plannedChunk.localJsonPath
    })
    const sample = finalVerification.missing.slice(0, 5).map((block) => `${block.name}@${block.x},${block.y},${block.z}`).join('; ')
    const error = new Error(`Chunk ${chunkKey} final validation found ${finalVerification.missing.length} missing block(s); rewound to block ${rewindIndex}/${blocks.length}. ${sample}`)
    error.code = 'CHUNK_MISSING_BLOCKS'
    throw error
  }
  const finishedCount = bot.placedBlocksCount || 0
  if (finishedCount >= blocks.length) {
    logger.info(`Chunk ${chunkKey} finished all ${blocks.length} blocks!`)
    if (finishChunkJob) await finishChunkJob(bot, config, chunkKey, { fileId: chunkSlice.fileId })
  }

  return { chunkKey, placedCount: finishedCount, totalBlocks: blocks.length }
}

module.exports = {
  clearMismatchedBlocks,
  canDispatchVerificationRepair,
  createPrinterLogger,
  enableAntiFallHover,
  executeRestockDetour,
  flyToTargetInAir,
  getConfirmedPrefixEnd,
  getLocalRecoveryEnvelope,
  isDebugLogging,
  isInsideChunkColumn,
  isPlacementTargetBelowBot,
  isAboveStationLandingColumn,
  placeBlockBatch,
  placeBlockAirOrSupport,
  printChunkSlice,
  readServerTpsSample,
  returnLowDurabilityElytraToStation,
  setDebugLogging,
  shouldDispatchVerificationBeforePrimary,
  silentSwapBack,
  silentSwapToItem,
  verifyLayerBlocks,
  waitForPlacementPacketSlots,
  waitForCheckpointChunk,
  waitForExpectedBlock
}
