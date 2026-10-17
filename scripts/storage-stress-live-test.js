'use strict'

const fs = require('fs')
const path = require('path')
const { getCliValue, loadConfig, toNumber } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { equipElytra, formatPosition } = require('../src/elytra-flight')
const { registerStorage, DEFAULT_ANCHOR } = require('../src/storage-registration')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseAnchor(value) {
  if (!value) return DEFAULT_ANCHOR
  const parts = String(value).split(',').map((part) => Number(part.trim()))
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return { x: Math.floor(parts[0]), y: Math.floor(parts[1]), z: Math.floor(parts[2]) }
  }
  return DEFAULT_ANCHOR
}

function percentile(values, percent) {
  if (!values.length) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percent) - 1))]
}

function positionKey(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function materialTotalsFingerprint(materialIndex) {
  return Object.entries(materialIndex || {})
    .map(([name, entries]) => [name, (entries || []).reduce((total, entry) => total + Number(entry.count || 0), 0)])
    .sort(([left], [right]) => left.localeCompare(right))
}

function registrationFingerprint(registration) {
  return JSON.stringify({
    discoveredContainerCount: registration.summary.discoveredContainerCount,
    registeredContainerCount: registration.summary.registeredContainerCount,
    materialContainerCount: registration.summary.materialContainerCount,
    dumpContainerCount: registration.summary.dumpContainerCount,
    discoveredEnderChestCount: registration.summary.discoveredEnderChestCount,
    enderChestCount: registration.summary.enderChestCount,
    shulkerCount: registration.summary.shulkerCount,
    materialTypeCount: registration.summary.materialTypeCount,
    ignoredEmptyContainerCount: registration.summary.ignoredEmptyContainerCount,
    enderChestPosition: registration.enderChest?.position || null,
    materials: materialTotalsFingerprint(registration.materialIndex)
  })
}

function validateRegistration(registration, bot, anchor, expected, baselineFingerprint) {
  const failures = []
  const containers = Array.isArray(registration.containers) ? registration.containers : []
  const containerIds = containers.map((container) => String(container.containerId || positionKey(container.position)))
  const uniqueContainerIds = new Set(containerIds)
  const discoveredEnderPositions = new Set((registration.discoveredEnderChests || []).map((item) => positionKey(item.position)))
  const enderPosition = registration.enderChest?.position ? positionKey(registration.enderChest.position) : null
  const anchorDistance = bot.entity?.position
    ? Math.hypot(bot.entity.position.x - (anchor.x + 0.5), bot.entity.position.y - (anchor.y + 1), bot.entity.position.z - (anchor.z + 0.5))
    : Number.POSITIVE_INFINITY

  if (registration.platformBounds?.minY !== anchor.y + 1) failures.push(`minY=${registration.platformBounds?.minY}`)
  if (containers.some((container) => Number(container.position?.y) <= anchor.y)) failures.push('anchor-level-container')
  if (containerIds.length !== uniqueContainerIds.size) failures.push('duplicate-container-id')
  if (containers.some((container) => String(container.blockName || '').includes('chest') && Number(container.capacitySlots) !== 54)) failures.push('non-54-slot-chest')
  if (Number(registration.summary.errorCount) !== 0 || (registration.errors || []).length !== 0) failures.push(`errors=${registration.summary.errorCount}`)
  if (Number(registration.summary.discoveredContainerCount) !== expected.logicalContainers) failures.push(`logical=${registration.summary.discoveredContainerCount}`)
  if (Number(registration.summary.materialContainerCount) !== expected.materialContainers) failures.push(`materials=${registration.summary.materialContainerCount}`)
  if (Number(registration.summary.dumpContainerCount) !== expected.dumpContainers) failures.push(`dumps=${registration.summary.dumpContainerCount}`)
  if (Number(registration.summary.shulkerCount) !== expected.storageShulkers) failures.push(`shulkers=${registration.summary.shulkerCount}`)
  if (Number(registration.summary.discoveredEnderChestCount) !== expected.discoveredEnderChests) failures.push(`ender-discovered=${registration.summary.discoveredEnderChestCount}`)
  if (Number(registration.summary.enderChestCount) !== 1 || !registration.enderChest) failures.push(`ender-registered=${registration.summary.enderChestCount}`)
  if (enderPosition && !discoveredEnderPositions.has(enderPosition)) failures.push(`ender-position=${enderPosition}`)
  if (registration.enderChest && Number(registration.enderChest.capacitySlots) !== 27) failures.push(`ender-capacity=${registration.enderChest.capacitySlots}`)
  if (anchorDistance > 2.5) failures.push(`anchor-distance=${anchorDistance.toFixed(2)}`)
  if (bot.entity?.onGround !== true) failures.push('not-on-ground')
  if (baselineFingerprint && registrationFingerprint(registration) !== baselineFingerprint) failures.push('registration-fingerprint-changed')
  return { failures, anchorDistance }
}

async function main() {
  const config = loadConfig()
  const anchor = parseAnchor(getCliValue('--anchor'))
  const iterations = Math.max(1, Math.min(1000, Math.floor(toNumber(getCliValue('--iterations'), 100))))
  const expected = {
    logicalContainers: Math.max(1, Math.floor(toNumber(getCliValue('--expected-logical'), 34))),
    materialContainers: Math.max(1, Math.floor(toNumber(getCliValue('--expected-materials'), 18))),
    dumpContainers: Math.max(1, Math.floor(toNumber(getCliValue('--expected-dumps'), 6))),
    storageShulkers: Math.max(0, Math.floor(toNumber(getCliValue('--expected-shulkers'), 912))),
    discoveredEnderChests: Math.max(1, Math.floor(toNumber(getCliValue('--expected-ender'), 2)))
  }
  const reportPath = path.resolve(getCliValue('--report') || path.join('logs', 'storage-stress-live-report.json'))
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }

  console.log(`[STORAGE-STRESS] Starting ${iterations} live registrations on ${config.bot.host}:${config.bot.port}.`)
  console.log(`[STORAGE-STRESS] Anchor=${anchor.x},${anchor.y},${anchor.z}; report=${reportPath}`)

  const bot = createBot(config)
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    botName: config.bot.username,
    server: `${config.bot.host}:${config.bot.port}`,
    anchor,
    requestedIterations: iterations,
    completedIterations: 0,
    passedIterations: 0,
    failedIterations: 0,
    expected,
    durationMs: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
    maxDurationMs: 0,
    runs: []
  }
  let finished = false
  let baselineFingerprint = null
  const startedAt = Date.now()

  function writeReport() {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    const tempPath = `${reportPath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(report, null, 2), 'utf8')
    fs.renameSync(tempPath, reportPath)
  }

  function finish(exitCode) {
    if (finished) return
    finished = true
    report.completedAt = new Date().toISOString()
    report.durationMs = Date.now() - startedAt
    const durations = report.runs.map((run) => run.durationMs).filter(Number.isFinite)
    report.p50DurationMs = percentile(durations, 0.5)
    report.p95DurationMs = percentile(durations, 0.95)
    report.maxDurationMs = durations.length ? Math.max(...durations) : 0
    writeReport()
    console.log(`[STORAGE-STRESS] Completed ${report.completedIterations}/${iterations}; passed=${report.passedIterations}; failed=${report.failedIterations}; p95=${report.p95DurationMs}ms.`)
    try { bot.quit('Storage stress test complete') } catch { }
    setTimeout(() => process.exit(exitCode), 1000)
  }

  bot.once('spawn', async () => {
    try {
      if (typeof bot.waitForChunksToLoad === 'function') await bot.waitForChunksToLoad()
      await delay(1500)
      await equipElytra(bot)
      console.log(`[STORAGE-STRESS] Spawned at ${formatPosition(bot.entity?.position)}.`)

      for (let iteration = 1; iteration <= iterations; iteration++) {
        const iterationStartedAt = Date.now()
        let registration = null
        let failures = []
        try {
          registration = await registerStorage(bot, config, { anchor })
          const fingerprint = registrationFingerprint(registration)
          const validation = validateRegistration(registration, bot, anchor, expected, baselineFingerprint)
          failures = validation.failures
          if (!baselineFingerprint && failures.length === 0) baselineFingerprint = fingerprint
        } catch (error) {
          failures = [error?.message || String(error)]
        }

        const durationMs = Date.now() - iterationStartedAt
        const run = {
          iteration,
          completedAt: new Date().toISOString(),
          durationMs,
          passed: failures.length === 0,
          failures,
          summary: registration?.summary || null,
          enderChestPosition: registration?.enderChest?.position || null,
          botPosition: bot.entity?.position
            ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, onGround: bot.entity.onGround === true }
            : null
        }
        report.runs.push(run)
        report.completedIterations++
        if (run.passed) report.passedIterations++
        else report.failedIterations++
        writeReport()
        console.log(`[STORAGE-STRESS] ${iteration}/${iterations} ${run.passed ? 'PASS' : 'FAIL'} duration=${durationMs}ms${failures.length ? ` failures=${failures.join('|')}` : ''}`)
        await delay(250)
      }

      finish(report.failedIterations === 0 ? 0 : 1)
    } catch (error) {
      console.error(`[STORAGE-STRESS-FATAL] ${error?.stack || error}`)
      finish(1)
    }
  })

  bot.on('kicked', (reason) => console.log(`[STORAGE-STRESS-KICKED] ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', (error) => console.log(`[STORAGE-STRESS-BOT-ERROR] ${error?.message || error}`))
  bot.on('end', () => {
    if (!finished) {
      report.failedIterations++
      report.runs.push({ iteration: report.completedIterations + 1, completedAt: new Date().toISOString(), durationMs: 0, passed: false, failures: ['bot connection ended'] })
      finish(1)
    }
  })
}

main().catch((error) => {
  console.error(`[STORAGE-STRESS-FATAL] ${error?.stack || error}`)
  process.exitCode = 1
})
