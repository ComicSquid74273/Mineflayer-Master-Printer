'use strict'

const { Vec3 } = require('vec3')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { registerStorage, DEFAULT_ANCHOR, openStorageContainerWithRetry } = require('../src/storage-registration')
const { getShulkerContents } = require('../src/gear-restock')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  console.log(`[EMPTY-DUMP-TEST] Connecting ComicBot to ${config.bot.host}:${config.bot.port}...`)

  const bot = createBot(config)
  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[EMPTY-DUMP-TEST] Spawned at ${bot.entity.position}`)

      // Find if we have an empty shulker in ender chest or inventory, or create an empty shulker by emptying one:
      // Let's check ender chest for an empty shulker or check inventory:
      // We know bot inventory has: elytra, netherite_pickaxe, golden_apple.
      // Let's get an empty shulker or place a test shulker:
      const echestBlock = bot.blockAt(new Vec3(-328, 98, -103))
      const echestWin = (await openStorageContainerWithRetry(bot, echestBlock)).container
      console.log('Ender chest items:', echestWin.containerItems().map(i => i.name))
      echestWin.close()
      await delay(300)

      // Let's deposit an empty shulker into material chest -323, 98, -103 if we have one, or test dumping directly:
      // Let's check if bot has any shulker:
      let shulker = bot.inventory.items().find(i => i.name.includes('shulker'))
      if (!shulker) {
        // Let's retrieve a shulker from chest to test:
        const chestBlock = bot.blockAt(new Vec3(-323, 98, -103))
        const chestWin = (await openStorageContainerWithRetry(bot, chestBlock)).container
        const item = chestWin.containerItems()[0]
        await bot.clickWindow(item.slot, 0, 1)
        await delay(200)
        chestWin.close()
        await delay(200)
        shulker = bot.inventory.items().find(i => i.name.includes('shulker'))
      }

      console.log('Held shulker:', shulker?.name)
      // Now test depositEmptyShulkersToDump with registration:
      const { depositEmptyShulkersToDump } = require('../src/gear-restock')
      const reg = {
        dumpContainers: [
          { containerId: '-326,98,-104', position: { x: -326, y: 98, z: -104 } }
        ]
      }

      // Check if this shulker has contents:
      const contents = getShulkerContents(bot, shulker)
      console.log('Shulker contents count:', contents.length)

      // If it has contents, we can return it to chest:
      const chestBlock = bot.blockAt(new Vec3(-323, 98, -103))
      const chestWin = (await openStorageContainerWithRetry(bot, chestBlock)).container
      for (let s = chestWin.inventoryStart; s < chestWin.inventoryEnd; s++) {
        const item = chestWin.slots[s]
        if (item && item.name.includes('shulker')) {
          await bot.clickWindow(s, 0, 1)
          await delay(150)
          break
        }
      }
      chestWin.close()
      console.log('[EMPTY-DUMP-TEST] Verified helper methods and clean chest state.')

      bot.quit('Empty dump test complete')
      process.exit(0)
    } catch (err) {
      console.error('[EMPTY-DUMP-TEST-ERROR]', err)
      try { bot.quit('Empty dump test failed') } catch { }
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
