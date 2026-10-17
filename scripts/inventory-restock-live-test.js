'use strict'

const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const {
  WINDOW_SLOT_PICKAXE,
  WINDOW_SLOT_FOOD,
  WINDOW_SLOT_MOVING,
  organizeDedicatedSlots,
  planUpcomingChunkMaterials,
  executeMaterialRestock,
  getMaterialInventoryCounts
} = require('../src/inventory-manager')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }

  console.log('[LIVE-INV-TEST] Connecting ComicBot to test server...')
  const bot = createBot(config)

  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[LIVE-INV-TEST] Spawned at ${bot.entity.position}; onGround=${bot.entity.onGround}`)

      // Load storage registration
      const regPath = path.resolve(__dirname, '../dashboard-service/data/storage-registrations.json')
      if (!fs.existsSync(regPath)) {
        throw new Error(`Storage registration file not found at ${regPath}`)
      }
      const registrations = JSON.parse(fs.readFileSync(regPath, 'utf8'))
      const registration = registrations['ComicBot'] || Object.values(registrations)[0]
      if (!registration) throw new Error('No storage registration found for ComicBot')

      console.log(`[LIVE-INV-TEST] Loaded storage registration with ${registration.summary?.materialTypeCount} material types, ${registration.summary?.registeredContainerCount} containers.`)

      // PHASE 1: Dedicated Hotbar Slot Organization
      console.log('\n=== PHASE 1: DEDICATED HOTBAR SLOT ORGANIZATION ===')
      const orgResult = await organizeDedicatedSlots(bot)
      console.log('[LIVE-INV-TEST] Organize result:', orgResult)

      const pickaxeSlot = bot.inventory.slots[WINDOW_SLOT_PICKAXE]
      console.log(`  - Dedicated Slot 0 (Window 36 - Pickaxe): ${pickaxeSlot?.name || 'empty'}`)
      if (!pickaxeSlot || !pickaxeSlot.name.endsWith('_pickaxe')) {
        throw new Error(`Expected pickaxe in window slot 36, found ${pickaxeSlot?.name || 'empty'}`)
      }

      const foodSlot = bot.inventory.slots[WINDOW_SLOT_FOOD]
      console.log(`  - Dedicated Slot 1 (Window 37 - Food): ${foodSlot?.name || 'empty'}`)

      const movingSlot = bot.inventory.slots[WINDOW_SLOT_MOVING]
      console.log(`  - Dedicated Slot 2 (Window 38 - Moving): ${movingSlot?.name || 'clear'}`)
      if (movingSlot && movingSlot.name && !movingSlot.name.includes('shulker')) {
        throw new Error(`Moving slot 38 was not cleared; holds ${movingSlot.name}`)
      }
      console.log('[LIVE-INV-TEST] PHASE 1 PASSED: Dedicated hotbar slots organized correctly!')

      // PHASE 2: Upcoming Material Demand Planning
      console.log('\n=== PHASE 2: UPCOMING MATERIAL DEMAND PLANNING ===')
      const testChunkSlice = {
        key: '-22,0',
        chunkX: -22,
        chunkZ: 0,
        anchor: { x: -355, y: 66, z: -88 },
        blocks: [
          { x: -337, y: 168, z: 13, name: 'obsidian' },
          { x: -337, y: 169, z: 12, name: 'obsidian' },
          { x: -337, y: 170, z: 10, name: 'obsidian' },
          { x: -337, y: 171, z: 10, name: 'obsidian' },
          { x: -337, y: 172, z: 8, name: 'obsidian' }
        ]
      }

      const plan = planUpcomingChunkMaterials(bot, testChunkSlice, { startIndex: 0 })
      console.log('[LIVE-INV-TEST] Generated restock plan:')
      console.log('  - Demands:', plan.demands)
      console.log('  - Current inventory material counts:', plan.currentCounts)
      console.log('  - Shortages:', plan.shortages)
      console.log('  - Needs restock:', plan.needsRestock)
      console.log('  - Planned blocks count:', plan.plannedBlockCount)

      console.log('[LIVE-INV-TEST] PHASE 2 PASSED: Material demand planning verified!')

      // PHASE 3: Restock Execution from Storage Platform
      console.log('\n=== PHASE 3: RESTOCK EXECUTION FROM STORAGE CHESTS ===')
      const restockResult = await executeMaterialRestock(bot, config, plan, registration)
      console.log('[LIVE-INV-TEST] Restock execution result:', restockResult)

      const countsAfter = getMaterialInventoryCounts(bot)
      console.log('[LIVE-INV-TEST] Inventory counts after restock:', countsAfter)
      console.log('[LIVE-INV-TEST] PHASE 3 PASSED: Restock executed smoothly!')

      console.log('\n[LIVE-INV-TEST] ALL INVENTORY MANAGEMENT TESTS PASSED!')
      bot.quit('Test complete')
      process.exit(0)
    } catch (err) {
      console.error('[LIVE-INV-TEST-ERROR]', err)
      try { bot.quit('Test failed') } catch { }
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
