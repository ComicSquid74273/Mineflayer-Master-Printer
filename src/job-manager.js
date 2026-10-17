'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const { toNumber } = require('./config')
const { parseSchematicBuffer, sliceSchematicIntoChunks } = require('./schematic-loader')

const STATE_DIR = path.resolve(process.env.PRINTER_STATE_DIR || path.resolve(process.cwd(), 'logs'))
const ACTIVE_CHUNKS_DIR = path.join(STATE_DIR, 'active-chunks')
const PROGRESS_FILE = path.join(STATE_DIR, 'print-progress.json')
const CHECKPOINT_FILE = path.join(STATE_DIR, 'printer-job-state.json')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestBuffer(urlValue, method = 'GET', body = null, timeoutMs = 15000) {
  const target = new URL(urlValue)
  const transport = target.protocol === 'https:' ? https : http
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  const headers = {}
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: Math.max(1000, toNumber(timeoutMs, 15000))
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const statusCode = Number(response.statusCode || 0)
        if (statusCode >= 400) {
          let errorMsg = `HTTP ${statusCode}`
          try {
            const parsed = JSON.parse(buffer.toString('utf8'))
            if (parsed?.error) errorMsg = parsed.error
          } catch { }
          reject(new Error(`Dashboard request failed: ${method} ${target.pathname} (${errorMsg})`))
          return
        }
        resolve({ statusCode, buffer })
      })
    })
    request.on('timeout', () => request.destroy(new Error(`Dashboard request timeout: ${method} ${urlValue}`)))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function getDashboardConfig(config) {
  const raw = config?.dashboard || {}
  return {
    enabled: raw.enabled === true,
    serviceUrl: String(raw.serviceUrl || 'http://127.0.0.1:4080').trim().replace(/\/$/, ''),
    hostLabel: String(raw.hostLabel || process.env.COMPUTERNAME || os.hostname() || 'unknown-host').trim(),
    heartbeatMs: Math.max(1000, toNumber(raw.heartbeatMs, 5000)),
    commandPollMs: Math.max(1000, toNumber(raw.commandPollMs, 3000))
  }
}

async function claimQueueChunks(config, botName, limit = 1) {
  const dashboard = getDashboardConfig(config)
  const url = `${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/queue/claim-next`
  const { buffer } = await requestBuffer(url, 'POST', {
    botName,
    limit: Math.max(1, Math.min(10, Math.floor(Number(limit || 1))))
  })
  const res = JSON.parse(buffer.toString('utf8'))
  const items = Array.isArray(res.items) ? res.items.filter(Boolean) : (res.item ? [res.item] : [])
  return { items, batchPolicy: res.batchPolicy || null }
}

async function claimQueueChunkById(config, botName, fileId) {
  const dashboard = getDashboardConfig(config)
  const url = `${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/queue/${encodeURIComponent(fileId)}/claim`
  const { buffer } = await requestBuffer(url, 'POST', { botName })
  return JSON.parse(buffer.toString('utf8') || '{}').item || null
}

async function downloadQueueFile(config, botName, fileId) {
  const dashboard = getDashboardConfig(config)
  const url = `${dashboard.serviceUrl}/api/files/${encodeURIComponent(fileId)}/download?botName=${encodeURIComponent(botName)}&hostLabel=${encodeURIComponent(dashboard.hostLabel)}`
  const { buffer } = await requestBuffer(url, 'GET')
  return buffer
}

async function reportQueueResult(config, botName, fileId, deliveryStatus, failedReason = null) {
  const dashboard = getDashboardConfig(config)
  const url = `${dashboard.serviceUrl}/api/nodes/${encodeURIComponent(dashboard.hostLabel)}/queue/${encodeURIComponent(fileId)}/result`
  await requestBuffer(url, 'POST', {
    botName,
    deliveryStatus,
    failedReason
  })
}

function parseChunkSliceData(buffer, fileName = '') {
  const text = buffer.toString('utf8')
  if (text.trim().startsWith('{')) {
    const json = JSON.parse(text)
    if (Array.isArray(json.blocks) && json.anchor) {
      return {
        fileId: json.fileId || null,
        fileName: json.fileName || json.originalName || fileName || null,
        originalName: json.originalName || json.fileName || fileName || null,
        structureName: json.structureName || fileName,
        anchor: json.anchor,
        chunkX: Number(json.chunkX),
        chunkZ: Number(json.chunkZ),
        key: json.key || `${json.chunkX},${json.chunkZ}`,
        blockCount: json.blockCount || json.blocks.length,
        bounds: json.bounds || null,
        structureBounds: json.structureBounds || null,
        materials: json.materials || {},
        blocks: json.blocks
      }
    }
  }
  return null
}

function storeLocalChunkJson(chunkData) {
  try {
    fs.mkdirSync(ACTIVE_CHUNKS_DIR, { recursive: true })
    const base = String(chunkData.structureName || 'structure').replace(/\.[^.]+$/, '')
    const cleanKey = `${chunkData.chunkX}_${chunkData.chunkZ}`
    const fileName = `${base}_chunk_${cleanKey}.json`
    const targetPath = path.join(ACTIVE_CHUNKS_DIR, fileName)

    const payload = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      fileId: chunkData.fileId || null,
      fileName: chunkData.fileName || chunkData.originalName || null,
      originalName: chunkData.originalName || chunkData.fileName || null,
      structureName: chunkData.structureName,
      anchor: chunkData.anchor,
      chunkX: chunkData.chunkX,
      chunkZ: chunkData.chunkZ,
      key: chunkData.key || `${chunkData.chunkX},${chunkData.chunkZ}`,
      blockCount: chunkData.blockCount || chunkData.blocks?.length || 0,
      bounds: chunkData.bounds || null,
      structureBounds: chunkData.structureBounds || null,
      materials: chunkData.materials || {},
      blocks: chunkData.blocks || []
    }

    const tmp = `${targetPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, targetPath)
    console.log(`[JOB-MANAGER] Stored local chunk JSON at: ${targetPath}`)
    return targetPath
  } catch (err) {
    console.error(`[JOB-MANAGER-WARN] Failed storing local chunk JSON: ${err.message}`)
    return null
  }
}

function deleteLocalChunkJson(localJsonPath) {
  if (!localJsonPath) return false
  try {
    if (fs.existsSync(localJsonPath)) {
      fs.unlinkSync(localJsonPath)
      console.log(`[JOB-MANAGER] Completed and deleted local chunk JSON: ${path.basename(localJsonPath)}`)
      return true
    }
  } catch (err) {
    console.error(`[JOB-MANAGER-WARN] Failed deleting local chunk JSON (${localJsonPath}): ${err.message}`)
  }
  return false
}

function loadPrintProgress() {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) return null
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
  } catch {
    return null
  }
}

function savePrintProgress(bot, details = {}) {
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true })
    const existing = loadPrintProgress() || {}
    const active = details.activeChunk !== undefined ? details.activeChunk : (bot?.activeChunkJob || existing.activeChunk || null)
    const placedBlocks = Number.isFinite(details.placedBlocks) ? details.placedBlocks
      : (bot?.placedBlocksCount ?? existing.activeChunk?.placedBlocks ?? 0)
    const totalBlocks = active?.blockCount || existing.activeChunk?.totalBlocks || 0
    const nextBlockIndex = Math.min(totalBlocks, placedBlocks)
    const nextBlock = active?.blocks?.[nextBlockIndex] || null

    const completed = Array.isArray(details.completedChunks) ? details.completedChunks
      : (Array.isArray(existing.completedChunks) ? existing.completedChunks : [])

    const progress = {
      schemaVersion: 1,
      botName: bot?.username || 'ComicBot',
      structureName: active?.structureName || existing.structureName || 'unnamed',
      anchor: active?.anchor || existing.anchor || null,
      status: details.status || existing.status || (active ? 'printing' : 'idle'),
      activeChunkKey: active?.key || existing.activeChunkKey || null,
      lastSavedAt: new Date().toISOString(),
      resumedCount: Number(existing.resumedCount || 0) + (details.isResumed ? 1 : 0),
      activeChunk: active ? {
        fileId: active.fileId || existing.activeChunk?.fileId || null,
        fileName: active.fileName || active.originalName || existing.activeChunk?.fileName || null,
        structureName: active.structureName || existing.structureName || null,
        anchor: active.anchor || existing.anchor || null,
        key: active.key || `${active.chunkX},${active.chunkZ}`,
        chunkX: active.chunkX,
        chunkZ: active.chunkZ,
        bounds: active.bounds || existing.activeChunk?.bounds || null,
        structureBounds: active.structureBounds || existing.activeChunk?.structureBounds || null,
        pathPlanVersion: active.pathPlanVersion || existing.activeChunk?.pathPlanVersion || null,
        blockCount: totalBlocks,
        localJsonPath: details.localJsonPath || active.localJsonPath || existing.activeChunk?.localJsonPath || null,
        totalBlocks,
        placedBlocks,
        remainingBlocks: Math.max(0, totalBlocks - placedBlocks),
        nextBlockIndex,
        nextBlock: nextBlock ? {
          x: nextBlock.x,
          y: nextBlock.y,
          z: nextBlock.z,
          name: nextBlock.name,
          state: nextBlock.state
        } : null,
        percent: totalBlocks > 0 ? Math.round((placedBlocks / totalBlocks) * 100) : 0
      } : null,
      completedChunks: completed,
      completedChunkKeys: completed.map((c) => typeof c === 'string' ? c : c.key).concat(Array.from(bot?.completedChunkKeys || [])),
      progress: {
        placedBlocks,
        totalBlocks,
        percent: totalBlocks > 0 ? Math.round((placedBlocks / totalBlocks) * 100) : 0
      }
    }

    const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(progress, null, 2), 'utf8')
    fs.renameSync(tmp, PROGRESS_FILE)
    if (bot) bot.__lastSavedPrintProgress = progress
    return progress
  } catch (err) {
    console.error(`[JOB-MANAGER-WARN] Failed saving print progress: ${err.message}`)
    return null
  }
}

function buildPlacementProgressSnapshot(bot, placed) {
  const previous = bot?.__lastSavedPrintProgress || {}
  const active = bot?.activeChunkJob || null
  const totalBlocks = Number(active?.blockCount || active?.blocks?.length || previous.activeChunk?.totalBlocks || 0)
  const nextBlockIndex = Math.min(totalBlocks, placed)
  const nextBlock = active?.blocks?.[nextBlockIndex] || null
  return {
    ...previous,
    status: 'printing',
    activeChunk: active ? {
      ...(previous.activeChunk || {}),
      placedBlocks: placed,
      remainingBlocks: Math.max(0, totalBlocks - placed),
      nextBlockIndex,
      nextBlock: nextBlock ? {
        x: nextBlock.x,
        y: nextBlock.y,
        z: nextBlock.z,
        name: nextBlock.name,
        state: nextBlock.state
      } : null,
      percent: totalBlocks > 0 ? Math.round((placed / totalBlocks) * 100) : 0
    } : null,
    progress: {
      placedBlocks: placed,
      totalBlocks,
      percent: totalBlocks > 0 ? Math.round((placed / totalBlocks) * 100) : 0
    }
  }
}

function updateChunkPlacementProgress(bot, blockIndex, blockInfo = null, options = {}) {
  const placed = blockIndex + 1
  if (bot) bot.placedBlocksCount = placed
  const totalBlocks = Number(bot?.activeChunkJob?.blockCount || bot?.activeChunkJob?.blocks?.length || 0)
  const saveEvery = Math.max(1, Math.floor(Number(bot?.config?.files?.progressSaveEvery || 1)))
  const shouldSave = options.force === true || !bot?.__lastSavedPrintProgress || placed >= totalBlocks || placed % saveEvery === 0
  if (!shouldSave) return buildPlacementProgressSnapshot(bot, placed)
  return savePrintProgress(bot, {
    placedBlocks: placed,
    status: 'printing'
  })
}

async function completeChunkJob(bot, config, chunkKey, options = {}) {
  const botName = String(config?.bot?.username || bot?.username || 'ComicBot').trim()
  const key = chunkKey || bot?.activeChunkJob?.key
  console.log(`[JOB-MANAGER] Marking chunk job ${key} completed...`)

  const progress = loadPrintProgress() || {}
  const active = bot?.activeChunkJob || progress.activeChunk
  const localJsonPath = options.localJsonPath || active?.localJsonPath

  // 1. Report to dashboard
  const fileId = options.fileId || bot?.activeChunkJob?.fileId
  if (fileId && config) {
    try {
      await reportQueueResult(config, botName, fileId, 'completed')
    } catch (err) {
      console.log(`[JOB-MANAGER-WARN] Failed reporting chunk completion to dashboard: ${err.message}`)
    }
  }

  // 2. Delete local JSON file once completed
  if (localJsonPath) {
    deleteLocalChunkJson(localJsonPath)
  } else if (active) {
    const base = String(active.structureName || 'structure').replace(/\.[^.]+$/, '')
    const fallbackPath = path.join(ACTIVE_CHUNKS_DIR, `${base}_chunk_${active.chunkX}_${active.chunkZ}.json`)
    deleteLocalChunkJson(fallbackPath)
  }

  // 3. Update progress file
  const completedList = Array.isArray(progress.completedChunks) ? progress.completedChunks : []
  if (active && !completedList.some((c) => c.key === active.key)) {
    completedList.push({
      key: active.key,
      chunkX: active.chunkX,
      chunkZ: active.chunkZ,
      blockCount: active.totalBlocks || active.blockCount || 0,
      completedAt: new Date().toISOString()
    })
  }

  savePrintProgress(bot, {
    activeChunk: null,
    status: 'completed',
    completedChunks: completedList
  })

  if (bot?.loadedChunkJobs) {
    bot.loadedChunkJobs.delete(key)
  }
  if (bot?.completedChunkKeys) {
    bot.completedChunkKeys.add(key)
  }
  if (bot) {
    bot.activeChunkJob = null
    bot.placedBlocksCount = 0
  }
  bot?.emit?.('chunkCompleted', { key })
  console.log(`[JOB-MANAGER] Chunk ${key} finalized. Progress file updated.`)
}

async function autoRecoverActiveJob(bot, config, options = {}) {
  const autoRecoverEnabled = options.autoRecover !== false && config?.autoRecover !== false && config?.printer?.autoRecover !== false
  if (!autoRecoverEnabled) {
    console.log('[AUTO-RECOVER] Auto-recover is disabled by configuration.')
    return { recovered: false }
  }

  console.log('[AUTO-RECOVER] Checking progress file for incomplete active chunk...')
  const progress = loadPrintProgress()
  if (!progress || !progress.activeChunk) {
    console.log('[AUTO-RECOVER] No incomplete active chunk found in progress file.')
    return { recovered: false, progress }
  }

  const active = progress.activeChunk
  if (active.remainingBlocks <= 0) {
    console.log(`[AUTO-RECOVER] Active chunk ${active.key} is already fully placed; skipping recovery.`)
    return { recovered: false, progress }
  }
  const completedList = Array.isArray(progress.completedChunks) ? progress.completedChunks : []
  if (completedList.some((c) => (c.key || c) === active.key)) {
    console.log(`[AUTO-RECOVER] Active chunk ${active.key} is already recorded in completedChunks; skipping recovery.`)
    savePrintProgress(bot, { activeChunk: null, status: 'completed' })
    return { recovered: false, progress }
  }

  console.log(`[AUTO-RECOVER] Found incomplete chunk ${active.key}: ${active.placedBlocks}/${active.totalBlocks} blocks placed (${active.remainingBlocks} remaining).`)

  // 1. Try to load the locally stored chunk JSON
  let chunkData = null
  let localPath = active.localJsonPath
  if (!localPath || !fs.existsSync(localPath)) {
    const base = String(progress.structureName || 'structure').replace(/\.[^.]+$/, '')
    const candidate = path.join(ACTIVE_CHUNKS_DIR, `${base}_chunk_${active.chunkX}_${active.chunkZ}.json`)
    if (fs.existsSync(candidate)) localPath = candidate
  }

  if (localPath && fs.existsSync(localPath)) {
    try {
      const buffer = fs.readFileSync(localPath)
      chunkData = parseChunkSliceData(buffer, path.basename(localPath))
      if (chunkData) {
        chunkData.fileId = chunkData.fileId || active.fileId || null
        chunkData.fileName = chunkData.fileName || active.fileName || null
      }
      console.log(`[AUTO-RECOVER] Successfully loaded chunk JSON locally from ${localPath}.`)
    } catch (err) {
      console.error(`[AUTO-RECOVER-WARN] Failed reading local chunk JSON (${localPath}): ${err.message}`)
    }
  }

  // 2. If local JSON was missing or corrupted, re-acquire lease from dashboard
  if (!chunkData && config) {
    console.log(`[AUTO-RECOVER] Local chunk JSON missing; checking dashboard lease recovery...`)
    const botName = String(config.bot?.username || bot?.username || 'ComicBot').trim()
    try {
      const claimRes = await claimQueueChunks(config, botName, 1)
      if (claimRes.items?.length > 0) {
        const item = claimRes.items[0]
        const buffer = await downloadQueueFile(config, botName, item.fileId)
        chunkData = parseChunkSliceData(buffer, item.originalName)
        if (chunkData) {
          localPath = storeLocalChunkJson(chunkData)
          chunkData.fileId = item.fileId
        }
      }
    } catch (err) {
      console.error(`[AUTO-RECOVER-WARN] Dashboard lease recovery failed: ${err.message}`)
    }
  }

  if (!chunkData) {
    console.error(`[AUTO-RECOVER-ERROR] Could not recover chunk data for ${active.key}.`)
    return { recovered: false, progress }
  }

  // 3. Restore state into bot
  chunkData.localJsonPath = localPath
  if (bot) {
    bot.activeChunkJob = chunkData
    bot.loadedChunkJobs = bot.loadedChunkJobs || new Map()
    bot.loadedChunkJobs.set(chunkData.key, chunkData)
    bot.placedBlocksCount = active.placedBlocks || 0
  }

  // 4. Update progress file with resumed state
  const updatedProgress = savePrintProgress(bot, {
    activeChunk: chunkData,
    placedBlocks: active.placedBlocks || 0,
    status: 'recovering',
    localJsonPath: localPath,
    isResumed: true
  })

  console.log(`[AUTO-RECOVER] SUCCESS: Resumed chunk ${active.key} at block index ${active.nextBlockIndex} (${active.nextBlock?.name || 'block'} at ${active.nextBlock?.x},${active.nextBlock?.y},${active.nextBlock?.z}). Status=recovering, remaining=${active.remainingBlocks} blocks.`)
  bot?.emit?.('jobAutoRecovered', { chunk: chunkData, progress: updatedProgress })
  return { recovered: true, chunkData, progress: updatedProgress }
}

async function pullAndLoadChunkJobs(bot, config, options = {}) {
  const botName = String(config.bot?.username || bot?.username || 'ComicBot').trim()
  const limit = Math.max(1, Math.min(10, Math.floor(Number(options.limit || 1))))
  console.log(`[JOB-MANAGER] ${botName} pulling up to ${limit} chunk job(s) from queue...`)

  const { items, batchPolicy } = await claimQueueChunks(config, botName, limit)
  if (items.length === 0) {
    console.log(`[JOB-MANAGER] No pending chunk jobs in queue for ${botName}.`)
    return { claimedCount: 0, items: [], loadedChunks: [] }
  }

  console.log(`[JOB-MANAGER] ${botName} claimed ${items.length} chunk job(s): ${items.map((i) => i.originalName).join(', ')}`)
  const loadedChunks = []
  bot.loadedChunkJobs = bot.loadedChunkJobs || new Map()

  for (const item of items) {
    try {
      console.log(`[JOB-MANAGER] Downloading ${item.originalName} (${item.fileId})...`)
      const buffer = await downloadQueueFile(config, botName, item.fileId)

      let chunkData = parseChunkSliceData(buffer, item.originalName)
      if (!chunkData) {
        const anchor = options.anchor || item.metadata?.anchor || { x: -355, y: 66, z: -88 }
        const parsed = await parseSchematicBuffer(buffer, item.originalName)
        const slices = sliceSchematicIntoChunks(parsed, anchor)
        chunkData = slices[0] || null
      }

      if (!chunkData || !Array.isArray(chunkData.blocks) || chunkData.blocks.length === 0) {
        throw new Error(`Loaded chunk slice ${item.originalName} contains no printable blocks`)
      }

      // 1. Store chunk JSON locally on disk
      chunkData.fileId = item.fileId
      chunkData.fileName = item.originalName
      chunkData.originalName = item.originalName
      const localJsonPath = storeLocalChunkJson(chunkData)
      chunkData.localJsonPath = localJsonPath

      const chunkKey = chunkData.key || `${chunkData.chunkX},${chunkData.chunkZ}`
      bot.loadedChunkJobs.set(chunkKey, {
        fileId: item.fileId,
        fileName: item.originalName,
        claimedAt: new Date().toISOString(),
        localJsonPath,
        ...chunkData
      })
      loadedChunks.push(chunkData)

      if (!bot.activeChunkJob) {
        bot.activeChunkJob = chunkData
        bot.placedBlocksCount = 0
      }

      // 2. Save progress file
      savePrintProgress(bot, {
        activeChunk: chunkData,
        status: 'downloaded',
        localJsonPath
      })

      // 3. Complete chunk or report downloaded
      if (options.deliveryStatus === 'completed') {
        await completeChunkJob(bot, config, chunkKey, { fileId: item.fileId, localJsonPath })
      } else {
        await reportQueueResult(config, botName, item.fileId, options.deliveryStatus || 'downloaded')
      }

      console.log(`[JOB-MANAGER] ${botName} loaded chunk ${chunkData.chunkX},${chunkData.chunkZ} (${chunkData.blockCount} blocks) at anchor ${chunkData.anchor.x},${chunkData.anchor.y},${chunkData.anchor.z}.`)
      bot.emit('chunkJobLoaded', chunkData)
    } catch (error) {
      console.error(`[JOB-MANAGER-ERROR] Failed loading chunk ${item.originalName}: ${error.message}`)
      await reportQueueResult(config, botName, item.fileId, 'failed', error.message).catch(() => {})
      throw error
    }
  }

  return { claimedCount: items.length, items, loadedChunks, batchPolicy }
}

function getLoadedChunkJobs(bot) {
  if (!bot?.loadedChunkJobs) return []
  return Array.from(bot.loadedChunkJobs.values())
}

function saveJobCheckpoint(bot, details = {}) {
  return savePrintProgress(bot, details)
}

function loadJobCheckpoint(bot) {
  const state = loadPrintProgress()
  if (state && bot) {
    if (state.completedChunkKeys) {
      bot.completedChunkKeys = new Set(state.completedChunkKeys)
    }
    if (state.activeChunk) {
      bot.activeChunkJob = state.activeChunk
      bot.loadedChunkJobs = bot.loadedChunkJobs || new Map()
      bot.loadedChunkJobs.set(state.activeChunk.key, state.activeChunk)
      bot.placedBlocksCount = state.progress?.placedBlocks ?? 0
    }
  }
  return state
}

async function recoverActiveJobsOnStartup(bot, config) {
  return autoRecoverActiveJob(bot, config)
}

module.exports = {
  ACTIVE_CHUNKS_DIR,
  PROGRESS_FILE,
  CHECKPOINT_FILE,
  getDashboardConfig,
  claimQueueChunks,
  claimQueueChunkById,
  downloadQueueFile,
  reportQueueResult,
  parseChunkSliceData,
  storeLocalChunkJson,
  deleteLocalChunkJson,
  loadPrintProgress,
  savePrintProgress,
  updateChunkPlacementProgress,
  completeChunkJob,
  autoRecoverActiveJob,
  pullAndLoadChunkJobs,
  getLoadedChunkJobs,
  saveJobCheckpoint,
  loadJobCheckpoint,
  recoverActiveJobsOnStartup
}






