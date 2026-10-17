'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { clearElytraControls, disableElytraHover, formatPosition } = require('./elytra-flight')
const {
  canonicalStorageBlock,
  openStorageContainerWithRetry,
  isShulkerName,
  selectNextDumpContainer,
  describeContainerItem
} = require('./storage-registration')
const { getVisibleBlockInteraction } = require('./shared/block-interaction')

const ELYTRA_MIN_REMAINING_DURABILITY = 10
const SHULKER_STAGING_TOLERANCE = 0.6

function isPickaxe(item) {
  return item && String(item.name || '').endsWith('_pickaxe')
}

function isFood(item) {
  return item && (item.name === 'golden_apple' || item.name === 'enchanted_golden_apple')
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function getFleetBotIndex(bot) {
  const suffix = String(bot?.username || '').match(/(\d+)$/)
  return suffix ? Math.max(0, Number(suffix[1])) : 0
}

function shulkerRestockLockPath(bot) {
  const port = Number(bot.config?.bot?.port || 25565)
  return path.join(os.tmpdir(), `mineflayer-master-printer-shulker-${port}-lane-${getFleetBotIndex(bot)}.lock`)
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

async function acquireShulkerRestockLock(bot, options = {}) {
  const lockPath = options.shulkerRestockLockPath || shulkerRestockLockPath(bot)
  const timeoutMs = Math.max(1000, Number(options.shulkerRestockLockTimeoutMs || 120000))
  const staleMs = Math.max(timeoutMs, Number(options.shulkerRestockLockStaleMs || 300000))
  const deadline = Date.now() + timeoutMs
  const token = `${process.pid}:${Date.now()}:${Math.random()}`
  let waitingLogged = false
  let waitHandlerRan = false

  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ token, pid: process.pid, botName: bot.username, acquiredAt: Date.now() }), { flag: 'wx' })
      console.log(`[GEAR-PREP] Acquired shared shulker staging lock for ${bot.username}.`)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
          if (lock.token === token) fs.unlinkSync(lockPath)
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (Date.now() - Number(lock.acquiredAt || 0) > staleMs || !isProcessAlive(lock.pid)) {
        fs.unlinkSync(lockPath)
        continue
      }
      if (!waitingLogged) {
        waitingLogged = true
        console.log(`[GEAR-PREP] Waiting for ${lock.botName || 'another bot'} to release shared shulker staging.`)
      }
      if (!waitHandlerRan && typeof options.onShulkerRestockWait === 'function') {
        waitHandlerRan = true
        await options.onShulkerRestockWait(lock)
      }
    } catch {
      try { fs.unlinkSync(lockPath) } catch {}
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for shared shulker staging lock at ${lockPath}`)
}

function placementDirection(vector) {
  if (vector.y < 0) return 0
  if (vector.y > 0) return 1
  if (vector.z < 0) return 2
  if (vector.z > 0) return 3
  if (vector.x < 0) return 4
  if (vector.x > 0) return 5
  throw new Error(`Invalid placement face ${vector}.`)
}

function sendRawBlockPlacement(bot, location, direction, cursor) {
  const sequence = (Number(bot.__printerPlacementSequence ?? -1) + 1) & 0x7fffffff
  bot.__printerPlacementSequence = sequence
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
    return
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
    return
  }
  bot._client.write('block_place', {
    location,
    direction,
    hand: 0,
    cursorX: Math.floor(cursor.x * 16),
    cursorY: Math.floor(cursor.y * 16),
    cursorZ: Math.floor(cursor.z * 16)
  })
}

function positionKey(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function patchItemProto(bot, proto) {
  if (!proto || proto.__enchantsFixed) return
  proto.__enchantsFixed = true
  const origDesc = Object.getOwnPropertyDescriptor(proto, 'enchants')
  if (!origDesc?.get) return
  Object.defineProperty(proto, 'enchants', {
    get() {
      const val = origDesc.get.call(this)
      if (val && !Array.isArray(val)) {
        const list = Array.isArray(val.enchantments) ? val.enchantments : []
        return list.map((e) => ({
          name: bot.registry?.enchantments?.[e.id]?.name || String(e.id),
          lvl: e.level ?? e.lvl ?? 1
        }))
      }
      return val
    },
    configurable: true,
    enumerable: origDesc.enumerable
  })
}

function normalizeHeldItemEnchants(bot, item) {
  if (!item) return
  patchItemProto(bot, Object.getPrototypeOf(item))
  if (item.enchants && !Array.isArray(item.enchants)) {
    const list = Array.isArray(item.enchants.enchantments) ? item.enchants.enchantments : []
    const normalized = list.map((e) => ({
      name: bot.registry?.enchantments?.[e.id]?.name || String(e.id),
      lvl: e.level ?? e.lvl ?? 1
    }))
    Object.defineProperty(item, 'enchants', {
      get() { return normalized },
      configurable: true
    })
  }
}

function installDigTimeFix(bot) {
  if (!bot) return
  const wrap = () => {
    if (typeof bot.digTime === 'function' && !bot.digTime.__enchantsWrapped) {
      const originalDigTime = bot.digTime
      bot.digTime = function (block) {
        if (bot.heldItem) normalizeHeldItemEnchants(bot, bot.heldItem)
        return originalDigTime.call(bot, block)
      }
      bot.digTime.__enchantsWrapped = true
    }
  }
  wrap()
  if (bot.registry) {
    try {
      const Item = require('prismarine-item')(bot.registry)
      if (Item?.prototype) patchItemProto(bot, Item.prototype)
    } catch { }
  }
  bot.once?.('spawn', () => {
    wrap()
    if (bot.registry) {
      try {
        const Item = require('prismarine-item')(bot.registry)
        if (Item?.prototype) patchItemProto(bot, Item.prototype)
      } catch { }
    }
  })
}

async function setSneaking(bot, sneaking) {
  if (typeof bot?.setControlState === 'function') {
    bot.setControlState('sneak', sneaking)
  }
  if (bot?._client?.write) {
    if (bot.supportFeature?.('newPlayerInputPacket')) {
      bot._client.write('player_input', { inputs: { shift: Boolean(sneaking) } })
    } else {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: sneaking
          ? (bot.supportFeature?.('entityActionUsesStringMapper') ? 'press_shift_key' : 0)
          : (bot.supportFeature?.('entityActionUsesStringMapper') ? 'stop_sneaking' : 1),
        jumpBoost: 0
      })
    }
  }
  await delay(80)
}

function hasPickaxe(bot) {
  const items = bot.inventory?.items?.() || []
  return items.some((item) => String(item?.name || '').endsWith('_pickaxe'))
}

function getBestPickaxe(bot) {
  const items = bot.inventory?.items?.() || []
  const pickaxes = items.filter((item) => String(item?.name || '').endsWith('_pickaxe'))
  if (pickaxes.length === 0) return null
  pickaxes.sort((left, right) => {
    const leftTier = left.name.includes('netherite') ? 5 : left.name.includes('diamond') ? 4 : 3
    const rightTier = right.name.includes('netherite') ? 5 : right.name.includes('diamond') ? 4 : 3
    return rightTier - leftTier
  })
  return pickaxes[0]
}

function hasElytraEquipped(bot) {
  const torsoSlot = bot.inventory?.slots?.[6]
  return Boolean(torsoSlot && torsoSlot.name === 'elytra')
}

function hasElytraInInventory(bot) {
  const items = bot.inventory?.items?.() || []
  return items.some((item) => item?.name === 'elytra')
}

function getElytraRemainingDurability(bot, item = bot.inventory?.slots?.[6]) {
  if (item?.name !== 'elytra') return null
  const maxDurability = Number(item.maxDurability ?? bot.registry?.itemsByName?.elytra?.maxDurability ?? 432)
  let durabilityUsed = Number.NaN
  try { durabilityUsed = Number(item.durabilityUsed) } catch {}
  if (!Number.isFinite(durabilityUsed)) durabilityUsed = Number(item.nbt?.value?.Damage?.value ?? 0)
  if (!Number.isFinite(maxDurability) || !Number.isFinite(durabilityUsed)) return null
  return Math.max(0, maxDurability - durabilityUsed)
}

function isElytraLowDurability(bot, item = bot.inventory?.slots?.[6], minimumRemaining = ELYTRA_MIN_REMAINING_DURABILITY) {
  const remaining = getElytraRemainingDurability(bot, item)
  return Number.isFinite(remaining) && remaining < Number(minimumRemaining)
}

function getGoldenAppleCount(bot) {
  const items = bot.inventory?.items?.() || []
  return items
    .filter((item) => item?.name === 'golden_apple' || item?.name === 'enchanted_golden_apple')
    .reduce((sum, item) => sum + Number(item.count || 0), 0)
}

function getShulkerContents(bot, item) {
  if (!item || !isShulkerName(item.name)) return []
  const described = describeContainerItem(bot, item)
  return described?.contents || []
}

function getInventoryShulkerCount(bot) {
  const items = bot.inventory?.items?.() || []
  return items
    .filter((item) => isShulkerName(item?.name))
    .reduce((sum, item) => sum + Number(item.count || 0), 0)
}

function findMatchingInventoryShulker(bot, matcher = null) {
  return (bot.inventory?.items?.() || []).find((item) => {
    if (!isShulkerName(item?.name)) return false
    return !matcher || matcher(item, getShulkerContents(bot, item))
  }) || null
}

async function waitForHeldShulker(bot, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(250, Number(timeoutMs || 2500))
  while (Date.now() < deadline) {
    bot.updateHeldItem?.()
    if (isShulkerName(bot.heldItem?.name)) return true
    await delay(50)
  }
  return isShulkerName(bot.heldItem?.name)
}

async function waitForInventoryShulkerCount(bot, maximumCount, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(250, Number(timeoutMs || 2500))
  while (Date.now() < deadline) {
    const count = getInventoryShulkerCount(bot)
    if (count <= maximumCount) return count
    await delay(50)
  }
  return getInventoryShulkerCount(bot)
}

function getEmptyPlayerSlotCount(bot) {
  return (bot.inventory?.slots || []).slice(9, 45).filter((item) => !item).length
}

function getRequiredShulkerExtractionSlots(bot, itemMatcher, targetCount) {
  let remaining = Math.max(0, Number(targetCount || 0))
  for (const item of bot.inventory?.items?.() || []) {
    if (!item || !itemMatcher(item.name)) continue
    const stackSize = Math.max(1, Number(item.stackSize || 64))
    remaining -= Math.max(0, stackSize - Number(item.count || 0))
  }
  return 1 + Math.ceil(Math.max(0, remaining) / 64)
}

async function waitForEmptyPlayerSlotIncrease(bot, previousCount, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs || 2500))
  while (Date.now() < deadline) {
    const currentCount = getEmptyPlayerSlotCount(bot)
    if (currentCount > previousCount) return currentCount
    await delay(50)
  }
  return getEmptyPlayerSlotCount(bot)
}

function countMatchingWindowPlayerItems(window, itemMatcher) {
  let count = 0
  for (let slot = window?.inventoryStart ?? 0; slot < (window?.inventoryEnd ?? 0); slot += 1) {
    const item = window.slots[slot]
    if (item && itemMatcher(item.name)) count += Number(item.count || 1)
  }
  return count
}

function countMatchingWindowContainerItems(window, itemMatcher) {
  let count = 0
  for (let slot = 0; slot < (window?.inventoryStart ?? 0); slot += 1) {
    const item = window.slots[slot]
    if (item && !isShulkerName(item.name) && itemMatcher(item.name)) count += Number(item.count || 1)
  }
  return count
}

function countWindowItemType(window, start, end, item) {
  let count = 0
  for (let slot = start; slot < end; slot += 1) {
    const candidate = window?.slots?.[slot]
    if (candidate?.type === item?.type && candidate?.metadata === item?.metadata) {
      count += Number(candidate.count || 1)
    }
  }
  return count
}

function getMaterialStashCandidates(registration, itemName) {
  const candidates = []
  const seen = new Set()
  const add = (position) => {
    if (!position) return
    const key = positionKey(position)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(new Vec3(position.x, position.y, position.z))
  }

  for (const entry of registration?.materialIndex?.[itemName] || []) add(entry.position)
  for (const container of registration?.containers || []) {
    if (container?.purpose === 'materials' && container?.full !== true) add(container.position)
  }
  for (const container of registration?.containers || []) {
    if (container?.purpose === 'materials') add(container.position)
  }
  return candidates
}

function findPlayerStackStashPlan(bot, window, item) {
  const destinationSlot = window?.slots?.findIndex((slot, index) => index < window.inventoryStart && !slot) ?? -1
  if (destinationSlot < 0) return null

  const playerInventoryStart = Number(bot.inventory?.inventoryStart ?? 9)
  const mappedSlot = Number(item?.slot) + window.inventoryStart - playerInventoryStart
  const mappedItem = window.slots[mappedSlot]
  if (mappedItem?.name === item?.name) return { sourceSlot: mappedSlot, destinationSlot }

  for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
    if (window.slots[slot]?.name === item?.name) return { sourceSlot: slot, destinationSlot }
  }
  return null
}

function recordLooseMaterialDeposit(registration, position, item) {
  if (!registration || !item?.name) return
  const containerId = positionKey(position)
  const count = Number(item.count || 1)
  const entries = registration.materialIndex?.[item.name] || []
  const existing = entries.find((entry) => entry.containerId === containerId && entry.source === 'direct')
  if (existing) existing.count = Number(existing.count || 0) + count
  else {
    if (!registration.materialIndex) registration.materialIndex = {}
    registration.materialIndex[item.name] = entries
    entries.push({
      containerId,
      position: { x: position.x, y: position.y, z: position.z },
      source: 'direct',
      slotPath: [],
      count
    })
  }

  const container = (registration.containers || []).find((entry) => entry.containerId === containerId)
  if (!container) return
  container.usedSlots = Number(container.usedSlots || 0) + 1
  container.freeSlots = Math.max(0, Number(container.capacitySlots || 0) - container.usedSlots)
  container.full = container.freeSlots === 0
}

async function reserveEmptyPlayerSlot(bot, registration, options = {}) {
  const minimumEmptySlots = Math.max(1, Number(options.minimumEmptySlots || 1))
  if (getEmptyPlayerSlotCount(bot) >= minimumEmptySlots) return true
  const previousEmptySlots = getEmptyPlayerSlotCount(bot)

  const inventoryItems = (bot.inventory?.items?.() || [])
    .filter((item) => item && !isPickaxe(item) && !isFood(item) && item.name !== 'elytra' && !isShulkerName(item.name))
    .sort((left, right) => Number(right.slot === 34) - Number(left.slot === 34))

  for (const item of inventoryItems) {
    for (const position of getMaterialStashCandidates(registration, item.name)) {
      const chestBlock = bot.blockAt(position)
      if (!chestBlock) continue

      let window = null
      try {
        const distanceToChest = bot.entity?.position ? bot.entity.position.distanceTo(chestBlock.position) : 5
  const walkTimeout = Math.max(5000, Math.ceil(distanceToChest / 2.5) * 1000 + 3000)
  await walkNear(bot, chestBlock.position, 2.0, walkTimeout)
        const opened = await openStorageContainerWithRetry(bot, chestBlock, options)
        window = opened.container
        const plan = findPlayerStackStashPlan(bot, window, item)
        if (!plan) continue

        console.log(`[INVENTORY] Reserving one empty slot by stashing ${item.name} x${item.count || 1} in material chest ${positionKey(position)}.`)
        await bot.moveSlotItem(plan.sourceSlot, plan.destinationSlot)
        const confirmed = await waitForConfirmedWindowState(
          bot,
          window,
          () => !window.slots[plan.sourceSlot] && window.slots[plan.destinationSlot]?.type === item.type
        )
        if (!confirmed) continue

        recordLooseMaterialDeposit(registration, position, item)
        window.close()
        window = null
        const emptySlots = await waitForEmptyPlayerSlotIncrease(bot, previousEmptySlots, options.inventorySyncTimeoutMs)
        if (emptySlots <= previousEmptySlots) throw new Error('Player inventory did not synchronize after material stash')
        console.log(`[INVENTORY] Empty-slot reservation confirmed; emptySlots=${emptySlots}.`)
        return true
      } catch (error) {
        console.log(`[INVENTORY-WARN] Could not stash ${item.name} in chest ${positionKey(position)}: ${error.message}`)
      } finally {
        try { window?.close() } catch {}
        await delay(120)
      }
    }
  }

  throw new Error('Cannot reserve an empty player inventory slot before shulker withdrawal')
}

async function ensureEmptyPlayerSlots(bot, registration, minimumEmptySlots, options = {}) {
  while (getEmptyPlayerSlotCount(bot) < minimumEmptySlots) {
    const before = getEmptyPlayerSlotCount(bot)
    await reserveEmptyPlayerSlot(bot, registration, { ...options, minimumEmptySlots })
    if (getEmptyPlayerSlotCount(bot) <= before) throw new Error(`Could not reserve ${minimumEmptySlots} empty player inventory slots.`)
  }
}

async function walkNear(bot, targetVec, distance = 2.0, timeoutMs = 5000) {
  const isWithinDistance = () => {
    const position = bot.entity?.position
    return Boolean(position) && Math.hypot(position.x - targetVec.x, position.z - targetVec.z) <= distance
  }
  const currentPos = bot.entity?.position
  if (!currentPos) return false
  if (isWithinDistance()) return true
  if (!bot?.pathfinder) return false

  if (bot.entity?.onGround === false) {
    const floorY = Math.floor(currentPos.y) - 1
    const nearbyFloor = [0, 1, 2].some((offset) => bot.blockAt?.(new Vec3(Math.floor(currentPos.x), floorY - offset, Math.floor(currentPos.z)))?.boundingBox === 'block')
    if (nearbyFloor) {
      disableElytraHover(bot)
      clearElytraControls(bot)
      if (bot.entity.velocity) bot.entity.velocity.set(0, -0.08, 0)
      const landingDeadline = Date.now() + 1500
      while (bot.entity?.onGround === false && Date.now() < landingDeadline) await delay(50)
    }
  }

  const movements = bot.pathfinder.movements || new Movements(bot)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allow1by1towers = false
  movements.allowParkour = false
  bot.pathfinder.setMovements(movements)
  return new Promise((resolve) => {
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      try { bot.pathfinder.setGoal(null) } catch { }
    }
    timer = setTimeout(() => {
      cleanup()
      resolve(isWithinDistance())
    }, timeoutMs)

    bot.pathfinder.goto(new GoalNear(targetVec.x, targetVec.y, targetVec.z, distance))
      .then(() => {
        cleanup()
        resolve(isWithinDistance())
      })
      .catch(() => {
        cleanup()
        resolve(false)
      })
  })
}

async function parkShulkerRestockWaiter(bot, registration) {
  const parking = getShulkerRestockParkingPosition(bot, registration)
  const distance = bot.entity?.position ? bot.entity.position.distanceTo(parking) : 30
  const timeoutMs = Math.max(15000, Math.ceil(distance / 3.0) * 1000 + 5000)
  console.log(`[GEAR-PREP] Parking ${bot.username} at ${parking.x},${parking.y},${parking.z} while another bot uses shulker staging.`)
  return walkNear(bot, parking, 1.25, timeoutMs)
}

function getShulkerRestockParkingPosition(bot, registration) {
  const index = getFleetBotIndex(bot)
  const anchor = registration?.anchor || { x: -326, y: 97, z: -100 }
  return new Vec3(Number(anchor.x) - 3.5 - (Math.min(index, 6) * 4), Number(anchor.y) + 1, Number(anchor.z) + 0.5)
}

function isWithinShulkerStagingReach(bot, staging, maxReach = 4.5) {
  return isWithinBlockInteractionReach(bot, staging?.targetPos, maxReach)
}

function isWithinBlockInteractionReach(bot, blockPosition, maxReach = 4.5) {
  const position = bot.entity?.position
  if (!position || !blockPosition) return false
  const eyePosition = position.offset(0, Number(bot.entity?.eyeHeight ?? 1.62), 0)
  return eyePosition.distanceTo(blockPosition.offset(0.5, 0.5, 0.5)) <= maxReach
}

function getWalkwayZForChest(chestZ) {
  return chestZ <= -100 ? -102 : -98
}

function findAdjacentStandPosition(bot, targetPos, standY) {
  const candidates = [
    [1.5, 0],
    [-1.5, 0],
    [0, 1.5],
    [0, -1.5],
    [1.5, 1.5],
    [1.5, -1.5],
    [-1.5, 1.5],
    [-1.5, -1.5],
    [2.5, 0],
    [-2.5, 0],
    [0, 2.5],
    [0, -2.5],
    [2.5, 2.5],
    [2.5, -2.5],
    [-2.5, 2.5],
    [-2.5, -2.5],
    [3.5, 0],
    [-3.5, 0],
    [0, 3.5],
    [0, -3.5]
  ]
  for (const [offsetX, offsetZ] of candidates) {
    const standPos = new Vec3(targetPos.x + 0.5 + offsetX, standY, targetPos.z + 0.5 + offsetZ)
    const feet = bot.blockAt(new Vec3(Math.floor(standPos.x), standY, Math.floor(standPos.z)))
    const head = bot.blockAt(new Vec3(Math.floor(standPos.x), standY + 1, Math.floor(standPos.z)))
    const floor = bot.blockAt(new Vec3(Math.floor(standPos.x), standY - 1, Math.floor(standPos.z)))
    if (feet?.name !== 'air' || head?.name !== 'air' || floor?.boundingBox !== 'block') continue
    return standPos
  }
  return null
}

function isShulkerStagingCellOccupied(bot, targetPos) {
  const centerX = Number(targetPos.x) + 0.5
  const centerZ = Number(targetPos.z) + 0.5
  const minY = Number(targetPos.y)
  const maxY = minY + 1
  return Object.values(bot.entities || {}).some((entity) => {
    if (!entity?.position || entity === bot.entity || entity.id === bot.entity?.id || entity.name === 'item') return false
    const halfWidth = Math.max(0.1, Number(entity.width || 0.6) / 2)
    const height = Math.max(0.1, Number(entity.height || 1.8))
    const overlapsHorizontal = Math.abs(entity.position.x - centerX) < 0.5 + halfWidth && Math.abs(entity.position.z - centerZ) < 0.5 + halfWidth
    const overlapsVertical = entity.position.y < maxY && entity.position.y + height > minY
    return overlapsHorizontal && overlapsVertical
  })
}

function isShulkerStagingCellAvailable(bot, targetPos) {
  return !bot.__failedShulkerStagingCells?.has(positionKey(targetPos)) && !isShulkerStagingCellOccupied(bot, targetPos)
}

function rejectShulkerStagingCell(bot, targetPos) {
  if (!bot.__failedShulkerStagingCells) bot.__failedShulkerStagingCells = new Set()
  bot.__failedShulkerStagingCells.add(positionKey(targetPos))
}

async function waitForOtherPlayersAwayFromStaging(bot, targetPos, timeoutMs = 60000) {
  const targetCenter = targetPos.offset(0.5, 0.5, 0.5)
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 20000))
  let waitingLogged = false
  while (Date.now() < deadline) {
    const nearby = Object.values(bot.entities || {}).filter((entity) => {
      if (!entity?.position || entity === bot.entity || entity.id === bot.entity?.id) return false
      if (entity.type !== 'player' && entity.name !== 'player' && !entity.username) return false
      return Math.hypot(entity.position.x - targetCenter.x, entity.position.z - targetCenter.z) < 1.7
    })
    if (nearby.length === 0) return true
    if (!waitingLogged) {
      waitingLogged = true
      console.log(`[GEAR-PREP] Waiting for ${nearby.map((entity) => entity.username || entity.name || entity.id).join(', ')} to clear shulker pickup range.`)
    }
    await delay(100)
  }
  return false
}

function findWalkwayStandY(bot, chestX, chestY, walkwayZ) {
  const botY = Math.floor(bot.entity?.position?.y ?? chestY)
  for (let y = Math.max(botY, chestY + 1); y >= Math.min(botY, chestY) - 3; y -= 1) {
    for (const dx of [0, -1, 1, -2, 2]) {
      const feet = bot.blockAt(new Vec3(chestX + dx, y, walkwayZ))
      const head = bot.blockAt(new Vec3(chestX + dx, y + 1, walkwayZ))
      const floor = bot.blockAt(new Vec3(chestX + dx, y - 1, walkwayZ))
      if (feet?.name === 'air' && head?.name === 'air' && floor?.boundingBox === 'block') return y
    }
  }
  return Math.min(botY, chestY)
}

function findDedicatedStagingPlacement(bot, registration) {
  if (!registration?.anchor) return null
  const standPos = getShulkerRestockParkingPosition(bot, registration)
  const targetPos = new Vec3(Math.floor(standPos.x), Number(registration.anchor.y) + 1, Number(registration.anchor.z) - 2)
  const targetBlock = bot.blockAt(targetPos)
  const aboveBlock = bot.blockAt(targetPos.offset(0, 1, 0))
  const floorBlock = bot.blockAt(targetPos.offset(0, -1, 0))
  const standBlock = new Vec3(Math.floor(standPos.x), Math.floor(standPos.y), Math.floor(standPos.z))
  const standFeet = bot.blockAt(standBlock)
  const standHead = bot.blockAt(standBlock.offset(0, 1, 0))
  const standFloor = bot.blockAt(standBlock.offset(0, -1, 0))
  if (
    targetBlock?.name === 'air' &&
    aboveBlock?.name === 'air' &&
    floorBlock?.boundingBox === 'block' &&
    standFeet?.name === 'air' &&
    standHead?.name === 'air' &&
    standFloor?.boundingBox === 'block' &&
    isShulkerStagingCellAvailable(bot, targetPos)
  ) {
    return { standPos, targetPos, referenceBlock: floorBlock, faceVector: new Vec3(0, 1, 0), dedicated: true }
  }
  return null
}

function findStagingPlacement(bot, chestBlock, registration = null) {
  const dedicated = findDedicatedStagingPlacement(bot, registration)
  if (dedicated) return dedicated
  const chestX = Math.floor(chestBlock.position.x)
  const chestY = Math.floor(chestBlock.position.y)
  const chestZ = Math.floor(chestBlock.position.z)
  const walkwayZ = getWalkwayZForChest(chestZ)
  const standY = findWalkwayStandY(bot, chestX, chestY, walkwayZ)
  const neighborZ = walkwayZ === -102 ? -103 : -97
  const faceVector = walkwayZ === -102 ? new Vec3(0, 0, 1) : new Vec3(0, 0, -1)

  // Search vertical levels from top down for an available solid reference block
  for (let y = 101; y >= standY + 2; y--) {
    const candidateRef = bot.blockAt(new Vec3(chestX, y, neighborZ))
    if (!candidateRef || candidateRef.name === 'air' || candidateRef.boundingBox !== 'block') continue

    const targetPos = candidateRef.position.plus(faceVector)
    const targetBlock = bot.blockAt(targetPos)
    const aboveBlock = bot.blockAt(targetPos.offset(0, 1, 0))

    if (targetBlock && targetBlock.name === 'air' && aboveBlock && aboveBlock.name === 'air' && isShulkerStagingCellAvailable(bot, targetPos)) {
      return {
        standPos: new Vec3(targetPos.x + 0.5, standY, walkwayZ + 0.5),
        targetPos,
        referenceBlock: candidateRef,
        faceVector
      }
    }
  }

  // Fallback: search adjacent X columns
  for (const dx of [0, -1, 1, -2, 2, -3, 3]) {
    for (let y = 101; y >= standY + 2; y--) {
      const candidateRef = bot.blockAt(new Vec3(chestX + dx, y, neighborZ))
      if (!candidateRef || candidateRef.name === 'air' || candidateRef.boundingBox !== 'block') continue

      const targetPos = candidateRef.position.plus(faceVector)
      const targetBlock = bot.blockAt(targetPos)
      const aboveBlock = bot.blockAt(targetPos.offset(0, 1, 0))

      if (targetBlock && targetBlock.name === 'air' && aboveBlock && aboveBlock.name === 'air' && isShulkerStagingCellAvailable(bot, targetPos)) {
        return {
          standPos: new Vec3(targetPos.x + 0.5, standY, walkwayZ + 0.5),
          targetPos,
          referenceBlock: candidateRef,
          faceVector
        }
      }
    }
  }

  // Last resort: use a lower side placement while standing clear of the target block.
  for (const dx of [0, -1, 1]) {
    for (let y = standY + 1; y >= standY; y--) {
      const candidateRef = bot.blockAt(new Vec3(chestX + dx, y, neighborZ))
      if (!candidateRef || candidateRef.name === 'air' || candidateRef.boundingBox !== 'block') continue
      const targetPos = candidateRef.position.plus(faceVector)
      const targetBlock = bot.blockAt(targetPos)
      const aboveBlock = bot.blockAt(targetPos.offset(0, 1, 0))
      if (!targetBlock || targetBlock.name !== 'air' || !aboveBlock || aboveBlock.name !== 'air' || !isShulkerStagingCellAvailable(bot, targetPos)) continue
      const standPos = findAdjacentStandPosition(bot, targetPos, standY)
      if (!standPos) continue
      return { standPos, targetPos, referenceBlock: candidateRef, faceVector }
    }
  }

  const chestFaceVector = new Vec3(0, 0, Math.sign(walkwayZ - chestZ) || faceVector.z)
  const chestReference = bot.blockAt(chestBlock.position) || chestBlock
  const chestTargetPos = chestReference.position.plus(chestFaceVector)
  const chestTargetBlock = bot.blockAt(chestTargetPos)
  const chestTargetAbove = bot.blockAt(chestTargetPos.offset(0, 1, 0))
  if (chestY <= standY && chestReference.boundingBox === 'block' && chestTargetBlock?.name === 'air' && chestTargetAbove?.name === 'air' && isShulkerStagingCellAvailable(bot, chestTargetPos)) {
    const standPos = findAdjacentStandPosition(bot, chestTargetPos, standY)
    if (standPos) return { standPos, targetPos: chestTargetPos, referenceBlock: chestReference, faceVector: chestFaceVector }
  }

  const floorOffsets = []
  for (let offsetX = -3; offsetX <= 3; offsetX += 1) {
    for (let offsetZ = -3; offsetZ <= 3; offsetZ += 1) {
      floorOffsets.push({ offsetX, offsetZ, distance: Math.hypot(offsetX, offsetZ) })
    }
  }
  floorOffsets.sort((left, right) => left.distance - right.distance)
  for (const { offsetX, offsetZ } of floorOffsets) {
    const targetPos = new Vec3(chestX + offsetX, standY, walkwayZ + offsetZ)
    const targetBlock = bot.blockAt(targetPos)
    const aboveBlock = bot.blockAt(targetPos.offset(0, 1, 0))
    const floorBlock = bot.blockAt(targetPos.offset(0, -1, 0))
    if (targetBlock?.name !== 'air' || aboveBlock?.name !== 'air' || floorBlock?.boundingBox !== 'block' || !isShulkerStagingCellAvailable(bot, targetPos)) continue
    const standPos = findAdjacentStandPosition(bot, targetPos, standY)
    if (standPos) return { standPos, targetPos, referenceBlock: floorBlock, faceVector: new Vec3(0, 1, 0) }
  }

  if (chestReference.boundingBox === 'block' && chestTargetBlock?.name === 'air' && chestTargetAbove?.name === 'air' && isShulkerStagingCellAvailable(bot, chestTargetPos)) {
    const standPos = findAdjacentStandPosition(bot, chestTargetPos, standY)
    if (standPos) return { standPos, targetPos: chestTargetPos, referenceBlock: chestReference, faceVector: chestFaceVector }
  }

  return null
}

function findShulkerReturnDestination(window) {
  for (let slot = 0; slot < window.inventoryStart; slot += 1) {
    if (!window.slots[slot]) return { slot, swapsLooseItem: false }
  }
  for (let slot = 0; slot < window.inventoryStart; slot += 1) {
    if (!isShulkerName(window.slots[slot]?.name)) return { slot, swapsLooseItem: true }
  }
  return null
}

function isShulkerReturnConfirmed(window, sourceSlot, destinationSlot) {
  const sourceCleared = !isShulkerName(window?.slots?.[sourceSlot]?.name)
  const destinationHasShulker = isShulkerName(window?.slots?.[destinationSlot]?.name)
  return sourceCleared && destinationHasShulker && !window?.selectedItem
}

async function moveShulkerIntoChest(bot, window, sourceSlot, destinationSlot) {
  await bot.moveSlotItem(sourceSlot, destinationSlot)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const confirmed = await waitForConfirmedWindowState(
      bot,
      window,
      () => isShulkerReturnConfirmed(window, sourceSlot, destinationSlot)
    )
    if (confirmed) return true

    if (isShulkerName(window.selectedItem?.name)) {
      await bot.clickWindow(destinationSlot, 0, 0)
    }
    if (window.selectedItem && !window.slots[sourceSlot]) {
      await bot.clickWindow(sourceSlot, 0, 0)
    } else if (!window.selectedItem && isShulkerName(window.slots[sourceSlot]?.name)) {
      await bot.moveSlotItem(sourceSlot, destinationSlot)
    }
  }
  return false
}

function getShulkerReturnCandidates(registration, preferredPosition) {
  const candidates = []
  const seen = new Set()
  const add = (position) => {
    if (!position) return
    const key = positionKey(position)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(new Vec3(position.x, position.y, position.z))
  }

  add(preferredPosition)
  for (const container of registration?.containers || []) {
    if (container?.purpose !== 'materials' || container?.full === true) continue
    add(container.position)
  }
  return candidates
}

function findInventoryShulkerWindowSlot(bot, window, matcher = null) {
  for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
    const item = window.slots[slot]
    if (!isShulkerName(item?.name)) continue
    const contents = getShulkerContents(bot, item)
    if (!matcher || matcher(item, contents)) return slot
  }
  return -1
}

async function returnInventoryShulkerToChest(bot, chestBlock, options = {}) {
  await walkNear(bot, chestBlock.position, 2.0, 3000)
  const opened = await openStorageContainerWithRetry(bot, chestBlock, options)
  const window = opened.container
  try {
    const sourceSlot = findInventoryShulkerWindowSlot(bot, window, options.shulkerMatcher)
    let destination = null
    destination = findShulkerReturnDestination(window)
    if (sourceSlot < 0) throw new Error('No matching shulker is available in player inventory to return')
    if (!destination) throw new Error(`Chest at ${positionKey(chestBlock.position)} has no empty or loose-item slot for the shulker`)
    if (destination.swapsLooseItem) {
      console.log(`[GEAR-PREP-WARN] Chest at ${positionKey(chestBlock.position)} is full; swapping returned shulker with loose ${window.slots[destination.slot]?.name || 'item'} in slot ${destination.slot}.`)
    }
    const confirmed = await moveShulkerIntoChest(bot, window, sourceSlot, destination.slot)
    if (!confirmed) {
      throw new Error(`Shulker return to chest at ${positionKey(chestBlock.position)} was not confirmed`)
    }
    return { sourceSlot, destinationSlot: destination.slot, swappedLooseItem: destination.swapsLooseItem }
  } finally {
    window.close()
    await delay(120)
  }
}

async function returnInventoryShulkerToStorage(bot, registration, preferredChestBlock, options = {}) {
  if (!findMatchingInventoryShulker(bot, options.shulkerMatcher)) {
    throw new Error('No matching shulker is confirmed in player inventory; refusing chest return')
  }
  const candidates = getShulkerReturnCandidates(registration, preferredChestBlock.position)
  let lastError = null
  for (const position of candidates) {
    const chestBlock = bot.blockAt(position)
    if (!chestBlock) continue
    try {
      if (!position.equals(preferredChestBlock.position)) {
        console.log(`[GEAR-PREP-WARN] Preferred chest is full; returning shulker to material chest at ${positionKey(position)}.`)
      }
      return await returnInventoryShulkerToChest(bot, chestBlock, options)
    } catch (error) {
      lastError = error
      console.log(`[GEAR-PREP-WARN] Could not return shulker to material chest at ${positionKey(position)}: ${error?.message || error}`)
    }
  }
  throw lastError || new Error('No registered material chest can accept the shulker')
}

async function catchDroppedShulker(bot, targetPos, countBefore, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  const standY = Math.floor(bot.entity?.position?.y ?? 98)
  const pickupBlock = new Vec3(Math.floor(targetPos.x), standY, Math.floor(targetPos.z))
  let pathfinderActive = false
  let lastGoalKey = null
  try {
    while (Date.now() < deadline) {
      if (getInventoryShulkerCount(bot) > countBefore) return true

      const droppedItem = Object.values(bot.entities || {}).find((entity) => {
        if (entity?.name !== 'item' || !entity.position) return false
        return entity.position.distanceTo(targetPos) <= 4.0
      })
      const pickupPosition = droppedItem?.position || pickupBlock

      if (bot.pathfinder) {
        try {
          const goalX = Math.floor(pickupPosition.x)
          const goalY = Math.floor(pickupPosition.y)
          const goalZ = Math.floor(pickupPosition.z)
          const goalKey = `${goalX},${goalY},${goalZ}`
          if (goalKey !== lastGoalKey) {
            bot.pathfinder.setGoal(new GoalNear(goalX, goalY, goalZ, 1))
            pathfinderActive = true
            lastGoalKey = goalKey
          }
        } catch {}
      } else if (droppedItem) {
        await bot.lookAt?.(droppedItem.position, true).catch(() => {})
        bot.setControlState?.('forward', true)
      }
      await delay(100)
    }
    return getInventoryShulkerCount(bot) > countBefore
  } finally {
    bot.setControlState?.('forward', false)
    if (pathfinderActive) {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
  }
}

function findEmptyShulkerSlots(bot, containerWindow) {
  const emptySlots = []
  if (!containerWindow) return emptySlots
  for (let slot = 0; slot < containerWindow.inventoryStart; slot++) {
    const item = containerWindow.slots[slot]
    if (item && isShulkerName(item.name)) {
      const contents = getShulkerContents(bot, item)
      if (contents.length === 0) {
        emptySlots.push({ slot, item })
      }
    }
  }
  return emptySlots
}

function findTransferredShulker(bot, window, itemMatcher, sourceSlot, destinationSlot) {
  const sourceItem = window?.slots?.[sourceSlot]
  const sourceStillMatches = isShulkerName(sourceItem?.name) &&
    getShulkerContents(bot, sourceItem).some((entry) => itemMatcher(entry.name || entry.itemId || entry))
  if (sourceStillMatches) return null

  const destinationItem = window?.slots?.[destinationSlot]
  if (isShulkerName(destinationItem?.name)) return destinationItem

  for (let slot = window?.inventoryStart ?? 0; slot < (window?.inventoryEnd ?? 0); slot += 1) {
    const item = window.slots[slot]
    if (!isShulkerName(item?.name)) continue
    if (getShulkerContents(bot, item).some((entry) => itemMatcher(entry.name || entry.itemId || entry))) return item
  }
  return null
}

async function syncOpenWindow(bot, window, timeoutMs = 2000) {
  if (typeof bot?._syncWindow !== 'function') return true
  let timer = null
  try {
    return await Promise.race([
      bot._syncWindow(window).then(() => true),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false) })
    ])
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForConfirmedWindowState(bot, window, predicate, options = {}) {
  const timeoutMs = Math.max(250, Number(options.timeoutMs || 3000))
  const syncTimeoutMs = Math.max(100, Number(options.syncTimeoutMs || 750))
  const pollMs = Math.max(10, Number(options.pollMs || 75))
  const deadline = Date.now() + timeoutMs
  const requiresSync = typeof bot?._syncWindow === 'function'
  const eventNames = [`setSlot:${window?.id}`, `setWindowItems:${window?.id}`]
  let sawServerUpdate = !requiresSync
  const onServerUpdate = () => { sawServerUpdate = true }

  for (const eventName of eventNames) bot?.on?.(eventName, onServerUpdate)
  try {
    while (Date.now() < deadline) {
      if (requiresSync) {
        const remainingMs = Math.max(100, deadline - Date.now())
        sawServerUpdate = await syncOpenWindow(bot, window, Math.min(syncTimeoutMs, remainingMs)) || sawServerUpdate
      }
      if (sawServerUpdate && predicate()) return true
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
    return sawServerUpdate && predicate()
  } finally {
    for (const eventName of eventNames) bot?.removeListener?.(eventName, onServerUpdate)
  }
}

async function withdrawWindowItem(bot, window, slot, item, requestedCount) {
  const transferCount = Math.min(Number(item?.count || 0), Math.max(0, Number(requestedCount || 0)))
  if (transferCount <= 0) return 0
  if (typeof window?.withdraw === 'function') {
    await window.withdraw(item.type, item.metadata, transferCount, item.nbt)
  } else if (transferCount === Number(item.count || 0)) {
    await bot.clickWindow(slot, 0, 1)
  } else {
    throw new Error(`Exact partial withdrawal is unavailable for ${item.name} x${transferCount}`)
  }
  return transferCount
}

async function withdrawWindowItemConfirmed(bot, window, slot, item, requestedCount, itemMatcher) {
  const before = countMatchingWindowPlayerItems(window, itemMatcher)
  const expected = await withdrawWindowItem(bot, window, slot, item, requestedCount)
  const confirmed = await waitForConfirmedWindowState(
    bot,
    window,
    () => countMatchingWindowPlayerItems(window, itemMatcher) >= before + expected
  )
  if (!confirmed) return 0
  return Math.max(0, countMatchingWindowPlayerItems(window, itemMatcher) - before)
}

async function depositWindowItemConfirmed(bot, window, slot) {
  const item = window?.slots?.[slot]
  if (!item) return 0

  const playerBefore = countWindowItemType(window, window.inventoryStart, window.inventoryEnd, item)
  const containerBefore = countWindowItemType(window, 0, window.inventoryStart, item)
  await bot.clickWindow(slot, 0, 1)
  const confirmed = await waitForConfirmedWindowState(
    bot,
    window,
    () => countWindowItemType(window, window.inventoryStart, window.inventoryEnd, item) < playerBefore &&
      countWindowItemType(window, 0, window.inventoryStart, item) > containerBefore
  )
  if (!confirmed) return 0

  return Math.min(
    playerBefore - countWindowItemType(window, window.inventoryStart, window.inventoryEnd, item),
    countWindowItemType(window, 0, window.inventoryStart, item) - containerBefore
  )
}

async function waitForTransferredShulker(bot, window, itemMatcher, sourceSlot, destinationSlot, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const shulker = findTransferredShulker(bot, window, itemMatcher, sourceSlot, destinationSlot)
    if (shulker) return shulker
    await delay(50)
  }
  return null
}

async function depositInventoryItemsToDump(bot, registration, itemMatcher, description, options = {}) {
  const matchingItems = (bot.inventory?.items?.() || []).filter(itemMatcher)
  if (matchingItems.length === 0) return 0

  const dumpContainer = selectNextDumpContainer(registration) || (registration.dumpContainers || [])[0]
  if (!dumpContainer) {
    const message = `No non-full dump chest available to deposit ${description}.`
    if (options.strict) throw new Error(message)
    console.log(`[GEAR-PREP-WARN] ${message}`)
    return 0
  }

  const dumpBlock = bot.blockAt(new Vec3(dumpContainer.position.x, dumpContainer.position.y, dumpContainer.position.z))
  if (!dumpBlock) {
    const message = `Dump chest block ${dumpContainer.containerId} is unavailable for ${description}.`
    if (options.strict) throw new Error(message)
    console.log(`[GEAR-PREP-WARN] ${message}`)
    return 0
  }

  console.log(`[GEAR-PREP] Dumping ${matchingItems.length} ${description} into trapped dump chest at ${dumpContainer.containerId}.`)
  const reachedDump = await walkNear(bot, dumpBlock.position, 2.0, 4000)
  if (!reachedDump && !isWithinBlockInteractionReach(bot, dumpBlock.position)) {
    if (options.strict) throw new Error(`Could not reach dump chest ${dumpContainer.containerId} for ${description}.`)
    return 0
  }
  if (!reachedDump) console.log(`[GEAR-PREP-WARN] Dump path is blocked; opening ${dumpContainer.containerId} from current interaction range.`)

  let depositedCount = 0
  try {
    const dumpOpened = await openStorageContainerWithRetry(bot, dumpBlock, options)
    const dumpWindow = dumpOpened.container
    for (let slot = dumpWindow.inventoryStart; slot < dumpWindow.inventoryEnd; slot++) {
      const item = dumpWindow.slots[slot]
      if (item && itemMatcher(item)) {
        const transferred = await depositWindowItemConfirmed(bot, dumpWindow, slot)
        if (transferred < 1) {
          throw new Error(`Inventory-to-dump transfer was not confirmed for ${item.name} in slot ${slot}.`)
        }
        depositedCount++
      }
    }
    dumpWindow.close()
    await delay(150)
  } catch (error) {
    if (options.strict) throw error
    console.log(`[GEAR-PREP-WARN] Failed depositing ${description}: ${error?.message || error}`)
  }
  return depositedCount
}

async function depositEmptyShulkersToDump(bot, registration, options = {}) {
  return depositInventoryItemsToDump(
    bot,
    registration,
    (item) => isShulkerName(item?.name) && getShulkerContents(bot, item).length === 0,
    'empty shulker(s)',
    options
  )
}

async function depositDamagedElytraToDump(bot, registration, options = {}) {
  return depositInventoryItemsToDump(
    bot,
    registration,
    (item) => item?.name === 'elytra' && isElytraLowDurability(bot, item),
    'damaged Elytra',
    { ...options, strict: true }
  )
}

async function unboxItemFromChest(bot, registration, chestPos, itemMatcher, options = {}) {
  if (!await parkShulkerRestockWaiter(bot, registration)) {
    throw new Error(`Could not park ${bot.username} outside shared shulker staging before restock`)
  }
  const releaseLock = await acquireShulkerRestockLock(bot, {
    ...options,
    onShulkerRestockWait: () => parkShulkerRestockWaiter(bot, registration)
  })
  try {
    return await unboxItemFromChestLocked(bot, registration, chestPos, itemMatcher, options)
  } finally {
    try {
      if (!await parkShulkerRestockWaiter(bot, registration)) {
        console.log(`[GEAR-PREP-WARN] ${bot.username} could not clear shared shulker staging before lock release.`)
      }
    } finally {
      releaseLock()
    }
  }
}

async function unboxItemFromChestLocked(bot, registration, chestPos, itemMatcher, options = {}) {
  const maxTargetCount = Math.max(1, Number(options.targetCount ?? 1))
  const chestBlock = bot.blockAt(chestPos)
  if (!chestBlock) throw new Error(`Chest block not found at ${positionKey(chestPos)}`)

  if (isShulkerName(chestBlock.name)) {
    console.log(`[GEAR-PREP] Block at ${formatPosition(chestPos)} is a placed shulker; accessing directly...`)
    const openedPlaced = await openStorageContainerWithRetry(bot, chestBlock, options)
    const placedWin = openedPlaced.container
    let count = 0
    for (let slot = 0; slot < placedWin.inventoryStart; slot++) {
      if (count >= maxTargetCount) break
      const item = placedWin.slots[slot]
      if (item && itemMatcher(item.name)) {
        const transferred = await withdrawWindowItemConfirmed(bot, placedWin, slot, item, maxTargetCount - count, itemMatcher)
        if (transferred < 1) break
        count += transferred
      }
    }
    placedWin.close()
    return { itemsWithdrawn: count, emptied: placedWin.containerItems().length === 0 }
  }

  const distanceToChest = bot.entity?.position ? bot.entity.position.distanceTo(chestBlock.position) : 5
  const walkTimeout = Math.max(4000, Math.ceil(distanceToChest / 3.0) * 1000 + 2500)
  await walkNear(bot, chestBlock.position, 2.5, walkTimeout)
  let looseWindow = null
  try {
    const openedLoose = await openStorageContainerWithRetry(bot, chestBlock, options)
    looseWindow = openedLoose.container
    if (countMatchingWindowContainerItems(looseWindow, itemMatcher) > 0) {
      const startingCount = countMatchingWindowPlayerItems(looseWindow, itemMatcher)
      let withdrawn = 0
      for (let slot = 0; slot < looseWindow.inventoryStart && withdrawn < maxTargetCount; slot += 1) {
        const item = looseWindow.slots[slot]
        if (!item || isShulkerName(item.name) || !itemMatcher(item.name)) continue
        await withdrawWindowItemConfirmed(bot, looseWindow, slot, item, maxTargetCount - withdrawn, itemMatcher)
        withdrawn = Math.max(0, countMatchingWindowPlayerItems(looseWindow, itemMatcher) - startingCount)
      }
      console.log(`[GEAR-PREP] Successfully withdrew ${withdrawn}/${maxTargetCount} loose items without shulker staging.`)
      return { itemsWithdrawn: withdrawn, emptied: false }
    }
  } finally {
    try { looseWindow?.close() } catch {}
    await delay(150)
  }

  await ensureEmptyPlayerSlots(
    bot,
    registration,
    getRequiredShulkerExtractionSlots(bot, itemMatcher, maxTargetCount),
    options
  )

  const distanceToChestBeforeOpen = bot.entity?.position ? bot.entity.position.distanceTo(chestBlock.position) : 5
  if (distanceToChestBeforeOpen > 3.0) {
    const walkTimeout = Math.max(4000, Math.ceil(distanceToChestBeforeOpen / 3.0) * 1000 + 2500)
    await walkNear(bot, chestBlock.position, 2.0, walkTimeout)
  }

  console.log(`[GEAR-PREP] Opening material chest at ${chestPos.x},${chestPos.y},${chestPos.z}...`)
  const openedChest = await openStorageContainerWithRetry(bot, chestBlock, options)
  const chestWindow = openedChest.container

  const rawCountWithdrawn = 0
  const remainingTargetCount = maxTargetCount

  let matchingShulkerSlot = -1
  for (let slot = 0; slot < chestWindow.inventoryStart; slot++) {
    const item = chestWindow.slots[slot]
    if (item && isShulkerName(item.name)) {
      const contents = getShulkerContents(bot, item)
      if (contents.some((entry) => itemMatcher(entry.name || entry.itemId || entry))) {
        matchingShulkerSlot = slot
        break
      }
    }
  }

  if (matchingShulkerSlot < 0) {
    chestWindow.close()
    await delay(150)
    throw new Error(`No matching shulker found in chest at ${chestPos.x},${chestPos.y},${chestPos.z}`)
  }

  console.log(`[GEAR-PREP] Withdrawing shulker from chest slot ${matchingShulkerSlot}...`)
  let heldShulker = null
  for (let transferAttempt = 1; transferAttempt <= 3 && !heldShulker; transferAttempt += 1) {
    const destinationSlot = Array.from(
      { length: chestWindow.inventoryEnd - chestWindow.inventoryStart },
      (_, offset) => chestWindow.inventoryStart + offset
    ).find((slot) => !chestWindow.slots[slot])
    if (!Number.isInteger(destinationSlot)) throw new Error('No empty player inventory slot is available for shulker withdrawal')

    if (typeof bot.moveSlotItem === 'function') await bot.moveSlotItem(matchingShulkerSlot, destinationSlot)
    else await bot.clickWindow(matchingShulkerSlot, 0, 1)
    let transferredShulker = null
    const confirmed = await waitForConfirmedWindowState(
      bot,
      chestWindow,
      () => {
        transferredShulker = findTransferredShulker(bot, chestWindow, itemMatcher, matchingShulkerSlot, destinationSlot)
        return Boolean(transferredShulker)
      }
    )
    heldShulker = confirmed ? transferredShulker : null
    if (!heldShulker && transferAttempt < 3) {
      console.log(`[GEAR-PREP-WARN] Shulker transfer was not confirmed; retrying ${transferAttempt + 1}/3...`)
      await delay(150)
    }
  }
  chestWindow.close()
  await delay(150)

  if (!heldShulker) throw new Error('Shulker withdrawal to player inventory was not confirmed')


  const staging = findStagingPlacement(bot, chestBlock, registration)
  if (!staging) throw new Error(`No clear placement cell above head near chest at ${chestPos.x},${chestPos.y},${chestPos.z}`)

  console.log(`[GEAR-PREP] Positioning at ${staging.dedicated ? 'dedicated fleet lane' : 'fallback stand point'} ${staging.standPos.x},${staging.standPos.y},${staging.standPos.z}...`)
  const distanceToStaging = bot.entity?.position ? bot.entity.position.distanceTo(staging.standPos) : 5
  const stagingTimeout = Math.max(5000, Math.ceil(distanceToStaging / 3.0) * 1000 + 2500)
  const reachedStaging = await walkNear(bot, staging.standPos, SHULKER_STAGING_TOLERANCE, stagingTimeout)
  if (!reachedStaging && !isWithinShulkerStagingReach(bot, staging)) {
    throw new Error(`Could not reach shulker staging point ${staging.standPos}; actual position is ${bot.entity?.position || 'unknown'}.`)
  }
  if (!reachedStaging) console.log(`[GEAR-PREP-WARN] Exact staging point is path-blocked; proceeding from reachable position ${bot.entity.position}.`)
  if (!await waitForOtherPlayersAwayFromStaging(bot, staging.targetPos)) {
    throw new Error(`Other players did not clear shulker staging at ${positionKey(staging.targetPos)}`)
  }


  console.log(`[GEAR-PREP] Placing shulker in ${staging.dedicated ? 'dedicated fleet lane' : 'fallback staging'} at ${staging.targetPos.x},${staging.targetPos.y},${staging.targetPos.z}...`)
  if (bot.entity?.position && bot.entity.position.distanceTo(staging.standPos) > SHULKER_STAGING_TOLERANCE) {
    const repositioned = await walkNear(bot, staging.standPos, SHULKER_STAGING_TOLERANCE, 3000)
    if (!repositioned && !isWithinShulkerStagingReach(bot, staging)) throw new Error(`Bot drifted out of shulker placement range at ${bot.entity.position}.`)
  }
  const shulkerCountBeforePlacement = getInventoryShulkerCount(bot)
  let heldConfirmed = false
  for (let equipAttempt = 1; equipAttempt <= 3; equipAttempt += 1) {
    await bot.equip(heldShulker, 'hand')
    heldConfirmed = await waitForHeldShulker(bot, Number(options.inventorySyncTimeoutMs || 2500))
    if (heldConfirmed) break
  }
  if (!heldConfirmed) throw new Error('Shulker selection was not confirmed in hand before placement')

  let placedBlock = null
  try {
    await setSneaking(bot, true)
    try {
      await bot.lookAt(staging.targetPos.offset(0.5, 0.5, 0.5), true).catch(() => {})
      await bot.placeBlock(staging.referenceBlock, staging.faceVector)
    } finally {
      await setSneaking(bot, false)
    }
  } catch (error) {
    placedBlock = bot.blockAt(staging.targetPos)
    if (!placedBlock || !isShulkerName(placedBlock.name)) {
      const direction = placementDirection(staging.faceVector)
      const cursor = new Vec3(
        0.5 + staging.faceVector.x * 0.499,
        0.5 + staging.faceVector.y * 0.499,
        0.5 + staging.faceVector.z * 0.499
      )
      for (let placementAttempt = 1; placementAttempt <= 3; placementAttempt += 1) {
        console.log(`[GEAR-PREP] Retrying shulker placement at ${staging.targetPos} against support ${staging.referenceBlock.position} (${placementAttempt}/3)...`)
        await setSneaking(bot, true)
        try {
          bot.swingArm('right')
          sendRawBlockPlacement(bot, staging.referenceBlock.position, direction, cursor)
        } finally {
          await setSneaking(bot, false)
        }
        for (let confirmationPoll = 0; confirmationPoll < 20; confirmationPoll += 1) {
          await delay(50)
          placedBlock = bot.blockAt(staging.targetPos)
          if (placedBlock && isShulkerName(placedBlock.name)) break
        }
        if (placedBlock && isShulkerName(placedBlock.name)) break
      }
    }
    if (!placedBlock || !isShulkerName(placedBlock.name)) {
      rejectShulkerStagingCell(bot, staging.targetPos)
      try {
        await returnInventoryShulkerToStorage(bot, registration, chestBlock, {
          ...options,
          shulkerMatcher: (_item, contents) => contents.some((entry) => itemMatcher(entry.name || entry.itemId || entry))
        })
      } catch (returnError) {
        error.message = `${error.message}; shulker return also failed: ${returnError.message}`
      }
      throw new Error(`Shulker placement failed at ${staging.targetPos.x},${staging.targetPos.y},${staging.targetPos.z}: ${error.message}`)
    }
  }
  await delay(100)

  placedBlock = placedBlock || bot.blockAt(staging.targetPos)
  if (!placedBlock || !isShulkerName(placedBlock.name)) {
    rejectShulkerStagingCell(bot, staging.targetPos)
    throw new Error(`Shulker placement was not confirmed at ${staging.targetPos.x},${staging.targetPos.y},${staging.targetPos.z}`)
  }
  const expectedShulkerCountAfterPlacement = Math.max(0, shulkerCountBeforePlacement - 1)
  const shulkerCountAfterPlacement = await waitForInventoryShulkerCount(bot, expectedShulkerCountAfterPlacement, Number(options.inventorySyncTimeoutMs || 2500))
  if (shulkerCountAfterPlacement > expectedShulkerCountAfterPlacement) {
    throw new Error('Inventory did not confirm the placed shulker was consumed; refusing to mine until synchronized')
  }

  console.log(`[GEAR-PREP] Opening placed shulker at ${staging.targetPos.x},${staging.targetPos.y},${staging.targetPos.z}...`)
  const shulkerWindow = await bot.openContainer(placedBlock)
  let itemsWithdrawn = 0

  for (let slot = 0; slot < shulkerWindow.inventoryStart; slot++) {
    if (itemsWithdrawn >= remainingTargetCount) break
    const item = shulkerWindow.slots[slot]
    if (item && itemMatcher(item.name)) {
      const transferred = await withdrawWindowItemConfirmed(bot, shulkerWindow, slot, item, remainingTargetCount - itemsWithdrawn, itemMatcher)
      if (transferred < 1) {
        console.log(`[GEAR-PREP-WARN] Shulker-to-inventory transfer was not confirmed for ${item.name} in slot ${slot}; preserving shulker and retrying through restock.`)
        break
      }
      itemsWithdrawn += transferred
    }
  }

  const remainingItems = shulkerWindow.containerItems()
  const isShulkerNowEmpty = remainingItems.length === 0
  shulkerWindow.close()
  await delay(150)

  const pickaxe = getBestPickaxe(bot)
  if (pickaxe) {
    await bot.equip(pickaxe, 'hand')
    await delay(80)
  }

  await ensureEmptyPlayerSlots(bot, registration, 1, options)
  if (!await waitForOtherPlayersAwayFromStaging(bot, staging.targetPos)) {
    throw new Error(`Other players entered shulker pickup range at ${positionKey(staging.targetPos)}`)
  }
  const shulkerCountBeforeBreak = getInventoryShulkerCount(bot)
  console.log(`[GEAR-PREP] Mining placed shulker (tool=${pickaxe?.name || 'hand'})...`)
  const mineStart = Date.now()
  await bot.dig(placedBlock)
  console.log(`[GEAR-PREP] Shulker mined in ${Date.now() - mineStart}ms.`)

  let caught = await catchDroppedShulker(bot, staging.targetPos, shulkerCountBeforeBreak, 6000)
  if (!caught) {
    console.log('[GEAR-PREP-WARN] Shulker pickup was not confirmed; reserving an empty slot and retrying pickup...')
    await reserveEmptyPlayerSlot(bot, registration, { ...options, minimumEmptySlots: 1 })
    caught = await catchDroppedShulker(bot, staging.targetPos, shulkerCountBeforeBreak, 10000)
  }
  if (!caught) throw new Error(`Mined shulker at ${positionKey(staging.targetPos)} was not picked up after recovery attempts`)

  if (isShulkerNowEmpty) {
    console.log('[GEAR-PREP] Shulker was completely emptied; queueing for trapped dump chest.')
  } else {
    const shulkerMatcher = (_item, contents) => contents.some((entry) => itemMatcher(entry.name || entry.itemId || entry))
    if (!findMatchingInventoryShulker(bot, shulkerMatcher)) {
      throw new Error(`Picked-up shulker from ${positionKey(staging.targetPos)} is not confirmed in inventory with the remaining requested contents`)
    }
    console.log(`[GEAR-PREP] Returning shulker back into material chest at ${chestPos.x},${chestPos.y},${chestPos.z}...`)
    await returnInventoryShulkerToStorage(bot, registration, chestBlock, {
      ...options,
      shulkerMatcher
    })
  }

  await depositEmptyShulkersToDump(bot, registration, options)
  const totalItemsWithdrawn = rawCountWithdrawn + itemsWithdrawn
  console.log(`[GEAR-PREP] Withdrew ${totalItemsWithdrawn}/${maxTargetCount} matching item(s): loose=${rawCountWithdrawn}, shulker=${itemsWithdrawn}.`)
  return { itemsWithdrawn: totalItemsWithdrawn, emptied: isShulkerNowEmpty }
}

async function ensurePickaxe(bot, registration, options = {}) {
  if (hasPickaxe(bot)) {
    const held = getBestPickaxe(bot)
    console.log(`[GEAR-PREP] Bot already has pickaxe in inventory (${held.name}); skipping pickaxe retrieval.`)
    return { status: 'already-present', pickaxe: held.name }
  }

  console.log('[GEAR-PREP] Priority 1: Pickaxe is not in inventory; searching storage chests...')
  const entries = Object.entries(registration.materialIndex || {})
  let targetEntry = null

  for (const [name, list] of entries) {
    if (name.endsWith('_pickaxe') && Array.isArray(list) && list.length > 0) {
      const preferred = list.find((e) => e.source === 'shulker') || list[0]
      targetEntry = { name, entry: preferred }
      break
    }
  }

  if (!targetEntry) {
    const errorMsg = 'First priority pickaxe is not available in storage chests.'
    console.error(`[GEAR-PREP-ERROR] ${errorMsg}`)
    registration.errors = registration.errors || []
    registration.errors.push({
      position: registration.anchor || { x: 0, y: 0, z: 0 },
      blockName: 'storage_pickaxe',
      message: errorMsg
    })
    registration.warnings = registration.warnings || []
    registration.warnings.push(errorMsg)
    throw new Error(errorMsg)
  }

  const chestPos = new Vec3(targetEntry.entry.position.x, targetEntry.entry.position.y, targetEntry.entry.position.z)
  console.log(`[GEAR-PREP] Retrieving pickaxe (${targetEntry.name}) from chest at ${formatPosition(chestPos)}...`)
  await unboxItemFromChest(bot, registration, chestPos, (name) => String(name || '').endsWith('_pickaxe'), {
    targetCount: 1,
    ...options
  })

  const pickaxe = getBestPickaxe(bot)
  if (!pickaxe) throw new Error('Pickaxe was withdrawn but not found in player inventory')
  console.log(`[GEAR-PREP] Successfully acquired pickaxe: ${pickaxe.name}.`)
  return { status: 'acquired', pickaxe: pickaxe.name }
}

async function ensureElytra(bot, registration, options = {}) {
  if (hasElytraEquipped(bot)) {
    const remaining = getElytraRemainingDurability(bot)
    if (!isElytraLowDurability(bot)) {
      console.log(`[GEAR-PREP] Elytra is already equipped in torso slot; remainingDurability=${remaining ?? 'unknown'}.`)
      return { status: 'already-equipped', remainingDurability: remaining }
    }

    console.log(`[GEAR-PREP-WARN] Equipped Elytra has ${remaining} durability remaining (<${ELYTRA_MIN_REMAINING_DURABILITY}); replacing it.`)
    await reserveEmptyPlayerSlot(bot, registration, { ...options, minimumEmptySlots: 1 })
    disableElytraHover(bot)
    clearElytraControls(bot)
    await bot.unequip('torso')
    await delay(150)
    const dumped = await depositDamagedElytraToDump(bot, registration, options)
    if (dumped < 1) throw new Error('Damaged Elytra was not deposited into a dump chest.')
  }

  await depositDamagedElytraToDump(bot, registration, options)
  const usableInventoryElytra = (bot.inventory?.items?.() || []).find((item) => item?.name === 'elytra' && !isElytraLowDurability(bot, item))
  if (usableInventoryElytra) {
    console.log('[GEAR-PREP] Elytra is present in inventory; equipping into torso slot...')
    await bot.equip(usableInventoryElytra, 'torso')
    return { status: 'equipped-from-inventory', remainingDurability: getElytraRemainingDurability(bot) }
  }

  console.log('[GEAR-PREP] Elytra not in inventory; searching storage chests...')
  const elytraEntries = registration.materialIndex?.elytra || []
  if (elytraEntries.length === 0) {
    console.log('[GEAR-PREP-WARN] No elytra found in storage chests.')
    return { status: 'not-available' }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const entry = elytraEntries[(attempt - 1) % elytraEntries.length]
    const chestPos = new Vec3(entry.position.x, entry.position.y, entry.position.z)
    console.log(`[GEAR-PREP] Retrieving Elytra from chest at ${formatPosition(chestPos)} (attempt ${attempt}/3)...`)
    await unboxItemFromChest(bot, registration, chestPos, (name) => name === 'elytra', {
      targetCount: 1,
      ...options
    })

    const candidate = (bot.inventory?.items?.() || []).find((item) => item?.name === 'elytra' && !isElytraLowDurability(bot, item))
    if (candidate) {
      await bot.equip(candidate, 'torso')
      const remaining = getElytraRemainingDurability(bot)
      console.log(`[GEAR-PREP] Successfully equipped Elytra; remainingDurability=${remaining ?? 'unknown'}.`)
      return { status: 'acquired-and-equipped', remainingDurability: remaining }
    }
    await depositDamagedElytraToDump(bot, registration, options)
  }

  throw new Error(`No Elytra with at least ${ELYTRA_MIN_REMAINING_DURABILITY} durability was available after 3 attempts.`)
}

async function ensureGoldenApples(bot, registration, options = {}) {
  const currentCount = getGoldenAppleCount(bot)
  if (currentCount >= 64) {
    console.log(`[GEAR-PREP] Bot already has 1 full stack of golden apples (${currentCount}/64).`)
    return { status: 'already-present', count: currentCount }
  }

  const needed = 64 - currentCount
  console.log(`[GEAR-PREP] Bot has ${currentCount}/64 golden apples; retrieving ${needed} more...`)

  const gappleEntries = registration.materialIndex?.enchanted_golden_apple ||
                        registration.materialIndex?.golden_apple || []
  if (gappleEntries.length === 0) {
    console.log('[GEAR-PREP-WARN] No golden apples found in storage chests.')
    return { status: 'not-available', count: currentCount }
  }

  const chestPos = new Vec3(gappleEntries[0].position.x, gappleEntries[0].position.y, gappleEntries[0].position.z)
  await unboxItemFromChest(bot, registration, chestPos, (name) => name === 'golden_apple' || name === 'enchanted_golden_apple', {
    targetCount: needed,
    ...options
  })

  const finalCount = getGoldenAppleCount(bot)
  console.log(`[GEAR-PREP] Successfully retrieved golden apples; total now ${finalCount}/64.`)
  return { status: 'acquired', count: finalCount }
}

async function prepareEssentialGear(bot, registration, config = {}, options = {}) {
  installDigTimeFix(bot)
  console.log('[GEAR-PREP] Starting post-registration essential gear preparation...')
  const startedAt = Date.now()
  const results = {}

  let pickaxeAttempts = 0
  const maxPickaxeAttempts = 3
  while (pickaxeAttempts < maxPickaxeAttempts) {
    try {
      pickaxeAttempts++
      results.pickaxe = await ensurePickaxe(bot, registration, options)
      break
    } catch (error) {
      console.log(`[GEAR-PREP-WARN] Pickaxe attempt ${pickaxeAttempts}/${maxPickaxeAttempts} failed: ${error.message}`)
      if (pickaxeAttempts >= maxPickaxeAttempts) throw error
      await delay(1000)
    }
  }

  try {
    results.elytra = await ensureElytra(bot, registration, options)
  } catch (error) {
    console.log(`[GEAR-PREP-WARN] Elytra retrieval warning: ${error.message}`)
    results.elytra = { status: 'failed', error: error.message }
  }

  try {
    results.goldenApples = await ensureGoldenApples(bot, registration, options)
  } catch (error) {
    console.log(`[GEAR-PREP-WARN] Golden apple retrieval warning: ${error.message}`)
    results.goldenApples = { status: 'failed', error: error.message }
  }

  const dumpedCount = await depositEmptyShulkersToDump(bot, registration, options)
  results.emptyShulkersDumped = dumpedCount

  console.log(`[GEAR-PREP] Essential gear preparation complete in ${Date.now() - startedAt}ms. Summary: pickaxe=${results.pickaxe?.pickaxe || 'none'}, elytra=${results.elytra?.status}, goldenApples=${results.goldenApples?.count ?? 0}/64, emptyShulkersDumped=${dumpedCount}.`)
  return results
}

module.exports = {
  installDigTimeFix,
  getShulkerContents,
  setSneaking,
  hasPickaxe,
  getBestPickaxe,
  hasElytraEquipped,
  hasElytraInInventory,
  getElytraRemainingDurability,
  isElytraLowDurability,
  getGoldenAppleCount,
  getRequiredShulkerExtractionSlots,
  findTransferredShulker,
  findStagingPlacement,
  findDedicatedStagingPlacement,
  isWithinBlockInteractionReach,
  isWithinShulkerStagingReach,
  isShulkerStagingCellOccupied,
  acquireShulkerRestockLock,
  getShulkerRestockParkingPosition,
  findWalkwayStandY,
  findShulkerReturnDestination,
  findInventoryShulkerWindowSlot,
  findMatchingInventoryShulker,
  isShulkerReturnConfirmed,
  getShulkerReturnCandidates,
  returnInventoryShulkerToStorage,
  reserveEmptyPlayerSlot,
  waitForEmptyPlayerSlotIncrease,
  findPlayerStackStashPlan,
  catchDroppedShulker,
  countMatchingWindowContainerItems,
  countMatchingWindowPlayerItems,
  syncOpenWindow,
  waitForConfirmedWindowState,
  findEmptyShulkerSlots,
  depositEmptyShulkersToDump,
  depositDamagedElytraToDump,
  depositWindowItemConfirmed,
  unboxItemFromChest,
  withdrawWindowItem,
  withdrawWindowItemConfirmed,
  ensurePickaxe,
  ensureElytra,
  ensureGoldenApples,
  prepareEssentialGear,
  walkNear
}










