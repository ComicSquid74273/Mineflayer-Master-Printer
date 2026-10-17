'use strict'

const { loadConfig } = require('./config')
const { runConnectionManager } = require('./connection-manager')

async function main() {
  const config = loadConfig()
  console.log(`[CONFIG] Loaded ${config.__meta.configFileName}; connection=${config.connection.active}.`)
  console.log(`[CONFIG] Dashboard=${config.dashboard?.enabled === true ? config.dashboard.serviceUrl : 'disabled'}.`)
  await runConnectionManager(config)
}

main().catch((error) => {
  console.error(`[FATAL] ${error?.stack || error}`)
  process.exitCode = 1
})
