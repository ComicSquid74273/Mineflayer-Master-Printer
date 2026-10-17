'use strict'

const { getCliValue, loadConfig, toNumber } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { equipElytra, formatPosition } = require('../src/elytra-flight')
const { registerStorage, DEFAULT_ANCHOR } = require('../src/storage-registration')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseAnchor(value) {
  if (!value) return DEFAULT_ANCHOR
  const parts = String(value).split(',').map((p) => Number(p.trim()))
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return { x: Math.floor(parts[0]), y: Math.floor(parts[1]), z: Math.floor(parts[2]) }
  }
  return DEFAULT_ANCHOR
}

async function main() {
  const config = loadConfig()
  const anchor = parseAnchor(getCliValue('--anchor'))
  const rawScanRadius = getCliValue('--scan-radius')
  const scanRadius = rawScanRadius ? Math.max(4, Math.min(64, toNumber(rawScanRadius, 32))) : 32
  const horizontalSpeed = toNumber(getCliValue('--horizontal-speed'), config.elytraFly.horizontalSpeed)
  config.elytraFly.horizontalSpeed = horizontalSpeed
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }

  console.log(`[STORAGE-LIVE] Starting live storage test for ${config.bot.username} on ${config.bot.host}:${config.bot.port}...`)
  console.log(`[STORAGE-LIVE] Target anchor: ${anchor.x}, ${anchor.y}, ${anchor.z}; scanRadius=${scanRadius}; Meteor horizontal-speed=${horizontalSpeed}`)

  const bot = createBot(config)
  let completed = false

  const finish = (exitCode) => {
    if (completed) return
    completed = true
    process.exitCode = exitCode
    try { bot.quit('Storage live test complete') } catch { }
    setTimeout(() => process.exit(exitCode), 1000)
  }

  bot.once('spawn', async () => {
    try {
      if (typeof bot.waitForChunksToLoad === 'function') await bot.waitForChunksToLoad()
      await delay(1500)
      console.log(`[STORAGE-LIVE] ${bot.username} spawned at ${formatPosition(bot.entity?.position)}; health=${bot.health}; food=${bot.food}`)
      await equipElytra(bot)

      const registration = await registerStorage(bot, config, {
        anchor,
        scanRadius
      })

      console.log('\n=== LIVE STORAGE REGISTRATION REPORT ===')
      console.log(`Bot: ${registration.botName}`)
      console.log(`Anchor: ${registration.anchor.x}, ${registration.anchor.y}, ${registration.anchor.z}`)
      if (registration.platformBounds) {
        console.log(`Platform Bounds: X[${registration.platformBounds.minX}..${registration.platformBounds.maxX}] Y[${registration.platformBounds.minY}..${registration.platformBounds.maxY}] Z[${registration.platformBounds.minZ}..${registration.platformBounds.maxZ}]`)
      }
      console.log(`Landed at: ${formatPosition(registration.landingTarget)}`)
      console.log(`Duration: ${(registration.durationMs / 1000).toFixed(1)}s; wokeFromSleep=${registration.wokeFromSleep}`)
      console.log(`Bed Registered: ${registration.summary.bedRegistered ? `${registration.bed?.blockName} at ${registration.bed?.position?.x},${registration.bed?.position?.y},${registration.bed?.position?.z} (clicked=${registration.bed?.clicked})` : 'none/ignored'}`)
      console.log(`Ender Chests: ${registration.summary.discoveredEnderChestCount} found; ${registration.summary.enderChestCount} registered`)
      if (registration.enderChest) {
        console.log(`Ender Registry: ${registration.enderChest.position.x},${registration.enderChest.position.y},${registration.enderChest.position.z} slots=${registration.enderChest.usedSlots}/${registration.enderChest.capacitySlots}`)
      }
      console.log(`Total Containers Registered: ${registration.summary.registeredContainerCount}`)
      console.log(`Material Chests: ${registration.summary.materialContainerCount}`)
      console.log(`Dump Chests (Trapped): ${registration.summary.dumpContainerCount}`)
      console.log(`Nested Shulkers Found: ${registration.summary.shulkerCount}`)
      console.log(`Distinct Material Types: ${registration.summary.materialTypeCount}`)
      console.log(`Ignored Empty Chests: ${registration.summary.ignoredEmptyContainerCount}`)
      if (registration.gearRestock) {
        console.log(`Gear Restock: pickaxe=${registration.gearRestock.pickaxe?.pickaxe || registration.gearRestock.pickaxe?.status || 'none'}, elytra=${registration.gearRestock.elytra?.status}, goldenApples=${registration.gearRestock.goldenApples?.count ?? 0}/64, emptyShulkersDumped=${registration.gearRestock.emptyShulkersDumped ?? 0}`)
      }

      if (registration.dumpContainers.length) {
        console.log('\n--- DUMP CHEST ORDER (TRAPPED CHESTS) ---')
        for (const dump of registration.dumpContainers) {
          console.log(`  Priority #${dump.order}: [${dump.containerId}] capacity=${dump.capacitySlots} free=${dump.freeSlots} full=${dump.full}`)
        }
      }

      if (registration.containers.length) {
        console.log('\n--- REGISTERED STORAGE INVENTORY ---')
        for (const container of registration.containers) {
          console.log(`  [${container.containerId}] (${container.blockName}, ${container.purpose}) slots=${container.usedSlots}/${container.capacitySlots} shulkers=${container.shulkerCount}`)
          for (const item of container.items) {
            if (item.isShulker) {
              console.log(`    - ${item.displayName} (slot ${item.slot}): contains ${item.contents.length} item stack(s)`)
              for (const inner of item.contents) {
                console.log(`        * ${inner.displayName} x${inner.count} (slot ${inner.slot})`)
              }
            } else {
              console.log(`    - ${item.displayName} x${item.count} (slot ${item.slot})`)
            }
          }
        }
      }

      if (Object.keys(registration.materialIndex).length) {
        console.log('\n--- MATERIAL INDEX (WHERE TO FIND EACH ITEM) ---')
        for (const [mat, sources] of Object.entries(registration.materialIndex)) {
          const total = sources.reduce((sum, s) => sum + s.count, 0)
          console.log(`  ${mat}: total=${total} in ${sources.length} location(s)`)
        }
      }

      if (registration.warnings.length) {
        console.log('\n--- WARNINGS ---')
        for (const w of registration.warnings) console.log(`  ! ${w}`)
      }

      console.log('========================================\n')
      finish(0)
    } catch (error) {
      console.error(`[STORAGE-LIVE-ERROR] ${error?.stack || error}`)
      finish(1)
    }
  })

  bot.on('kicked', (reason) => console.log(`[STORAGE-LIVE-KICKED] ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', (error) => console.log(`[STORAGE-LIVE-BOT-ERROR] ${error?.message || error}`))
  bot.on('end', () => {
    if (!completed) {
      completed = true
      console.error('[STORAGE-LIVE-ERROR] Bot connection ended before storage registration completed.')
      process.exit(1)
    }
  })
}

main().catch((error) => {
  console.error(`[STORAGE-LIVE-FATAL] ${error?.stack || error}`)
  process.exitCode = 1
})

