'use strict'

const nbt = require('prismarine-nbt')
const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { travelToAnchor } = require('./elytra-flight')
const { getVisibleBlockInteraction } = require('./shared/block-interaction')

const DEFAULT_ANCHOR = Object.freeze({ x: -326, y: 97, z: -100 })
const DIRECT_STORAGE_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel'])
const CARDINALS = Object.freeze({
  north: Object.freeze({ x: 0, z: -1 }),
  south: Object.freeze({ x: 0, z: 1 }),
  west: Object.freeze({ x: -1, z: 0 }),
  east: Object.freeze({ x: 1, z: 0 })
})
const CHEST_FACING_MAP = Object.freeze({
  north: Object.freeze({ west: 'right', east: 'left' }),
  south: Object.freeze({ west: 'left', east: 'right' }),
  west: Object.freeze({ north: 'left', south: 'right' }),
  east: Object.freeze({ north: 'right', south: 'left' })
})
const bedRegistrationCache = new WeakMap()

function getPlatformBounds(anchor) {
  const a = normalizePoint(anchor, DEFAULT_ANCHOR)
  return {
    minX: a.x - 50,
    maxX: a.x + 50,
    minY: a.y + 1,
    maxY: a.y + 5,
    minZ: a.z - 4,
    maxZ: a.z + 4
  }
}

function isInsidePlatformBounds(pos, anchor) {
  const bounds = getPlatformBounds(anchor)
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  return x >= bounds.minX && x <= bounds.maxX &&
         y >= bounds.minY && y <= bounds.maxY &&
         z >= bounds.minZ && z <= bounds.maxZ
}

function isBedName(name) {
  return String(name || '').endsWith('_bed')
}

function isEnderChestName(name) {
  return name === 'ender_chest'
}

function isOverworld(bot) {
  const dim = String(bot.game?.dimension || bot.game?.worldName || '').toLowerCase()
  if (dim.includes('nether') || dim.includes('the_end') || dim.includes('end') || dim === '-1' || dim === '1') {
    return false
  }
  return true
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizePoint(value, fallback = null) {
  const point = value && typeof value === 'object' ? value : fallback
  const x = Number(point?.x)
  const y = Number(point?.y)
  const z = Number(point?.z)
  if (![x, y, z].every(Number.isFinite)) return null
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

function positionKey(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function isShulkerName(name) {
  const normalized = String(name || '')
  return normalized === 'shulker_box' || normalized.endsWith('_shulker_box')
}

function isStorageBlockName(name) {
  return DIRECT_STORAGE_BLOCKS.has(String(name || '')) || isShulkerName(name)
}

function getContainerComponentContents(item) {
  const component = item?.componentMap?.get?.('container') ||
    (Array.isArray(item?.components) ? item.components.find((entry) => entry?.type === 'container') : null)
  if (!component) return []
  if (Array.isArray(component.data?.contents)) return component.data.contents
  if (Array.isArray(component.data)) return component.data
  return []
}

function simplifyItemNbt(item) {
  if (!item?.nbt) return null
  try {
    return nbt.simplify(item.nbt)
  } catch {
    return null
  }
}

function getLegacyContainerContents(item) {
  const simplified = simplifyItemNbt(item)
  if (!simplified || typeof simplified !== 'object') return []
  const candidates = [
    simplified.BlockEntityTag?.Items,
    simplified.block_entity_data?.Items,
    simplified.Items,
    simplified.tag?.BlockEntityTag?.Items
  ]
  return candidates.find(Array.isArray) || []
}

function normalizeItemIdentity(bot, item, slot = null) {
  const type = Number(item?.type ?? item?.itemId ?? item?.id)
  const registryItem = Number.isFinite(type) ? bot.registry?.items?.[type] : null
  const rawName = typeof item?.id === 'string' ? item.id.replace(/^minecraft:/, '') : ''
  const name = String(item?.name || registryItem?.name || rawName || 'unknown')
  const count = Math.max(0, Number(item?.count ?? item?.itemCount ?? item?.Count ?? 0))
  const rawSlot = Number(item?.slot ?? item?.Slot ?? slot)
  return {
    slot: Number.isFinite(rawSlot) ? rawSlot : null,
    name,
    displayName: String(item?.displayName || registryItem?.displayName || name),
    count
  }
}

function describeContainerItem(bot, item, slot = null, depth = 0) {
  const identity = normalizeItemIdentity(bot, item, slot)
  if (identity.count <= 0 || identity.name === 'unknown') return null
  const nestedRaw = [
    ...getContainerComponentContents(item),
    ...getLegacyContainerContents(item)
  ]
  const seenSlots = new Set()
  const contents = []
  if (depth < 4) {
    for (let index = 0; index < nestedRaw.length; index += 1) {
      const nested = describeContainerItem(bot, nestedRaw[index], index, depth + 1)
      if (!nested) continue
      const key = `${nested.slot}:${nested.name}:${nested.count}`
      if (seenSlots.has(key)) continue
      seenSlots.add(key)
      contents.push(nested)
    }
  }
  return {
    ...identity,
    isShulker: isShulkerName(identity.name),
    contents
  }
}

function countNestedShulkers(items) {
  let count = 0
  for (const item of items) {
    if (item.isShulker) count += 1
    count += countNestedShulkers(item.contents || [])
  }
  return count
}

function collectMaterialEntries(items, context, materialIndex, totals, path = []) {
  for (const item of items) {
    const nextPath = [...path, item.slot]
    if (item.isShulker) {
      collectMaterialEntries(item.contents || [], context, materialIndex, totals, nextPath)
      continue
    }
    totals[item.name] = (totals[item.name] || 0) + item.count
    if (!materialIndex[item.name]) materialIndex[item.name] = []
    materialIndex[item.name].push({
      containerId: context.containerId,
      position: context.position,
      source: path.length > 0 ? 'shulker' : 'direct',
      slotPath: nextPath,
      count: item.count
    })
  }
}

function createContainerSnapshot(bot, block, container) {
  const capacitySlots = Math.max(0, Number(container.inventoryStart || 0))
  const rawItems = Array.isArray(container.slots) ? container.slots.slice(0, capacitySlots) : []
  const items = rawItems
    .map((item, slot) => describeContainerItem(bot, item, slot))
    .filter(Boolean)
  const usedSlots = rawItems.filter(Boolean).length
  const position = { x: block.position.x, y: block.position.y, z: block.position.z }
  const containerId = positionKey(position)
  const purpose = block.name === 'trapped_chest' ? 'dump' : 'materials'
  const materialTotals = {}
  const materialIndex = {}
  if (purpose === 'materials') collectMaterialEntries(items, { containerId, position }, materialIndex, materialTotals)
  return {
    containerId,
    position,
    blockName: block.name,
    purpose,
    capacitySlots,
    usedSlots,
    freeSlots: Math.max(0, capacitySlots - usedSlots),
    full: capacitySlots > 0 && usedSlots >= capacitySlots,
    shulkerCount: countNestedShulkers(items),
    items,
    materialTotals,
    materialIndex
  }
}

function canonicalStorageBlock(bot, block) {
  if (!block || !['chest', 'trapped_chest'].includes(block.name)) return block
  const partner = getDoubleChestPartner(bot, block)
  if (!partner) return block
  return comparePositions(block.position, partner.position) <= 0 ? block : partner
}

function comparePositions(left, right) {
  return (Math.floor(left.x) - Math.floor(right.x)) ||
    (Math.floor(left.y) - Math.floor(right.y)) ||
    (Math.floor(left.z) - Math.floor(right.z))
}

function getChestState(bot, block) {
  const properties = typeof block?.getProperties === 'function' ? block.getProperties() : {}
  const chestTypes = ['single', 'right', 'left']
  const cardinalNames = Object.keys(CARDINALS)
  const metadata = Number(block?.metadata)
  const parsedFacing = Number.isFinite(metadata) ? cardinalNames[Math.floor(metadata / 6)] : null
  let facing = String(properties?.facing || parsedFacing || '').toLowerCase()
  let type = String(properties?.type || '').toLowerCase()
  let inferTypeFromNeighbors = false
  try {
    inferTypeFromNeighbors = bot?.supportFeature?.('doesntHaveChestType') === true
  } catch { }

  if (!type && !inferTypeFromNeighbors && Number.isFinite(metadata)) {
    type = chestTypes[(metadata >> 1) % 3]
  }
  if (!CARDINALS[facing]) facing = ''

  if ((!type || inferTypeFromNeighbors) && facing) {
    type = 'single'
    for (const cardinal of Object.keys(CHEST_FACING_MAP[facing] || {})) {
      const offset = CARDINALS[cardinal]
      const candidate = bot.blockAt(block.position.offset(offset.x, 0, offset.z), false)
      if (candidate?.type === block.type) {
        type = CHEST_FACING_MAP[facing][cardinal]
        break
      }
    }
  }

  if (!['single', 'left', 'right'].includes(type)) type = 'single'
  return { facing, type }
}

function getDoubleChestPartner(bot, block) {
  const state = getChestState(bot, block)
  if (!state.facing) return null
  const perpendicularCardinals = Object.keys(CHEST_FACING_MAP[state.facing] || {})

  if (state.type !== 'single') {
    const partnerType = state.type === 'left' ? 'right' : 'left'
    const cardinal = perpendicularCardinals
      .find((name) => CHEST_FACING_MAP[state.facing][name] === partnerType)
    if (cardinal) {
      const offset = CARDINALS[cardinal]
      const partner = bot.blockAt(block.position.offset(offset.x, 0, offset.z), false)
      if (partner?.name === block.name) {
        const partnerState = getChestState(bot, partner)
        if (partnerState.type === partnerType && partnerState.facing === state.facing) return partner
      }
    }
  }

  const orientationPartners = perpendicularCardinals
    .map((cardinal) => {
      const offset = CARDINALS[cardinal]
      return bot.blockAt(block.position.offset(offset.x, 0, offset.z), false)
    })
    .filter((candidate) => candidate?.name === block.name && getChestState(bot, candidate).facing === state.facing)
  return orientationPartners.length === 1 ? orientationPartners[0] : null
}

function discoverPlatformBlocks(bot, anchor) {
  const bounds = getPlatformBounds(anchor)
  const storageBlocks = new Map()
  const enderChests = new Map()
  const beds = new Map()

  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const block = bot.blockAt(bot.entity.position.clone().set(x, y, z), true)
        if (!block || block.name === 'air') continue
        const key = positionKey(block.position)
        if (isBedName(block.name)) {
          if (!beds.has(key)) beds.set(key, block)
        } else if (isEnderChestName(block.name)) {
          if (!enderChests.has(key)) enderChests.set(key, block)
        } else if (isStorageBlockName(block.name)) {
          const canonical = canonicalStorageBlock(bot, block)
          const canonicalKey = positionKey(canonical.position)
          if (!storageBlocks.has(canonicalKey)) storageBlocks.set(canonicalKey, canonical)
        }
      }
    }
  }

  return {
    storageBlocks: [...storageBlocks.values()],
    enderChests: [...enderChests.values()],
    beds: [...beds.values()],
    bounds
  }
}

function createSafeMovements(bot) {
  const movements = new Movements(bot)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.allowSprinting = false
  return movements
}

async function withTimeout(promise, timeoutMs, message, onTimeout = null) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.() } catch { }
          reject(new Error(message))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function openStorageContainerOnce(bot, block, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      bot.removeListener('windowOpen', onWindowOpen)
      bot.removeListener('end', onBotEnd)
    }
    const finish = (handler, value) => {
      if (settled) return
      settled = true
      cleanup()
      handler(value)
    }
    const onWindowOpen = (window) => finish(resolve, window)
    const onBotEnd = (reason) => finish(reject, new Error(`container-open-session-ended: ${reason || 'disconnected'}`))

    bot.on('windowOpen', onWindowOpen)
    bot.on('end', onBotEnd)
    timer = setTimeout(() => {
      const error = new Error(`open timeout after ${timeoutMs}ms`)
      error.code = 'STORAGE_OPEN_TIMEOUT'
      finish(reject, error)
    }, timeoutMs)

    const interaction = getVisibleBlockInteraction(bot, block)
    Promise.resolve(bot.activateBlock(block, interaction?.direction, interaction?.cursorPos)).catch((error) => finish(reject, error))
  })
}

function resolveStorageOpenTimeoutMs(bot, configuredTimeoutMs = 6000) {
  const configured = Math.max(1, Number(configuredTimeoutMs) || 6000)
  const ping = Number(bot?.players?.[bot.username]?.ping)
  if (!Number.isFinite(ping) || ping <= 0) return configured
  return Math.max(configured, Math.min(30000, (ping * 2) + 2000))
}

async function openStorageContainerWithRetry(bot, block, options = {}) {
  const timeoutMs = resolveStorageOpenTimeoutMs(bot, options.timeoutMs)
  const retries = Math.max(0, Math.min(5, Math.floor(Number(options.retries ?? 2))))
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 250))
  const retryMoveTimeoutMs = Math.max(0, Number(options.retryMoveTimeoutMs) || 0)
  const targets = [block, ...(Array.isArray(options.alternateBlocks) ? options.alternateBlocks : [])]
    .filter((target, index, items) => target && items.findIndex((item) => positionKey(item.position) === positionKey(target.position)) === index)
  let lastError = null

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const target = targets[(attempt - 1) % targets.length]
    try {
      const container = await openStorageContainerOnce(bot, target, timeoutMs)
      return { container, attempts: attempt, openedPosition: target.position }
    } catch (error) {
      lastError = error
      if (error?.code !== 'STORAGE_OPEN_TIMEOUT' || attempt > retries) break
      console.log(`[STORAGE-REGISTER-WARN] Open timed out for logical ${block.name} at ${positionKey(block.position)} using half ${positionKey(target.position)}; retrying (${attempt}/${retries}).`)
      try { bot.currentWindow?.close?.() } catch { }
      const nextTarget = targets[attempt % targets.length]
      if (retryMoveTimeoutMs > 0 && bot.pathfinder && nextTarget) {
        await withTimeout(
          bot.pathfinder.goto(new GoalNear(nextTarget.position.x, nextTarget.position.y, nextTarget.position.z, 2)),
          retryMoveTimeoutMs,
          'retry approach timeout'
        ).catch((moveError) => {
          console.log(`[STORAGE-REGISTER-WARN] Retry approach failed for ${positionKey(nextTarget.position)}: ${moveError.message}`)
        })
      }
      if (retryDelayMs > 0) await delay(retryDelayMs)
    }
  }

  throw lastError
}

async function registerBed(bot, beds, bounds) {
  if (!beds.length) return null
  const bedBlock = beds[0]
  const overworld = isOverworld(bot)
  const bedPos = { x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z }
  // Force live click on bed during registration to ensure server sets respawn point


  if (!overworld) {
    console.log(`[STORAGE-REGISTER] Bed found at ${positionKey(bedBlock.position)} but dimension is non-overworld; skipping interaction.`)
    return {
      position: bedPos,
      blockName: bedBlock.name,
      clicked: false,
      ignoredReason: 'non-overworld dimension'
    }
  }

  try {
    const targetCenter = bedBlock.position.offset(0.5, 0.5, 0.5)
    if (bot.entity.position.distanceTo(targetCenter) > 2.5) {
      if (bot.pathfinder) {
        bot.pathfinder.setMovements(createSafeMovements(bot))
        await withTimeout(
          bot.pathfinder.goto(new GoalNear(bedPos.x, bedPos.y, bedPos.z, 1.5)),
          7000,
          'Timed out walking to bed'
        ).catch(() => {})
      }
    }
    await bot.lookAt(targetCenter, true)
    try { await bot.activateBlock(bedBlock) } catch (err) {}
    await delay(50)
    for (let i = 0; i < 5; i++) {
      await wakeIfSleeping(bot)
      if (typeof bot.wake === 'function' && bot.isSleeping) {
        await bot.wake().catch(() => {})
      }
      await delay(100)
    }
    console.log(`[STORAGE-REGISTER] Bed registered and clicked at ${positionKey(bedBlock.position)}.`)
    const registration = {
      position: bedPos,
      blockName: bedBlock.name,
      clicked: true,
      dimension: 'overworld'
    }
    bedRegistrationCache.set(bot, registration)
    return registration
  } catch (err) {
    console.log(`[STORAGE-REGISTER-WARN] Failed clicking bed at ${positionKey(bedBlock.position)}: ${err.message}`)
    return {
      position: bedPos,
      blockName: bedBlock.name,
      clicked: false,
      error: err.message
    }
  }
}

async function registerOneEnderChest(bot, enderChests, anchor, options = {}) {
  const candidates = (Array.isArray(enderChests) ? enderChests : [])
    .slice()
    .sort((left, right) => distanceToAnchor(left, anchor) - distanceToAnchor(right, anchor))
  const errors = []
  const openTimeoutMs = Math.max(300, Math.min(15000, Number(options.openTimeoutMs ?? 6000)))
  const openRetries = Math.max(0, Math.min(5, Math.floor(Number(options.openRetries ?? 2))))
  const openRetryDelayMs = Math.max(0, Math.min(5000, Number(options.openRetryDelayMs ?? 400)))
  const openRetryMoveTimeoutMs = Math.max(0, Math.min(10000, Number(options.openRetryMoveTimeoutMs ?? 4000)))

  for (const block of candidates) {
    let container = null
    try {
      const eyePosition = bot.entity.position.offset(0, Number(bot.entity.eyeHeight ?? 1.62), 0)
      if (eyePosition.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.35 && bot.pathfinder) {
        bot.pathfinder.setMovements(createSafeMovements(bot))
        await withTimeout(
          bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2)),
          Math.max(4000, Number(options.pathTimeoutMs ?? 30000)),
          'Timed out walking to ender chest',
          () => bot.pathfinder.stop()
        )
      }
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      const opened = await openStorageContainerWithRetry(bot, block, {
        timeoutMs: openTimeoutMs,
        retries: openRetries,
        retryDelayMs: openRetryDelayMs,
        retryMoveTimeoutMs: openRetryMoveTimeoutMs
      })
      container = opened.container
      const snapshot = createContainerSnapshot(bot, block, container)
      const registration = { ...snapshot, purpose: 'ender-storage' }
      console.log(`[STORAGE-REGISTER] Registered one ender chest at ${positionKey(block.position)} (used=${registration.usedSlots}/${registration.capacitySlots}, shulkers=${registration.shulkerCount}).`)
      return { registration, errors }
    } catch (error) {
      errors.push({
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        blockName: block.name,
        message: error.message
      })
      console.log(`[STORAGE-REGISTER-WARN] Could not register ender chest at ${positionKey(block.position)}: ${error.message}`)
    } finally {
      try { container?.close() } catch { }
    }
  }

  return { registration: null, errors }
}

async function scanStorageBlocksFast(bot, storageBlocks, anchor, options = {}) {
  const containers = []
  const ignoredEmptyContainers = []
  const errors = []
  const materialIndex = {}
  const openTimeoutMs = Math.max(300, Math.min(15000, Number(options.openTimeoutMs ?? 6000)))
  const openRetries = Math.max(0, Math.min(5, Math.floor(Number(options.openRetries ?? 2))))
  const openRetryDelayMs = Math.max(0, Math.min(5000, Number(options.openRetryDelayMs ?? 400)))
  const openRetryMoveTimeoutMs = Math.max(0, Math.min(10000, Number(options.openRetryMoveTimeoutMs ?? 4000)))
  const visitedKeys = new Set()
  const failedAttempts = new Map()
  const safeMovements = createSafeMovements(bot)
  if (bot.pathfinder) bot.pathfinder.setMovements(safeMovements)

  while (visitedKeys.size < storageBlocks.length) {
    const inReach = []
    const eyePos = bot.entity.position.offset(0, Number(bot.entity.eyeHeight ?? 1.62), 0)
    for (const block of storageBlocks) {
      const key = positionKey(block.position)
      if (visitedKeys.has(key)) continue
      const center = block.position.offset(0.5, 0.5, 0.5)
      if (eyePos.distanceTo(center) <= 4.35) {
        inReach.push(block)
      }
    }

    if (inReach.length > 0) {
      for (const block of inReach) {
        const key = positionKey(block.position)
        let container = null
        try {
          await wakeIfSleeping(bot)
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
          const opened = await openStorageContainerWithRetry(bot, block, {
            timeoutMs: openTimeoutMs,
            retries: openRetries,
            retryDelayMs: openRetryDelayMs,
            retryMoveTimeoutMs: openRetryMoveTimeoutMs,
            alternateBlocks: [getDoubleChestPartner(bot, block)].filter(Boolean)
          })
          container = opened.container
          const snapshot = createContainerSnapshot(bot, block, container)
          const hasMaterials = Object.keys(snapshot.materialTotals).length > 0
          if (snapshot.purpose === 'dump' || hasMaterials) {
            containers.push(snapshot)
            if (snapshot.purpose === 'materials') mergeMaterialIndex(materialIndex, snapshot.materialIndex)
            console.log(`[STORAGE-REGISTER] Scanned ${block.name} at ${key} (${snapshot.purpose}, used=${snapshot.usedSlots}/${snapshot.capacitySlots}, shulkers=${snapshot.shulkerCount})`)
          } else {
            ignoredEmptyContainers.push({ position: snapshot.position, blockName: snapshot.blockName })
            console.log(`[STORAGE-REGISTER] Ignored empty ${block.name} at ${key}`)
          }
        } catch (err) {
          errors.push({ position: { x: block.position.x, y: block.position.y, z: block.position.z }, blockName: block.name, message: err.message })
          console.log(`[STORAGE-REGISTER-WARN] Skipped ${block.name} at ${key}: ${err.message}`)
        } finally {
          visitedKeys.add(key)
          try { container?.close() } catch { }
        }
      }
      continue
    }

    const unvisited = storageBlocks.filter((b) => !visitedKeys.has(positionKey(b.position)))
    if (unvisited.length === 0) break

    unvisited.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
    const nextTarget = unvisited[0]
    const nextKey = positionKey(nextTarget.position)

    const approachX = nextTarget.position.x
    const approachY = anchor.y + 1
    const approachZ = Math.max(anchor.z - 2, Math.min(anchor.z + 2, nextTarget.position.z))

    if (bot.pathfinder) {
      try {
        await withTimeout(
          bot.pathfinder.goto(new GoalNear(approachX, approachY, approachZ, 1.5)),
          4000,
          'walking timeout'
        )
      } catch {
        const count = (failedAttempts.get(nextKey) || 0) + 1
        failedAttempts.set(nextKey, count)
        if (count >= 2) {
          visitedKeys.add(nextKey)
          console.log(`[STORAGE-REGISTER-WARN] Cannot reach ${nextTarget.name} at ${nextKey} after 2 attempts; skipping.`)
        }
      }
    } else {
      break
    }
  }

  return { containers, ignoredEmptyContainers, errors, materialIndex }
}

function mergeMaterialIndex(target, source) {
  for (const [itemName, entries] of Object.entries(source || {})) {
    if (!target[itemName]) target[itemName] = []
    target[itemName].push(...entries)
  }
}

function selectNextDumpContainer(registration) {
  return (Array.isArray(registration?.dumpContainers) ? registration.dumpContainers : [])
    .slice()
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
    .find((container) => container.full !== true && Number(container.freeSlots || 0) > 0) || null
}

async function returnToAnchor(bot, landingTarget, options = {}) {
  if (!landingTarget || !bot.pathfinder) return
  if (bot.entity.position.distanceTo({
    x: landingTarget.x,
    y: landingTarget.y,
    z: landingTarget.z
  }) <= 2) return
  bot.pathfinder.setMovements(createSafeMovements(bot))
  await withTimeout(
    bot.pathfinder.goto(new GoalNear(Math.floor(landingTarget.x), Math.floor(landingTarget.y), Math.floor(landingTarget.z), 1)),
    Math.max(5000, Number(options.pathTimeoutMs ?? 30000)),
    'Timed out returning to the storage anchor after registration.',
    () => bot.pathfinder.stop()
  )
}

async function waitForRuntimeReady(bot, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while ((!bot.entity || !bot.elytrafly || !bot.pathfinder) && Date.now() < deadline) await delay(100)
  if (!bot.entity) throw new Error('Bot did not spawn before storage registration timed out.')
  if (!bot.elytrafly) throw new Error('ElytraFly plugin is unavailable for storage registration travel.')
  if (!bot.pathfinder) throw new Error('Mineflayer pathfinder is unavailable for storage registration.')
}

async function wakeIfSleeping(bot) {
  if (!bot.isSleeping) return false
  const wakeAction = bot.supportFeature?.('entityActionUsesStringMapper') ? 'stop_sleeping' : 2
  bot._client?.write?.('entity_action', {
    entityId: bot.entity?.id,
    actionId: wakeAction,
    jumpBoost: 0
  })
  bot.isSleeping = false
  await delay(150)
  console.log('[STORAGE-REGISTER] Bot was sleeping and has been woken for registration.')
  return true
}

function distanceToAnchor(container, anchor) {
  return Math.hypot(
    container.position.x - anchor.x,
    container.position.y - anchor.y,
    container.position.z - anchor.z
  )
}

async function registerStorage(bot, config = {}, commandOptions = {}) {
  await waitForRuntimeReady(bot, Math.max(5000, Number(commandOptions.readyTimeoutMs ?? 30000)))
  const settings = config.storageRegistration || {}
  const anchor = normalizePoint(commandOptions.anchor, normalizePoint(settings.anchor, DEFAULT_ANCHOR))
  if (!anchor) throw new Error('Storage registration requires a valid anchor target block.')
  const scanRadius = Math.max(4, Math.min(64, Number(commandOptions.scanRadius ?? settings.scanRadius ?? 32)))
  const verticalRadius = Math.max(2, Math.min(32, Number(commandOptions.verticalRadius ?? settings.verticalRadius ?? 12)))
  const expectedDumpChestCount = Math.max(1, Number(settings.expectedDumpChestCount ?? 3))
  const startedAt = Date.now()
  const wokeFromSleep = await wakeIfSleeping(bot)

  console.log(`[STORAGE-REGISTER] Travelling to anchor block ${anchor.x}, ${anchor.y}, ${anchor.z}.`)
  const travel = await travelToAnchor(bot, anchor, {
    horizontalSpeed: Number(config.elytraFly?.horizontalSpeed ?? 2),
    verticalSpeed: Number(config.elytraFly?.verticalSpeed ?? 2)
  })
  const landingTarget = travel.landingTarget
  await wakeIfSleeping(bot)

  const { storageBlocks, enderChests, beds, bounds } = discoverPlatformBlocks(bot, anchor)
  if (storageBlocks.length === 0) throw new Error(`No chest, trapped chest, barrel, or placed shulker was found inside platform bounding box: X[${bounds.minX}..${bounds.maxX}] Y[${bounds.minY}..${bounds.maxY}] Z[${bounds.minZ}..${bounds.maxZ}].`)
  console.log(`[STORAGE-REGISTER] Discovered ${storageBlocks.length} storage block(s), ${enderChests.length} ender chest(s), ${beds.length} bed(s) on platform.`)

  const { containers, ignoredEmptyContainers, errors: storageErrors, materialIndex } = await scanStorageBlocksFast(bot, storageBlocks, anchor, settings)
  const enderChestResult = await registerOneEnderChest(bot, enderChests, anchor, settings)
  const enderChest = enderChestResult.registration
  if (enderChest) mergeMaterialIndex(materialIndex, enderChest.materialIndex)
  const errors = [...storageErrors, ...enderChestResult.errors]
  const bedRegistration = await registerBed(bot, beds, bounds)

  const dumpContainers = containers
    .filter((container) => container.purpose === 'dump')
    .sort((left, right) => distanceToAnchor(left, anchor) - distanceToAnchor(right, anchor))
    .map((container, index) => ({
      containerId: container.containerId,
      position: container.position,
      order: index + 1,
      capacitySlots: container.capacitySlots,
      usedSlots: container.usedSlots,
      freeSlots: container.freeSlots,
      full: container.full
    }))
  const materialContainers = containers.filter((container) => container.purpose === 'materials')
  const warnings = []
  if (dumpContainers.length < expectedDumpChestCount) {
    warnings.push(`Expected ${expectedDumpChestCount} trapped dump chests but registered ${dumpContainers.length}.`)
  }
  if (errors.length > 0) warnings.push(`${errors.length} storage block(s) could not be opened.`)

  const registration = {
    schemaVersion: 1,
    botName: bot.username,
    anchor,
    platformBounds: bounds,
    landingTarget,
    registeredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    wokeFromSleep,
    bed: bedRegistration,
    discoveredEnderChests: enderChests.map((b) => ({ position: { x: b.position.x, y: b.position.y, z: b.position.z }, blockName: b.name })),
    enderChest,
    enderChests: enderChest ? [{ position: enderChest.position, blockName: enderChest.blockName }] : [],
    nestedReadMode: 'parent-window item container component/NBT; shulkers are never removed or opened',
    summary: {
      discoveredContainerCount: storageBlocks.length,
      registeredContainerCount: containers.length,
      materialContainerCount: materialContainers.length,
      dumpContainerCount: dumpContainers.length,
      discoveredEnderChestCount: enderChests.length,
      enderChestCount: enderChest ? 1 : 0,
      enderChestUsedSlots: enderChest?.usedSlots ?? 0,
      enderChestShulkerCount: enderChest?.shulkerCount ?? 0,
      bedRegistered: Boolean(bedRegistration?.clicked),
      shulkerCount: materialContainers.reduce((total, container) => total + container.shulkerCount, 0),
      materialTypeCount: Object.keys(materialIndex).length,
      ignoredEmptyContainerCount: ignoredEmptyContainers.length,
      errorCount: errors.length
    },
    containers,
    dumpContainers,
    materialIndex,
    ignoredEmptyContainers,
    warnings,
    errors
  }
  const nextDump = selectNextDumpContainer(registration)
  console.log(`[STORAGE-REGISTER] Registered materials=${materialContainers.length} dumps=${dumpContainers.length} ender=${registration.summary.enderChestCount} shulkers=${registration.summary.shulkerCount} itemTypes=${registration.summary.materialTypeCount} ignoredEmpty=${ignoredEmptyContainers.length} nextDump=${nextDump?.containerId || 'none'}.`)

  if (commandOptions.prepareGear !== false && settings.prepareGear !== false) {
    const { prepareEssentialGear } = require('./gear-restock')
    try {
      registration.gearRestock = await prepareEssentialGear(bot, registration, config, commandOptions)
    } catch (err) {
      warnings.push(`Gear preparation error: ${err.message}`)
      registration.gearRestock = { status: 'failed', error: err.message }
      if (String(err?.message || '').includes('pickaxe')) {
        errors.push({
          position: anchor,
          blockName: 'storage_pickaxe',
          message: err.message
        })
        registration.summary.errorCount = errors.length
        throw err
      }
    }
  }

  await returnToAnchor(bot, landingTarget, settings)
  return registration
}

module.exports = {
  DEFAULT_ANCHOR,
  canonicalStorageBlock,
  createContainerSnapshot,
  describeContainerItem,
  discoverPlatformBlocks,
  getChestState,
  getPlatformBounds,
  isInsidePlatformBounds,
  isOverworld,
  getContainerComponentContents,
  isShulkerName,
  normalizePoint,
  openStorageContainerWithRetry,
  resolveStorageOpenTimeoutMs,
  registerOneEnderChest,
  registerStorage,
  selectNextDumpContainer,
  prepareEssentialGear: (...args) => require('./gear-restock').prepareEssentialGear(...args)
}



