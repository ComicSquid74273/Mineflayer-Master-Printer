'use strict'

const { Vec3 } = require('vec3')
const {
  configureMeteorElytra,
  engageElytraHover,
  disableElytraHover,
  clearElytraControls,
  startElytraFlight,
  ensureElytraGliding,
  ensureElytraTakeoff,
  horizontalDistance,
  MAX_FLIGHT_ALTITUDE_Y
} = require('./elytra-flight')

const DEFAULT_EYE_HEIGHT = 1.62

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isOpenFlightBlock(block) {
  return Boolean(block && (block.boundingBox === 'empty' || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'))
}

function isFlightCellOpen(bot, x, z, escapeY, entityHeight = 1.8) {
  const bottomY = Math.floor(escapeY)
  const topY = Math.ceil(escapeY + entityHeight) - 1
  for (let y = bottomY; y <= topY; y += 1) {
    if (!isOpenFlightBlock(bot.blockAt(new Vec3(x, y, z)))) return false
  }
  return true
}

function isVerticalShaftClear(bot, x, z, escapeY, targetY, entityHeight = 1.8) {
  const bottomY = Math.floor(escapeY)
  const topY = Math.ceil(Math.max(escapeY, targetY) + entityHeight) - 1
  for (let y = bottomY; y <= topY; y += 1) {
    if (!isOpenFlightBlock(bot.blockAt(new Vec3(x, y, z)))) return false
  }
  return true
}

function isDirectFlightClear(bot, fromPos, toPos, entityHeight = 1.8) {
  if (!fromPos || !toPos) return true
  const steps = Math.max(2, Math.ceil(Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y, toPos.z - fromPos.z) * 3))
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps
    const x = fromPos.x + (toPos.x - fromPos.x) * t
    const y = fromPos.y + (toPos.y - fromPos.y) * t
    const z = fromPos.z + (toPos.z - fromPos.z) * t
    if (!isFlightCellOpen(bot, Math.floor(x), Math.floor(z), y, entityHeight)) return false
  }
  return true
}

function findVerticalShaftEscapePath(bot, targetY, options = {}) {
  if (!bot.entity?.position || typeof bot.blockAt !== "function") return []
  const startX = Math.floor(bot.entity.position.x)
  const startY = Math.floor(bot.entity.position.y)
  const startZ = Math.floor(bot.entity.position.z)
  const escapeY = Number(bot.entity.position.y)
  const searchRadius = Math.max(1, Math.min(64, Math.floor(Number(options.searchRadius || 24))))
  if (isVerticalShaftClear(bot, startX, startZ, escapeY, targetY)) {
    const centerX = startX + 0.5
    const centerZ = startZ + 0.5
    if (Math.hypot(bot.entity.position.x - centerX, bot.entity.position.z - centerZ) <= 0.2) return []
    return [{ x: centerX, y: escapeY, z: centerZ }]
  }

  const startKey = `${startX},${startY},${startZ}`
  const queue = [{ x: startX, y: startY, z: startZ }]
  const parents = new Map([[startKey, null]])
  const directions = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [0, 1, 0], [0, -1, 0],
    [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
  ]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [deltaX, deltaY, deltaZ] of directions) {
      const x = current.x + deltaX
      const y = current.y + deltaY
      const z = current.z + deltaZ
      if (Math.abs(x - startX) > searchRadius || Math.abs(z - startZ) > searchRadius || Math.abs(y - startY) > 6) continue
      const key = `${x},${y},${z}`
      if (parents.has(key) || !isFlightCellOpen(bot, x, z, y === startY ? escapeY : y)) continue
      parents.set(key, `${current.x},${current.y},${current.z}`)
      queue.push({ x, y, z })
      if (!isVerticalShaftClear(bot, x, z, y === startY ? escapeY : y, targetY)) continue

      const path = []
      let cursor = key
      while (cursor !== startKey) {
        const [pathX, pathY, pathZ] = cursor.split(",").map(Number)
        path.push({ x: pathX + 0.5, y: pathY === startY ? escapeY : pathY, z: pathZ + 0.5 })
        cursor = parents.get(cursor)
      }
      return path.reverse()
    }
  }
  return null
}
function resolveSafeLayerCheckpoint(bot, checkpoint, targetBlocks, options = {}) {
  if (!bot.entity?.position || typeof bot.blockAt !== 'function') return checkpoint
  const chunkX = Number.isFinite(Number(options.chunkX)) ? Number(options.chunkX) : Math.floor(checkpoint.x / 16)
  const chunkZ = Number.isFinite(Number(options.chunkZ)) ? Number(options.chunkZ) : Math.floor(checkpoint.z / 16)
  const searchMargin = Math.max(0, Math.min(4, Math.floor(Number(options.searchMargin ?? 2))))
  const minX = chunkX * 16 - searchMargin
  const minZ = chunkZ * 16 - searchMargin
  const maxX = chunkX * 16 + 15 + searchMargin
  const maxZ = chunkZ * 16 + 15 + searchMargin
  const maxReach = Math.max(2, Math.min(5, Number(options.maxReach || 5)))
  const eyeHeight = Math.max(0, Number(options.eyeHeight ?? DEFAULT_EYE_HEIGHT))
  const requireVerticalShaft = options.requireVerticalShaft === true
  const skywayY = Number(options.skywayY)
  const blocks = (targetBlocks || []).filter((block) => [block?.x, block?.y, block?.z].every((value) => Number.isFinite(Number(value))))
  const candidates = [{ x: checkpoint.x, z: checkpoint.z }]
  for (let x = minX + 0.5; x <= maxX + 0.5; x += 1) {
    for (let z = minZ + 0.5; z <= maxZ + 0.5; z += 1) candidates.push({ x, z })
  }
  const fromPosition = bot.entity?.position
  candidates.sort((left, right) => (
    (fromPosition ? (isDirectFlightClear(bot, fromPosition, { x: right.x, y: checkpoint.y, z: right.z }) - isDirectFlightClear(bot, fromPosition, { x: left.x, y: checkpoint.y, z: left.z })) : 0) ||
    (Math.hypot(left.x - checkpoint.x, left.z - checkpoint.z) - Math.hypot(right.x - checkpoint.x, right.z - checkpoint.z))
  ))

  const seen = new Set()
  for (const candidate of candidates) {
    const key = `${candidate.x},${candidate.z}`
    if (seen.has(key)) continue
    seen.add(key)
    const blockX = Math.floor(candidate.x)
    const blockZ = Math.floor(candidate.z)
    if (!isFlightCellOpen(bot, blockX, blockZ, checkpoint.y, 1.8)) continue
    if (requireVerticalShaft && (!Number.isFinite(skywayY) || !isVerticalShaftClear(bot, blockX, blockZ, checkpoint.y, skywayY))) continue
    const reachesAllBlocks = blocks.every((block) => Math.hypot(
      candidate.x - (Number(block.x) + 0.5),
      Number(checkpoint.y) + eyeHeight - (Number(block.y) + 0.5),
      candidate.z - (Number(block.z) + 0.5)
    ) <= maxReach)
    if (!reachesAllBlocks) continue
    return new FlightCheckpoint(candidate.x, checkpoint.y, candidate.z, checkpoint.phase, checkpoint.horizontalSpeed)
  }

  throw new Error(`No clear reachable flight cell found for ${checkpoint.phase} inside chunk ${chunkX},${chunkZ} at Y${checkpoint.y}.`)
}

class FlightCheckpoint {
  constructor(x, y, z, phase = 'waypoint', horizontalSpeed = 2) {
    this.x = Number(x)
    this.y = Number(y)
    this.z = Number(z)
    this.phase = phase
    this.horizontalSpeed = Number(horizontalSpeed)
  }

  toVec3() {
    return new Vec3(this.x, this.y, this.z)
  }
}

function getSkywayAltitude(stationAnchor, chunkSlice, options = {}) {
  const stationY = Number(stationAnchor?.y ?? 97)
  const clearanceY = Math.max(1, Number(options.pathClearanceY ?? 3))
  const maxPathingY = Math.min(
    MAX_FLIGHT_ALTITUDE_Y - 2,
    Math.floor(Number(options.maxPathingY ?? 322))
  )
  const stationTopY = Number(options.stationMaxY ?? stationAnchor?.maxY ?? stationY + 5)
  const rawBlocks = chunkSlice?.blocks || []
  let maxBlockY = Math.max(
    Number(chunkSlice?.bounds?.maxY ?? Number.NEGATIVE_INFINITY),
    Number(chunkSlice?.structureBounds?.maxY ?? Number.NEGATIVE_INFINITY)
  )
  for (const block of rawBlocks) {
    if (Number(block.y) > maxBlockY) maxBlockY = Number(block.y)
  }

  const minimumSafeY = Math.ceil(Math.max(stationTopY, maxBlockY) + clearanceY)
  if (maxPathingY < minimumSafeY) {
    throw new RangeError(`elytraFly.maxPathingY=${maxPathingY} is below safe transit Y${minimumSafeY}. Raise maxPathingY or reduce pathClearanceY.`)
  }
  return minimumSafeY
}

function generateMacroTransitCheckpoints(fromPos, toTarget, skywayY, horizontalSpeed = 2, options = {}) {
  const checkpoints = []
  const startY = Number(fromPos.y || 98)
  const destY = Number(toTarget.y)
  const maxCruiseLegBlocks = Math.max(8, Number(options.maxCruiseLegBlocks || 24))

  // 1. Vertically align before horizontal travel; never fly diagonally through built chunks.
  const alignmentPhase = startY <= skywayY ? 'skyway-climb' : 'skyway-descent'
  checkpoints.push(new FlightCheckpoint(fromPos.x, skywayY, fromPos.z, alignmentPhase, horizontalSpeed))

  // 2. High-speed horizontal flight at skyway altitude above all chunk obstacles
  const deltaX = Number(toTarget.x) - Number(fromPos.x)
  const deltaZ = Number(toTarget.z) - Number(fromPos.z)
  const cruiseDistance = Math.sqrt((deltaX * deltaX) + (deltaZ * deltaZ))
  const cruiseLegs = Math.max(1, Math.ceil(cruiseDistance / maxCruiseLegBlocks))
  for (let leg = 1; leg <= cruiseLegs; leg += 1) {
    const progress = leg / cruiseLegs
    checkpoints.push(new FlightCheckpoint(
      Number(fromPos.x) + (deltaX * progress),
      skywayY,
      Number(fromPos.z) + (deltaZ * progress),
      'skyway-cruise',
      horizontalSpeed
    ))
  }

  // 3. Vertical descent directly through the top of the chunk into target position (Top-Entry)
  checkpoints.push(new FlightCheckpoint(toTarget.x, destY, toTarget.z, 'chunk-top-entry', horizontalSpeed))

  return checkpoints
}

function generateLandingTransitCheckpoints(fromPos, toTarget, skywayY, horizontalSpeed = 2, options = {}) {
  return generateMacroTransitCheckpoints(fromPos, toTarget, skywayY, horizontalSpeed, options).slice(0, -1)
}

function generateObstacleAwareReentryCheckpoints(bot, fromPos, target, options = {}) {
  if (typeof bot?.blockAt !== 'function') throw new TypeError('Obstacle-aware re-entry requires bot.blockAt().')
  const chunkX = Number.isFinite(Number(options.chunkX)) ? Number(options.chunkX) : Math.floor(Number(target.x) / 16)
  const chunkZ = Number.isFinite(Number(options.chunkZ)) ? Number(options.chunkZ) : Math.floor(Number(target.z) / 16)
  const margin = Math.max(1, Math.min(8, Math.floor(Number(options.searchMargin || 4))))
  const minX = Math.min(chunkX * 16 - margin, Math.floor(Number(fromPos.x)), Math.floor(Number(target.x)))
  const maxX = Math.max(chunkX * 16 + 15 + margin, Math.floor(Number(fromPos.x)), Math.floor(Number(target.x)))
  const minZ = Math.min(chunkZ * 16 - margin, Math.floor(Number(fromPos.z)), Math.floor(Number(target.z)))
  const maxZ = Math.max(chunkZ * 16 + 15 + margin, Math.floor(Number(fromPos.z)), Math.floor(Number(target.z)))
  const minY = Math.floor(Math.min(Number(fromPos.y), Number(target.y)))
  const maxY = Math.ceil(Math.max(Number(fromPos.y), Number(target.y)) + Math.max(0, Number(options.verticalMarginY || 0)))
  const start = { x: Math.floor(Number(fromPos.x)), y: Math.floor(Number(fromPos.y)), z: Math.floor(Number(fromPos.z)) }
  const goal = { x: Math.floor(Number(target.x)), y: Math.floor(Number(target.y)), z: Math.floor(Number(target.z)) }
  const keyOf = (point) => `${point.x},${point.y},${point.z}`
  const goalKey = keyOf(goal)
  let openStart = isFlightCellOpen(bot, start.x, start.z, start.y, 1.8) ? start : null
  if (!openStart) {
    const candidates = [
      { x: start.x, y: start.y + 1, z: start.z },
      { x: start.x, y: start.y + 2, z: start.z },
      { x: Math.round(Number(fromPos.x)), y: Math.floor(Number(fromPos.y)), z: Math.round(Number(fromPos.z)) },
      { x: start.x + 1, y: start.y, z: start.z },
      { x: start.x - 1, y: start.y, z: start.z },
      { x: start.x, y: start.y, z: start.z + 1 },
      { x: start.x, y: start.y, z: start.z - 1 }
    ]
    openStart = candidates.find((c) => isFlightCellOpen(bot, c.x, c.z, c.y, 1.8)) || null
  }
  if (!openStart) throw new Error(`Top re-entry start cell ${keyOf(start)} is blocked and has no open neighbor.`)
  const startKey = keyOf(openStart)
  if (!isFlightCellOpen(bot, goal.x, goal.z, goal.y, 1.8)) throw new Error(`Layer checkpoint cell ${goalKey} is blocked.`)

  const queue = [openStart]
  const parents = new Map([[startKey, null]])
  const directions = [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1]
  ]
  for (let index = 0; index < queue.length && !parents.has(goalKey); index += 1) {
    const current = queue[index]
    for (const [deltaX, deltaY, deltaZ] of directions) {
      const next = { x: current.x + deltaX, y: current.y + deltaY, z: current.z + deltaZ }
      if (next.x < minX || next.x > maxX || next.y < minY || next.y > maxY || next.z < minZ || next.z > maxZ) continue
      const key = keyOf(next)
      if (parents.has(key) || !isFlightCellOpen(bot, next.x, next.z, next.y, 1.8)) continue
      parents.set(key, keyOf(current))
      queue.push(next)
    }
  }
  if (!parents.has(goalKey)) {
    throw new Error(`No open 3D top-entry route found to layer checkpoint ${goalKey} within ${margin} blocks of chunk ${chunkX},${chunkZ}.`)
  }

  const cells = []
  for (let cursor = goalKey; cursor; cursor = parents.get(cursor)) {
    const [x, y, z] = cursor.split(',').map(Number)
    cells.push({ x, y, z })
  }
  cells.reverse()
  const turns = []
  let previousDirection = null
  for (let index = 1; index < cells.length; index += 1) {
    const direction = {
      x: cells[index].x - cells[index - 1].x,
      y: cells[index].y - cells[index - 1].y,
      z: cells[index].z - cells[index - 1].z
    }
    if (previousDirection && (direction.x !== previousDirection.x || direction.y !== previousDirection.y || direction.z !== previousDirection.z)) {
      turns.push(cells[index - 1])
    }
    previousDirection = direction
  }
  turns.push(cells.at(-1))

  const horizontalSpeed = Number(options.horizontalSpeed || 2)
  const checkpoints = turns.map((point, index) => {
    const previous = index === 0 ? start : turns[index - 1]
    const vertical = point.x === previous.x && point.z === previous.z
    return new FlightCheckpoint(point.x + 0.5, point.y, point.z + 0.5, vertical ? 'chunk-reentry-vertical' : 'chunk-reentry-route', horizontalSpeed)
  })
  const final = checkpoints.at(-1)
  if (!final || Math.hypot(final.x - Number(target.x), final.y - Number(target.y), final.z - Number(target.z)) > 0.01) {
    checkpoints.push(new FlightCheckpoint(target.x, target.y, target.z, 'chunk-top-entry', horizontalSpeed))
  } else {
    final.phase = 'chunk-top-entry'
  }
  return checkpoints
}

function generateLayerCheckpoints(chunkX, chunkZ, layerY, layerBlocks, options = {}) {
  const minX = chunkX * 16
  const minZ = chunkZ * 16
  const hoverOffsetY = Math.max(2, Number(options.hoverOffsetY ?? 2))
  const hoverY = layerY + hoverOffsetY
  const horizontalSpeed = Number(options.horizontalSpeed || 2)
  const maxReach = Math.max(2, Math.min(5, Number(options.maxReach || 4.8)))
  const eyeHeight = Math.max(0, Number(options.eyeHeight ?? DEFAULT_EYE_HEIGHT))
  const minimumLayerY = Number(options.minimumLayerY ?? layerY)
  const maximumVerticalDistance = hoverY + eyeHeight - (minimumLayerY + 0.5)
  const horizontalReach = Math.sqrt(Math.max(0.01, (maxReach * maxReach) - (maximumVerticalDistance * maximumVerticalDistance)))
  const laneCount = Math.max(1, Math.min(16, Math.ceil(16 / Math.max(0.5, horizontalReach * Math.SQRT2))))
  const laneStep = 16 / laneCount
  const laneOffsets = Array.from({ length: laneCount }, (_unused, index) => (index + 0.5) * laneStep)
  const checkpoints = []

  const activeBlocks = (layerBlocks || []).filter((block) => {
    return block.y >= minimumLayerY && block.y <= layerY && block.name && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air'
  })
  if (activeBlocks.length === 0) return []

  for (let laneIndex = 0; laneIndex < laneOffsets.length; laneIndex += 1) {
    const checkpointX = minX + laneOffsets[laneIndex]
    const zOffsets = laneIndex % 2 === 0 ? laneOffsets : laneOffsets.slice().reverse()
    for (const zOffset of zOffsets) {
      const checkpointZ = minZ + zOffset
      const coversBlock = activeBlocks.some((block) => {
        const dx = checkpointX - (Number(block.x) + 0.5)
        const dy = hoverY + eyeHeight - (Number(block.y) + 0.5)
        const dz = checkpointZ - (Number(block.z) + 0.5)
        return (dx * dx) + (dy * dy) + (dz * dz) <= maxReach * maxReach
      })
      if (coversBlock) checkpoints.push(new FlightCheckpoint(checkpointX, hoverY, checkpointZ, 'layer-print', horizontalSpeed))
    }
  }

  return checkpoints
}

function getReachableLayersPerPass(options = {}) {
  const requestedLayers = Math.max(1, Math.min(3, Math.floor(Number(options.layersPerPass || 1))))
  const maxReach = Math.max(2, Math.min(5, Number(options.maxReach || 4.8)))
  const hoverOffsetY = Math.max(2, Number(options.hoverOffsetY ?? 2))
  const eyeHeight = Math.max(0, Number(options.eyeHeight ?? DEFAULT_EYE_HEIGHT))
  const topLayerDistance = hoverOffsetY + eyeHeight - 0.5
  const reachableLayers = Math.max(1, Math.floor(maxReach - topLayerDistance) + 1)
  return Math.min(requestedLayers, reachableLayers)
}

function generateLayerPrintPlan(chunkX, chunkZ, blocks, options = {}) {
  const maxReach = Math.max(2, Math.min(5, Number(options.maxReach || 4.8)))
  const hoverOffsetY = Math.max(2, Number(options.hoverOffsetY ?? 2))
  const eyeHeight = Math.max(0, Number(options.eyeHeight ?? DEFAULT_EYE_HEIGHT))
  const layersPerPass = getReachableLayersPerPass(options)
  const layers = new Map()
  for (const block of blocks || []) {
    if (!block?.name || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue
    const layerY = Number(block.y)
    if (!layers.has(layerY)) layers.set(layerY, [])
    layers.get(layerY).push(block)
  }

  const plan = []
  const layerYs = [...layers.keys()].sort((left, right) => left - right)
  for (let layerIndex = 0; layerIndex < layerYs.length;) {
    const bandLayers = [layerYs[layerIndex]]
    while (
      bandLayers.length < layersPerPass &&
      layerIndex + bandLayers.length < layerYs.length &&
      layerYs[layerIndex + bandLayers.length] === bandLayers.at(-1) + 1
    ) {
      bandLayers.push(layerYs[layerIndex + bandLayers.length])
    }
    layerIndex += bandLayers.length
    const layerMinY = bandLayers[0]
    const layerMaxY = bandLayers.at(-1)
    const layerBlocks = bandLayers
      .flatMap((layerY) => layers.get(layerY))
      .sort((left, right) => left.y - right.y || left.z - right.z || left.x - right.x)
    const checkpoints = generateLayerCheckpoints(chunkX, chunkZ, layerMaxY, layerBlocks, {
      ...options,
      minimumLayerY: layerMinY
    })
    const assignments = checkpoints.map((checkpoint) => ({ checkpoint, blocks: [] }))

    const fallbackAssignments = []
    for (const block of layerBlocks) {
      let bestIndex = -1
      let bestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < checkpoints.length; index += 1) {
        const checkpoint = checkpoints[index]
        const dx = checkpoint.x - (Number(block.x) + 0.5)
        const dy = checkpoint.y + eyeHeight - (Number(block.y) + 0.5)
        const dz = checkpoint.z - (Number(block.z) + 0.5)
        const distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
        if (distance <= maxReach && distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      }

      if (bestIndex >= 0) {
        assignments[bestIndex].blocks.push(block)
      } else {
        fallbackAssignments.push({
          layerY: block.y,
          layerMinY: block.y,
          layerMaxY: block.y,
          layers: [block.y],
          checkpoint: new FlightCheckpoint(block.x + 0.5, block.y + hoverOffsetY, block.z + 0.5, 'layer-print-fallback', Number(options.horizontalSpeed || 2)),
          blocks: [block]
        })
      }
    }

    for (const assignment of assignments) {
      if (assignment.blocks.length > 0) {
        assignment.blocks.sort((left, right) => left.y - right.y || left.z - right.z || left.x - right.x)
        plan.push({ layerY: layerMaxY, layerMinY, layerMaxY, layers: bandLayers.slice(), ...assignment })
      }
    }
    plan.push(...fallbackAssignments)
  }
  return plan
}

async function flyToCheckpoint(bot, checkpoint, options = {}) {
  if (!bot.elytrafly) throw new Error('ElytraFly plugin is required for checkpoint flight.')
  if (bot.__interruptPrintRequested) {
    const error = new Error('Checkpoint flight interrupted by the printer runtime.')
    error.code = 'PRINT_INTERRUPTED'
    throw error
  }

  const targetVec = checkpoint.toVec3()
  const isSkywayLeg = checkpoint.phase.startsWith('skyway-')
  const configuredMaxAltitudeY = Number(options.elytraFly?.maxAltitudeY ?? bot.config?.elytraFly?.maxAltitudeY ?? MAX_FLIGHT_ALTITUDE_Y)
  const localAltitudeAllowanceY = Math.max(0.25, Number(options.localAltitudeAllowanceY ?? 0.5))
  const checkpointMaxAltitudeY = isSkywayLeg
    ? configuredMaxAltitudeY
    : Math.min(configuredMaxAltitudeY, targetVec.y + localAltitudeAllowanceY)
  const settings = configureMeteorElytra(bot, {
    noCrash: false,
    ...(options.elytraFly || {}),
    horizontalSpeed: Number(options.horizontalSpeed ?? checkpoint.horizontalSpeed ?? bot.config?.elytraFly?.horizontalSpeed ?? 2),
    verticalSpeed: Number(options.verticalSpeed ?? bot.config?.elytraFly?.verticalSpeed ?? 2),
    maxAltitudeY: checkpointMaxAltitudeY
  })
  const maxPathingY = Math.min(settings.maxAltitudeY, Math.floor(Number(settings.maxPathingY)))
  if (targetVec.y > maxPathingY) {
    const error = new RangeError(`Checkpoint ${checkpoint.phase} Y${targetVec.y} exceeds configured path ceiling Y${maxPathingY}.`)
    error.code = 'CHECKPOINT_ABOVE_PATH_CEILING'
    throw error
  }
  if (checkpoint.phase === 'skyway-climb' && options.skipShaftEscape !== true) {
    const escapePath = findVerticalShaftEscapePath(bot, targetVec.y, { searchRadius: settings.pathEscapeSearchRadius })
    if (escapePath === null) throw new Error(`No open vertical skyway shaft found within ${settings.pathEscapeSearchRadius} blocks.`)
    if (escapePath.length > 0) {
      const centeredCurrentCell = escapePath.length === 1 &&
        Math.floor(escapePath[0].x) === Math.floor(bot.entity.position.x) &&
        Math.floor(escapePath[0].z) === Math.floor(bot.entity.position.z)
      if (centeredCurrentCell) {
        targetVec.x = escapePath[0].x
        targetVec.z = escapePath[0].z
      } else {
        console.warn(`[ELYTRA-PATH] Vertical shaft blocked above ${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}; flying ${escapePath.length} escape checkpoint(s) before climbing.`)
        for (const point of escapePath) {
          await flyToCheckpoint(bot, new FlightCheckpoint(point.x, point.y, point.z, 'obstruction-escape', checkpoint.horizontalSpeed), {
            ...options,
            skipShaftEscape: true,
            horizontalTolerance: 0.35,
            verticalTolerance: 0.4,
            timeoutMs: Number(options.escapeTimeoutMs || 10000)
          })
        }
      }
    }
  }
  const isRouteLeg = checkpoint.phase.includes('-route')
  const isLayerPrint = checkpoint.phase === 'layer-print'
  const horizontalTolerance = Math.max(0.25, Number(options.horizontalTolerance ?? (isRouteLeg ? 1.0 : (isLayerPrint ? 0.35 : 2))))
  const isTopEntry = checkpoint.phase === 'chunk-top-entry'
  const isVerticalLeg = checkpoint.phase === 'skyway-climb' || checkpoint.phase === 'skyway-descent' || isTopEntry || checkpoint.phase === 'layer-recovery-climb' || checkpoint.phase === 'chunk-reentry-vertical'
  const verticalTolerance = Math.max(0.25, Number(options.verticalTolerance ?? (isVerticalLeg ? 0.25 : 1.5)))
  const arrivalEpsilon = Math.max(0, Number(options.arrivalEpsilon ?? 0.05))
  const isSkywayVertical = checkpoint.phase === 'skyway-climb' || checkpoint.phase === 'skyway-descent'
  const verticalColumnTolerance = isSkywayVertical
    ? Math.max(0.05, Number(options.verticalColumnTolerance ?? 0.1))
    : horizontalTolerance
  bot.__checkpointFlightActive = true
  try {
    const launchAttempts = Math.max(1, Number(options.launchAttempts || 3))
    let launchError = null
    for (let launchAttempt = 1; launchAttempt <= launchAttempts; launchAttempt += 1) {
      if (bot.__interruptPrintRequested) {
        const error = new Error('Checkpoint flight interrupted before takeoff.')
        error.code = 'PRINT_INTERRUPTED'
        throw error
      }
      disableElytraHover(bot)
      startElytraFlight(bot)
      clearElytraControls(bot, { preserveGoal: bot.entity?.onGround !== true })
      try {
        await ensureElytraTakeoff(bot, {
          attempts: Number(options.glideAttempts || 6),
          confirmationMs: Number(options.glideConfirmationMs || 500),
          airborneTimeoutMs: Number(options.takeoffTimeoutMs || 1500)
        })
        launchError = null
        break
      } catch (error) {
        launchError = error
        if (launchAttempt < launchAttempts) await delay(150)
      }
    }
    if (launchError) throw launchError
    startElytraFlight(bot)
    if (checkpoint.phase === 'skyway-climb') {
      for (let shaftCheck = 0; shaftCheck < 2; shaftCheck += 1) {
        await delay(100)
        const correctedEscapePath = findVerticalShaftEscapePath(bot, targetVec.y, { searchRadius: settings.pathEscapeSearchRadius })
        if (correctedEscapePath === null) throw new Error(`No open vertical skyway shaft found within ${settings.pathEscapeSearchRadius} blocks after server correction.`)
        if (correctedEscapePath.length === 0) break
        const centeredCurrentCell = correctedEscapePath.length === 1 &&
          Math.floor(correctedEscapePath[0].x) === Math.floor(bot.entity.position.x) &&
          Math.floor(correctedEscapePath[0].z) === Math.floor(bot.entity.position.z)
        if (centeredCurrentCell) {
          targetVec.x = correctedEscapePath[0].x
          targetVec.z = correctedEscapePath[0].z
          break
        }
        console.warn(`[ELYTRA-PATH] Server correction moved the bot out of the centered climb shaft; flying ${correctedEscapePath.length} correction checkpoint(s).`)
        for (const point of correctedEscapePath) {
          await flyToCheckpoint(bot, new FlightCheckpoint(point.x, point.y, point.z, 'obstruction-escape', checkpoint.horizontalSpeed), {
            ...options,
            skipShaftEscape: true,
            horizontalTolerance: 0.2,
            verticalTolerance: 0.4,
            timeoutMs: Number(options.escapeTimeoutMs || 10000)
          })
        }
      }
      const rebaseDistance = horizontalDistance(targetVec, bot.entity.position)
      targetVec.x = Math.floor(bot.entity.position.x) + 0.5
      targetVec.z = Math.floor(bot.entity.position.z) + 0.5
      if (rebaseDistance > 0.5) {
        console.warn(`[ELYTRA-PATH] Rebased skyway climb column by ${rebaseDistance.toFixed(2)} blocks after server correction.`)
      }
    }
    const controller = bot.elytrafly.__meteorController
    const initialHorizontal = horizontalDistance(bot.entity.position, targetVec)
    const initialVertical = Math.abs(bot.entity.position.y - targetVec.y)
    let aligningVerticalColumn = isVerticalLeg && initialHorizontal > verticalColumnTolerance + arrivalEpsilon
    const setCheckpointGoal = () => {
      const goal = aligningVerticalColumn
        ? new Vec3(targetVec.x, bot.entity.position.y, targetVec.z)
        : targetVec
      controller.setGoal(goal, {
        horizontal: true,
        horizontalTolerance: isVerticalLeg ? verticalColumnTolerance : horizontalTolerance,
        verticalTolerance: aligningVerticalColumn ? 0.05 : verticalTolerance
      })
      controller.onTick()
    }
    setCheckpointGoal()

    const horizontalBps = Math.max(0.1, settings.horizontalSpeed * 20)
    const verticalBps = Math.max(0.1, settings.verticalSpeed * 10)
    const expectedSeconds = isVerticalLeg
      ? (initialHorizontal / horizontalBps) + (initialVertical / verticalBps)
      : Math.max(initialHorizontal / horizontalBps, initialVertical / verticalBps)
    const deadline = Date.now() + Number(options.timeoutMs ?? Math.max(10000, Math.ceil(expectedSeconds * 4 + 5) * 1000))
    const stallTimeoutMs = Math.max(250, Number(options.stallTimeoutMs || 10000))
    let bestRemaining = Math.hypot(initialHorizontal, initialVertical)
    let lastProgressAt = Date.now()
    let lastBlocksPlaced = Number(bot.placedBlocksCount || 0)

    while (Date.now() < deadline && !bot.__stopPrintingRequested && !bot.__interruptPrintRequested) {
      const currentBlocksPlaced = Number(bot.placedBlocksCount || 0)
      if (currentBlocksPlaced > lastBlocksPlaced) {
        lastBlocksPlaced = currentBlocksPlaced
        lastProgressAt = Date.now()
      }
      const remainingHorizontal = horizontalDistance(bot.entity.position, targetVec)
      const remainingVertical = Math.abs(bot.entity.position.y - targetVec.y)
      if (isVerticalLeg) {
        const shouldAlignVerticalColumn = remainingHorizontal > verticalColumnTolerance + arrivalEpsilon
        if (shouldAlignVerticalColumn !== aligningVerticalColumn) {
          aligningVerticalColumn = shouldAlignVerticalColumn
          setCheckpointGoal()
          bestRemaining = Math.hypot(remainingHorizontal, remainingVertical)
          lastProgressAt = Date.now()
        }
      }
      const activeHorizontalTolerance = isVerticalLeg ? verticalColumnTolerance : horizontalTolerance
      const arrived = remainingHorizontal <= activeHorizontalTolerance + arrivalEpsilon && remainingVertical <= verticalTolerance + arrivalEpsilon
      if (arrived) break
      const remaining = Math.hypot(remainingHorizontal, remainingVertical)
      if (remaining < bestRemaining - 0.02) {
        bestRemaining = remaining
        lastProgressAt = Date.now()
      } else if (Date.now() - lastProgressAt >= stallTimeoutMs) {
        throw new Error(`Stalled reaching ${checkpoint.phase}; horizontal=${remainingHorizontal.toFixed(2)}, vertical=${remainingVertical.toFixed(2)}.`)
      }
      if (bot.entity?.onGround) {
        await ensureElytraTakeoff(bot, { attempts: 3, confirmationMs: 250, airborneTimeoutMs: 800 })
      } else if (bot.entity?.elytraFlying !== true) {
        await ensureElytraGliding(bot, { attempts: 3, confirmationMs: 250 }).catch(() => {})
      }
      await delay(50)
    }

    const remainingHorizontal = horizontalDistance(bot.entity.position, targetVec)
    const remainingVertical = Math.abs(bot.entity.position.y - targetVec.y)
    const activeHorizontalTolerance = isVerticalLeg ? verticalColumnTolerance : horizontalTolerance
    if (bot.__stopPrintingRequested || bot.__interruptPrintRequested) {
      const error = new Error(`Checkpoint flight interrupted during ${checkpoint.phase}.`)
      error.code = 'PRINT_INTERRUPTED'
      throw error
    }
    if (remainingHorizontal > activeHorizontalTolerance + arrivalEpsilon || remainingVertical > verticalTolerance + arrivalEpsilon) {
      throw new Error(`Timed out reaching ${checkpoint.phase}; horizontal=${remainingHorizontal.toFixed(2)}, vertical=${remainingVertical.toFixed(2)}.`)
    }
    engageElytraHover(bot, { targetY: targetVec.y, settings })
    return true
  } catch (error) {
    try { engageElytraHover(bot, { targetY: targetVec.y, settings }) } catch {}
    throw error
  } finally {
    bot.__checkpointFlightActive = false
  }
}

module.exports = {
  FlightCheckpoint,
  flyToCheckpoint,
  findVerticalShaftEscapePath,
  getReachableLayersPerPass,
  generateLandingTransitCheckpoints,
  generateObstacleAwareReentryCheckpoints,
  generateLayerCheckpoints,
  generateLayerPrintPlan,
  generateMacroTransitCheckpoints,
  getSkywayAltitude,
  isDirectFlightClear,
  resolveSafeLayerCheckpoint
}
