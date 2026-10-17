'use strict'

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const {
  loadPrintProgress,
  savePrintProgress,
  autoRecoverActiveJob,
  storeLocalChunkJson,
  deleteLocalChunkJson,
  PROGRESS_FILE
} = require('../src/job-manager')
const {
  enableAntiFallHover,
  placeBlockAirOrSupport
} = require('../src/printer')
const { travelToAnchor } = require('../src/elytra-flight')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  const anchor = { x: -355, y: 66, z: -88 }

  console.log('[LIVE-PRINT-TEST] Starting print and auto-recovery live test...')

  // Step 1: Define test chunk slice with 3 blocks to print at anchor (-355, 66, -88)
  const testChunk = {
    structureName: 'cityfountain.schem',
    chunkX: -23,
    chunkZ: -6,
    key: '-23,-6',
    anchor,
    blockCount: 3,
    materials: { netherite_block: 1, ender_chest: 1, beacon: 1 },
    blocks: [
      { x: -355, y: 67, z: -88, name: 'netherite_block', state: 'minecraft:netherite_block' },
      { x: -355, y: 68, z: -88, name: 'ender_chest', state: 'minecraft:ender_chest' },
      { x: -354, y: 67, z: -88, name: 'beacon', state: 'minecraft:beacon' } // air placement
    ]
  }

  // Store chunk JSON locally on disk
  const localJsonPath = storeLocalChunkJson(testChunk)
  testChunk.localJsonPath = localJsonPath

  // Initialize progress file
  savePrintProgress({ username: config.bot.username }, {
    activeChunk: testChunk,
    status: 'downloaded',
    localJsonPath
  })

  // Connect bot to test server
  console.log(`[LIVE-PRINT-TEST] Connecting ${config.bot.username} to ${config.bot.host}:${config.bot.port}...`)
  let bot = createBot(config)

  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[LIVE-PRINT-TEST] ${bot.username} spawned at ${bot.entity.position}`)

      // Verify inventory has needed items
      console.log('[LIVE-PRINT-TEST] Checking inventory blocks:');
      for (const it of bot.inventory.items()) {
        console.log(`  - ${it.name} x${it.count}`);
      }

      const distToPrint = bot.entity.position.distanceTo(new Vec3(-355, 68, -88));
      if (distToPrint > 5.0) {
        console.log('[LIVE-PRINT-TEST] Flying to print location with elytra flight...');
        await travelToAnchor(bot, { x: -355, y: 68, z: -88 }, { horizontalSpeed: 2, verticalSpeed: 2, hoverInAir: true });
        console.log(`[LIVE-PRINT-TEST] Arrived at print location! Current pos=${bot.entity.position}`);
      } else {
        console.log(`[LIVE-PRINT-TEST] Already hovering at print location (${distToPrint.toFixed(2)} blocks away).`);
      }

      // Hover in air
      enableAntiFallHover(bot)
      await delay(500)
      console.log(`[LIVE-PRINT-TEST] Hovering at ${bot.entity.position}; onGround=${bot.entity.onGround}`)

      // TEST PHASE 1: Print block 0 and block 1
      console.log('\n=== PHASE 1: PRINTING INITIAL BLOCKS ===')
      const b0 = testChunk.blocks[0]
      await placeBlockAirOrSupport(bot, b0);
      const prog1 = (require('../src/job-manager')).updateChunkPlacementProgress(bot, 0, b0);
      console.log(`[LIVE-PRINT-TEST] Placed block 0 (${b0.name}). Progress: ${prog1.activeChunk.placedBlocks}/${prog1.activeChunk.totalBlocks}`)
      await delay(400)

      const b1 = testChunk.blocks[1]
      await placeBlockAirOrSupport(bot, b1);
      const prog2 = (require('../src/job-manager')).updateChunkPlacementProgress(bot, 1, b1);
      console.log(`[LIVE-PRINT-TEST] Placed block 1 (${b1.name}). Progress: ${prog2.activeChunk.placedBlocks}/${prog2.activeChunk.totalBlocks}`)
      await delay(400)

      console.log('[LIVE-PRINT-TEST] Progress file before simulated crash:')
      console.log(JSON.stringify(loadPrintProgress().activeChunk, null, 2))

      // TEST PHASE 2: SIMULATE CRASH IN MID-AIR!
      console.log('\n=== PHASE 2: SIMULATE CRASH & RECONNECT IN MID-AIR ===')
      console.log('[LIVE-PRINT-TEST] Simulating sudden crash/disconnect while hovering in air...')
      bot.quit('Simulated crash')
      await delay(1500)

      // Reconnect bot
      console.log('[LIVE-PRINT-TEST] Reconnecting bot to server...')
      const restartedBot = createBot(config)

      restartedBot.once('spawn', async () => {
        try {
          await delay(1200)
          console.log(`[LIVE-PRINT-TEST] Reconnected at ${restartedBot.entity.position}; onGround=${restartedBot.entity.onGround}`)

          // VERIFY ANTI-FALL HOVER IN AIR:
          console.log('[LIVE-PRINT-TEST] Verifying anti-fall elytra flight activation in air...')
          await delay(1500)
          console.log(`[LIVE-PRINT-TEST] Flight status: onGround=${restartedBot.entity.onGround}, position=${restartedBot.entity.position}`)
          if (restartedBot.entity.onGround && restartedBot.entity.position.y < 65) {
            throw new Error('Bot fell to the ground after reconnect!')
          }
          console.log('[LIVE-PRINT-TEST] SUCCESS: Bot remained hovering in air upon reconnect!')

          // TEST AUTO-RECOVERY:
          console.log('\n=== PHASE 3: VERIFY AUTO-RECOVERY RESUMES FROM PROGRESS ===')
          const recovery = await autoRecoverActiveJob(restartedBot, config)
          console.log('[LIVE-PRINT-TEST] Auto-recovery result:', recovery.recovered)
          if (!recovery.recovered) throw new Error('Auto-recovery failed to find active chunk!')

          const active = recovery.progress.activeChunk
          console.log(`[LIVE-PRINT-TEST] Recovered active chunk: ${active.key}`)
          console.log(`[LIVE-PRINT-TEST] Progress restored: ${active.placedBlocks}/${active.totalBlocks} placed, ${active.remainingBlocks} remaining`)
          console.log(`[LIVE-PRINT-TEST] Next block to continue: index ${active.nextBlockIndex} (${active.nextBlock?.name} at ${active.nextBlock?.x},${active.nextBlock?.y},${active.nextBlock?.z})`)

          if (active.placedBlocks !== 2) throw new Error(`Expected 2 placed blocks recovered, got ${active.placedBlocks}`)
          if (active.remainingBlocks !== 1) throw new Error(`Expected 1 remaining block, got ${active.remainingBlocks}`)
          if (active.nextBlockIndex !== 2) throw new Error(`Expected nextBlockIndex 2, got ${active.nextBlockIndex}`)

          // Print remaining block (block 2 - testing air placement!)
          console.log('\n=== PHASE 4: PRINTING REMAINING AIR BLOCK ===')
          const b2 = testChunk.blocks[2]
          console.log(`[LIVE-PRINT-TEST] Placing remaining block in air at ${b2.x},${b2.y},${b2.z}...`)
          await placeBlockAirOrSupport(restartedBot, b2);
          (require('../src/job-manager')).updateChunkPlacementProgress(restartedBot, 2, b2);
          await delay(400)

          // Complete chunk
          console.log('[LIVE-PRINT-TEST] Completing chunk job...')
          await (require('../src/job-manager')).completeChunkJob(restartedBot, config, '-23,-6', { localJsonPath })

          // Verify local JSON file was deleted
          console.log('[LIVE-PRINT-TEST] Verifying local chunk JSON deletion upon completion...')
          const jsonExists = fs.existsSync(localJsonPath)
          console.log(`[LIVE-PRINT-TEST] Local JSON exists on disk: ${jsonExists} (must be false)`)
          if (jsonExists) throw new Error('Local chunk JSON was not deleted upon chunk completion!')

          const finalProgress = loadPrintProgress()
          console.log('[LIVE-PRINT-TEST] Final progress file status:', finalProgress?.status, 'completedChunks:', finalProgress?.completedChunks?.length)
          if (finalProgress?.status !== 'completed') throw new Error(`Expected status completed, got ${finalProgress?.status}`)

          // Clean up placed blocks with pickaxe
          console.log('\n=== CLEANUP: REMOVING TEST BLOCKS ===')
          const pickaxe = restartedBot.inventory.items().find(i => i.name.endsWith('_pickaxe'))
          if (pickaxe) await restartedBot.equip(pickaxe, 'hand')
          for (const b of testChunk.blocks) {
            const blockObj = restartedBot.blockAt(new Vec3(b.x, b.y, b.z))
            if (blockObj && blockObj.name !== 'air') {
              console.log(`[CLEANUP] Digging test block at ${b.x},${b.y},${b.z}...`)
              try { await restartedBot.dig(blockObj) } catch { }
            }
          }

          // Return to platform anchor
          console.log('[LIVE-PRINT-TEST] Returning to storage platform anchor -326, 97, -100...');
          await travelToAnchor(restartedBot, { x: -326, y: 97, z: -100 }, { horizontalSpeed: 2, verticalSpeed: 2 });
          console.log('[LIVE-PRINT-TEST] Safely back on platform at:', restartedBot.entity.position);

          console.log('\n[LIVE-PRINT-TEST] ALL TESTS PASSED SUCCESSFULLY!')
          restartedBot.quit('Live test complete')
          process.exit(0)
        } catch (err) {
          console.error('[LIVE-PRINT-TEST-ERROR]', err)
          try { restartedBot.quit('Test failed') } catch { }
          process.exit(1)
        }
      })
    } catch (err) {
      console.error('[LIVE-PRINT-TEST-ERROR]', err)
      try { bot.quit('Test failed') } catch { }
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})



