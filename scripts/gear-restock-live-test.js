'use strict'

const { Vec3 } = require('vec3')
const { loadConfig, getCliValue } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { registerStorage, DEFAULT_ANCHOR, openStorageContainerWithRetry } = require('../src/storage-registration')
const {
  hasPickaxe,
  hasElytraEquipped,
  getGoldenAppleCount
} = require('../src/gear-restock')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  console.log(`[LIVE-TEST] Connecting ComicBot to ${config.bot.host}:${config.bot.port}...`)

  const bot = createBot(config)
  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[LIVE-TEST] ComicBot spawned at ${bot.entity.position}`)

      // TEST PHASE 1: Clear pickaxe from inventory to verify full unbox-break-catch-return sequence
      console.log('=== TEST PHASE 1: UNBOX PICKAXE WHEN NOT IN INVENTORY ===')
      const pickaxeInInv = (bot.inventory.items() || []).find((i) => i.name.endsWith('_pickaxe'))
      if (pickaxeInInv) {
        console.log(`[LIVE-TEST] Temporarily stashing inventory pickaxe (${pickaxeInInv.name}) in chest to test unboxing...`)
        const testChestBlock = bot.blockAt(new Vec3(-323, 100, -103))
        const testOpened = await openStorageContainerWithRetry(bot, testChestBlock)
        const testWin = testOpened.container
        for (let s = testWin.inventoryStart; s < testWin.inventoryEnd; s++) {
          const item = testWin.slots[s]
          if (item && item.name.endsWith('_pickaxe')) {
            await bot.clickWindow(s, 0, 1)
            await delay(150)
            break
          }
        }
        testWin.close()
        await delay(300)
      }

      console.log('[LIVE-TEST] Inventory before registration:', bot.inventory.items().map((i) => i.name))
      console.log(`[LIVE-TEST] Has pickaxe before registration: ${hasPickaxe(bot)} (must be false)`)

      console.log('[LIVE-TEST] Executing registerStorage with essential gear preparation...')
      const t0 = Date.now()
      const reg1 = await registerStorage(bot, config, { anchor: DEFAULT_ANCHOR })
      const duration1 = Date.now() - t0
      console.log(`[LIVE-TEST] registerStorage finished in ${duration1}ms.`)

      console.log(`[LIVE-TEST] Summary: materials=${reg1.summary.materialContainerCount}, dumps=${reg1.summary.dumpContainerCount}, ender=${reg1.summary.enderChestCount}`)
      console.log('[LIVE-TEST] GearRestock result:', JSON.stringify(reg1.gearRestock, null, 2))

      const hasPickaxeAfter1 = hasPickaxe(bot)
      const hasElytraAfter1 = hasElytraEquipped(bot)
      const gappleCountAfter1 = getGoldenAppleCount(bot)

      console.log(`[LIVE-TEST] Has pickaxe after phase 1: ${hasPickaxeAfter1}`)
      console.log(`[LIVE-TEST] Has elytra equipped after phase 1: ${hasElytraAfter1}`)
      console.log(`[LIVE-TEST] Golden apples count after phase 1: ${gappleCountAfter1}/64`)

      if (!hasPickaxeAfter1) throw new Error('Phase 1 failed: Bot did not acquire pickaxe!')
      if (!hasElytraAfter1) throw new Error('Phase 1 failed: Bot does not have elytra equipped!')
      if (gappleCountAfter1 < 64) throw new Error(`Phase 1 failed: Expected at least 64 golden apples, found ${gappleCountAfter1}`)

      // TEST PHASE 2: Bot already has pickaxe, elytra, and golden apples.
      // Must IGNORE getting pickaxe shulker!
      console.log('=== TEST PHASE 2: IGNORE PICKAXE SHULKER WHEN ALREADY IN INVENTORY ===')
      const t1 = Date.now()
      const reg2 = await registerStorage(bot, config, { anchor: DEFAULT_ANCHOR })
      const duration2 = Date.now() - t1
      console.log(`[LIVE-TEST] Second registration finished in ${duration2}ms.`)
      console.log('[LIVE-TEST] Second GearRestock result:', JSON.stringify(reg2.gearRestock, null, 2))

      if (reg2.gearRestock?.pickaxe?.status !== 'already-present') {
        throw new Error(`Phase 2 failed: Expected pickaxe status 'already-present', got: ${reg2.gearRestock?.pickaxe?.status}`)
      }
      console.log('[LIVE-TEST] Confirmed: Pickaxe shulker retrieval was correctly ignored because bot already had pickaxe!')

      console.log('=== ALL LIVE TESTS PASSED CLEANLY! ===')
      bot.quit('Live test passed')
      process.exit(0)
    } catch (error) {
      console.error('[LIVE-TEST-FAILED]', error)
      try { bot.quit('Live test failed') } catch { }
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})


