'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const {
  installDigTimeFix,
  hasPickaxe,
  getBestPickaxe,
  hasElytraEquipped,
  hasElytraInInventory,
  getElytraRemainingDurability,
  isElytraLowDurability,
  getGoldenAppleCount,
  getRequiredShulkerExtractionSlots,
  countMatchingWindowContainerItems,
  countMatchingWindowPlayerItems,
  depositWindowItemConfirmed,
  withdrawWindowItem,
  withdrawWindowItemConfirmed,
  waitForEmptyPlayerSlotIncrease,
  findTransferredShulker,
  findDedicatedStagingPlacement,
  findStagingPlacement,
  isWithinBlockInteractionReach,
  isWithinShulkerStagingReach,
  isShulkerStagingCellOccupied,
  acquireShulkerRestockLock,
  getShulkerRestockParkingPosition,
  catchDroppedShulker,
  findWalkwayStandY,
  findShulkerReturnDestination,
  findInventoryShulkerWindowSlot,
  findMatchingInventoryShulker,
  isShulkerReturnConfirmed,
  getShulkerReturnCandidates,
  returnInventoryShulkerToStorage,
  findPlayerStackStashPlan,
  ensurePickaxe
} = require('../src/gear-restock')

test('shulker staging accepts a path-blocked position still inside interaction reach', () => {
  const bot = { entity: { position: new Vec3(-323.3, 98.5, -101.35), eyeHeight: 1.62 } }
  const staging = { targetPos: new Vec3(-321, 99, -102) }
  assert.equal(isWithinShulkerStagingReach(bot, staging), true)
  bot.entity.position.x = -326
  assert.equal(isWithinShulkerStagingReach(bot, staging), false)
})

test('block interaction reach uses the block center instead of its corner', () => {
  const bot = { entity: { position: new Vec3(-325.5, 98, -99.3), eyeHeight: 1.62 } }
  assert.equal(isWithinBlockInteractionReach(bot, new Vec3(-326, 98, -104)), true)
})

test('shulker staging rejects a cell occupied by another bot', () => {
  const target = new Vec3(-320, 99, -102)
  const bot = {
    entity: { id: 1, position: new Vec3(-318, 98, -101.5) },
    entities: {
      1: { id: 1, position: new Vec3(-318, 98, -101.5) },
      2: { id: 2, name: 'player', position: new Vec3(-319.5, 98, -101.5), width: 0.6, height: 1.8 }
    }
  }
  assert.equal(isShulkerStagingCellOccupied(bot, target), true)
  bot.entities[2].position = new Vec3(-316.5, 98, -101.5)
  assert.equal(isShulkerStagingCellOccupied(bot, target), false)
})

test('shared shulker staging lock serializes separate bots', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'printer-shulker-lock-test-'))
  const lockPath = path.join(directory, 'lock')
  const options = { shulkerRestockLockPath: lockPath, shulkerRestockLockTimeoutMs: 2000 }
  const releaseFirst = await acquireShulkerRestockLock({ username: 'ComicBot', config: { bot: {} } }, options)
  let secondAcquired = false
  const second = acquireShulkerRestockLock({ username: 'ComicBot01', config: { bot: {} } }, options).then((release) => {
    secondAcquired = true
    return release
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(secondAcquired, false)
  releaseFirst()
  const releaseSecond = await second
  assert.equal(secondAcquired, true)
  releaseSecond()
  fs.rmdirSync(directory)
})

test('fleet bots receive separate shulker staging parking positions', () => {
  const registration = { anchor: { x: -326, y: 97, z: -100 } }
  const main = getShulkerRestockParkingPosition({ username: 'ComicBot' }, registration)
  const fifth = getShulkerRestockParkingPosition({ username: 'ComicBot05' }, registration)

  assert.deepEqual(main, new Vec3(-329.5, 98, -99.5))
  assert.deepEqual(fifth, new Vec3(-349.5, 98, -99.5))
})

test('fleet bots receive separate floor-backed shulker staging lanes', () => {
  const registration = { anchor: { x: -326, y: 97, z: -100 } }
  const createBot = (username) => ({
    username,
    entity: { id: username, position: new Vec3(-326, 98, -100) },
    entities: {},
    blockAt(position) {
      return {
        name: position.y === 97 ? 'stone' : 'air',
        boundingBox: position.y === 97 ? 'block' : 'empty',
        position
      }
    }
  })

  const main = findDedicatedStagingPlacement(createBot('ComicBot'), registration)
  const second = findDedicatedStagingPlacement(createBot('ComicBot02'), registration)
  assert.deepEqual(main.targetPos, new Vec3(-330, 98, -102))
  assert.deepEqual(second.targetPos, new Vec3(-338, 98, -102))
  assert.deepEqual(main.faceVector, new Vec3(0, 1, 0))
})

test('dropped shulker pickup reuses an unchanged pathfinder goal', async () => {
  let shulkerCount = 0
  const goals = []
  const bot = {
    entity: { id: 1, position: new Vec3(-321.5, 98, -101.5) },
    entities: { 2: { id: 2, name: 'item', position: new Vec3(-323.5, 98, -101.5) } },
    inventory: {
      items: () => shulkerCount ? [{ name: 'red_shulker_box', count: 1 }] : []
    },
    pathfinder: { setGoal: (goal) => goals.push(goal) },
    setControlState: () => {}
  }
  setTimeout(() => { shulkerCount = 1 }, 240)

  assert.equal(await catchDroppedShulker(bot, new Vec3(-323, 100, -102), 0, 1000), true)
  assert.equal(goals.filter(Boolean).length, 1)
})

test('findTransferredShulker reads the open container player slots', () => {
  const slots = new Array(90).fill(null)
  slots[54] = { name: 'netherite_shulker_box', count: 1, slot: 54 }
  const window = { inventoryStart: 54, inventoryEnd: 90, slots }

  assert.equal(
    findTransferredShulker({}, window, (name) => name === 'elytra', 1, 54),
    slots[54]
  )
})

test('findPlayerStackStashPlan maps a player inventory slot into an open chest window', () => {
  const slots = new Array(90).fill(null)
  slots[79] = { name: 'crying_obsidian', count: 64 }
  const bot = { inventory: { inventoryStart: 9 } }
  const window = { inventoryStart: 54, inventoryEnd: 90, slots }

  assert.deepEqual(findPlayerStackStashPlan(bot, window, {
    name: 'crying_obsidian',
    count: 64,
    slot: 34
  }), {
    sourceSlot: 79,
    destinationSlot: 0
  })
})

test('countMatchingWindowPlayerItems measures transferred inventory, not mutable chest items', () => {
  const slots = new Array(90).fill(null)
  slots[0] = { name: 'obsidian', count: 52 }
  slots[54] = { name: 'obsidian', count: 64 }
  slots[55] = { name: 'obsidian', count: 6 }
  const window = { inventoryStart: 54, inventoryEnd: 90, slots }

  assert.equal(countMatchingWindowContainerItems(window, (name) => name === 'obsidian'), 52)
  assert.equal(countMatchingWindowPlayerItems(window, (name) => name === 'obsidian'), 70)
})

test('withdrawWindowItem requests only the remaining partial stack', async () => {
  const calls = []
  const window = {
    withdraw: async (...args) => calls.push(args)
  }
  const item = { name: 'crying_obsidian', type: 49, metadata: 0, count: 64, nbt: null }

  assert.equal(await withdrawWindowItem({}, window, 4, item, 6), 6)
  assert.deepEqual(calls, [[49, 0, 6, null]])
})

test('withdrawWindowItemConfirmed reports authoritative player inventory delta', async () => {
  const slots = new Array(90).fill(null)
  const item = { name: 'crying_obsidian', type: 49, metadata: 0, count: 64, nbt: null }
  slots[0] = item
  const window = {
    id: 1,
    inventoryStart: 54,
    inventoryEnd: 90,
    slots,
    withdraw: async () => {
      slots[0] = { ...item, count: 58 }
      slots[54] = { ...item, count: 6 }
    }
  }
  const bot = new EventEmitter()
  let syncCount = 0
  bot._syncWindow = async () => {
    syncCount += 1
    if (syncCount !== 1) return
    slots[0] = item
    slots[54] = null
    setTimeout(() => {
      slots[0] = { ...item, count: 58 }
      slots[54] = { ...item, count: 6 }
      bot.emit('setWindowItems:1')
    }, 20)
  }

  assert.equal(await withdrawWindowItemConfirmed(bot, window, 0, item, 6, (name) => name === 'crying_obsidian'), 6)
})

test('depositWindowItemConfirmed survives a stale first full-window snapshot', async () => {
  const slots = new Array(90).fill(null)
  const item = { name: 'netherite_axe', type: 910, metadata: 0, count: 1, nbt: null }
  slots[54] = item
  const window = { id: 2, inventoryStart: 54, inventoryEnd: 90, slots }
  const bot = new EventEmitter()
  bot.clickWindow = async () => {
    slots[54] = null
    slots[0] = item
  }
  let syncCount = 0
  bot._syncWindow = async () => {
    syncCount += 1
    if (syncCount !== 1) return
    slots[54] = item
    slots[0] = null
    setTimeout(() => {
      slots[54] = null
      slots[0] = item
      bot.emit('setWindowItems:2')
    }, 20)
  }

  assert.equal(await depositWindowItemConfirmed(bot, window, 54), 1)
})

test('getRequiredShulkerExtractionSlots reuses partial stacks before reserving inventory slots', () => {
  const matcher = (name) => name === 'crying_obsidian'
  const withPartialStack = {
    inventory: { items: () => [{ name: 'crying_obsidian', count: 27, stackSize: 64 }] }
  }
  const withoutMaterial = { inventory: { items: () => [] } }

  assert.equal(getRequiredShulkerExtractionSlots(withPartialStack, matcher, 37), 1)
  assert.equal(getRequiredShulkerExtractionSlots(withoutMaterial, matcher, 64), 2)
})

test('waitForEmptyPlayerSlotIncrease waits for delayed inventory synchronization', async () => {
  const slots = Array(45).fill({ name: 'obsidian' })
  const bot = { inventory: { slots } }
  setTimeout(() => { slots[34] = null }, 25)

  assert.equal(await waitForEmptyPlayerSlotIncrease(bot, 0, 200), 1)
})

test('findShulkerReturnDestination reuses a loose-item slot when a material chest is full', () => {
  const slots = [
    { name: 'red_shulker_box' },
    { name: 'crying_obsidian' },
    { name: 'blue_shulker_box' }
  ]

  assert.deepEqual(findShulkerReturnDestination({ inventoryStart: 3, slots }), {
    slot: 1,
    swapsLooseItem: true
  })
})

test('findInventoryShulkerWindowSlot returns the shulker selected by contents', () => {
  const slots = new Array(90).fill(null)
  slots[54] = { name: 'shulker_box', marker: 'elytra' }
  slots[55] = { name: 'shulker_box', marker: 'obsidian' }
  const window = { inventoryStart: 54, inventoryEnd: 90, slots }

  assert.equal(findInventoryShulkerWindowSlot({}, window, (item) => item.marker === 'obsidian'), 55)
})

test('findMatchingInventoryShulker confirms the selected shulker before chest return', () => {
  const obsidian = { name: 'shulker_box', marker: 'obsidian' }
  const bot = { inventory: { items: () => [{ name: 'stone' }, obsidian] } }
  assert.equal(findMatchingInventoryShulker(bot, (item) => item.marker === 'obsidian'), obsidian)
  assert.equal(findMatchingInventoryShulker(bot, (item) => item.marker === 'elytra'), null)
})

test('returnInventoryShulkerToStorage refuses to open chests without a confirmed matching shulker', async () => {
  let blockReads = 0
  const bot = {
    inventory: { items: () => [] },
    blockAt() {
      blockReads += 1
      return { position: new Vec3(1, 2, 3) }
    }
  }
  await assert.rejects(
    returnInventoryShulkerToStorage(bot, { containers: [] }, { position: new Vec3(1, 2, 3) }),
    /refusing chest return/
  )
  assert.equal(blockReads, 0)
})

test('isShulkerReturnConfirmed requires authoritative destination and source changes', () => {
  const window = { slots: [] }
  window.slots[2] = { name: 'shulker_box' }
  window.slots[54] = { name: 'ender_chest' }
  assert.equal(isShulkerReturnConfirmed(window, 54, 2), true)

  window.slots[54] = { name: 'shulker_box' }
  window.slots[2] = { name: 'ender_chest' }
  assert.equal(isShulkerReturnConfirmed(window, 54, 2), false)

  window.slots[54] = null
  window.slots[2] = { name: 'ender_chest' }
  window.selectedItem = null
  assert.equal(isShulkerReturnConfirmed(window, 54, 2), false)
})

test('getShulkerReturnCandidates falls back to a registered material chest with space', () => {
  const candidates = getShulkerReturnCandidates({
    containers: [
      { purpose: 'materials', full: true, position: { x: 1, y: 2, z: 3 } },
      { purpose: 'materials', full: false, position: { x: 4, y: 5, z: 6 } },
      { purpose: 'dump', full: false, position: { x: 7, y: 8, z: 9 } }
    ]
  }, { x: 1, y: 2, z: 3 })

  assert.deepEqual(candidates, [new Vec3(1, 2, 3), new Vec3(4, 5, 6)])
})

test('hasPickaxe accurately detects pickaxes in player inventory', () => {
  const botEmpty = { inventory: { items: () => [] } }
  assert.equal(hasPickaxe(botEmpty), false)

  const botWithSword = { inventory: { items: () => [{ name: 'diamond_sword', count: 1 }] } }
  assert.equal(hasPickaxe(botWithSword), false)

  const botWithNetherite = { inventory: { items: () => [{ name: 'netherite_pickaxe', count: 1 }] } }
  assert.equal(hasPickaxe(botWithNetherite), true)

  const botWithMultiple = {
    inventory: {
      items: () => [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'netherite_pickaxe', count: 1 }
      ]
    }
  }
  assert.equal(hasPickaxe(botWithMultiple), true)
  assert.equal(getBestPickaxe(botWithMultiple).name, 'netherite_pickaxe')
})

test('hasElytraEquipped inspects torso equipment slot 6', () => {
  const botNoArmor = { inventory: { slots: {} } }
  assert.equal(hasElytraEquipped(botNoArmor), false)

  const botChestplate = { inventory: { slots: { 6: { name: 'netherite_chestplate' } } } }
  assert.equal(hasElytraEquipped(botChestplate), false)

  const botElytra = { inventory: { slots: { 6: { name: 'elytra' } } } }
  assert.equal(hasElytraEquipped(botElytra), true)
})

test('Elytra durability replacement threshold is strictly below 10 remaining', () => {
  const bot = { inventory: { slots: {} }, registry: { itemsByName: { elytra: { maxDurability: 432 } } } }
  const tenRemaining = { name: 'elytra', durabilityUsed: 422, maxDurability: 432 }
  const nineRemaining = { name: 'elytra', durabilityUsed: 423, maxDurability: 432 }

  assert.equal(getElytraRemainingDurability(bot, tenRemaining), 10)
  assert.equal(isElytraLowDurability(bot, tenRemaining), false)
  assert.equal(getElytraRemainingDurability(bot, nineRemaining), 9)
  assert.equal(isElytraLowDurability(bot, nineRemaining), true)
})

test('getGoldenAppleCount sums both normal and enchanted golden apples', () => {
  const bot = {
    inventory: {
      items: () => [
        { name: 'golden_apple', count: 12 },
        { name: 'enchanted_golden_apple', count: 32 },
        { name: 'bread', count: 64 }
      ]
    }
  }
  assert.equal(getGoldenAppleCount(bot), 44)
})

test('installDigTimeFix normalizes modern component enchantments into an array', () => {
  const mockBlock = {
    name: 'shulker_box',
    digTime: (heldType, creative, inWater, notOnGround, enchantments) => {
      assert(Array.isArray(enchantments), 'enchantments must be an array for prismarine-block')
      return 150
    }
  }

  const bot = {
    registry: {
      enchantments: {
        8: { name: 'efficiency' },
        34: { name: 'unbreaking' }
      }
    },
    heldItem: {
      type: 900,
      enchants: {
        enchantments: [
          { id: 8, level: 5 },
          { id: 34, level: 3 }
        ]
      }
    },
    inventory: { slots: {} },
    game: { gameMode: 'survival' },
    entity: { onGround: true, eyeHeight: 1.62, position: new Vec3(0, 0, 0), effects: {} },
    _getBlockAtEyeLevel: () => null,
    getEquipmentDestSlot: () => 5,
    digTime: function (block) {
      return block.digTime(this.heldItem.type, false, false, false, this.heldItem.enchants, {})
    }
  }

  installDigTimeFix(bot)
  const time = bot.digTime(mockBlock)
  assert.equal(time, 150)
  assert(Array.isArray(bot.heldItem.enchants))
  assert.equal(bot.heldItem.enchants[0].name, 'efficiency')
  assert.equal(bot.heldItem.enchants[0].lvl, 5)
})

test('findStagingPlacement selects overhead air block adjacent to solid chest/block', () => {
  const blocks = new Map()
  function setB(x, y, z, name, boundingBox = 'block') {
    blocks.set(`${x},${y},${z}`, { name, boundingBox, position: new Vec3(x, y, z) })
  }

  // Chest at -323, 100, -103
  setB(-323, 100, -103, 'chest')
  setB(-323, 99, -103, 'chest')
  setB(-323, 99, -102, 'air', 'empty')
  // Air above head at -323, 100, -102 and -323, 101, -102
  setB(-323, 100, -102, 'air', 'empty')
  setB(-323, 101, -102, 'air', 'empty')

  const bot = {
    entity: { position: new Vec3(-323.5, 98.0, -101.5) },
    blockAt: (p) => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: 'air', boundingBox: 'empty', position: p }
  }

  const chestBlock = { position: new Vec3(-323, 100, -103) }
  const staging = findStagingPlacement(bot, chestBlock)
  assert(staging, 'staging spot must be found')
  assert.equal(staging.targetPos.y, 100)
  assert.equal(staging.referenceBlock.name, 'chest')
  assert.equal(staging.faceVector.z, 1)
})

test('findStagingPlacement uses chest walkway height when bot is standing on a chest', () => {
  const blocks = new Map()
  const setBlock = (x, y, z, name, boundingBox = 'block') => {
    blocks.set(`${x},${y},${z}`, { name, boundingBox, position: new Vec3(x, y, z) })
  }
  setBlock(-323, 100, -103, 'chest')
  setBlock(-323, 100, -102, 'air', 'empty')
  setBlock(-323, 101, -102, 'air', 'empty')
  const bot = {
    entity: { position: new Vec3(-321.4, 99.875, -103.5) },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position }
  }

  const staging = findStagingPlacement(bot, { position: new Vec3(-321, 98, -104) })
  assert(staging)
  assert.equal(staging.standPos.y, 98)
  assert.equal(staging.targetPos.y, 100)
})

test('findWalkwayStandY finds the platform floor below an upper chest row', () => {
  const blocks = new Map()
  blocks.set('-320,97,-102', { name: 'orange_concrete', boundingBox: 'block', position: new Vec3(-320, 97, -102) })
  const bot = {
    entity: { position: new Vec3(-320.5, 99.875, -103.5) },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position }
  }

  assert.equal(findWalkwayStandY(bot, -320, 99, -102), 98)
})

test('findStagingPlacement uses a non-colliding adjacent stand for a lower fallback', () => {
  const blocks = new Map()
  function setB(x, y, z, name, boundingBox = 'block') {
    blocks.set(`${x},${y},${z}`, { name, boundingBox, position: new Vec3(x, y, z) })
  }
  setB(-323, 99, -103, 'chest')
  setB(-323, 99, -102, 'air', 'empty')
  setB(-323, 100, -102, 'air', 'empty')
  for (const x of [-325, -324, -322, -321, -320]) setB(x, 97, -102, 'stone')

  const bot = {
    entity: { position: new Vec3(-323.5, 98, -101.5) },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position }
  }
  const staging = findStagingPlacement(bot, { position: new Vec3(-323, 98, -104) })
  assert(staging)
  assert.equal(staging.targetPos.y, 99)
  assert.notEqual(Math.floor(staging.standPos.x), staging.targetPos.x)
})

test('findStagingPlacement uses the chest face for an outer storage row', () => {
  const blocks = new Map()
  const setBlock = (x, y, z, name, boundingBox = 'block') => {
    blocks.set(`${x},${y},${z}`, { name, boundingBox, position: new Vec3(x, y, z) })
  }
  setBlock(-321, 98, -104, 'chest')
  setBlock(-321, 98, -103, 'air', 'empty')
  setBlock(-321, 99, -103, 'air', 'empty')
  for (let x = -324; x <= -318; x++) {
    for (let z = -106; z <= -100; z++) setBlock(x, 97, z, 'stone')
  }

  const bot = {
    entity: { position: new Vec3(-321.5, 98, -101.5) },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position }
  }
  const staging = findStagingPlacement(bot, blocks.get('-321,98,-104'))

  assert(staging)
  assert.deepEqual(staging.targetPos, new Vec3(-321, 98, -103))
  assert.deepEqual(staging.faceVector, new Vec3(0, 0, 1))
})

test('findStagingPlacement falls back to an open floor cell for a blocked upper chest', () => {
  const chestPosition = new Vec3(-323, 100, -104)
  const bot = {
    entity: { position: new Vec3(-323.5, 98, -101.5) },
    blockAt(position) {
      const x = Math.floor(position.x)
      const y = Math.floor(position.y)
      const z = Math.floor(position.z)
      if (x === chestPosition.x && y === chestPosition.y && z === chestPosition.z) {
        return { name: 'chest', boundingBox: 'block', position: chestPosition }
      }
      if (y === 97) return { name: 'stone', boundingBox: 'block', position: new Vec3(x, y, z) }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(x, y, z) }
    }
  }

  const staging = findStagingPlacement(bot, { position: chestPosition })
  assert(staging)
  assert.equal(staging.targetPos.y, 98)
  assert.deepEqual(staging.faceVector, new Vec3(0, 1, 0))
})

test('ensurePickaxe throws clear error when no pickaxe is in storage chests', async () => {
  const bot = {
    inventory: { items: () => [] }
  }
  const registration = {
    anchor: { x: -326, y: 97, z: -100 },
    materialIndex: {
      obsidian: [{ count: 64 }]
    },
    errors: [],
    warnings: []
  }

  await assert.rejects(
    async () => ensurePickaxe(bot, registration),
    /First priority pickaxe is not available in storage chests/
  )
  assert.equal(registration.errors.length, 1)
  assert.equal(registration.warnings.length, 1)
  assert.equal(registration.errors[0].blockName, 'storage_pickaxe')
})
