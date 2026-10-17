'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const {
  HOTBAR_SLOT_PICKAXE,
  HOTBAR_SLOT_FOOD,
  HOTBAR_SLOT_MOVING,
  HOTBAR_SLOT_BUFFER,
  WINDOW_SLOT_PICKAXE,
  WINDOW_SLOT_FOOD,
  WINDOW_SLOT_MOVING,
  WINDOW_SLOT_BUFFER,
  TOTAL_MATERIAL_SLOTS,
  MATERIAL_SLOT_INDICES,
  createPrintingHotbarPlan,
  getMaterialInventoryCounts,
  getEmptyPlayerSlotCount,
  ensurePlayerInventoryWindow,
  getInventoryItemCount,
  getPrintingHotbarCoverage,
  getUnneededInventoryItems,
  needsInventoryCleanup,
  organizeDedicatedSlots,
  planUpcomingChunkMaterials,
  findChestCandidatesForMaterial,
  findBestChestForMaterial,
  executeMaterialRestock,
  organizePrintingHotbar,
  prefetchPrintingHotbar,
  checkAndConsumeGoldenApple
} = require('../src/inventory-manager')

test('slot constants expose hotbar slots 1 through 8 while reserving one empty slot, pickaxe, and food', () => {
  assert.equal(HOTBAR_SLOT_PICKAXE, 0)
  assert.equal(HOTBAR_SLOT_FOOD, 1)
  assert.equal(HOTBAR_SLOT_MOVING, 2)
  assert.equal(HOTBAR_SLOT_BUFFER, 8)
  assert.equal(WINDOW_SLOT_PICKAXE, 36)
  assert.equal(WINDOW_SLOT_FOOD, 37)
  assert.equal(WINDOW_SLOT_MOVING, 38)
  assert.equal(WINDOW_SLOT_BUFFER, 44)

  assert.equal(TOTAL_MATERIAL_SLOTS, 33)
  assert.equal(MATERIAL_SLOT_INDICES.length, 33)

  // Dedicated hotbar slots must never intersect material slot indices
  assert.equal(MATERIAL_SLOT_INDICES.includes(WINDOW_SLOT_PICKAXE), false)
  assert.equal(MATERIAL_SLOT_INDICES.includes(WINDOW_SLOT_FOOD), true)
  assert.equal(MATERIAL_SLOT_INDICES.includes(WINDOW_SLOT_MOVING), true)
  assert.equal(MATERIAL_SLOT_INDICES.includes(34), false)
  assert.equal(MATERIAL_SLOT_INDICES.includes(WINDOW_SLOT_BUFFER), true)
})

test('planUpcomingChunkMaterials sorts blocks bottom to top and plans up to 33 slots', () => {
  const chunkSlice = {
    key: '0,0',
    chunkX: 0,
    chunkZ: 0,
    blocks: [
      { x: 0, y: 75, z: 0, name: 'obsidian' },
      { x: 0, y: 65, z: 0, name: 'netherite_block' },
      { x: 0, y: 70, z: 0, name: 'obsidian' },
      { x: 0, y: 64, z: 0, name: 'netherite_block' }
    ]
  }

  const mockBot = {
    inventory: { slots: {} }
  }

  const plan = planUpcomingChunkMaterials(mockBot, chunkSlice)
  assert.equal(plan.needsRestock, true)
  assert.equal(plan.plannedBlockCount, 4)

  // Planned blocks must be strictly ordered from bottom to top (Y ascending)
  assert.equal(plan.plannedBlocks[0].y, 64)
  assert.equal(plan.plannedBlocks[1].y, 65)
  assert.equal(plan.plannedBlocks[2].y, 70)
  assert.equal(plan.plannedBlocks[3].y, 75)

  assert.equal(plan.demands.netherite_block, 2)
  assert.equal(plan.demands.obsidian, 2)
  assert.equal(plan.neededItems.length, 2)
})

test('planUpcomingChunkMaterials skips restock when inventory already has enough items', () => {
  const chunkSlice = {
    key: '0,0',
    blocks: [
      { x: 0, y: 64, z: 0, name: 'obsidian' },
      { x: 0, y: 65, z: 0, name: 'obsidian' }
    ]
  }

  const slots = {}
  // Put 64 obsidian in material slot 39
  slots[39] = { name: 'obsidian', count: 64, slot: 39 }
  // Put pickaxe and food in dedicated slots
  slots[WINDOW_SLOT_PICKAXE] = { name: 'netherite_pickaxe', count: 1, slot: WINDOW_SLOT_PICKAXE }
  slots[WINDOW_SLOT_FOOD] = { name: 'golden_apple', count: 64, slot: WINDOW_SLOT_FOOD }

  const mockBot = {
    inventory: { slots }
  }

  const plan = planUpcomingChunkMaterials(mockBot, chunkSlice)
  assert.equal(plan.needsRestock, false)
  assert.equal(plan.neededItems.length, 0)
  assert.equal(plan.shortages.obsidian, 0)
})

test('getInventoryItemCount verifies transfers across every player inventory slot', () => {
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'obsidian', count: 64, slot: 9 },
        { name: 'obsidian', count: 12, slot: 35 },
        { name: 'stone', count: 64, slot: 40 }
      ]
    }
  }

  assert.equal(getInventoryItemCount(mockBot, 'obsidian'), 76)
})

test('getEmptyPlayerSlotCount enforces one reserved player inventory slot', () => {
  const slots = Array(46).fill({ name: 'stone' })
  slots[34] = null
  assert.equal(getEmptyPlayerSlotCount({ inventory: { slots } }), 1)
})

test('ensurePlayerInventoryWindow closes a stale container before player inventory swaps', async () => {
  const staleWindow = { id: 7 }
  const bot = {
    currentWindow: staleWindow,
    closeWindow(window) {
      assert.equal(window, staleWindow)
      this.currentWindow = null
    }
  }

  assert.equal(await ensurePlayerInventoryWindow(bot), true)
  assert.equal(bot.currentWindow, null)
  assert.equal(await ensurePlayerInventoryWindow(bot), false)
})

test('needsInventoryCleanup catches carried shulkers and duplicate pickaxes', () => {
  const slots = Array(46).fill(null)
  slots[9] = { name: 'shulker_box', slot: 9 }
  slots[10] = { name: 'netherite_pickaxe', slot: 10 }
  slots[36] = { name: 'netherite_pickaxe', slot: 36 }
  const bot = { inventory: { slots, items: () => slots.filter(Boolean) } }

  assert.equal(needsInventoryCleanup(bot), true)
})

test('getUnneededInventoryItems keeps one pickaxe and one enchanted apple stack', () => {
  const items = [
    { name: 'netherite_pickaxe', slot: 10, count: 1 },
    { name: 'netherite_pickaxe', slot: 36, count: 1 },
    { name: 'enchanted_golden_apple', slot: 11, count: 64 },
    { name: 'enchanted_golden_apple', slot: 12, count: 64 },
    { name: 'obsidian', slot: 13, count: 64 }
  ]
  const bot = { inventory: { items: () => items } }

  assert.deepEqual(
    getUnneededInventoryItems(bot, new Set(['obsidian'])).map((item) => item.slot),
    [36, 12]
  )
})

test('planUpcomingChunkMaterials preserves checkpoint order when requested', () => {
  const blocks = [
    { x: 0, y: 65, z: 5, name: 'stone' },
    { x: 0, y: 65, z: 1, name: 'obsidian' }
  ]
  const plan = planUpcomingChunkMaterials({ inventory: { slots: {} } }, { blocks }, { preserveOrder: true })

  assert.deepEqual(plan.plannedBlocks, blocks)
})

test('organizeDedicatedSlots moves pickaxe to slot 36, keeps food out of hotbar, and clears slot 38', async () => {
  const slots = {}
  const windowClicks = []

  // Pickaxe sits in main inventory slot 15
  slots[15] = { name: 'netherite_pickaxe', count: 1, slot: 15 }
  // Golden apples sit in main inventory slot 20
  slots[20] = { name: 'golden_apple', count: 64, slot: 20 }
  // Random stone sits in moving slot 38
  slots[WINDOW_SLOT_MOVING] = { name: 'stone', count: 64, slot: WINDOW_SLOT_MOVING }

  const mockBot = {
    inventory: {
      slots,
      items: () => Object.values(slots)
    },
    clickWindow: async (sourceSlot, hotbarIndex, mode) => {
      windowClicks.push({ sourceSlot, hotbarIndex, mode })
      // Simulate swap
      const targetSlot = 36 + hotbarIndex
      const temp = slots[targetSlot]
      slots[targetSlot] = slots[sourceSlot]
      slots[sourceSlot] = temp
    }
  }

  const result = await organizeDedicatedSlots(mockBot)
  assert.equal(result.organized, true)

  // Pickaxe must now be in slot 36 (hotbar 0)
  assert.equal(slots[WINDOW_SLOT_PICKAXE]?.name, 'netherite_pickaxe')
  // Food remains in main inventory until health is below 12.
  assert.equal(slots[WINDOW_SLOT_FOOD]?.name, 'stone')
  assert.equal(slots[20]?.name, 'golden_apple')

  // Moving slot 38 must be clear
  assert.equal(slots[WINDOW_SLOT_MOVING], undefined)

  // Mode 2 hotbar swaps must have been used
  assert.ok(windowClicks.some((c) => c.sourceSlot === 15 && c.hotbarIndex === HOTBAR_SLOT_PICKAXE && c.mode === 2))
})

test('getMaterialInventoryCounts includes freed hotbar material slots and excludes gear and food', () => {
  const slots = {
    35: { name: 'enchanted_golden_apple', count: 64, slot: 35 },
    36: { name: 'netherite_pickaxe', count: 1, slot: 36 },
    37: { name: 'obsidian', count: 64, slot: 37 },
    38: { name: 'netherite_block', count: 64, slot: 38 }
  }

  assert.deepEqual(getMaterialInventoryCounts({ inventory: { slots } }), {
    obsidian: 64,
    netherite_block: 64
  })
})

test('findBestChestForMaterial chooses chest with the highest quantity of material', () => {
  const storageRegistration = {
    materialIndex: {
      obsidian: [
        { containerId: '-325,98,-103', position: { x: -325, y: 98, z: -103 }, count: 64 },
        { containerId: '-322,98,-104', position: { x: -322, y: 98, z: -104 }, count: 1728 },
        { containerId: '-324,98,-103', position: { x: -324, y: 98, z: -103 }, count: 320 }
      ]
    }
  }

  const bestPos = findBestChestForMaterial(storageRegistration, 'obsidian')
  assert.ok(bestPos)
  assert.equal(bestPos.x, -322)
  assert.equal(bestPos.y, 98)
  assert.equal(bestPos.z, -104)
})

test('findChestCandidatesForMaterial aggregates duplicate shulker entries per chest', () => {
  const storageRegistration = {
    materialIndex: {
      crying_obsidian: [
        { position: { x: -323, y: 98, z: -104 }, count: 64 },
        { position: { x: -323, y: 98, z: -104 }, count: 64 },
        { position: { x: -320, y: 98, z: -104 }, count: 120 }
      ]
    }
  }

  assert.deepEqual(findChestCandidatesForMaterial(storageRegistration, 'crying_obsidian'), [
    new Vec3(-323, 98, -104),
    new Vec3(-320, 98, -104)
  ])
})

test('executeMaterialRestock skips when no restock is needed', async () => {
  const mockBot = {}
  const restockPlan = { needsRestock: false, neededItems: [] }
  const result = await executeMaterialRestock(mockBot, {}, restockPlan, {})
  assert.equal(result.restocked, true)
  assert.equal(result.skipped, true)
})

test('organizePrintingHotbar keeps hotbar slots 1 and 2 free for materials and moves apples to main', async () => {
  const slots = {}
  // Golden apples sit in hotbar slot 1 (37)
  slots[WINDOW_SLOT_FOOD] = { name: 'golden_apple', count: 64, slot: WINDOW_SLOT_FOOD }
  // Pickaxe sits in slot 36
  slots[WINDOW_SLOT_PICKAXE] = { name: 'netherite_pickaxe', count: 1, slot: WINDOW_SLOT_PICKAXE }

  const mockBot = {
    inventory: {
      slots,
      items: () => Object.values(slots)
    },
    clickWindow: async (sourceSlot, hotbarIndex, mode) => {
      const targetSlot = 36 + hotbarIndex
      const temp = slots[targetSlot]
      slots[targetSlot] = slots[sourceSlot]
      slots[sourceSlot] = temp
    }
  }

  await organizePrintingHotbar(mockBot)
  // Hotbar slot 1 (37) must be freed
  assert.equal(slots[WINDOW_SLOT_FOOD], undefined)
  // Pickaxe stays in slot 36
  assert.equal(slots[WINDOW_SLOT_PICKAXE]?.name, 'netherite_pickaxe')
})

test('organizePrintingHotbar keeps hotbar slot 44 available for building materials', async () => {
  const slots = Array(46).fill(null)
  for (let slot = 9; slot <= 34; slot += 1) slots[slot] = { name: 'obsidian', count: 64, slot }
  slots[WINDOW_SLOT_PICKAXE] = { name: 'netherite_pickaxe', count: 1, slot: WINDOW_SLOT_PICKAXE }
  slots[WINDOW_SLOT_MOVING] = { name: 'shulker_box', count: 1, slot: WINDOW_SLOT_MOVING }
  let clicked = false
  const mockBot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async () => { clicked = true }
  }

  await organizePrintingHotbar(mockBot)

  assert.equal(clicked, false)
  assert.equal(slots[WINDOW_SLOT_BUFFER], null)
  assert.equal(slots[WINDOW_SLOT_MOVING]?.name, 'shulker_box')
})

test('createPrintingHotbarPlan stages route-ordered stacks before their demand', () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'stone', count: 2, slot: 37 }
  slots[10] = { name: 'stone', count: 64, slot: 10 }
  slots[11] = { name: 'dirt', count: 64, slot: 11 }
  slots[12] = { name: 'glass', count: 64, slot: 12 }
  const blocks = [
    { name: 'stone' },
    { name: 'stone' },
    { name: 'stone' },
    { name: 'dirt' },
    { name: 'glass' }
  ]

  const plan = createPrintingHotbarPlan({ inventory: { slots } }, blocks)

  assert.deepEqual(plan.desiredMaterials, ['stone', 'stone', 'dirt', 'glass'])
  assert.deepEqual(plan.assignments, [
    { material: 'stone', retained: true, slot: 37, sourceSlot: 37 },
    { material: 'stone', retained: false, slot: 38, sourceSlot: 10 },
    { material: 'dirt', retained: false, slot: 39, sourceSlot: 11 },
    { material: 'glass', retained: false, slot: 40, sourceSlot: 12 }
  ])
})

test('getPrintingHotbarCoverage predicts the first route block not resident in hotbar', () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'stone', count: 2, slot: 37 }
  slots[38] = { name: 'dirt', count: 1, slot: 38 }
  const blocks = ['stone', 'dirt', 'stone', 'glass', 'stone']

  const coverage = getPrintingHotbarCoverage({ inventory: { slots } }, blocks)

  assert.equal(coverage.coveredBlocks, 3)
  assert.equal(coverage.nextMissingIndex, 3)
  assert.equal(coverage.nextMissingMaterial, 'glass')
})

test('getPrintingHotbarCoverage reserves stacks consumed by pending placement packets', () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'stone', count: 2, slot: 37 }

  const coverage = getPrintingHotbarCoverage({ inventory: { slots } }, ['stone', 'stone'], {
    reservedMaterials: new Map([['stone', 1]])
  })

  assert.equal(coverage.coveredBlocks, 1)
  assert.equal(coverage.nextMissingIndex, 1)
})

test('createPrintingHotbarPlan stages a replacement for hotbar items reserved by pending packets', () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'stone', count: 2, slot: 37 }
  slots[10] = { name: 'stone', count: 64, slot: 10 }

  const plan = createPrintingHotbarPlan({ inventory: { slots } }, ['stone', 'stone'], {
    reservedMaterials: new Map([['stone', 2]])
  })

  assert.deepEqual(plan.assignments, [
    { material: 'stone', retained: false, slot: 37, sourceSlot: 10 }
  ])
})

test('prefetchPrintingHotbar preserves residents and uses slot 44 as a material slot', async () => {
  const slots = Array(46).fill(null)
  slots[34] = null
  slots[36] = { name: 'netherite_pickaxe', count: 1, slot: 36 }
  slots[37] = { name: 'stone', count: 2, slot: 37 }
  slots[38] = { name: 'cobblestone', count: 64, slot: 38 }
  slots[44] = { name: 'quartz_block', count: 64, slot: 44 }
  slots[10] = { name: 'stone', count: 64, slot: 10 }
  slots[11] = { name: 'dirt', count: 64, slot: 11 }
  slots[12] = { name: 'glass', count: 64, slot: 12 }
  const clicks = []
  const mockBot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async (sourceSlot, hotbarIndex, mode) => {
      clicks.push([sourceSlot, hotbarIndex, mode])
      const targetSlot = 36 + hotbarIndex
      const source = slots[sourceSlot]
      const target = slots[targetSlot]
      slots[sourceSlot] = target
      slots[targetSlot] = source
      if (slots[sourceSlot]) slots[sourceSlot].slot = sourceSlot
      if (slots[targetSlot]) slots[targetSlot].slot = targetSlot
    }
  }
  const blocks = ['stone', 'stone', 'stone', 'dirt', 'glass']

  const result = await prefetchPrintingHotbar(mockBot, blocks)

  assert.equal(result.swaps, 3)
  assert.equal(slots[37]?.name, 'stone')
  assert.equal(slots[38]?.name, 'stone')
  assert.equal(slots[39]?.name, 'dirt')
  assert.equal(slots[40]?.name, 'glass')
  assert.equal(slots[44]?.name, 'quartz_block')
  assert.equal(slots[34], null)
  assert.deepEqual(clicks[0], [10, 2, 2])
})

test('prefetchPrintingHotbar waits for a server-confirmed delayed swap', async () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'cobblestone', count: 64, slot: 37 }
  slots[10] = { name: 'stone', count: 64, slot: 10 }
  const mockBot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async (sourceSlot, hotbarIndex) => {
      const targetSlot = 36 + hotbarIndex
      setTimeout(() => {
        const source = slots[sourceSlot]
        const target = slots[targetSlot]
        slots[sourceSlot] = target
        slots[targetSlot] = source
        if (slots[sourceSlot]) slots[sourceSlot].slot = sourceSlot
        if (slots[targetSlot]) slots[targetSlot].slot = targetSlot
      }, 50)
    }
  }
  const startedAt = Date.now()

  const result = await prefetchPrintingHotbar(mockBot, ['stone'])

  assert.equal(result.swaps, 1)
  assert.equal(slots[37]?.count, 64)
  assert.ok(Date.now() - startedAt >= 40)
})

test('prefetchPrintingHotbar limits runtime work to one confirmed swap', async () => {
  const slots = Array(46).fill(null)
  slots[10] = { name: 'stone', count: 64, slot: 10 }
  slots[11] = { name: 'dirt', count: 64, slot: 11 }
  const clicks = []
  const mockBot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async (sourceSlot, hotbarIndex) => {
      clicks.push([sourceSlot, hotbarIndex])
      const targetSlot = 36 + hotbarIndex
      const source = slots[sourceSlot]
      slots[sourceSlot] = slots[targetSlot]
      slots[targetSlot] = source
      if (slots[sourceSlot]) slots[sourceSlot].slot = sourceSlot
      if (slots[targetSlot]) slots[targetSlot].slot = targetSlot
    }
  }

  const result = await prefetchPrintingHotbar(mockBot, ['stone', 'dirt'], { maxSwaps: 1 })

  assert.equal(result.swaps, 1)
  assert.deepEqual(clicks, [[10, 1]])
  assert.equal(slots[37]?.name, 'stone')
  assert.equal(slots[38], null)
})

test('prefetchPrintingHotbar does not swap an already-correct target stack', async () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'stone', count: 1, slot: 37 }
  slots[38] = { name: 'stone', count: 64, slot: 38 }
  slots[10] = { name: 'stone', count: 64, slot: 10 }
  let clicks = 0
  const mockBot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async () => { clicks += 1 }
  }

  const result = await prefetchPrintingHotbar(mockBot, ['stone', 'stone'])

  assert.equal(result.swaps, 0)
  assert.equal(clicks, 0)
})

test('prefetchPrintingHotbar trusts the inventory array index instead of stale item slot metadata', async () => {
  const slots = Array(46).fill(null)
  slots[10] = { name: 'obsidian', count: 64, slot: 42 }
  const clicks = []
  const bot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async (sourceSlot, hotbarIndex) => {
      clicks.push([sourceSlot, hotbarIndex])
      const targetSlot = 36 + hotbarIndex
      const source = slots[sourceSlot]
      slots[sourceSlot] = slots[targetSlot]
      slots[targetSlot] = source
    }
  }

  const result = await prefetchPrintingHotbar(bot, ['obsidian'])

  assert.equal(result.swaps, 1)
  assert.deepEqual(clicks, [[10, 1]])
  assert.equal(slots[37]?.name, 'obsidian')
})

test('prefetchPrintingHotbar stages a legacy material stack from source-only slot 34', async () => {
  const slots = Array(46).fill(null)
  slots[34] = { name: 'obsidian', count: 64, slot: 34 }
  const clicks = []
  const bot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async (sourceSlot, hotbarIndex) => {
      clicks.push([sourceSlot, hotbarIndex])
      const targetSlot = 36 + hotbarIndex
      const source = slots[sourceSlot]
      slots[sourceSlot] = slots[targetSlot]
      slots[targetSlot] = source
    }
  }

  const result = await prefetchPrintingHotbar(bot, ['obsidian'])

  assert.equal(result.swaps, 1)
  assert.deepEqual(clicks, [[34, 1]])
  assert.equal(slots[37]?.name, 'obsidian')
  assert.equal(slots[34], null)
})

test('prefetchPrintingHotbar defers an unconfirmed optimization swap instead of stopping printing', async () => {
  const slots = Array(46).fill(null)
  slots[10] = { name: 'obsidian', count: 64, slot: 10 }
  const warnings = []
  const bot = {
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async () => { throw new Error('simulated inventory acknowledgement failure') }
  }

  const result = await prefetchPrintingHotbar(bot, ['obsidian'], {
    logger: { warn: (message) => warnings.push(message) }
  })

  assert.equal(result.swaps, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Printing will wait and retry the confirmed hotbar swap/)
})

test('checkAndConsumeGoldenApple eats only when health < 12 and restores hotbar', async () => {
  const slots = {}
  // Golden apples in slot 15
  slots[15] = { name: 'golden_apple', count: 64, slot: 15 }

  let consumed = false
  const mockBot = {
    health: 10, // low health!
    inventory: {
      slots,
      items: () => Object.values(slots)
    },
    clickWindow: async (sourceSlot, hotbarIndex, mode) => {
      const targetSlot = 36 + hotbarIndex
      const temp = slots[targetSlot]
      slots[targetSlot] = slots[sourceSlot]
      slots[sourceSlot] = temp
    },
    equip: async (item, dest) => {},
    consume: async () => {
      consumed = true
      mockBot.health = 20
    }
  }

  // When health < 12, eats
  const ate = await checkAndConsumeGoldenApple(mockBot)
  assert.equal(ate, true)
  assert.equal(consumed, true)
  assert.equal(slots[15]?.name, 'golden_apple')
  assert.equal(slots[WINDOW_SLOT_FOOD], undefined)

  // When health >= 12, does not eat
  mockBot.health = 18
  const ateAgain = await checkAndConsumeGoldenApple(mockBot)
  assert.equal(ateAgain, false)
})

test('checkAndConsumeGoldenApple restores food without requiring an empty main slot', async () => {
  const slots = Array(46).fill(null)
  for (let slot = 9; slot <= 35; slot += 1) slots[slot] = { name: 'obsidian', count: 64, slot }
  slots[15] = { name: 'enchanted_golden_apple', count: 64, slot: 15 }
  slots[WINDOW_SLOT_FOOD] = { name: 'crying_obsidian', count: 64, slot: WINDOW_SLOT_FOOD }
  const bot = {
    health: 10,
    username: 'ComicBot',
    players: { ComicBot: { ping: 0 } },
    inventory: { slots, items: () => slots.filter(Boolean) },
    clickWindow: async (sourceSlot, hotbarIndex) => {
      const targetSlot = 36 + hotbarIndex
      const source = slots[sourceSlot]
      slots[sourceSlot] = slots[targetSlot]
      slots[targetSlot] = source
    },
    equip: async () => {},
    consume: async () => { bot.health = 20 }
  }

  assert.equal(await checkAndConsumeGoldenApple(bot), true)
  assert.equal(slots[15]?.name, 'enchanted_golden_apple')
  assert.equal(slots[WINDOW_SLOT_FOOD]?.name, 'crying_obsidian')
})
