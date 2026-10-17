'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { Vec3 } = require('vec3')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { createDashboardClient } = require('../src/dashboard-client')
const {
  ACTIVE_CHUNKS_DIR,
  PROGRESS_FILE,
  autoRecoverActiveJob,
  claimQueueChunkById,
  downloadQueueFile,
  loadPrintProgress,
  parseChunkSliceData,
  reportQueueResult,
  savePrintProgress,
  storeLocalChunkJson
} = require('../src/job-manager')
const { printChunkSlice } = require('../src/printer')
const {
  engageElytraHover,
  equipElytra,
  getElytraTickListenerCount,
  travelToAnchor
} = require('../src/elytra-flight')

const DEFAULT_FILE_ID = '8b7becc1-6c07-43f6-99f8-6e41693947f2'
const CRASH_EXIT_CODE = 86
const PLATFORM_ANCHOR = { x: -326, y: 97, z: -100 }
const REPORT_FILE = path.resolve(process.cwd(), 'logs', 'queue-chunk-recovery-live-report.json')
const QUEUE_FILE = path.resolve(process.cwd(), 'dashboard-service', 'data', 'files.json')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function getArgument(name, fallback = null) {
  const prefix = `${name}=`
  const entry = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : fallback
}

function positionSnapshot(bot) {
  const position = bot.entity?.position
  return position ? { x: position.x, y: position.y, z: position.z } : null
}

function distance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

function horizontalDistance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function inventoryCount(bot, itemName) {
  return (bot.inventory?.items?.() || [])
    .filter((item) => item.name === itemName)
    .reduce((total, item) => total + Number(item.count || 0), 0)
}

function readQueueRecord(fileId) {
  const records = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
  return records.find((record) => record.fileId === fileId) || null
}

function writeReport(patch) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true })
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
  } catch { }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  const temporary = `${REPORT_FILE}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(temporary, REPORT_FILE)
  return next
}

function waitForDashboard(urlValue, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const attempt = () => {
      const request = http.get(urlValue, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) {
          resolve()
          return
        }
        retry()
      })
      request.setTimeout(2000, () => request.destroy())
      request.on('error', retry)
    }
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Dashboard did not become reachable at ${urlValue}.`))
        return
      }
      setTimeout(attempt, 300)
    }
    attempt()
  })
}

function waitForSpawn(bot, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for ComicBot to spawn.')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('end', onEnd)
      bot.removeListener('kicked', onKicked)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const onSpawn = () => finish(null, positionSnapshot(bot))
    const onEnd = (reason) => finish(new Error(`Connection ended before spawn: ${reason || 'unknown'}`))
    const onKicked = (reason) => finish(new Error(`Kicked before spawn: ${JSON.stringify(reason)}`))
    bot.once('spawn', onSpawn)
    bot.once('end', onEnd)
    bot.once('kicked', onKicked)
  })
}

async function connectLiveBot(phase) {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  const bot = createBot(config)
  bot.on('error', (error) => console.error(`[LIVE-BOT-ERROR] ${error?.message || error}`))
  bot.on('kicked', (reason) => console.error(`[LIVE-BOT-KICKED] ${JSON.stringify(reason)}`))
  const spawnPosition = await waitForSpawn(bot)
  const dashboard = createDashboardClient(bot, config, {
    runtimeInstanceId: `queue-recovery-live-${process.pid}`,
    runtimeStartedAt: new Date().toISOString(),
    sessionNumber: 1
  })
  dashboard.state.online = true
  dashboard.state.reconnectState = 'connected'
  dashboard.setPhase(phase, phase)
  await dashboard.postStatus()
  const heartbeat = setInterval(() => dashboard.postStatus(), 2000)
  heartbeat.unref?.()
  await delay(2500)
  console.log(`[LIVE] ComicBot ready at ${JSON.stringify(positionSnapshot(bot))}; onGround=${bot.entity?.onGround}.`)
  return { bot, config, dashboard, heartbeat, spawnPosition }
}

async function stopLiveBot(context, reason, online = false) {
  if (!context) return
  clearInterval(context.heartbeat)
  try { await context.dashboard.stop(online) } catch { }
  try { context.bot.quit(reason) } catch { }
  await delay(500)
}

async function waitForChunks(bot, timeoutMs = 10000) {
  if (typeof bot.waitForChunksToLoad !== 'function') return
  await Promise.race([bot.waitForChunksToLoad(), delay(timeoutMs)])
}

function inspectBlocks(bot, blocks) {
  return blocks.map((block, index) => {
    const actual = bot.blockAt(new Vec3(block.x, block.y, block.z))
    return {
      index,
      expected: block.name,
      actual: actual?.name || null,
      x: block.x,
      y: block.y,
      z: block.z
    }
  })
}

function assertBlockRange(states, startIndex, endIndex, expectedName) {
  const failures = states
    .slice(startIndex, endIndex)
    .filter((state) => state.actual !== expectedName)
  if (failures.length > 0) {
    throw new Error(`Server block verification failed: ${JSON.stringify(failures)}`)
  }
}

async function sampleAirStability(bot, durationMs) {
  const samples = []
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (bot.entity?.onGround) throw new Error(`Bot touched ground during airborne stability sample at ${JSON.stringify(positionSnapshot(bot))}.`)
    samples.push(positionSnapshot(bot))
    await delay(250)
  }
  const ys = samples.map((sample) => sample.y)
  const start = samples[0]
  const end = samples[samples.length - 1]
  return {
    durationMs,
    sampleCount: samples.length,
    start,
    end,
    verticalRange: Math.max(...ys) - Math.min(...ys),
    horizontalDrift: horizontalDistance(start, end),
    totalDrift: distance(start, end),
    minimumY: Math.min(...ys),
    maximumY: Math.max(...ys),
    physicsTickListeners: bot.listenerCount('physicsTick'),
    elytraPhysicsTickListeners: getElytraTickListenerCount(bot)
  }
}

async function ensureFlightInventory(bot, requiredObsidian) {
  await equipElytra(bot)
  await delay(250)
  const chestItem = bot.inventory?.slots?.[6]
  if (chestItem?.name !== 'elytra') throw new Error(`Elytra is not equipped in the chest slot; found ${chestItem?.name || 'empty'}.`)
  const obsidian = inventoryCount(bot, 'obsidian')
  if (obsidian < requiredObsidian) throw new Error(`Need ${requiredObsidian} obsidian but ComicBot has ${obsidian}.`)
  return { chestItem: chestItem.name, obsidian }
}

async function runCrashPhase(fileId, crashAfter) {
  let context = null
  try {
    context = await connectLiveBot('claiming queue chunk')
    const { bot, config, dashboard } = context
    const claimed = await claimQueueChunkById(config, bot.username, fileId)
    if (!claimed) throw new Error(`Target queue file ${fileId} could not be claimed.`)
    const existingProgress = loadPrintProgress()
    if (existingProgress?.activeChunk?.fileId === fileId && existingProgress.activeChunk.nextBlockIndex === crashAfter) {
      const recovery = await autoRecoverActiveJob(bot, config)
      if (!recovery.recovered) throw new Error('Could not restore the existing durable crash checkpoint.')
      await ensureFlightInventory(bot, recovery.chunkData.blocks.length - crashAfter)
      await waitForChunks(bot)
      const recoveredStates = inspectBlocks(bot, recovery.chunkData.blocks)
      assertBlockRange(recoveredStates, 0, crashAfter, 'obsidian')
      assertBlockRange(recoveredStates, crashAfter, recoveredStates.length, 'air')
      if (bot.entity?.onGround) {
        const current = positionSnapshot(bot)
        await travelToAnchor(bot, {
          x: Math.floor(current.x) + 12,
          y: Math.floor(current.y),
          z: Math.floor(current.z) + 12
        }, {
          horizontalSpeed: 2,
          verticalSpeed: 2,
          hoverInAir: true,
          noLanding: true
        })
      }
      if (bot.entity?.onGround) throw new Error('Elytra-only relaunch did not leave the recovered checkpoint airborne.')
      engageElytraHover(bot)
      const stability = await sampleAirStability(bot, 3000)
      if (stability.elytraPhysicsTickListeners !== 1) {
        throw new Error(`Expected one ElytraFly physicsTick listener before crash, found ${stability.elytraPhysicsTickListeners}.`)
      }
      const crashPosition = positionSnapshot(bot)
      writeReport({
        expectedBlocks: recovery.chunkData.blocks.length,
        originalName: claimed.originalName,
        chunkKey: recovery.chunkData.key,
        localJsonPath: recovery.chunkData.localJsonPath,
        recoveredStatesBeforeCrash: recoveredStates,
        phaseOneCompletedAt: new Date().toISOString(),
        crashPosition,
        preCrashAirStability: stability,
        checkpointBeforeCrash: recovery.progress,
        inventoryAtCrash: { obsidian: inventoryCount(bot, 'obsidian') }
      })
      console.log(`[LIVE-CRASH] Recovered durable index ${crashAfter} at ${JSON.stringify(crashPosition)}; terminating process without bot.quit().`)
      await delay(250)
      process.exit(CRASH_EXIT_CODE)
    }
    const buffer = await downloadQueueFile(config, bot.username, fileId)
    const chunk = parseChunkSliceData(buffer, claimed.originalName)
    if (!chunk || chunk.blocks.length !== 18 || chunk.materials?.obsidian !== 18) {
      throw new Error(`Unexpected target payload: ${JSON.stringify({ blockCount: chunk?.blocks?.length, materials: chunk?.materials })}`)
    }
    chunk.fileId = claimed.fileId
    chunk.fileName = claimed.originalName
    chunk.originalName = claimed.originalName
    const localJsonPath = storeLocalChunkJson(chunk)
    if (!localJsonPath) throw new Error('Failed to persist the claimed chunk locally.')
    chunk.localJsonPath = localJsonPath
    bot.activeChunkJob = chunk
    bot.placedBlocksCount = 0
    bot.loadedChunkJobs = new Map([[chunk.key, chunk]])
    savePrintProgress(bot, { activeChunk: chunk, placedBlocks: 0, status: 'downloaded', localJsonPath })
    await reportQueueResult(config, bot.username, fileId, 'downloaded')
    const inventoryBefore = await ensureFlightInventory(bot, chunk.blocks.length)
    dashboard.setPhase('printing', `flying to chunk ${chunk.key}`)
    await dashboard.postStatus()
    const firstBlock = chunk.blocks[0]
    const travel = await travelToAnchor(bot, firstBlock, {
      horizontalSpeed: 2,
      verticalSpeed: 2,
      hoverInAir: true,
      noLanding: true
    })
    await waitForChunks(bot)
    const initialStates = inspectBlocks(bot, chunk.blocks)
    assertBlockRange(initialStates, 0, initialStates.length, 'air')
    await reportQueueResult(config, bot.username, fileId, 'printing')
    writeReport({
      fileId,
      originalName: claimed.originalName,
      chunkKey: chunk.key,
      expectedBlocks: chunk.blocks.length,
      crashAfter,
      localJsonPath,
      initialStates,
      inventoryBefore,
      outboundTravel: travel.telemetry || null,
      firstProcessSpawnPosition: context.spawnPosition
    })
    await printChunkSlice(bot, config, chunk, {
      confirmTimeoutMs: 6000,
      placementIntervalMs: 250,
      afterPlacement: async ({ blockIndex, progress }) => {
        if (blockIndex + 1 !== crashAfter) return
        engageElytraHover(bot)
        await delay(1000)
        const stability = await sampleAirStability(bot, 3000)
        if (stability.elytraPhysicsTickListeners !== 1) {
          throw new Error(`Expected one ElytraFly physicsTick listener before crash, found ${stability.elytraPhysicsTickListeners}.`)
        }
        if (progress?.activeChunk?.nextBlockIndex !== crashAfter) {
          throw new Error(`Checkpoint next index is ${progress?.activeChunk?.nextBlockIndex}; expected ${crashAfter}.`)
        }
        const crashPosition = positionSnapshot(bot)
        writeReport({
          phaseOneCompletedAt: new Date().toISOString(),
          crashPosition,
          preCrashAirStability: stability,
          checkpointBeforeCrash: progress,
          inventoryAtCrash: { obsidian: inventoryCount(bot, 'obsidian') }
        })
        console.log(`[LIVE-CRASH] Durable index ${crashAfter} confirmed at ${JSON.stringify(crashPosition)}; terminating process without bot.quit().`)
        await delay(250)
        process.exit(CRASH_EXIT_CODE)
      }
    })
    throw new Error('Crash phase returned without terminating at the requested durable index.')
  } catch (error) {
    writeReport({ phaseOneError: error?.stack || String(error) })
    await stopLiveBot(context, 'Crash phase failed')
    throw error
  }
}

async function runResumePhase(fileId, crashAfter) {
  let context = null
  try {
    const priorReport = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
    context = await connectLiveBot('recovering queue chunk')
    const { bot, config, dashboard } = context
    if (bot.entity?.onGround) throw new Error(`ComicBot reconnected on the ground at ${JSON.stringify(positionSnapshot(bot))}.`)
    const reconnectReadyPosition = positionSnapshot(bot)
    const reconnectDisplacement = distance(priorReport.crashPosition, context.spawnPosition)
    const reconnectStability = await sampleAirStability(bot, 10000)
    if (reconnectDisplacement > 2) throw new Error(`Reconnect position moved ${reconnectDisplacement.toFixed(3)} blocks from the crash position.`)
    if (reconnectStability.verticalRange > 0.75) throw new Error(`Reconnect hover vertical range was ${reconnectStability.verticalRange.toFixed(3)} blocks.`)
    if (reconnectStability.elytraPhysicsTickListeners !== 1) {
      throw new Error(`Expected one ElytraFly physicsTick listener after reconnect, found ${reconnectStability.elytraPhysicsTickListeners}.`)
    }
    writeReport({
      reconnectVerifiedAt: new Date().toISOString(),
      secondProcessSpawnPosition: context.spawnPosition,
      reconnectReadyPosition,
      reconnectDisplacement,
      reconnectAirStability: reconnectStability
    })
    const savedBeforeRecovery = loadPrintProgress()
    if (savedBeforeRecovery?.activeChunk?.nextBlockIndex !== crashAfter) {
      throw new Error(`Saved next index is ${savedBeforeRecovery?.activeChunk?.nextBlockIndex}; expected ${crashAfter}.`)
    }
    const recovery = await autoRecoverActiveJob(bot, config)
    if (!recovery.recovered) throw new Error('Auto-recovery did not restore the active chunk.')
    if (recovery.chunkData.fileId !== fileId) throw new Error(`Recovered fileId ${recovery.chunkData.fileId || 'missing'} does not match ${fileId}.`)
    if (recovery.progress?.activeChunk?.nextBlockIndex !== crashAfter) {
      throw new Error(`Recovered next index is ${recovery.progress?.activeChunk?.nextBlockIndex}; expected ${crashAfter}.`)
    }
    await ensureFlightInventory(bot, recovery.chunkData.blocks.length - crashAfter)
    await waitForChunks(bot)
    const statesBeforeResume = inspectBlocks(bot, recovery.chunkData.blocks)
    assertBlockRange(statesBeforeResume, 0, crashAfter, 'obsidian')
    assertBlockRange(statesBeforeResume, crashAfter, statesBeforeResume.length, 'air')
    dashboard.setPhase('printing', `resuming chunk ${recovery.chunkData.key} at ${crashAfter}/${recovery.chunkData.blocks.length}`)
    await dashboard.postStatus()
    await reportQueueResult(config, bot.username, fileId, 'printing')
    const result = await printChunkSlice(bot, config, recovery.chunkData, {
      confirmTimeoutMs: 6000,
      placementIntervalMs: 250
    })
    if (result.placedCount !== recovery.chunkData.blocks.length) {
      throw new Error(`Printer stopped at ${result.placedCount}/${recovery.chunkData.blocks.length}.`)
    }
    await waitForChunks(bot)
    const finalStates = inspectBlocks(bot, recovery.chunkData.blocks)
    assertBlockRange(finalStates, 0, finalStates.length, 'obsidian')
    const localFileExists = fs.existsSync(recovery.chunkData.localJsonPath)
    if (localFileExists) throw new Error(`Completed local chunk file still exists: ${recovery.chunkData.localJsonPath}`)
    const completedProgress = loadPrintProgress()
    if (completedProgress && (completedProgress.status !== 'completed' || completedProgress.activeChunk !== null)) {
      throw new Error(`Final progress is not completed and cleared: ${JSON.stringify(completedProgress)}`)
    }
    const completedQueue = readQueueRecord(fileId)
    if (completedQueue?.queueStatus !== 'completed' || !['completed', 'placed'].includes(completedQueue?.deliveryStatus)) {
      throw new Error(`Dashboard queue did not complete: ${JSON.stringify(completedQueue)}`)
    }
    dashboard.setPhase('returning', 'returning to storage platform with ElytraFly')
    await dashboard.postStatus()
    const returnTravel = await travelToAnchor(bot, PLATFORM_ANCHOR, { horizontalSpeed: 2, verticalSpeed: 2 })
    await delay(1000)
    const landingPosition = positionSnapshot(bot)
    if (!bot.entity?.onGround) throw new Error(`ComicBot did not finish on the ground: ${JSON.stringify(landingPosition)}`)
    if (Number(bot.health) !== 20) throw new Error(`ComicBot landed with health ${bot.health}; expected 20.`)
    const finalReport = writeReport({
      completedAt: new Date().toISOString(),
      secondProcessSpawnPosition: context.spawnPosition,
      reconnectReadyPosition,
      reconnectDisplacement,
      reconnectAirStability: reconnectStability,
      recoveredNextBlockIndex: recovery.progress.activeChunk.nextBlockIndex,
      recoveredFileId: recovery.chunkData.fileId,
      statesBeforeResume,
      finalStates,
      printResult: result,
      completedProgress,
      completedQueue: {
        fileId: completedQueue.fileId,
        queueStatus: completedQueue.queueStatus,
        deliveryStatus: completedQueue.deliveryStatus,
        claimedByBotName: completedQueue.claimedByBotName,
        claimedByHostLabel: completedQueue.claimedByHostLabel,
        attemptCount: completedQueue.attemptCount,
        claimCount: completedQueue.claimCount
      },
      localFileExistsAfterCompletion: localFileExists,
      returnTravel: returnTravel.telemetry || null,
      landingPosition,
      onGround: bot.entity.onGround,
      health: bot.health,
      finalInventory: { obsidian: inventoryCount(bot, 'obsidian') }
    })
    dashboard.setPhase('idle', 'live chunk recovery test completed; landed safely')
    await dashboard.postStatus()
    console.log(`[LIVE-COMPLETE] ${JSON.stringify(finalReport, null, 2)}`)
    await stopLiveBot(context, 'Queue chunk recovery live test complete')
  } catch (error) {
    writeReport({ phaseTwoError: error?.stack || String(error) })
    if (context) {
      context.dashboard.setError(error)
      await context.dashboard.postStatus().catch(() => {})
    }
    await stopLiveBot(context, 'Resume phase failed')
    throw error
  }
}

async function runLandingPhase(fileId) {
  let context = null
  try {
    context = await connectLiveBot('returning to storage platform')
    const { bot, dashboard } = context
    const completedQueue = readQueueRecord(fileId)
    if (completedQueue?.queueStatus !== 'completed' || !['completed', 'placed'].includes(completedQueue?.deliveryStatus)) {
      throw new Error(`Landing recovery requires a completed queue item: ${JSON.stringify(completedQueue)}`)
    }
    const payloadPath = path.resolve(process.cwd(), 'dashboard-service', 'data', 'files', completedQueue.storedName)
    const chunk = parseChunkSliceData(fs.readFileSync(payloadPath), completedQueue.originalName)
    await waitForChunks(bot)
    const finalStates = inspectBlocks(bot, chunk.blocks)
    if (finalStates.some((s) => s.actual !== null)) {
      assertBlockRange(finalStates, 0, finalStates.length, 'obsidian')
    }
    dashboard.setPhase('returning', 'returning to storage platform with ElytraFly')
    await dashboard.postStatus()
    const returnTravel = await travelToAnchor(bot, PLATFORM_ANCHOR, { horizontalSpeed: 2, verticalSpeed: 2 })
    await delay(1000)
    const landingPosition = positionSnapshot(bot)
    if (!bot.entity?.onGround) throw new Error(`ComicBot did not finish on the ground: ${JSON.stringify(landingPosition)}`)
    if (Number(bot.health) !== 20) throw new Error(`ComicBot landed with health ${bot.health}; expected 20.`)
    const completedProgress = loadPrintProgress()
    if (completedProgress && (completedProgress.status !== 'completed' || completedProgress.activeChunk !== null)) {
      throw new Error(`Final progress is not completed and cleared: ${JSON.stringify(completedProgress)}`)
    }
    const priorReport = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
    const finalReport = writeReport({
      phaseTwoError: null,
      completedAt: new Date().toISOString(),
      recoveredNextBlockIndex: priorReport.checkpointBeforeCrash?.activeChunk?.nextBlockIndex || null,
      finalStates,
      printResult: { chunkKey: chunk.key, placedCount: chunk.blocks.length, totalBlocks: chunk.blocks.length },
      completedProgress,
      completedQueue: {
        fileId: completedQueue.fileId,
        queueStatus: completedQueue.queueStatus,
        deliveryStatus: completedQueue.deliveryStatus,
        claimedByBotName: completedQueue.claimedByBotName,
        claimedByHostLabel: completedQueue.claimedByHostLabel,
        attemptCount: completedQueue.attemptCount,
        claimCount: completedQueue.claimCount
      },
      localFileExistsAfterCompletion: fs.existsSync(path.join(ACTIVE_CHUNKS_DIR, 'robomech_chunk_-22_0.json')),
      returnTravel: returnTravel.telemetry || null,
      landingPosition,
      onGround: bot.entity.onGround,
      health: bot.health,
      finalInventory: { obsidian: inventoryCount(bot, 'obsidian') }
    })
    dashboard.setPhase('idle', 'live chunk recovery test completed; landed safely')
    await dashboard.postStatus()
    console.log(`[LIVE-LANDING-COMPLETE] ${JSON.stringify(finalReport, null, 2)}`)
    await stopLiveBot(context, 'Landing recovery complete')
  } catch (error) {
    writeReport({ landingError: error?.stack || String(error) })
    if (context) {
      context.dashboard.setError(error)
      await context.dashboard.postStatus().catch(() => {})
    }
    await stopLiveBot(context, 'Landing recovery failed')
    throw error
  }
}

function runChild(mode, fileId, crashAfter) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      __filename,
      `--mode=${mode}`,
      '--connection=testserver',
      `--file-id=${fileId}`,
      `--crash-after=${crashAfter}`
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function runParent(fileId, crashAfter) {
  const config = loadConfig()
  await waitForDashboard(config.dashboard.serviceUrl)
  const progress = loadPrintProgress()
  const queueRecord = readQueueRecord(fileId)
  if (!queueRecord) throw new Error(`Queue file ${fileId} does not exist.`)
  const retryingOwnedLease = progress?.activeChunk?.fileId === fileId &&
    [0, crashAfter].includes(progress.activeChunk.nextBlockIndex) &&
    queueRecord.claimedByBotName === config.bot.username &&
    queueRecord.claimedByHostLabel === config.dashboard.hostLabel &&
    ['claimed', 'downloaded', 'printing'].includes(queueRecord.queueStatus)
  if (progress?.activeChunk && !retryingOwnedLease) {
    throw new Error(`Refusing to overwrite active progress for chunk ${progress.activeChunk.key}.`)
  }
  if (!retryingOwnedLease && (queueRecord.queueStatus !== 'pending' || queueRecord.deliveryStatus !== 'pending')) {
    throw new Error(`Queue file must be pending before this live test: ${JSON.stringify({ queueStatus: queueRecord.queueStatus, deliveryStatus: queueRecord.deliveryStatus })}`)
  }
  const expectedLocalPath = path.join(ACTIVE_CHUNKS_DIR, 'robomech_chunk_-22_0.json')
  if (fs.existsSync(expectedLocalPath) && !retryingOwnedLease) {
    throw new Error(`Refusing to overwrite existing active chunk file ${expectedLocalPath}.`)
  }
  if (fs.existsSync(REPORT_FILE)) fs.unlinkSync(REPORT_FILE)
  writeReport({
    startedAt: new Date().toISOString(),
    fileId,
    crashAfter,
    queueBefore: {
      queueStatus: queueRecord.queueStatus,
      deliveryStatus: queueRecord.deliveryStatus,
      claimCount: queueRecord.claimCount,
      attemptCount: queueRecord.attemptCount,
      retryingOwnedLease
    },
    progressFile: PROGRESS_FILE
  })
  console.log(`[LIVE-PARENT] Starting crash phase for ${fileId}.`)
  const crashResult = await runChild('crash', fileId, crashAfter)
  if (crashResult.code !== CRASH_EXIT_CODE) {
    throw new Error(`Crash child exited with code=${crashResult.code} signal=${crashResult.signal || 'none'}; expected code ${CRASH_EXIT_CODE}.`)
  }
  const checkpoint = loadPrintProgress()
  if (checkpoint?.activeChunk?.nextBlockIndex !== crashAfter) {
    throw new Error(`Parent observed next index ${checkpoint?.activeChunk?.nextBlockIndex}; expected ${crashAfter}.`)
  }
  console.log(`[LIVE-PARENT] Crash confirmed at durable index ${crashAfter}; restarting in 2500 ms.`)
  await delay(2500)
  const resumeResult = await runChild('resume', fileId, crashAfter)
  if (resumeResult.code !== 0) {
    throw new Error(`Resume child exited with code=${resumeResult.code} signal=${resumeResult.signal || 'none'}.`)
  }
  const finalQueue = readQueueRecord(fileId)
  const finalProgress = loadPrintProgress()
  if (finalQueue?.queueStatus !== 'completed' || finalProgress?.status !== 'completed' || finalProgress.activeChunk !== null) {
    throw new Error(`Parent final verification failed: ${JSON.stringify({ finalQueue, finalProgress })}`)
  }
  const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
  console.log(`[LIVE-PARENT] PASS: completed ${report.expectedBlocks} blocks, resumed at ${report.recoveredNextBlockIndex}, reconnect displacement=${report.reconnectDisplacement.toFixed(3)}, hover vertical range=${report.reconnectAirStability.verticalRange.toFixed(3)}, landed=${report.onGround}, health=${report.health}.`)
}

async function main() {
  const mode = getArgument('--mode', 'parent')
  const fileId = getArgument('--file-id', DEFAULT_FILE_ID)
  const crashAfter = Math.max(1, Number(getArgument('--crash-after', '5')))
  if (mode === 'crash') return runCrashPhase(fileId, crashAfter)
  if (mode === 'resume') return runResumePhase(fileId, crashAfter)
  if (mode === 'land') return runLandingPhase(fileId)
  return runParent(fileId, crashAfter)
}

main().catch((error) => {
  console.error(`[LIVE-FAIL] ${error?.stack || error}`)
  process.exitCode = 1
})
