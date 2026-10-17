'use strict'

const { Vec3 } = require('vec3')

const BLOCK_FACE_DIRECTIONS = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0)
]
const FACE_SAMPLE_OFFSETS = [0.5, 0.25, 0.75]
const HORIZONTAL_INTERACTION_BLOCKS = new Set(['barrel', 'chest', 'trapped_chest', 'ender_chest'])

function getFaceSampleCursor(face, first, second) {
  if (face === 0) return new Vec3(first, 0.001, second)
  if (face === 1) return new Vec3(first, 0.999, second)
  if (face === 2) return new Vec3(first, second, 0.001)
  if (face === 3) return new Vec3(first, second, 0.999)
  if (face === 4) return new Vec3(0.001, first, second)
  return new Vec3(0.999, first, second)
}

function isFaceNeighbourOpen(bot, blockPosition, face) {
  if (typeof bot?.blockAt !== 'function') return true
  try {
    const neighbour = bot.blockAt(blockPosition.plus(BLOCK_FACE_DIRECTIONS[face]))
    return !neighbour || neighbour.boundingBox === 'empty'
  } catch {
    return true
  }
}

function getReferenceBlockInteraction(bot, block) {
  const entityPosition = bot?.entity?.position
  const blockPosition = block?.position
  if (!entityPosition?.offset || !blockPosition?.offset) return null
  const eyeHeight = Number(bot?.entity?.eyeHeight)
  const eye = entityPosition.offset(0, Number.isFinite(eyeHeight) ? eyeHeight : 1.62, 0)
  let bestFace = 1
  let bestDistance = Number.POSITIVE_INFINITY

  for (let face = 0; face < BLOCK_FACE_DIRECTIONS.length; face++) {
    const neighbourCenter = blockPosition.plus(BLOCK_FACE_DIRECTIONS[face]).offset(0.5, 0.5, 0.5)
    const distance = eye.distanceTo(neighbourCenter)
    if (distance < bestDistance) {
      bestDistance = distance
      bestFace = face
    }
  }

  return {
    direction: BLOCK_FACE_DIRECTIONS[bestFace],
    cursorPos: getFaceSampleCursor(bestFace, 0.5, 0.5)
  }
}

function getVisibleBlockInteraction(bot, block) {
  const entityPosition = bot?.entity?.position
  const blockPosition = block?.position
  if (!entityPosition?.offset || !blockPosition?.plus || !bot?.world?.raycast) {
    return getReferenceBlockInteraction(bot, block)
  }

  const eyeHeight = Number(bot?.entity?.eyeHeight)
  const eye = entityPosition.offset(0, Number.isFinite(eyeHeight) ? eyeHeight : 1.62, 0)
  const candidates = []
  for (let face = 0; face < BLOCK_FACE_DIRECTIONS.length; face++) {
    for (const first of FACE_SAMPLE_OFFSETS) {
      for (const second of FACE_SAMPLE_OFFSETS) {
        const cursorPos = getFaceSampleCursor(face, first, second)
        const aimPos = blockPosition.plus(cursorPos)
        candidates.push({
          face,
          cursorPos,
          aimPos,
          exposed: isFaceNeighbourOpen(bot, blockPosition, face),
          distance: eye.distanceTo(aimPos)
        })
      }
    }
  }
  const preferHorizontal = HORIZONTAL_INTERACTION_BLOCKS.has(String(block?.name || '').replace(/^minecraft:/, ''))
  candidates.sort((left, right) => (
    Number(right.exposed) - Number(left.exposed) ||
    (preferHorizontal ? Number(left.face < 2) - Number(right.face < 2) : 0) ||
    left.distance - right.distance
  ))

  for (const candidate of candidates) {
    const delta = candidate.aimPos.minus(eye)
    const range = delta.norm()
    if (!Number.isFinite(range) || range <= 0) continue
    const hit = bot.world.raycast(eye, delta.normalize(), range + 0.15)
    if (!hit?.position?.equals?.(blockPosition)) continue
    return {
      direction: BLOCK_FACE_DIRECTIONS[candidate.face],
      cursorPos: candidate.cursorPos,
      visible: true
    }
  }

  const fallback = getReferenceBlockInteraction(bot, block)
  return fallback ? { ...fallback, visible: false } : null
}

module.exports = { getReferenceBlockInteraction, getVisibleBlockInteraction }
