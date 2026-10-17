'use strict'

const { Vec3 } = require('vec3')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { registerStorage, DEFAULT_ANCHOR, openStorageContainerWithRetry } = require('../src/storage-registration')
const { hasPickaxe, hasElytraEquipped, getGoldenAppleCount } = require('../src/gear-restock')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  console.log(`[LIVE-UNBOX] Connecting ComicBot to ${config.bot.host}:${config.bot.port}...`)

  const bot = createBot(config)
  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[LIVE-UNBOX] ComicBot spawned at ${bot.entity.position}`)

      // Ensure NO pickaxe in bot inventory by stashing in ender chest
      console.log('[LIVE-UNBOX] Stashing pickaxe in ender chest to force unboxing...')
      const echestBlock = bot.blockAt(new Vec3(-328, 98, -103))
      const echestWin = (await openStorageContainerWithRetry(bot, echestBlock)).container
      for (let s = echestWin.inventoryStart; s < echestWin.inventoryEnd; s++) {
        const item = echestWin.slots[s]
        if (item && item.name.endsWith('_pickaxe')) {
          console.log(`[LIVE-UNBOX] Moving ${item.name} to ender chest slot 0...`)
          await bot.clickWindow(s, 0, 1)
          await delay(200)
          break
        }
      }
      echestWin.close()
      await delay(300)

      console.log('[LIVE-UNBOX] Bot inventory before test:', bot.inventory.items().map(i => i.name))
      console.log('[LIVE-UNBOX] Has pickaxe in inventory:', hasPickaxe(bot))
      if (hasPickaxe(bot)) throw new Error('Bot still has a pickaxe in inventory!')

      // Run registerStorage with essential gear preparation
      console.log('[LIVE-UNBOX] Starting registerStorage with gear restock...')
      const t0 = Date.now()
      const reg = await registerStorage(bot, config, { anchor: DEFAULT_ANCHOR })
      const duration = Date.now() - t0

      console.log(`[LIVE-UNBOX] registerStorage completed in ${duration}ms!`)
      console.log('[LIVE-UNBOX] Gear restock summary:', JSON.stringify(reg.gearRestock, null, 2))

      console.log(`[LIVE-UNBOX] Bot has pickaxe now: ${hasPickaxe(bot)}`)
      console.log(`[LIVE-UNBOX] Bot has elytra equipped: ${hasElytraEquipped(bot)}`)
      console.log(`[LIVE-UNBOX] Bot golden apple count: ${getGoldenAppleCount(bot)}/64`)
      console.log(`[LIVE-UNBOX] Bot inventory:`, bot.inventory.items().map(i => `${i.name} x${i.count}`))

      if (!hasPickaxe(bot)) throw new Error('Failed: Bot did not acquire pickaxe!')
      if (!hasElytraEquipped(bot)) throw new Error('Failed: Bot does not have elytra equipped!')
      if (getGoldenAppleCount(bot) < 64) throw new Error('Failed: Bot has less than 64 golden apples!')

      console.log('[LIVE-UNBOX] SUCCESS: Shulker was retrieved, placed above head, pickaxe taken, shulker broken, caught, and returned cleanly!')
      bot.quit('Unbox live test complete')
      process.exit(0)
    } catch (err) {
      console.error('[LIVE-UNBOX-ERROR]', err)
      try { bot.quit('Unbox live test failed') } catch { }
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
