'use strict'

const { Vec3 } = require('vec3')
const {
  depositEmptyShulkersToDump,
  depositWindowItemConfirmed,
  getBestPickaxe,
  getGoldenAppleCount,
  getShulkerContents,
  prepareEssentialGear,
  reserveEmptyPlayerSlot,
  returnInventoryShulkerToStorage,
  unboxItemFromChest,
  walkNear
} = require('./gear-restock')
const { isShulkerName } = require('./storage-registration')
const { openStorageContainerWithRetry } = require('./storage-registration')
const { travelToAnchor } = require('./elytra-flight')

const HOTBAR_SLOT_PICKAXE = 0
const HOTBAR_SLOT_FOOD = 1
const HOTBAR_SLOT_MOVING = 2
const HOTBAR_SLOT_BUFFER = 8
const WINDOW_SLOT_PICKAXE = 36
const WINDOW_SLOT_FOOD = 37
const WINDOW_SLOT_MOVING = 38
const WINDOW_SLOT_BUFFER = 44
const WINDOW_SLOT_STAGING = 34

// 33 building material slots while printing:
// 8 managed hotbar slots (37..44) + 25 main inventory slots (9..33).
// Slot 34 stays empty, slot 35 keeps food, and slot 36 keeps the pickaxe.
const MATERIAL_HOTBAR_SLOTS = [37, 38, 39, 40, 41, 42, 43, 44]
const MATERIAL_MAIN_SLOTS = [
  9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33
]
const MATERIAL_SLOT_INDICES = [...MATERIAL_HOTBAR_SLOTS, ...MATERIAL_MAIN_SLOTS]
const TOTAL_MATERIAL_SLOTS = MATERIAL_SLOT_INDICES.length
const DEFAULT_HOTBAR_LOOKAHEAD_BLOCKS = 512

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isDedicatedHotbarSlot(slotIndex) {
  return slotIndex === WINDOW_SLOT_PICKAXE
}

function isMaterialSlot(slotIndex) {
  return MATERIAL_SLOT_INDICES.includes(slotIndex)
}

function isPickaxe(item) {
  return Boolean(item?.name && item.name.endsWith('_pickaxe'))
}

function isFood(item) {
  if (!item?.name) return false
  return item.name === 'golden_apple' ||
    item.name === 'enchanted_golden_apple' ||
    item.name === 'cooked_beef' ||
    item.name === 'bread' ||
    item.name === 'cooked_porkchop' ||
    item.name === 'cooked_mutton' ||
    item.name === 'baked_potato'
}

function isGoldenApple(item) {
  return item?.name === 'golden_apple' || item?.name === 'enchanted_golden_apple'
}

function isBuildingMaterial(item) {
  return Boolean(item?.name) &&
    !isShulkerName(item.name) &&
    !isPickaxe(item) &&
    !isFood(item) &&
    item.name !== 'elytra'
}

function isAirBlock(name) {
  if (!name) return true
  const clean = String(name).replace(/^minecraft:/, '').toLowerCase()
  return clean === 'air' || clean === 'cave_air' || clean === 'void_air'
}

function getMaterialInventoryCounts(bot) {
  const counts = {}
  if (!bot?.inventory?.slots) return counts

  for (let slotIndex = 9; slotIndex <= 44; slotIndex += 1) {
    const item = bot.inventory.slots[slotIndex]
    if (isBuildingMaterial(item)) {
      counts[item.name] = (counts[item.name] || 0) + Number(item.count || 1)
    }
  }
  return counts
}

function getInventoryItemCount(bot, itemName) {
  return (bot?.inventory?.items?.() || []).reduce((total, item) => {
    return item?.name === itemName ? total + Number(item.count || 1) : total
  }, 0)
}

function getEmptyPlayerSlotCount(bot) {
  return (bot?.inventory?.slots || []).slice(9, 45).filter((item) => !item).length
}

async function ensurePlayerInventoryWindow(bot, timeoutMs = 1500) {
  if (!bot?.currentWindow) return false
  const staleWindow = bot.currentWindow
  if (typeof bot.closeWindow === 'function') await bot.closeWindow(staleWindow)
  else staleWindow.close?.()
  const deadline = Date.now() + Math.max(250, Number(timeoutMs || 1500))
  while (bot.currentWindow && Date.now() < deadline) await delay(25)
  if (bot.currentWindow) throw new Error(`Container window ${bot.currentWindow.id ?? 'unknown'} remained open before player-inventory swap.`)
  return true
}

function needsInventoryCleanup(bot) {
  if (!Array.isArray(bot?.inventory?.slots)) return false
  const items = bot?.inventory?.items?.() || []
  const pickaxeCount = items.filter(isPickaxe).length
  return getEmptyPlayerSlotCount(bot) < 1 ||
    pickaxeCount > 1 ||
    items.filter(isGoldenApple).length > 1
}

async function swapSlotWithHotbar(bot, sourceSlot, hotbarIndex) {
  if (typeof bot?.clickWindow !== 'function') return
  await ensurePlayerInventoryWindow(bot)
  // Minecraft Protocol Mode 2: number key swap with hotbar (0..8)
  await bot.clickWindow(sourceSlot, hotbarIndex, 2)
  await delay(80)
}

async function waitForInventorySlot(bot, slot, predicate, timeoutMs = 3000) {
  const ping = Number(bot?.players?.[bot.username]?.ping || 0)
  const deadline = Date.now() + Math.max(timeoutMs, Number.isFinite(ping) ? (ping * 4) + 500 : timeoutMs)
  while (Date.now() < deadline) {
    if (predicate(bot?.inventory?.slots?.[slot])) return true
    await delay(25)
  }
  return false
}

async function swapSlotWithHotbarConfirmed(bot, sourceSlot, hotbarIndex, expectedTargetName) {
  if (typeof bot?.clickWindow !== 'function') throw new Error('Inventory swap requires clickWindow support.')
  await ensurePlayerInventoryWindow(bot)
  const targetSlot = 36 + hotbarIndex
  const sourceBefore = bot.inventory?.slots?.[sourceSlot]
  const targetBefore = bot.inventory?.slots?.[targetSlot]
  await bot.clickWindow(sourceSlot, hotbarIndex, 2)
  const confirmed = await waitForInventorySlot(bot, targetSlot, (item) => {
    const targetMatches = expectedTargetName ? item?.name === expectedTargetName : !item
    if (!targetMatches) return false
    if (sourceBefore === targetBefore) return true
    const sourceNow = bot.inventory?.slots?.[sourceSlot]
    return item !== targetBefore ||
      sourceNow !== sourceBefore ||
      sourceBefore?.slot === targetSlot ||
      targetBefore?.slot === sourceSlot
  })
  if (!confirmed) {
    throw new Error(`Server did not confirm inventory swap into hotbar slot ${hotbarIndex}; expected ${expectedTargetName || 'empty'}.`)
  }
}

function createPrintingHotbarPlan(bot, blocks, options = {}) {
  const startIndex = Math.max(0, Math.floor(Number(options.startIndex || 0)))
  const lookaheadBlocks = Math.max(1, Math.floor(Number(options.lookaheadBlocks || DEFAULT_HOTBAR_LOOKAHEAD_BLOCKS)))
  const route = Array.isArray(blocks) ? blocks : []
  const reservedMaterials = options.reservedMaterials instanceof Map
    ? options.reservedMaterials
    : new Map(Object.entries(options.reservedMaterials || {}))
  const sourceCounts = new Map()

  for (const slot of [...MATERIAL_HOTBAR_SLOTS, ...MATERIAL_MAIN_SLOTS, WINDOW_SLOT_STAGING, 35]) {
    const item = bot?.inventory?.slots?.[slot]
    if (!isBuildingMaterial(item)) continue
    const sources = sourceCounts.get(item.name) || []
    sources.push({
      count: Math.max(1, Number(item.count || 1)),
      resident: MATERIAL_HOTBAR_SLOTS.includes(slot),
      slot
    })
    sourceCounts.set(item.name, sources)
  }
  for (const [name, sources] of sourceCounts) {
    sources.sort((left, right) => Number(right.resident) - Number(left.resident) || (left.resident ? left.slot - right.slot : right.count - left.count || left.slot - right.slot))
    let reserved = Math.max(0, Number(reservedMaterials.get(name) || 0))
    for (const source of sources) {
      if (!source.resident || reserved < 1) continue
      const consumed = Math.min(source.count, reserved)
      source.count -= consumed
      reserved -= consumed
    }
    sourceCounts.set(name, sources.filter((source) => source.count > 0))
  }

  const activatedCapacity = new Map()
  const activatedSources = new Map()
  const demand = new Map()
  const desiredSources = []
  const missingMaterials = new Set()
  const routeEnd = Math.min(route.length, startIndex + lookaheadBlocks)
  let scannedBlocks = 0

  for (let index = startIndex; index < routeEnd && desiredSources.length < MATERIAL_HOTBAR_SLOTS.length; index += 1) {
    const name = String(route[index]?.name || route[index] || '').replace(/^minecraft:/, '')
    if (!name || isAirBlock(name)) continue
    scannedBlocks += 1
    const needed = (demand.get(name) || 0) + 1
    demand.set(name, needed)
    let capacity = activatedCapacity.get(name) || 0
    while (capacity < needed && desiredSources.length < MATERIAL_HOTBAR_SLOTS.length) {
      const sourceIndex = activatedSources.get(name) || 0
      const source = sourceCounts.get(name)?.[sourceIndex]
      if (!source) {
        missingMaterials.add(name)
        break
      }
      desiredSources.push({ material: name, sourceSlot: source.slot, resident: source.resident })
      capacity += source.count
      activatedCapacity.set(name, capacity)
      activatedSources.set(name, sourceIndex + 1)
    }
  }

  const desiredMaterials = desiredSources.map((source) => source.material)
  const remaining = desiredSources.slice()
  const assignments = []
  const takenSlots = new Set()
  for (const slot of MATERIAL_HOTBAR_SLOTS) {
    const wantedIndex = remaining.findIndex((source) => source.resident && source.sourceSlot === slot)
    if (wantedIndex < 0) continue
    assignments.push({ material: remaining[wantedIndex].material, retained: true, slot, sourceSlot: slot })
    remaining.splice(wantedIndex, 1)
    takenSlots.add(slot)
  }
  const freeSlots = MATERIAL_HOTBAR_SLOTS.filter((slot) => !takenSlots.has(slot))
  for (let index = 0; index < remaining.length && index < freeSlots.length; index += 1) {
    assignments.push({ material: remaining[index].material, retained: false, slot: freeSlots[index], sourceSlot: remaining[index].sourceSlot })
  }

  return {
    assignments,
    desiredMaterials,
    missingMaterials: [...missingMaterials],
    scannedBlocks,
    startIndex,
    workingSetKey: desiredMaterials.join('|')
  }
}

function getPrintingHotbarCoverage(bot, blocks, options = {}) {
  const startIndex = Math.max(0, Math.floor(Number(options.startIndex || 0)))
  const lookaheadBlocks = Math.max(1, Math.floor(Number(options.lookaheadBlocks || DEFAULT_HOTBAR_LOOKAHEAD_BLOCKS)))
  const route = Array.isArray(blocks) ? blocks : []
  const remaining = new Map()
  for (const slot of MATERIAL_HOTBAR_SLOTS) {
    const item = bot?.inventory?.slots?.[slot]
    if (!isBuildingMaterial(item)) continue
    remaining.set(item.name, (remaining.get(item.name) || 0) + Math.max(1, Number(item.count || 1)))
  }

  const reservedMaterials = options.reservedMaterials instanceof Map
    ? options.reservedMaterials
    : new Map(Object.entries(options.reservedMaterials || {}))
  for (const [name, count] of reservedMaterials) {
    remaining.set(name, Math.max(0, (remaining.get(name) || 0) - Math.max(0, Number(count || 0))))
  }

  const routeEnd = Math.min(route.length, startIndex + lookaheadBlocks)
  let coveredBlocks = 0
  for (let index = startIndex; index < routeEnd; index += 1) {
    const name = String(route[index]?.name || route[index] || '').replace(/^minecraft:/, '')
    if (!name || isAirBlock(name)) continue
    const count = remaining.get(name) || 0
    if (count < 1) {
      return { coveredBlocks, coveredUntilIndex: index, nextMissingIndex: index, nextMissingMaterial: name }
    }
    remaining.set(name, count - 1)
    coveredBlocks += 1
  }

  return { coveredBlocks, coveredUntilIndex: routeEnd, nextMissingIndex: -1, nextMissingMaterial: null }
}

async function organizeDedicatedSlots(bot) {
  if (!bot?.inventory?.slots) return { organized: false }

  // 1. Ensure pickaxe is in dedicated hotbar slot 0 (window slot 36)
  const currentSlot36 = bot.inventory.slots[WINDOW_SLOT_PICKAXE]
  if (!isPickaxe(currentSlot36)) {
    const pickaxeItem = bot.inventory.items().find(isPickaxe)
    if (pickaxeItem && pickaxeItem.slot !== WINDOW_SLOT_PICKAXE) {
      console.log(`[INVENTORY] Swapping pickaxe (${pickaxeItem.name}) from slot ${pickaxeItem.slot} into dedicated hotbar slot 0...`)
      await swapSlotWithHotbar(bot, pickaxeItem.slot, HOTBAR_SLOT_PICKAXE)
    }
  }

  // 2. Golden apples stay out of the hotbar until health drops below 12.
  const currentSlot37 = bot.inventory.slots[WINDOW_SLOT_FOOD]
  if (isFood(currentSlot37)) {
    const foodSlot = !bot.inventory.slots[35]
      ? 35
      : (MATERIAL_MAIN_SLOTS.find((slot) => !bot.inventory.slots[slot]) ?? 35)
    await swapSlotWithHotbar(bot, foodSlot, HOTBAR_SLOT_FOOD)
  }

  // 3. At restock station, ensure moving slot (window slot 38) is clear of non-shulker materials
  const currentSlot38 = bot.inventory.slots[WINDOW_SLOT_MOVING]
  if (currentSlot38 && !isShulkerName(currentSlot38.name)) {
    const emptySlot = MATERIAL_SLOT_INDICES.find((slot) => slot !== WINDOW_SLOT_MOVING && !bot.inventory.slots[slot])
    if (Number.isInteger(emptySlot)) {
      console.log(`[INVENTORY] Clearing moving slot 2 (${currentSlot38.name}) into material slot ${emptySlot}...`)
      await swapSlotWithHotbar(bot, emptySlot, HOTBAR_SLOT_MOVING)
    }
  }

  return {
    organized: true,
    pickaxe: bot.inventory.slots[WINDOW_SLOT_PICKAXE]?.name || null,
    food: bot.inventory.items().find(isFood)?.name || null,
    movingSlot: bot.inventory.slots[WINDOW_SLOT_MOVING]?.name || 'empty'
  }
}

async function organizePrintingHotbar(bot, options = {}) {
  if (!bot?.inventory?.slots) return { organized: false }

  // 1. Pickaxe stays in hotbar slot 0 (36)
  const currentSlot36 = bot.inventory.slots[WINDOW_SLOT_PICKAXE]
  if (!isPickaxe(currentSlot36)) {
    const pickaxeItem = bot.inventory.items().find(isPickaxe)
    if (pickaxeItem && pickaxeItem.slot !== WINDOW_SLOT_PICKAXE) {
      await swapSlotWithHotbar(bot, pickaxeItem.slot, HOTBAR_SLOT_PICKAXE)
    }
  }

  // 2. User requirement: we do not need golden apple always in hotbar.
  // During printing, slot 37 is freed so hotbar holds building materials.
  // Move golden apples into main inventory slot 35.
  const currentSlot37 = bot.inventory.slots[WINDOW_SLOT_FOOD]
  if (isFood(currentSlot37)) {
    const mainSlot = !bot.inventory.slots[35] || !isFood(bot.inventory.slots[35])
      ? 35
      : MATERIAL_MAIN_SLOTS.find((slot) => !bot.inventory.slots[slot])
    if (!Number.isInteger(mainSlot)) throw new Error('Cannot remove food from printing hotbar; no main-inventory slot is available.')
    await swapSlotWithHotbar(bot, mainSlot, HOTBAR_SLOT_FOOD)
  }

  // 3. User requirement: shulker slot only needed at refill station; while printing same slot will be free.
  // If a shulker box remains in moving slot 38, move it to main inventory or clear it.
  const currentSlot38 = bot.inventory.slots[WINDOW_SLOT_MOVING]
  if (currentSlot38 && isShulkerName(currentSlot38.name)) {
    const mainSlot = MATERIAL_MAIN_SLOTS.find((slot) => !bot.inventory.slots[slot])
    if (Number.isInteger(mainSlot)) await swapSlotWithHotbar(bot, mainSlot, HOTBAR_SLOT_MOVING)
  }

  return { organized: true }
}

async function prefetchPrintingHotbar(bot, blocks, options = {}) {
  if (!bot?.inventory?.slots) return { organized: false, assignments: [], swaps: 0 }
  await organizePrintingHotbar(bot, options)
  const plan = createPrintingHotbarPlan(bot, blocks, options)
  const maxSwaps = Math.max(0, Math.floor(Number(options.maxSwaps ?? Number.POSITIVE_INFINITY)))
  let swaps = 0

  for (const assignment of plan.assignments) {
    if (swaps >= maxSwaps) break
    if (bot.inventory.slots[assignment.slot]?.name === assignment.material) continue
    const sourceSlots = [assignment.sourceSlot, ...MATERIAL_MAIN_SLOTS, WINDOW_SLOT_STAGING, 35]
    const sourceSlot = sourceSlots.find((slot, index) => {
      return sourceSlots.indexOf(slot) === index && bot.inventory.slots[slot]?.name === assignment.material && isBuildingMaterial(bot.inventory.slots[slot])
    })
    if (!Number.isInteger(sourceSlot)) continue
    const displaced = bot.inventory.slots[assignment.slot]?.name || 'empty'
    try {
      await swapSlotWithHotbarConfirmed(bot, sourceSlot, assignment.slot - 36, assignment.material)
    } catch (error) {
      options.logger?.warn?.(`Hotbar prefetch deferred ${assignment.material}: inventory=${sourceSlot}, hotbar=${assignment.slot - 36}, reason=${error.message}. Printing will wait and retry the confirmed hotbar swap.`)
      break
    }
    swaps += 1
    options.logger?.debug?.(`Hotbar prefetch: ${assignment.material} inventory=${sourceSlot} -> hotbar=${assignment.slot - 36}; displaced=${displaced}.`)
  }

  return { ...plan, organized: true, swaps }
}

async function checkAndConsumeGoldenApple(bot) {
  const health = Number(bot?.health)
  if (!Number.isFinite(health) || health >= 12) return false

  const foodItem = bot.inventory?.items?.()?.find(isFood)
  if (!foodItem) {
    console.log(`[HEAL-WARN] Health is low (${health}/20) but no golden apples found in inventory!`)
    return false
  }

  console.log(`[HEAL] Health is low (${health}/20 < 12); equipping and consuming ${foodItem.name}...`)
  const originalSlot = foodItem.slot
  const originalHotbarItem = bot.inventory.slots[WINDOW_SLOT_FOOD]
  const movedFromMain = originalSlot !== WINDOW_SLOT_FOOD

  // Swap food into hotbar slot 1 to eat
  if (movedFromMain) await swapSlotWithHotbarConfirmed(bot, originalSlot, HOTBAR_SLOT_FOOD, foodItem.name)
  const hotbarFood = bot.inventory.slots[WINDOW_SLOT_FOOD]
  try {
    if (hotbarFood) {
      await bot.equip(hotbarFood, 'hand')
      await delay(100)
      if (typeof bot.consume === 'function') {
        await bot.consume()
      } else if (typeof bot.activateItem === 'function') {
        bot.activateItem()
        await delay(1650)
        bot.deactivateItem?.()
      }
      console.log(`[HEAL] Consumed ${foodItem.name}. Health now ${bot.health}/20.`)
    }
  } catch (err) {
    console.log(`[HEAL-WARN] Consumption warning: ${err.message}`)
  } finally {
    if (movedFromMain) {
      await swapSlotWithHotbarConfirmed(bot, originalSlot, HOTBAR_SLOT_FOOD, originalHotbarItem?.name || null)
    } else {
      await organizePrintingHotbar(bot)
    }
  }
  return true
}

function planUpcomingChunkMaterials(bot, chunkSlice, options = {}) {
  const rawBlocks = chunkSlice?.blocks || []
  // User requirement: skip air blocks and sort bottom to top (Y ascending, Z ascending, X ascending)
  const validBlocks = rawBlocks.filter((b) => !isAirBlock(b.name))
  const blocks = options.preserveOrder === true
    ? validBlocks.slice()
    : validBlocks.slice().sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  const startIdx = Math.max(0, Number(options.startIndex ?? bot?.placedBlocksCount ?? 0))
  const remaining = blocks.slice(startIdx)

  if (remaining.length === 0) {
    return {
      needsRestock: false,
      complete: true,
      plannedBlockCount: 0,
      startIndex: startIdx,
      endIndex: startIdx,
      demands: {},
      currentCounts: {},
      shortages: {},
      neededItems: [],
      plannedBlocks: []
    }
  }

  const maxSlots = Math.max(1, Math.min(TOTAL_MATERIAL_SLOTS, Number(options.maxSlots || TOTAL_MATERIAL_SLOTS)))
  const demands = {}
  const plannedBlocks = []

  // User requirement: if bot has space in inventory it will get more items for upcoming blocks and fill its inventory
  for (const block of remaining) {
    const candidateDemands = { ...demands, [block.name]: (demands[block.name] || 0) + 1 }
    const slotsRequired = Object.values(candidateDemands).reduce((total, count) => {
      return total + Math.ceil(count / 64)
    }, 0)

    if (slotsRequired > maxSlots && plannedBlocks.length > 0) {
      break
    }

    demands[block.name] = (demands[block.name] || 0) + 1
    plannedBlocks.push(block)
  }

  const currentCounts = getMaterialInventoryCounts(bot)
  const shortages = {}
  const neededItems = []

  for (const [itemName, demandCount] of Object.entries(demands)) {
    const current = currentCounts[itemName] || 0
    if (current >= demandCount) {
      shortages[itemName] = 0
      continue
    }
    const shortageUnits = Math.max(0, demandCount - current)
    if (shortageUnits > 0) {
      const fullStacksNeeded = Math.ceil(shortageUnits / 64)
      const fillCount = fullStacksNeeded * 64
      shortages[itemName] = fillCount
      neededItems.push({
        name: itemName,
        countNeeded: fillCount,
        stacksNeeded: fullStacksNeeded
      })
    } else {
      shortages[itemName] = 0
    }
  }

  const needsRestock = neededItems.length > 0
  return {
    needsRestock,
    complete: false,
    plannedBlockCount: plannedBlocks.length,
    startIndex: startIdx,
    endIndex: startIdx + plannedBlocks.length,
    demands,
    currentCounts,
    shortages,
    neededItems,
    plannedBlocks
  }
}

function findChestCandidatesForMaterial(storageRegistration, materialName) {
  const index = storageRegistration?.materialIndex?.[materialName]
  if (!Array.isArray(index) || index.length === 0) return []

  const totalsByPosition = new Map()
  for (const entry of index) {
    const x = Number(entry.position?.x)
    const y = Number(entry.position?.y)
    const z = Number(entry.position?.z)
    if (![x, y, z].every(Number.isFinite)) continue
    const key = `${x},${y},${z}`
    const current = totalsByPosition.get(key) || { position: { x, y, z }, count: 0 }
    current.count += Math.max(0, Number(entry.count || 0))
    totalsByPosition.set(key, current)
  }

  return [...totalsByPosition.values()]
    .sort((left, right) => right.count - left.count)
    .map((entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z))
}

function findBestChestForMaterial(storageRegistration, materialName) {
  return findChestCandidatesForMaterial(storageRegistration, materialName)[0] || null
}

async function returnStrandedMaterialShulkers(bot, storageRegistration, options = {}) {
  let returned = 0
  const maximumReturns = (bot.inventory?.items?.() || []).filter((item) => isShulkerName(item?.name)).length
  for (let attempt = 0; attempt < maximumReturns; attempt += 1) {
    const shulker = (bot.inventory?.items?.() || []).find((item) => isShulkerName(item?.name) && getShulkerContents(bot, item).length > 0)
    if (!shulker) break
    const contents = getShulkerContents(bot, shulker)
    const materialName = String(contents[0]?.name || contents[0]?.itemId || contents[0] || '').replace(/^minecraft:/, '')
    const chestPos = findBestChestForMaterial(storageRegistration, materialName)
    const chestBlock = chestPos ? bot.blockAt(chestPos) : null
    if (!materialName || !chestBlock) {
      console.log(`[INVENTORY-WARN] Cannot return stranded shulker from slot ${shulker.slot}; no registered chest for ${materialName || 'unknown contents'}.`)
      break
    }
    await returnInventoryShulkerToStorage(bot, storageRegistration, chestBlock, {
      ...options,
      shulkerMatcher: (_item, candidateContents) => candidateContents.some((entry) => String(entry?.name || entry?.itemId || entry || '').replace(/^minecraft:/, '') === materialName)
    })
    returned += 1
  }
  if (returned > 0) console.log(`[INVENTORY] Returned ${returned} stranded material shulker(s) to storage before restock.`)
  return returned
}

function getUnneededInventoryItems(bot, neededMaterialNames) {
  const inventoryItems = bot?.inventory?.items?.() || []
  const bestPickaxe = getBestPickaxe(bot)
  const keptGoldenApple = inventoryItems
    .filter(isGoldenApple)
    .sort((left, right) => Number(right.name === 'enchanted_golden_apple') - Number(left.name === 'enchanted_golden_apple') || Number(right.count || 0) - Number(left.count || 0))[0]

  return inventoryItems.filter((it) => {
    if (isPickaxe(it)) return it.slot !== bestPickaxe?.slot
    if (isGoldenApple(it)) return it.slot !== keptGoldenApple?.slot
    if (isDedicatedHotbarSlot(it.slot)) return false
    if (isFood(it)) return false
    if (isShulkerName(it.name)) return false
    if (it.name === 'elytra') return false
    return !neededMaterialNames.has(it.name)
  })
}

async function evacuateUnneededMaterials(bot, storageRegistration, neededMaterialNames, options = {}) {
  if (!bot?.inventory?.items) return 0

  const unneededItems = getUnneededInventoryItems(bot, neededMaterialNames)

  if (unneededItems.length === 0) return 0

  const unneededNames = [...new Set(unneededItems.map((item) => item.name))]
  console.log(`[INVENTORY] Evacuating ${unneededItems.length} unneeded material stack(s) (${unneededNames.join(', ')}) back to storage chests...`)

  let evacuatedCount = 0
  for (const itemName of unneededNames) {
    const sourceInventorySlots = unneededItems.filter((item) => item.name === itemName).map((item) => item.slot)
    const chestPos = findBestChestForMaterial(storageRegistration, itemName)
    if (!chestPos) {
      console.log(`[INVENTORY-WARN] No registered chest for ${itemName}; cannot evacuate.`)
      continue
    }

    const chestBlock = bot.blockAt(chestPos)
    if (!chestBlock) continue

    let window = null
    try {
      await walkNear(bot, chestBlock.position, 2.0, 3000)
      const opened = await openStorageContainerWithRetry(bot, chestBlock, options)
      window = opened.container
      const playerInventoryStart = Number(bot.inventory?.inventoryStart ?? 9)
      for (const inventorySlot of sourceInventorySlots) {
        const windowSlot = inventorySlot + window.inventoryStart - playerInventoryStart
        const liveItem = window.slots[windowSlot]
        if (liveItem && liveItem.name === itemName) {
          const transferred = await depositWindowItemConfirmed(bot, window, windowSlot)
          if (transferred < 1) {
            throw new Error(`Inventory-to-chest transfer was not confirmed for ${itemName} in slot ${inventorySlot}.`)
          }
          evacuatedCount++
        }
      }
    } catch (error) {
      console.log(`[INVENTORY-WARN] Could not evacuate ${itemName} to chest ${chestPos.x},${chestPos.y},${chestPos.z}: ${error?.message || error}`)
    } finally {
      try { window?.close() } catch {}
      await delay(150)
    }
  }
  console.log(`[INVENTORY] Successfully evacuated ${evacuatedCount} stack(s) back to storage chests.`)
  return evacuatedCount
}

async function executeMaterialRestock(bot, config, restockPlan, storageRegistration, options = {}) {
  const neededItems = restockPlan?.neededItems || []
  const materialRestockNeeded = Boolean(restockPlan?.needsRestock && neededItems.length > 0)
  const cleanupNeeded = needsInventoryCleanup(bot)
  if (!materialRestockNeeded && !cleanupNeeded) {
    console.log('[RESTOCK] Inventory already has all required materials for upcoming blocks; skipping restock.')
    return { restocked: true, skipped: true }
  }

  if (materialRestockNeeded) {
    console.log(`[RESTOCK] Starting restock for ${neededItems.length} material(s): ${neededItems.map((item) => `${item.name} x${item.countNeeded}`).join(', ')}...`)
  } else {
    console.log('[RESTOCK] Returning inventory clutter and restoring one empty slot before printing...')
  }

  // 1. Fly to restock station / storage anchor if bot is not already on ground near anchor
  const anchor = storageRegistration?.anchor || config?.storageRegistration?.anchor || { x: -326, y: 97, z: -100 }
  const anchorVec = new Vec3(anchor.x, anchor.y, anchor.z)
  const currentDist = bot.entity?.position?.distanceTo(anchorVec) || Number.POSITIVE_INFINITY

  if (options.skipTravelToStation !== true && (currentDist > 8.0 || !bot.entity?.onGround)) {
    console.log(`[RESTOCK] Flying to restock station at ${anchor.x},${anchor.y},${anchor.z} using ElytraFly...`)
    await travelToAnchor(bot, anchor, {
      horizontalSpeed: Number(config?.elytraFly?.horizontalSpeed ?? 2),
      verticalSpeed: Number(config?.elytraFly?.verticalSpeed ?? 2)
    })
    await delay(500)
  }

  // 2. Evacuate unneeded materials from previous chunks to free inventory slots
  await depositEmptyShulkersToDump(bot, storageRegistration, options)
  await returnStrandedMaterialShulkers(bot, storageRegistration, options)
  const activeChunkMaterials = new Set(Object.keys(restockPlan.demands || {}))
  await evacuateUnneededMaterials(bot, storageRegistration, activeChunkMaterials, options)

  // 3. Organize dedicated hotbar slots (pickaxe in 0, food in 1, moving slot 2 cleared)
  await organizeDedicatedSlots(bot)

  // 4. Ensure essential gear (pickaxe, elytra, golden apples)
  await prepareEssentialGear(bot, storageRegistration, config, options)

  // 5. Retrieve each needed material from registered storage chests
  const itemsWithdrawn = []
  for (let itemIndex = 0; itemIndex < neededItems.length; itemIndex += 1) {
    const item = neededItems[itemIndex]
    const chestCandidates = findChestCandidatesForMaterial(storageRegistration, item.name)
    if (chestCandidates.length === 0) {
      throw new Error(`No registered storage chest found containing material "${item.name}"`)
    }

    while (getEmptyPlayerSlotCount(bot) < 2) {
      const before = getEmptyPlayerSlotCount(bot)
      await reserveEmptyPlayerSlot(bot, storageRegistration, { ...options, minimumEmptySlots: 2 })
      if (getEmptyPlayerSlotCount(bot) <= before) throw new Error('Restock could not reserve shulker handling space.')
    }

    const laterMaterialTypes = neededItems.length - itemIndex - 1
    const freeSlots = getEmptyPlayerSlotCount(bot)
    const maximumAdditionalStacks = Math.max(1, freeSlots - 1 - laterMaterialTypes)
    const capacityCount = maximumAdditionalStacks * 64
    const cappedCountNeeded = Math.min(Number(item.countNeeded), capacityCount)
    if (cappedCountNeeded < Number(item.countNeeded)) {
      console.log(`[RESTOCK] Capping ${item.name} refill to ${cappedCountNeeded}/${item.countNeeded} items to preserve shulker pickup, later materials, and one empty slot.`)
    }
    const startingCount = getInventoryItemCount(bot, item.name)
    const targetCount = startingCount + cappedCountNeeded
    let currentCount = startingCount
    let attempts = 0
    let consecutiveNoProgress = 0
    const maximumAttempts = Math.max(8, chestCandidates.length)

    while (currentCount < targetCount && attempts < maximumAttempts) {
      attempts += 1
      const chestPos = chestCandidates[0]
      const remainingCount = targetCount - currentCount
      console.log(`[RESTOCK] Withdrawing ${item.name} x${remainingCount} from chest at ${chestPos.x},${chestPos.y},${chestPos.z} (attempt ${attempts}/${maximumAttempts})...`)
      let unboxResult
      try {
        unboxResult = await unboxItemFromChest(bot, storageRegistration, chestPos, (name) => name === item.name, {
          targetCount: remainingCount,
          ...options
        })
      } catch (error) {
        if (!String(error?.message || error).includes('No matching shulker found')) throw error
        chestCandidates.shift()
        if (chestCandidates.length === 0) {
          throw new Error(`Registered storage chests no longer contain material "${item.name}"`)
        }
        const next = chestCandidates[0]
        console.log(`[RESTOCK-WARN] Chest ${chestPos.x},${chestPos.y},${chestPos.z} no longer contains ${item.name}; trying ${next.x},${next.y},${next.z}.`)
        continue
      }
      const nextCount = getInventoryItemCount(bot, item.name)
      const gained = Math.max(0, nextCount - currentCount)
      console.log(`[RESTOCK] ${item.name} transfer: reported=${unboxResult.itemsWithdrawn}, inventoryDelta=${gained}, inventory=${nextCount}/${targetCount}.`)
      if (gained <= 0) {
        consecutiveNoProgress += 1
        if (consecutiveNoProgress >= 3 || attempts >= 8) {
          throw new Error(`Restock made no inventory progress for ${item.name} after ${consecutiveNoProgress} consecutive shulkers at ${chestPos.x},${chestPos.y},${chestPos.z}.`)
        }
        console.log(`[RESTOCK-WARN] Shulker contained no transferable ${item.name}; trying the next candidate (${consecutiveNoProgress}/3).`)
        await delay(250)
        continue
      }
      consecutiveNoProgress = 0
      currentCount = nextCount
    }

    if (currentCount < targetCount) {
      throw new Error(`Restock stopped short for ${item.name}: inventory=${currentCount}, target=${targetCount}.`)
    }
    itemsWithdrawn.push({ name: item.name, count: currentCount - startingCount })
  }

  // 6. Deposit any empty shulkers into trapped dump chest
  const dumpedCount = await depositEmptyShulkersToDump(bot, storageRegistration, options)
  await reserveEmptyPlayerSlot(bot, storageRegistration, options)

  // 7. Return to clear center landing pad before flight takeoff
  const landingTarget = storageRegistration?.landingTarget || {}
  const centerPad = new Vec3(
    Number(landingTarget.x ?? anchor.x + 0.5),
    Number(landingTarget.y ?? anchor.y + 1),
    Number(landingTarget.z ?? anchor.z + 0.5)
  )
  await walkNear(bot, centerPad, 1.0, 3000)

  // 8. Finalize hotbar organization for printing (freeing slots 1 and 2 for materials)
  await organizePrintingHotbar(bot)
  await reserveEmptyPlayerSlot(bot, storageRegistration, options)
  const emptySlotCount = getEmptyPlayerSlotCount(bot)
  if (emptySlotCount < 1) throw new Error('Restock filled every player inventory slot; one slot must remain empty.')

  console.log(`[RESTOCK] Material restock completed successfully. Items: ${itemsWithdrawn.map((i) => `${i.name}x${i.count}`).join(', ')}; dumpedShulkers=${dumpedCount}; emptySlots=${emptySlotCount}.`)
  return { restocked: true, skipped: false, itemsWithdrawn, dumpedCount }
}

module.exports = {
  HOTBAR_SLOT_PICKAXE,
  HOTBAR_SLOT_FOOD,
  HOTBAR_SLOT_MOVING,
  HOTBAR_SLOT_BUFFER,
  WINDOW_SLOT_PICKAXE,
  WINDOW_SLOT_FOOD,
  WINDOW_SLOT_MOVING,
  WINDOW_SLOT_BUFFER,
  MATERIAL_SLOT_INDICES,
  TOTAL_MATERIAL_SLOTS,
  checkAndConsumeGoldenApple,
  createPrintingHotbarPlan,
  evacuateUnneededMaterials,
  executeMaterialRestock,
  findChestCandidatesForMaterial,
  findBestChestForMaterial,
  getMaterialInventoryCounts,
  getEmptyPlayerSlotCount,
  ensurePlayerInventoryWindow,
  getInventoryItemCount,
  getPrintingHotbarCoverage,
  getUnneededInventoryItems,
  needsInventoryCleanup,
  isAirBlock,
  isDedicatedHotbarSlot,
  isMaterialSlot,
  organizeDedicatedSlots,
  organizePrintingHotbar,
  prefetchPrintingHotbar,
  planUpcomingChunkMaterials
}
