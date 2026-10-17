'use strict'

const { getCliValue, loadConfig, toNumber } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { equipElytra, runDirectionalFlightTest } = require('../src/elytra-flight')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main() {
  const config = loadConfig()
  const horizontalSpeed = toNumber(getCliValue('--horizontal-speed'), config.elytraFly.horizontalSpeed)
  const verticalSpeed = toNumber(getCliValue('--vertical-speed'), config.elytraFly.verticalSpeed)
  const lateralPhaseMs = Math.max(1500, Math.min(6000, toNumber(
    getCliValue('--phase-ms') || getCliValue('--flight-ms'),
    3000
  )))
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  const bot = createBot(config)

  let completed = false
  const finish = (exitCode) => {
    if (completed) return
    completed = true
    process.exitCode = exitCode
    try { bot.quit('Elytra live test complete') } catch { }
    setTimeout(() => process.exit(exitCode), 1000)
  }

  bot.once('spawn', async () => {
    try {
      if (typeof bot.waitForChunksToLoad === 'function') await bot.waitForChunksToLoad()
      await delay(1000)
      await equipElytra(bot)
      const result = await runDirectionalFlightTest(bot, { horizontalSpeed, verticalSpeed, lateralPhaseMs })
      if (!result.landed) throw new Error('Directional flight test ended without a confirmed landing.')
      if (!result.speedSafe) throw new Error('Directional flight exceeded its configured speed safety limit.')
      finish(result.rubberbandingDetected ? 2 : 0)
    } catch (error) {
      console.error(`[ELYTRA-TEST-ERROR] ${error?.stack || error}`)
      finish(1)
    }
  })
  bot.on('kicked', (reason) => console.log(`[ELYTRA-TEST-KICKED] ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', (error) => console.log(`[ELYTRA-TEST-BOT-ERROR] ${error?.message || error}`))
  bot.on('end', () => {
    if (!completed) {
      completed = true
      console.error('[ELYTRA-TEST-ERROR] Bot connection ended before the flight test completed.')
      process.exit(1)
    }
  })
}

main().catch((error) => {
  console.error(`[ELYTRA-TEST-FATAL] ${error?.stack || error}`)
  process.exitCode = 1
})
