'use strict'

const { Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder')
const { MeteorElytraController, normalizeMeteorElytraSettings } = require('./meteor-elytra-controller')

const MAX_FLIGHT_ALTITUDE_Y = 324

const HAZARDOUS_BLOCKS = new Set([
  'bubble_column',
  'cactus',
  'campfire',
  'fire',
  'lava',
  'magma_block',
  'pointed_dripstone',
  'powder_snow',
  'soul_campfire',
  'sweet_berry_bush',
  'water',
  'wither_rose'
])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function positionSnapshot(bot) {
  const position = bot.entity?.position
  return position ? { x: position.x, y: position.y, z: position.z } : null
}

function formatPosition(position) {
  if (!position) return 'unknown'
  return `${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`
}

function horizontalDistance(left, right) {
  return Math.hypot(Number(right.x) - Number(left.x), Number(right.z) - Number(left.z))
}

function distance(left, right) {
  return Math.hypot(
    Number(right.x) - Number(left.x),
    Number(right.y) - Number(left.y),
    Number(right.z) - Number(left.z)
  )
}

function getLandingVelocity(position, target, options = {}) {
  const remainingHeight = Math.max(0, Number(position.y) - Number(target.y))
  const deltaX = Number(target.x) - Number(position.x)
  const deltaZ = Number(target.z) - Number(position.z)
  const drift = Math.hypot(deltaX, deltaZ)
  const verticalBlocksPerSecond = remainingHeight > 3
    ? 1.5
    : (remainingHeight > 1 ? 0.75 : (remainingHeight > 0.35 ? 0.3 : 0.08))
  const horizontalBlocksPerSecond = drift > 1.25
    ? 1.5
    : (drift > 0.4 ? 0.75 : (drift > 0.15 ? 0.25 : 0))
  const horizontalScale = drift > 0 ? horizontalBlocksPerSecond / (20 * drift) : 0
  const liftBlocksPerSecond = Math.max(0, Number(options.liftBlocksPerSecond || 0))
  return {
    x: deltaX * horizontalScale,
    y: liftBlocksPerSecond > 0 ? liftBlocksPerSecond / 20 : -verticalBlocksPerSecond / 20,
    z: deltaZ * horizontalScale,
    drift,
    remainingHeight,
    horizontalBlocksPerSecond,
    verticalBlocksPerSecond
  }
}

function getLandingApproachAltitude(position, target, nearbyDistance = 8) {
  const currentY = Number(position.y)
  if (horizontalDistance(position, target) <= Math.max(0, Number(nearbyDistance))) {
    return Math.max(Number(target.y) + 2, currentY)
  }
  return Math.min(MAX_FLIGHT_ALTITUDE_Y - 10, Math.max(Number(target.y) + 12, currentY))
}

function assertConnected(bot) {
  if (!bot.entity || bot?._client?.state === 'disconnected') throw new Error('Bot disconnected during Elytra flight.')
  if (Number(bot.health) <= 0) throw new Error('Bot health reached zero during Elytra flight.')
}

function assertElytraEquipped(bot) {
  const torsoSlot = bot.getEquipmentDestSlot('torso')
  const equipped = bot.inventory.slots[torsoSlot]
  if (equipped?.name !== 'elytra') throw new Error('Elytra is no longer equipped in the torso slot.')
  return equipped
}

function getGroundClearance(bot, maxDistance = 2) {
  const position = bot.entity?.position
  if (!position || typeof bot.blockAt !== 'function') return Number.POSITIVE_INFINITY
  const x = Math.floor(position.x)
  const z = Math.floor(position.z)
  for (let offset = 0; offset <= Math.ceil(maxDistance); offset += 1) {
    const y = Math.floor(position.y - 0.01) - offset
    const block = bot.blockAt(blockPosition(bot, x, y, z))
    if (!block || block.boundingBox === 'empty') continue
    return position.y - (y + 1)
  }
  return Number.POSITIVE_INFINITY
}

async function pathfindToWaterExit(bot, target, timeoutMs) {
  if (!bot.pathfinder || !target) return false
  const movements = bot.pathfinder.movements || new Movements(bot)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.allowSprinting = false
  bot.pathfinder.setMovements(movements)
  let timer = null
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Water-exit path timed out.')), timeoutMs)
      })
    ])
  } catch (error) {
    console.log(`[ELYTRA-WARN] Dry-exit path failed: ${error.message}`)
  } finally {
    if (timer) clearTimeout(timer)
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  return bot.entity?.isInWater !== true
}

async function performWaterEscape(bot, timeoutMs) {
  if (!bot.entity?.isInWater) return false
  try { stopElytraFlight(bot) } catch {}
  bot.clearControlStates?.()
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 6000))
  const exitTarget = findSafeLandingSpot(bot, bot.entity.position, {
    radius: 12,
    searchAbove: 3,
    searchBelow: 3
  })
  console.log(exitTarget
    ? `[ELYTRA] Swimming toward dry exit at ${formatPosition(exitTarget)} before flight recovery.`
    : '[ELYTRA] Swimming vertically out of water before flight recovery.')
  if (exitTarget && bot.pathfinder) {
    const pathTimeoutMs = Math.max(1000, Math.min(12000, deadline - Date.now() - 500))
    if (await pathfindToWaterExit(bot, exitTarget, pathTimeoutMs)) return true
  }
  bot.setControlState?.('jump', true)
  bot.setControlState?.('forward', Boolean(exitTarget))
  let nextLookAt = 0
  let drySince = null
  try {
    while (Date.now() < deadline) {
      if (bot.entity?.isInWater) drySince = null
      else {
        drySince ??= Date.now()
        if (bot.entity?.onGround || Date.now() - drySince >= 300) break
      }
      if (exitTarget && Date.now() >= nextLookAt) {
        await bot.lookAt?.(blockPosition(bot, exitTarget.x, exitTarget.y + 0.5, exitTarget.z), true)
        nextLookAt = Date.now() + 500
      }
      if (bot.entity?.velocity) bot.entity.velocity.set(bot.entity.velocity.x, Math.max(0.2, bot.entity.velocity.y), bot.entity.velocity.z)
      await delay(50)
    }
  } finally {
    bot.setControlState?.('jump', false)
    bot.setControlState?.('forward', false)
  }
  if (bot.entity?.isInWater) throw new Error('Could not exit water before flight recovery timeout.')
  return true
}

async function escapeWaterForFlight(bot, timeoutMs = 20000) {
  if (!bot.entity?.isInWater) return false
  if (bot.__waterEscapePromise) return bot.__waterEscapePromise
  const escapePromise = performWaterEscape(bot, timeoutMs)
  bot.__waterEscapePromise = escapePromise
  try {
    return await escapePromise
  } finally {
    if (bot.__waterEscapePromise === escapePromise) bot.__waterEscapePromise = null
  }
}

async function requestElytraStart(bot) {
  try {
    if (typeof bot.elytraFly === 'function') await bot.elytraFly()
    else bot.elytrafly?.sendStartStopPacket?.()
  } catch (error) {
    if (!String(error?.message || error).includes('Already elytra flying')) throw error
  }
  if (bot.entity && !bot.entity.onGround && !bot.entity.isInWater) {
    bot.entity.elytraFlying = true
  }
}

async function ensureElytraGliding(bot, options = {}) {
  if (bot.entity?.elytraFlying === true) return true
  await escapeWaterForFlight(bot, options.waterEscapeTimeoutMs)
  const attempts = Math.max(1, Number(options.attempts || 4))
  const confirmationMs = Math.max(100, Number(options.confirmationMs || 500))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertConnected(bot)
    assertElytraEquipped(bot)
    if (bot.entity?.isInWater) {
      await escapeWaterForFlight(bot, options.waterEscapeTimeoutMs)
      continue
    }
    if (bot.entity?.onGround) throw new Error('Cannot arm Elytra glide while on the ground.')
    if (bot.entity?.velocity && bot.entity.velocity.y > 0.05) {
      const apexDeadline = Date.now() + Math.max(100, Number(options.apexTimeoutMs || 500))
      while (!bot.entity?.onGround && bot.entity?.velocity?.y > 0.05 && Date.now() < apexDeadline) await delay(25)
    }
    if (bot.entity?.onGround) throw new Error('Bot landed before Elytra glide could be armed.')
    if (bot.entity?.velocity && bot.entity.velocity.y >= -0.01) {
      bot.entity.velocity.set(bot.entity.velocity.x, -0.02, bot.entity.velocity.z)
    }
    try {
      await requestElytraStart(bot)
    } catch (error) {
      if (!String(error?.message || error).includes('while in water')) throw error
      await escapeWaterForFlight(bot, options.waterEscapeTimeoutMs)
      continue
    }
    const deadline = Date.now() + confirmationMs
    let nextRequestAt = 0
    while (Date.now() < deadline) {
      if (bot.entity?.elytraFlying === true) return true
      if (bot.entity?.onGround) break
      if (Date.now() >= nextRequestAt) {
        bot.elytrafly?.sendStartStopPacket?.()
        nextRequestAt = Date.now() + 100
      }
      await delay(25)
    }
  }
  throw new Error(`Server did not confirm Elytra glide after ${attempts} attempts; refusing survival landing.`)
}

async function ensureElytraTakeoff(bot, options = {}) {
  const minimumClearance = Math.max(0.25, Number(options.minimumClearance || 0.75))
  if (bot.entity?.elytraFlying === true && bot.entity?.onGround === false && getGroundClearance(bot) >= minimumClearance) return true
  const attempts = Math.max(1, Number(options.attempts || 4))
  const airborneTimeoutMs = Math.max(250, Number(options.airborneTimeoutMs || 1500))
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertConnected(bot)
    assertElytraEquipped(bot)
    const groundClearance = getGroundClearance(bot)
    if (bot.entity?.onGround || groundClearance < minimumClearance) {
      const groundY = Number(bot.entity?.position?.y || 0) - (Number.isFinite(groundClearance) ? groundClearance : 0)
      const deadline = Date.now() + airborneTimeoutMs
      bot.setControlState?.('jump', true)
      try {
        while (Date.now() < deadline) {
          if (bot.entity?.elytraFlying === true) {
            if (bot.entity.velocity) bot.entity.velocity.set(bot.entity.velocity.x, Math.max(0.3, bot.entity.velocity.y), bot.entity.velocity.z)
            return true
          }
          const currentY = Number(bot.entity?.position?.y || groundY)
          const airborne = !bot.entity?.onGround && currentY >= groundY + 0.2
          const atApex = airborne && Number(bot.entity?.velocity?.y || 0) <= 0.1
          if (atApex) {
            bot.setControlState?.('jump', false)
            try { await requestElytraStart(bot) } catch (err) { lastError = err }
          }
          await delay(25)
        }
      } finally {
        bot.setControlState?.('jump', false)
      }
    }
    if (bot.entity?.elytraFlying === true) return true
    if (!bot.entity?.onGround) {
      try {
        await requestElytraStart(bot)
        if (bot.entity?.elytraFlying === true) return true
      } catch (err) { lastError = err }
    } else {
      lastError = new Error('Bot did not leave the ground for Elytra takeoff.')
    }
    await delay(100)
  }
  throw lastError || new Error('Elytra takeoff failed.')
}

function getElytraTickListenerCount(bot) {
  const listeners = new Set([
    bot?.elytrafly?.onTick,
    bot?.elytrafly?.__legacyOnTick,
    bot?.elytrafly?.__meteorController?.onTick
  ].filter(Boolean))
  if (listeners.size === 0 || typeof bot?.listeners !== 'function') return 0
  return bot.listeners('physicsTick').filter((listener) => listeners.has(listener)).length
}

function removeElytraTickListeners(bot) {
  const listeners = new Set([
    bot?.elytrafly?.onTick,
    bot?.elytrafly?.__legacyOnTick,
    bot?.elytrafly?.__meteorController?.onTick
  ].filter(Boolean))
  if (listeners.size === 0 || typeof bot?.removeListener !== 'function') return 0
  let removed = 0
  for (const listener of listeners) {
    while (bot.listeners?.('physicsTick').includes(listener)) {
      bot.removeListener('physicsTick', listener)
      removed += 1
    }
  }
  return removed
}

function installElytraFlightLifecycle(bot) {
  const flight = bot?.elytrafly
  if (!flight) return flight
  if (flight.__masterPrinterLifecycleInstalled) {
    flight.__meteorController.configure(bot.config?.elytraFly || {})
    return flight
  }

  const legacyOnTick = flight.onTick
  removeElytraTickListeners(bot)
  const controller = new MeteorElytraController(bot, bot.config?.elytraFly || {})
  flight.__legacyOnTick = legacyOnTick
  flight.__meteorController = controller
  flight.onTick = controller.onTick
  flight.start = () => {
    removeElytraTickListeners(bot)
    controller.configure(bot.config?.elytraFly || {})
    controller.start()
    flight.tryingToTakeOff = bot.entity?.onGround === true
    return flight
  }
  flight.stop = () => {
    removeElytraTickListeners(bot)
    controller.stop()
    flight.tryingToTakeOff = false
    return flight
  }
  flight.setControlState = (state, value) => controller.setControlState(state, value)
  flight.getControlState = (state) => controller.getControlState(state)
  flight.setGoal = (target, options) => controller.setGoal(target, options)
  flight.clearGoal = () => controller.clearGoal()
  flight.configureMeteor = (settings) => controller.configure(settings)
  Object.defineProperty(flight, '__masterPrinterLifecycleInstalled', {
    configurable: false,
    enumerable: false,
    value: true
  })
  return flight
}

function configureMeteorElytra(bot, settings = {}) {
  const flight = installElytraFlightLifecycle(bot)
  if (!flight) throw new Error('ElytraFly plugin is not loaded.')
  const config = normalizeMeteorElytraSettings({ ...(bot.config?.elytraFly || {}), ...settings })
  flight.__meteorController.configure(config)
  return config
}

function startElytraFlight(bot) {
  const flight = installElytraFlightLifecycle(bot)
  if (!flight) throw new Error('ElytraFly plugin is not loaded.')
  flight.start()
  return getElytraTickListenerCount(bot)
}

function disableElytraHover(bot) {
  if (bot?.__elytraAltitudeHold?.onTick) bot.removeListener?.('physicsTick', bot.__elytraAltitudeHold.onTick)
  delete bot?.__elytraAltitudeHold
  bot?.elytrafly?.clearGoal?.()
}

function stopElytraFlight(bot) {
  disableElytraHover(bot)
  const flight = installElytraFlightLifecycle(bot)
  if (!flight) return 0
  flight.stop()
  return getElytraTickListenerCount(bot)
}

function engageElytraHover(bot, options = {}) {
  const listenerCount = startElytraFlight(bot)
  const settings = configureMeteorElytra(bot, options.settings || {})
  clearElytraControls(bot)
  const position = bot.entity?.position
  const currentY = Number(bot.entity?.position?.y)
  const hoverCeilingY = Math.min(settings.maxAltitudeY, settings.maxPathingY)
  const safeTargetY = Math.min(hoverCeilingY, Number.isFinite(Number(options.targetY)) ? Number(options.targetY) : currentY)
  if (position) {
    bot.elytrafly.setGoal({ x: position.x, y: safeTargetY, z: position.z }, {
      horizontalTolerance: 0.05,
      verticalTolerance: 0.02
    })
  }
  if (options.sendStartPacket !== false && bot.entity?.onGround === false) {
    bot.elytrafly.sendStartStopPacket?.()
  }
  return { listenerCount, airborne: bot.entity?.onGround === false, targetY: safeTargetY }
}

function clampVelocity(bot, horizontalBlocksPerSecond, verticalBlocksPerSecond) {
  const velocity = bot.entity?.velocity
  if (!velocity) return { horizontal: 0, vertical: 0 }

  const currentY = Number(bot.entity?.position?.y || 0)
  if (currentY >= MAX_FLIGHT_ALTITUDE_Y && velocity.y > 0) {
    velocity.set(velocity.x, 0, velocity.z)
  }

  const horizontalPerTick = Math.max(0.05, horizontalBlocksPerSecond / 20)
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  if (horizontalSpeed > horizontalPerTick) {
    const scale = horizontalPerTick / horizontalSpeed
    velocity.set(velocity.x * scale, velocity.y, velocity.z * scale)
  }

  const verticalPerTick = Math.max(0.005, verticalBlocksPerSecond / 20)
  if (velocity.y > verticalPerTick) velocity.set(velocity.x, verticalPerTick, velocity.z)
  if (velocity.y < -verticalPerTick) velocity.set(velocity.x, -verticalPerTick, velocity.z)
  return {
    horizontal: Math.hypot(velocity.x, velocity.z) * 20,
    vertical: velocity.y * 20
  }
}

function clearElytraControls(bot, options = {}) {
  if (!bot.elytrafly) return
  if (options.preserveGoal !== true) bot.elytrafly.clearGoal?.()
  for (const state of ['forward', 'back', 'up', 'down']) bot.elytrafly.setControlState(state, false)
  bot.setControlState?.('jump', false)
}

function setElytraVerticalControl(bot, direction = 'neutral') {
  if (!bot.elytrafly) return
  bot.elytrafly.setControlState('up', false)
  bot.elytrafly.setControlState('down', false)
  const currentY = Number(bot.entity?.position?.y || 0)
  if (direction === 'up') {
    if (currentY < MAX_FLIGHT_ALTITUDE_Y) bot.elytrafly.setControlState('up', true)
  }
  if (direction === 'down') bot.elytrafly.setControlState('down', true)
}

function getPacketFlag(packet, name, bit) {
  if (typeof packet.flags === 'object') return packet.flags?.[name] === true
  return (Number(packet.flags) & bit) !== 0
}

function resolvePositionPacket(currentPosition, packet) {
  return {
    x: getPacketFlag(packet, 'x', 1) ? currentPosition.x + Number(packet.x) : Number(packet.x),
    y: getPacketFlag(packet, 'y', 2) ? currentPosition.y + Number(packet.y) : Number(packet.y),
    z: getPacketFlag(packet, 'z', 4) ? currentPosition.z + Number(packet.z) : Number(packet.z)
  }
}

function directionForYaw(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) }
}

function createFlightTelemetry(bot, limits, options = {}) {
  const logger = options.logger || console.log
  const correctionThreshold = Number(options.correctionThreshold ?? 0.05)
  const stats = {
    correctionCount: 0,
    totalCorrectionDistance: 0,
    maximumCorrectionDistance: 0,
    backwardCorrectionCount: 0,
    maximumHorizontalVelocity: 0,
    maximumActualHorizontalSpeed: 0,
    speedLimitViolationCount: 0,
    measuredSpeedViolationCount: 0
  }
  let currentPhase = 'preflight'
  let expectedYaw = null
  let previousPosition = positionSnapshot(bot)
  let speedWindowStartedAt = Date.now()
  let speedWindowDistance = 0
  let measuredHorizontalSpeed = 0
  let lastLogAt = 0

  const onPosition = (packet) => {
    const before = positionSnapshot(bot)
    if (!before) return
    const target = resolvePositionPacket(before, packet)
    if (![target.x, target.y, target.z].every(Number.isFinite)) return
    const correctionDistance = distance(before, target)
    if (correctionDistance < correctionThreshold) return

    stats.correctionCount += 1
    stats.totalCorrectionDistance += correctionDistance
    stats.maximumCorrectionDistance = Math.max(stats.maximumCorrectionDistance, correctionDistance)
    if (expectedYaw != null) {
      const direction = directionForYaw(expectedYaw)
      const alongFlightPath = ((target.x - before.x) * direction.x) + ((target.z - before.z) * direction.z)
      if (alongFlightPath < -0.5) stats.backwardCorrectionCount += 1
    }
    logger(`[ELYTRA-CORRECTION] phase=${currentPhase} distance=${correctionDistance.toFixed(2)} from=${formatPosition(before)} to=${formatPosition(target)} count=${stats.correctionCount}`)
  }

  const onPhysicsTick = () => {
    const velocity = clampVelocity(bot, limits.horizontalBlocksPerSecond, limits.verticalBlocksPerSecond)
    if (Number.isFinite(limits.holdAltitude) && bot.entity?.velocity) {
      const targetAltitude = Math.min(MAX_FLIGHT_ALTITUDE_Y - 2, limits.holdAltitude)
      const altitudeError = targetAltitude - bot.entity.position.y
      const maxVertical = Math.max(1, Math.min(Number(limits.verticalBlocksPerSecond ?? 6), 6))
      let heldVerticalSpeed = Math.max(-maxVertical, Math.min(maxVertical, altitudeError * 2))
      if (bot.entity.position.y >= MAX_FLIGHT_ALTITUDE_Y && heldVerticalSpeed > 0) {
        heldVerticalSpeed = 0
      }
      bot.entity.velocity.set(bot.entity.velocity.x, heldVerticalSpeed / 20, bot.entity.velocity.z)
      velocity.vertical = heldVerticalSpeed
    }
    stats.maximumHorizontalVelocity = Math.max(stats.maximumHorizontalVelocity, velocity.horizontal)
    if (velocity.horizontal > limits.horizontalBlocksPerSecond + 0.25) stats.speedLimitViolationCount += 1

    const now = Date.now()
    const currentPosition = positionSnapshot(bot)
    if (previousPosition && currentPosition) speedWindowDistance += horizontalDistance(previousPosition, currentPosition)
    if (now - speedWindowStartedAt >= 1000) {
      measuredHorizontalSpeed = speedWindowDistance / ((now - speedWindowStartedAt) / 1000)
      stats.maximumActualHorizontalSpeed = Math.max(stats.maximumActualHorizontalSpeed, measuredHorizontalSpeed)
      if (measuredHorizontalSpeed > Number(limits.absoluteHorizontalBlocksPerSecond ?? 60) + 0.5) {
        stats.measuredSpeedViolationCount += 1
      }
      speedWindowStartedAt = now
      speedWindowDistance = 0
    }
    previousPosition = currentPosition

    if (now - lastLogAt >= 1000) {
      lastLogAt = now
      logger(`[ELYTRA-LIVE] phase=${currentPhase} pos=${formatPosition(currentPosition)} velocity=${velocity.horizontal.toFixed(2)}bps measured=${measuredHorizontalSpeed.toFixed(2)}bps vertical=${velocity.vertical.toFixed(2)}bps onGround=${Boolean(bot.entity?.onGround)} health=${Number(bot.health).toFixed(1)} corrections=${stats.correctionCount}`)
    }
  }

  bot._client.prependListener('position', onPosition)
  bot.on('physicsTick', onPhysicsTick)

  return {
    stats,
    setPhase(name, yaw = null, holdAltitude = null) {
      currentPhase = name
      expectedYaw = yaw
      limits.holdAltitude = holdAltitude
      previousPosition = positionSnapshot(bot)
      speedWindowStartedAt = Date.now()
      speedWindowDistance = 0
      measuredHorizontalSpeed = 0
      logger(`[ELYTRA-PHASE] ${name}`)
    },
    stop() {
      bot._client.removeListener('position', onPosition)
      bot.removeListener('physicsTick', onPhysicsTick)
    }
  }
}

function isHazardousBlock(block) {
  if (!block) return true
  const name = String(block.name || '')
  return HAZARDOUS_BLOCKS.has(name) || name.endsWith('_leaves') || name.endsWith('_portal')
}

function isFullBlockSurface(block) {
  if (!block || isHazardousBlock(block) || block.boundingBox !== 'block') return false
  if (!Array.isArray(block.shapes) || block.shapes.length === 0) return true
  return block.shapes.some((shape) => (
    shape[0] <= 0 && shape[1] <= 0 && shape[2] <= 0 &&
    shape[3] >= 1 && shape[4] >= 1 && shape[5] >= 1
  ))
}

function isClearLandingSpace(block) {
  return Boolean(block) && !isHazardousBlock(block) && block.boundingBox === 'empty'
}

function blockPosition(bot, x, y, z) {
  const position = bot.entity.position.clone()
  position.set(x, y, z)
  return position
}

function isLandingPadSafe(bot, x, surfaceY, z, footprintRadius = 0) {
  for (let offsetX = -footprintRadius; offsetX <= footprintRadius; offsetX += 1) {
    for (let offsetZ = -footprintRadius; offsetZ <= footprintRadius; offsetZ += 1) {
      const blockX = x + offsetX
      const blockZ = z + offsetZ
      const surface = bot.blockAt(blockPosition(bot, blockX, surfaceY, blockZ), false)
      const feet = bot.blockAt(blockPosition(bot, blockX, surfaceY + 1, blockZ), false)
      const head = bot.blockAt(blockPosition(bot, blockX, surfaceY + 2, blockZ), false)
      if (!isFullBlockSurface(surface) || !isClearLandingSpace(feet) || !isClearLandingSpace(head)) return false
    }
  }
  return true
}

function landingOffsets(radius) {
  const offsets = []
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) offsets.push({ x, z, distanceSquared: (x * x) + (z * z) })
  }
  offsets.sort((left, right) => left.distanceSquared - right.distanceSquared)
  return offsets
}

function findSafeLandingSpot(bot, origin, options = {}) {
  if (!origin || !bot.entity?.position) return null
  const radius = Math.max(0, Number(options.radius ?? 10))
  const minWorldY = Number(bot.game?.minY ?? 0)
  const maxWorldY = minWorldY + Number(bot.game?.height ?? 256) - 1
  const maxY = Math.min(maxWorldY, Math.floor(origin.y) + Number(options.searchAbove ?? 8))
  const minY = Math.max(minWorldY, Math.floor(origin.y) - Number(options.searchBelow ?? 96))
  const originX = Math.floor(origin.x)
  const originZ = Math.floor(origin.z)
  const offsets = landingOffsets(radius)

  for (const footprintRadius of [1, 0]) {
    for (const offset of offsets) {
      const x = originX + offset.x
      const z = originZ + offset.z
      for (let surfaceY = maxY; surfaceY >= minY; surfaceY -= 1) {
        if (!isLandingPadSafe(bot, x, surfaceY, z, footprintRadius)) continue
        return {
          x: x + 0.5,
          y: surfaceY + 1,
          z: z + 0.5,
          surfaceY,
          footprintRadius
        }
      }
    }
  }
  return null
}

function verifyLandingTarget(bot, target) {
  return Boolean(target) && isLandingPadSafe(
    bot,
    Math.floor(target.x),
    Number(target.surfaceY),
    Math.floor(target.z),
    Number(target.footprintRadius || 0)
  )
}

function resolveAnchorLandingTarget(bot, anchor) {
  if (!anchor || !bot.entity?.position) return null
  const x = Math.floor(Number(anchor.x))
  const y = Math.floor(Number(anchor.y))
  const z = Math.floor(Number(anchor.z))
  if (![x, y, z].every(Number.isFinite)) return null

  for (const surfaceY of [y, y - 1]) {
    for (const footprintRadius of [1, 0]) {
      if (!isLandingPadSafe(bot, x, surfaceY, z, footprintRadius)) continue
      return { x: x + 0.5, y: surfaceY + 1, z: z + 0.5, surfaceY, footprintRadius }
    }
  }
  return findSafeLandingSpot(bot, { x: x + 0.5, y: y + 1, z: z + 0.5 }, {
    radius: 8,
    searchAbove: 8,
    searchBelow: 32
  })
}

async function equipElytra(bot, logger = console.log) {
  const torsoSlot = bot.getEquipmentDestSlot('torso')
  const equipped = bot.inventory.slots[torsoSlot]
  if (equipped?.name === 'elytra') {
    logger(`[ELYTRA-TEST] Elytra already equipped in torso slot ${torsoSlot}.`)
    return equipped
  }

  const elytra = bot.inventory.items().find((item) => item.name === 'elytra')
  if (!elytra) {
    const names = bot.inventory.items().map((item) => `${item.name}x${item.count}`).join(', ') || 'empty'
    throw new Error(`No elytra found in ${bot.username} inventory. Inventory: ${names}`)
  }
  await bot.equip(elytra, 'torso')
  const confirmed = assertElytraEquipped(bot)
  logger(`[ELYTRA-TEST] Equipped ${confirmed.displayName || confirmed.name} in torso slot ${torsoSlot}.`)
  return confirmed
}

async function runPhase(bot, telemetry, phase) {
  disableElytraHover(bot)
  clearElytraControls(bot)
  if (phase.yaw != null) await bot.look(phase.yaw, 0, true)
  const startPosition = positionSnapshot(bot)
  telemetry.setPhase(phase.name, phase.forward ? phase.yaw : null, phase.holdAltitude ? startPosition.y : null)
  if (phase.forward) bot.elytrafly.setControlState('forward', true)
  if (phase.up) bot.elytrafly.setControlState('up', true)
  if (phase.down) bot.elytrafly.setControlState('down', true)

  const startedAt = Date.now()
  const deadline = startedAt + phase.durationMs
  while (Date.now() < deadline) {
    assertConnected(bot)
    assertElytraEquipped(bot)
    if (bot.entity?.onGround || bot.entity?.elytraFlying !== true) {
      await ensureElytraTakeoff(bot, { attempts: 3, confirmationMs: 500, airborneTimeoutMs: 1500 })
    }
    await delay(100)
  }
  const endPosition = positionSnapshot(bot)
  clearElytraControls(bot)
  const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
  const horizontal = startPosition && endPosition ? horizontalDistance(startPosition, endPosition) : 0
  const vertical = startPosition && endPosition ? endPosition.y - startPosition.y : 0
  console.log(`[ELYTRA-PHASE-END] ${phase.name} horizontal=${horizontal.toFixed(2)} vertical=${vertical.toFixed(2)} average=${(horizontal / seconds).toFixed(2)}bps pos=${formatPosition(endPosition)}`)
  await delay(250)
}

async function moveToLandingApproach(bot, target, telemetry, limits) {
  const approachY = getLandingApproachAltitude(bot.entity.position, target)
  telemetry.setPhase('landing-approach', null, approachY)
  if (horizontalDistance(bot.entity.position, target) <= 12) {
    try {
      const { FlightCheckpoint, flyToCheckpoint, generateObstacleAwareReentryCheckpoints } = require('./flight-trajectory-planner')
      const approachTarget = new FlightCheckpoint(target.x, approachY, target.z, 'landing-approach-route', Number(bot.config?.elytraFly?.horizontalSpeed || 2))
      const checkpoints = generateObstacleAwareReentryCheckpoints(bot, bot.entity.position, approachTarget, {
        chunkX: Math.floor(Number(target.x) / 16),
        chunkZ: Math.floor(Number(target.z) / 16),
        horizontalSpeed: Number(bot.config?.elytraFly?.horizontalSpeed || 2),
        searchMargin: 8,
        verticalMarginY: 4
      })
      console.log(`[ELYTRA-LANDING] Obstacle-aware nearby approach planned ${checkpoints.length} checkpoint(s) at Y${approachY.toFixed(2)}.`)
      for (const checkpoint of checkpoints) {
        await flyToCheckpoint(bot, checkpoint, {
          horizontalTolerance: 0.25,
          verticalTolerance: 0.25,
          timeoutMs: 15000,
          elytraFly: {
            ...(bot.config?.elytraFly || {}),
            maxAltitudeY: Math.min(Number(bot.config?.elytraFly?.maxAltitudeY ?? MAX_FLIGHT_ALTITUDE_Y), approachY + 4.5)
          }
        })
      }
      limits.holdAltitude = null
      return
    } catch (error) {
      console.warn(`[ELYTRA-LANDING] Obstacle-aware nearby approach failed: ${error.message}. Falling back to direct approach.`)
    }
  }
  clearElytraControls(bot)
  if (bot.entity.position.y < approachY - 1) setElytraVerticalControl(bot, 'up')
  const climbDeadline = Date.now() + 15000
  while (bot.entity.position.y < approachY - 1 && Date.now() < climbDeadline) {
    assertConnected(bot)
    await delay(100)
  }
  clearElytraControls(bot)
  limits.holdAltitude = approachY

  const approachDeadline = Date.now() + 45000
  while (horizontalDistance(bot.entity.position, target) > 1.25 && Date.now() < approachDeadline) {
    assertConnected(bot)
    if (!verifyLandingTarget(bot, target)) throw new Error('The selected landing pad changed or unloaded during the flight.')
    const remaining = horizontalDistance(bot.entity.position, target)
    limits.horizontalBlocksPerSecond = remaining > 30 ? 20 : (remaining > 12 ? 12 : 6)
    limits.verticalBlocksPerSecond = 5
    const lookTarget = blockPosition(bot, target.x, bot.entity.position.y + Number(bot.entity.eyeHeight ?? 1.62), target.z)
    await bot.lookAt(lookTarget, true)
    bot.elytrafly.setControlState('forward', true)
    const verticalDirection = bot.entity.position.y < approachY - 1.5
      ? 'up'
      : (bot.entity.position.y > approachY + 1.5 ? 'down' : 'neutral')
    setElytraVerticalControl(bot, verticalDirection)
    await delay(100)
  }
  clearElytraControls(bot)
  limits.holdAltitude = null
  if (horizontalDistance(bot.entity.position, target) > 2) throw new Error('Timed out while returning to the verified landing pad.')
}

async function descendOntoLandingPad(bot, target, telemetry, limits) {
  disableElytraHover(bot)
  telemetry.setPhase('landing-descent', null, null)
  const initialHeight = Math.max(0, bot.entity.position.y - target.y)
  const descentBudgetMs = Math.ceil((initialHeight / 7) * 1000) + 30000
  const deadline = Date.now() + Math.max(45000, descentBudgetMs)
  const landingHealth = Number(bot.health)
  let glideActive = false
  let flareController = null
  let flareLiftUntil = 0
  let flareLeveled = false
  let landed = false
  bot.__landingState = {
    target: { ...target },
    startedAt: Date.now(),
    startHealth: landingHealth,
    phase: 'landing-descent'
  }

  try {
    clearElytraControls(bot)
    startElytraFlight(bot)
    await ensureElytraGliding(bot, { attempts: 6, confirmationMs: 500 })
    console.log(`[ELYTRA-LANDING] Server-confirmed Elytra glide armed before descent from ${initialHeight.toFixed(2)} blocks.`)
    while (!bot.entity.onGround && Date.now() < deadline) {
    assertConnected(bot)
    assertElytraEquipped(bot)
    if (bot.entity?.elytraFlying !== true) {
      clearElytraControls(bot)
      startElytraFlight(bot)
      await ensureElytraGliding(bot, { attempts: 6, confirmationMs: 500 })
      console.log(`[ELYTRA-LANDING] Re-armed server-confirmed Elytra glide during descent.`)
    }
    if (!verifyLandingTarget(bot, target)) throw new Error('The selected landing pad is no longer safe.')
    const remainingHeight = bot.entity.position.y - target.y
    const drift = horizontalDistance(bot.entity.position, target)
    bot.__landingState = {
      ...bot.__landingState,
      phase: glideActive ? 'landing-glide' : 'landing-descent',
      remainingHeight,
      drift,
      position: positionSnapshot(bot),
      velocity: bot.entity.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : null
    }

    const glideThreshold = Number(limits.glideHeight ?? 5)
    if (glideActive || remainingHeight <= glideThreshold) {
      if (!glideActive) {
        glideActive = true
        const flareLiftBlocksPerSecond = Math.max(0.5, Number(bot.config?.elytraFly?.landingFlareLiftBlocksPerSecond ?? 1.6))
        const flareDurationMs = Math.max(250, Number(bot.config?.elytraFly?.landingFlareDurationMs ?? 750))
        flareLiftUntil = Date.now() + flareDurationMs
        telemetry.setPhase('landing-glide', null, null)
        clearElytraControls(bot)
        limits.verticalBlocksPerSecond = 1.5
        limits.horizontalBlocksPerSecond = 1.5
        await bot.look(bot.entity.yaw, -0.35, true).catch(() => {})
        flareController = () => {
          if (bot.entity?.onGround || !bot.entity?.velocity) return
          const controlledVelocity = getLandingVelocity(bot.entity.position, target, {
            liftBlocksPerSecond: Date.now() < flareLiftUntil ? flareLiftBlocksPerSecond : 0
          })
          bot.entity.velocity.set(controlledVelocity.x, controlledVelocity.y, controlledVelocity.z)
          }
          bot.on('physicsTick', flareController)
          flareController()
          await ensureElytraGliding(bot)
          console.log(`[ELYTRA-LANDING] Server-confirmed flare engaged ${remainingHeight.toFixed(2)} blocks above the pad; mode=${bot.game?.gameMode || 'unknown'} health=${Number(bot.health).toFixed(1)}.`)
      } else {
        flareController?.()
        if (!flareLeveled && Date.now() >= flareLiftUntil) {
          flareLeveled = true
          void bot.look(bot.entity.yaw, 0, true).catch(() => {})
        }
      }
    } else {
      const configuredH = Number(bot.config?.elytraFly?.horizontalSpeed ? bot.config.elytraFly.horizontalSpeed * 20 : 30)
      const configuredV = Number(bot.config?.elytraFly?.verticalSpeed ? bot.config.elytraFly.verticalSpeed * 10 : 20)
      limits.horizontalBlocksPerSecond = drift > 1 ? Math.min(configuredH, 12) : 2
      limits.verticalBlocksPerSecond = remainingHeight > 20 ? configuredV : (remainingHeight > 8 ? Math.min(configuredV, 10) : 4)

      if (drift > 0.65) {
        const lookTarget = blockPosition(bot, target.x, bot.entity.position.y + Number(bot.entity.eyeHeight ?? 1.62), target.z)
        await bot.lookAt(lookTarget, true).catch(() => {})
        bot.elytrafly.setControlState('forward', true)
      } else {
        bot.elytrafly.setControlState('forward', false)
      }
      setElytraVerticalControl(bot, 'down')
    }
      if (bot.entity.onGround) break
      if (bot.entity.position.y < target.y - 0.5) throw new Error('Descended below the verified landing surface height.')
      await delay(glideActive ? 50 : 100)
    }
    if (!bot.entity.onGround) throw new Error(`Landing did not settle on the verified pad; position=${formatPosition(positionSnapshot(bot))}.`)
    landed = true
  } finally {
    if (flareController) bot.removeListener?.('physicsTick', flareController)
    clearElytraControls(bot)
    bot.clearControlStates?.()
    if (bot.entity?.onGround) {
      if (bot.entity.velocity) bot.entity.velocity.set(0, 0, 0)
      stopElytraFlight(bot)
      disableElytraHover(bot)
    } else if (!landed) {
      try { engageElytraHover(bot, { targetY: Math.max(Number(bot.entity?.position?.y || target.y + 2), target.y + 2) }) } catch {}
    }
    delete bot.__landingState
  }

  await delay(500)
  assertConnected(bot)
  const finalHealth = Number(bot.health)
  if (Number.isFinite(landingHealth) && finalHealth < landingHealth) {
    throw new Error(`Landing caused ${(landingHealth - finalHealth).toFixed(1)} damage in ${bot.game?.gameMode || 'unknown'} mode.`)
  }
  console.log(`[ELYTRA-LANDING] Safe stable landing at ${formatPosition(positionSnapshot(bot))} on dry solid ground.`)
}

function classifyRubberbanding(stats) {
  return stats.maximumCorrectionDistance >= 1.5 ||
    stats.backwardCorrectionCount >= 2 ||
    (stats.correctionCount >= 3 && stats.totalCorrectionDistance >= 2)
}

async function waitForChunks(bot, timeoutMs = 8000) {
  if (typeof bot.waitForChunksToLoad !== 'function') return
  try {
    await Promise.race([
      bot.waitForChunksToLoad(),
      delay(timeoutMs)
    ])
  } catch { }
}

async function travelToAnchor(bot, anchor, options = {}) {
  const logger = options.logger || console.log
  const anchorPoint = {
    x: Math.floor(Number(anchor?.x)),
    y: Math.floor(Number(anchor?.y)),
    z: Math.floor(Number(anchor?.z))
  }
  const currentPos = bot.entity?.position
  const dist = currentPos
    ? Math.hypot(currentPos.x - (anchorPoint.x + 0.5), currentPos.y - (anchorPoint.y + 1), currentPos.z - (anchorPoint.z + 0.5))
    : Number.POSITIVE_INFINITY

  const anchorCenter = { x: anchorPoint.x + 0.5, y: anchorPoint.y + 1, z: anchorPoint.z + 0.5 }

  if (options.hoverInAir === true || options.noLanding === true) {
    const horiz = currentPos ? Math.hypot(currentPos.x - anchorCenter.x, currentPos.z - anchorCenter.z) : Number.POSITIVE_INFINITY
    const vert = currentPos ? Math.abs(currentPos.y - anchorCenter.y) : Number.POSITIVE_INFINITY
    if (horiz <= 1.5 && vert <= 0.8) {
      logger(`[ELYTRA-ANCHOR] Already at air destination (${dist.toFixed(2)} blocks away); hovering in air.`)
      return { landingTarget: anchorCenter, alreadyNearby: true, hovering: true }
    }
  } else if (dist <= 6.0) {
    const current = positionSnapshot(bot)
    const landingTarget = findSafeLandingSpot(bot, current, { radius: 4 }) ||
      resolveAnchorLandingTarget(bot, anchorPoint) ||
      { x: anchorPoint.x + 0.5, y: anchorPoint.y + 1, z: anchorPoint.z + 0.5 }
    if (bot.entity.onGround || options.hoverInAir === true || options.noLanding === true) {
      logger(`[ELYTRA-ANCHOR] Already at anchor destination (${dist.toFixed(2)} blocks away); skipping flight.`)
      return { landingTarget, alreadyNearby: true }
    }
    logger(`[ELYTRA-ANCHOR] Already near anchor destination (${dist.toFixed(2)} blocks away) in air; descending onto landing pad.`)
    const limits = {
      horizontalBlocksPerSecond: 4,
      verticalBlocksPerSecond: 2,
      absoluteHorizontalBlocksPerSecond: 30
    }
    const telemetry = createFlightTelemetry(bot, limits, options)
    try {
      await descendOntoLandingPad(bot, landingTarget, telemetry, limits)
      return { landingTarget, alreadyNearby: true, telemetry: { ...telemetry.stats } }
    } finally {
      clearElytraControls(bot)
      bot.clearControlStates?.()
      if (bot.entity?.onGround) stopElytraFlight(bot)
      telemetry.stop()
    }
  }

  if (!bot.elytrafly) throw new Error('ElytraFly plugin is not loaded.')
  assertConnected(bot)
  if (bot.isSleeping && typeof bot.wake === 'function') await bot.wake()
  await equipElytra(bot, logger)
  if (![anchorPoint.x, anchorPoint.y, anchorPoint.z].every(Number.isFinite)) throw new Error('A finite anchor x, y, and z are required.')

  const elytraConfig = bot.config?.elytraFly || options.config?.elytraFly || {}
  const meteorSettings = configureMeteorElytra(bot, {
    ...elytraConfig,
    ...(options.elytraFly || {}),
    horizontalSpeed: Number(options.horizontalSpeed ?? (options.speedBlocksPerSecond == null ? elytraConfig.horizontalSpeed : Number(options.speedBlocksPerSecond) / 20) ?? 2),
    verticalSpeed: Number(options.verticalSpeed ?? (options.verticalBlocksPerSecond == null ? elytraConfig.verticalSpeed : Number(options.verticalBlocksPerSecond) / 10) ?? 2)
  })
  const requestedHorizontal = meteorSettings.horizontalSpeed * 20
  const requestedVertical = meteorSettings.verticalSpeed * 10
  const absoluteMaxSpeed = Math.max(requestedHorizontal, Math.min(80, Number(options.absoluteMaxSpeedBlocksPerSecond ?? 70)))
  const glideHeight = Math.max(2, Math.min(20, Number(options.glideHeight ?? meteorSettings.glideHeight)))

  const limits = {
    horizontalBlocksPerSecond: requestedHorizontal,
    verticalBlocksPerSecond: requestedVertical,
    absoluteHorizontalBlocksPerSecond: absoluteMaxSpeed,
    glideHeight
  }
  if (bot.entity.onGround && horizontalDistance(bot.entity.position, anchorCenter) <= 4) {
    await waitForChunks(bot)
    const nearbyTarget = resolveAnchorLandingTarget(bot, anchorPoint)
    if (nearbyTarget) return { landingTarget: nearbyTarget, alreadyNearby: true, telemetry: null }
  }

  stopElytraFlight(bot)
  clearElytraControls(bot)
  startElytraFlight(bot)
  configureMeteorElytra(bot, meteorSettings)
  const controller = bot.elytrafly.__meteorController
  const telemetry = createFlightTelemetry(bot, limits, options)
  let landed = false

  try {
    const startedOnGround = bot.entity.onGround
    await ensureElytraTakeoff(bot, { attempts: 6, confirmationMs: 500, airborneTimeoutMs: 1500 })
    if (startedOnGround) {
      await runPhase(bot, telemetry, { name: 'anchor-takeoff', durationMs: 2200, up: true })
    }

    const departureY = Number(bot.entity?.position?.y || 0)
    const isNearbyAdjustment = horizontalDistance(bot.entity.position, anchorCenter) <= 25
    const cruiseAltitude = isNearbyAdjustment
      ? Math.min(MAX_FLIGHT_ALTITUDE_Y - 10, Math.max(departureY, anchorPoint.y + 2))
      : Math.min(
      MAX_FLIGHT_ALTITUDE_Y - 10,
      Math.max(departureY + 8, anchorPoint.y + 24, 106)
    )

    const needsClimb = bot.entity.position.y < (cruiseAltitude - 2)
    if (needsClimb) {
      telemetry.setPhase('anchor-climb', null, cruiseAltitude)
      clearElytraControls(bot)
      controller.setGoal({ x: bot.entity.position.x, y: cruiseAltitude, z: bot.entity.position.z }, {
        horizontal: false,
        verticalTolerance: 1
      })
      controller.onTick()
      limits.horizontalBlocksPerSecond = 0
      const climbDeadline = Date.now() + Math.max(20000, Math.ceil(Math.abs(cruiseAltitude - bot.entity.position.y) / 4) * 1000)
      while (bot.entity.position.y < cruiseAltitude - 1 && bot.entity.position.y < MAX_FLIGHT_ALTITUDE_Y - 2 && Date.now() < climbDeadline) {
        assertConnected(bot)
        assertElytraEquipped(bot)
        await delay(100)
      }
      clearElytraControls(bot)
    }

    telemetry.setPhase('anchor-cruise', null, cruiseAltitude)
    const initialDistance = horizontalDistance(bot.entity.position, anchorCenter)
    const deadline = Date.now() + Math.max(60000, Math.ceil(initialDistance / 12) * 1000)
    const isAirTarget = options.hoverInAir === true || options.noLanding === true
    const targetArrivalDistance = isAirTarget ? 2.5 : 8
    const timeoutDistance = isAirTarget ? 5.0 : 10

    while (horizontalDistance(bot.entity.position, anchorCenter) > targetArrivalDistance && Date.now() < deadline) {
      assertConnected(bot)
      assertElytraEquipped(bot)
      const remaining = horizontalDistance(bot.entity.position, anchorCenter)
      limits.horizontalBlocksPerSecond = remaining > 40 ? requestedHorizontal : (remaining > 15 ? 14 : 6)
      const currentTargetAlt = (isAirTarget && remaining <= 25) ? anchorCenter.y : cruiseAltitude
      controller.setGoal({ x: anchorCenter.x, y: currentTargetAlt, z: anchorCenter.z }, {
        horizontalTolerance: targetArrivalDistance,
        verticalTolerance: 1
      })
      controller.onTick()
      await delay(100)
    }
    clearElytraControls(bot)
    limits.holdAltitude = null
    if (horizontalDistance(bot.entity.position, anchorCenter) > timeoutDistance) throw new Error('Timed out before reaching the storage anchor area.')

    if (isAirTarget) {
      console.log(`[ELYTRA-ANCHOR] Arrived at air target ${formatPosition(anchorPoint)} (dist=${horizontalDistance(bot.entity.position, anchorCenter).toFixed(2)}, y=${bot.entity.position.y.toFixed(2)}); hovering in air without landing.`)
      clearElytraControls(bot)
      engageElytraHover(bot, { targetY: anchorCenter.y })
      return { landingTarget: anchorCenter, alreadyNearby: false, telemetry: { ...telemetry.stats }, hovering: true }
    }

    await waitForChunks(bot)
    const landingTarget = resolveAnchorLandingTarget(bot, anchorPoint)
    if (!landingTarget) throw new Error(`No dry solid landing surface was found at or near anchor ${anchorPoint.x},${anchorPoint.y},${anchorPoint.z}.`)
    console.log(`[ELYTRA-ANCHOR] Landing target ${formatPosition(landingTarget)} resolved from anchor block ${anchorPoint.x}, ${anchorPoint.y}, ${anchorPoint.z}.`)
    await moveToLandingApproach(bot, landingTarget, telemetry, limits)
    await descendOntoLandingPad(bot, landingTarget, telemetry, limits)
    landed = true

    const rubberbandingDetected = classifyRubberbanding(telemetry.stats)
    const speedSafe = telemetry.stats.speedLimitViolationCount === 0 && telemetry.stats.measuredSpeedViolationCount === 0
    if (!speedSafe) throw new Error('Anchor travel exceeded its configured speed safety limit.')
    if (rubberbandingDetected) throw new Error('Anchor travel detected repeated or large server position corrections.')
    return { landingTarget, alreadyNearby: false, telemetry: { ...telemetry.stats } }
  } finally {
    clearElytraControls(bot)
    if (landed || bot.entity?.onGround) stopElytraFlight(bot)
    telemetry.stop()
  }
}

async function runDirectionalFlightTest(bot, options = {}) {
  if (!bot.elytrafly) throw new Error('ElytraFly plugin is not loaded.')
  assertConnected(bot)
  assertElytraEquipped(bot)

  const elytraConfig = bot.config?.elytraFly || options.config?.elytraFly || {}
  const meteorSettings = configureMeteorElytra(bot, {
    ...elytraConfig,
    horizontalSpeed: Number(options.horizontalSpeed ?? elytraConfig.horizontalSpeed ?? 2),
    verticalSpeed: Number(options.verticalSpeed ?? elytraConfig.verticalSpeed ?? 2)
  })
  const requestedHorizontal = meteorSettings.horizontalSpeed * 20
  const requestedVertical = meteorSettings.verticalSpeed * 10
  const absoluteMaxSpeed = Math.max(requestedHorizontal, Math.min(80, Number(options.absoluteMaxSpeedBlocksPerSecond ?? 70)))
  const glideHeight = Math.max(2, Math.min(20, Number(options.glideHeight ?? meteorSettings.glideHeight)))
  const lateralPhaseMs = Math.max(1500, Math.min(6000, Number(options.lateralPhaseMs ?? 3000)))
  const landingTarget = findSafeLandingSpot(bot, positionSnapshot(bot), { radius: 10 })
  if (!landingTarget) throw new Error('No dry solid landing pad was found near the starting position; refusing to launch.')
  console.log(`[ELYTRA-LANDING] Verified ${landingTarget.footprintRadius ? '3x3' : '1x1'} landing pad centered at ${formatPosition(landingTarget)}.`)

  const limits = {
    horizontalBlocksPerSecond: requestedHorizontal,
    verticalBlocksPerSecond: requestedVertical,
    absoluteHorizontalBlocksPerSecond: absoluteMaxSpeed,
    glideHeight
  }
  stopElytraFlight(bot)
  clearElytraControls(bot)
  startElytraFlight(bot)
  configureMeteorElytra(bot, meteorSettings)
  const telemetry = createFlightTelemetry(bot, limits, options)
  const startingYaw = bot.entity.yaw
  let landed = false

  try {
    console.log(`[ELYTRA-TEST] Launching from ${formatPosition(positionSnapshot(bot))}; Meteor horizontal-speed=${meteorSettings.horizontalSpeed.toFixed(1)} vertical-speed=${meteorSettings.verticalSpeed.toFixed(1)}.`)
    await ensureElytraTakeoff(bot, { attempts: 6, confirmationMs: 500, airborneTimeoutMs: 1500 })
    await runPhase(bot, telemetry, { name: 'up', durationMs: 2200, up: true })
    if (bot.entity.onGround) throw new Error('Elytra takeoff failed; the bot remained on the ground.')
    await runPhase(bot, telemetry, { name: 'down', durationMs: 900, down: true })
    await runPhase(bot, telemetry, { name: 'left', durationMs: lateralPhaseMs, yaw: startingYaw - (Math.PI / 2), forward: true, holdAltitude: true })
    await runPhase(bot, telemetry, { name: 'right', durationMs: lateralPhaseMs, yaw: startingYaw + (Math.PI / 2), forward: true, holdAltitude: true })
    await moveToLandingApproach(bot, landingTarget, telemetry, limits)
    await descendOntoLandingPad(bot, landingTarget, telemetry, limits)
    landed = true
  } finally {
    clearElytraControls(bot)
    if (landed || bot.entity?.onGround) stopElytraFlight(bot)
    telemetry.stop()
  }

  const rubberbandingDetected = classifyRubberbanding(telemetry.stats)
  const speedSafe = telemetry.stats.speedLimitViolationCount === 0 && telemetry.stats.measuredSpeedViolationCount === 0
  console.log(`[ELYTRA-RESULT] maxVelocity=${telemetry.stats.maximumHorizontalVelocity.toFixed(2)}bps maxMeasured=${telemetry.stats.maximumActualHorizontalSpeed.toFixed(2)}bps corrections=${telemetry.stats.correctionCount} maxCorrection=${telemetry.stats.maximumCorrectionDistance.toFixed(2)} backwardCorrections=${telemetry.stats.backwardCorrectionCount} velocityViolations=${telemetry.stats.speedLimitViolationCount} measuredViolations=${telemetry.stats.measuredSpeedViolationCount} speedSafe=${speedSafe} rubberbanding=${rubberbandingDetected ? 'DETECTED' : 'not-detected'}`)
  return { ...telemetry.stats, rubberbandingDetected, speedSafe, landingTarget, landed }
}

module.exports = {
  classifyRubberbanding,
  clearElytraControls,
  configureMeteorElytra,
  descendOntoLandingPad,
  moveToLandingApproach,
  clampVelocity,
  createFlightTelemetry,
  disableElytraHover,
  engageElytraHover,
  escapeWaterForFlight,
  ensureElytraGliding,
  ensureElytraTakeoff,
  equipElytra,
  findSafeLandingSpot,
  formatPosition,
  getLandingVelocity,
  getLandingApproachAltitude,
  horizontalDistance,
  blockPosition,
  getElytraTickListenerCount,
  installElytraFlightLifecycle,
  isClearLandingSpace,
  isFullBlockSurface,
  MAX_FLIGHT_ALTITUDE_Y,
  resolveAnchorLandingTarget,
  resolvePositionPacket,
  runDirectionalFlightTest,
  setElytraVerticalControl,
  startElytraFlight,
  stopElytraFlight,
  travelToAnchor
}







