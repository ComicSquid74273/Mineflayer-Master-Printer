'use strict'

const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config')
const { createBot } = require('../src/connection-manager')
const { pullAndLoadChunkJobs, getLoadedChunkJobs } = require('../src/job-manager')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function uploadTestSchematic(serviceUrl, filePath, anchor) {
  const fileName = path.basename(filePath)
  const fileBuffer = fs.readFileSync(filePath)
  console.log(`[LIVE-LOAD] Uploading ${fileName} (${fileBuffer.length} bytes) to ${serviceUrl} at anchor ${anchor.x},${anchor.y},${anchor.z}...`)

  // Log in as admin
  const adminPassword = String(process.env.DASHBOARD_ADMIN_PASSWORD || '').trim()
  if (!adminPassword) throw new Error('Set DASHBOARD_ADMIN_PASSWORD (dashboard admin password from dashboard-service/data/operators.json) before running this script')
  const loginRes = await fetch(`${serviceUrl}/api/dashboard/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword })
  })
  if (!loginRes.ok) throw new Error(`Dashboard login failed: HTTP ${loginRes.status}`)
  const cookie = String(loginRes.headers.get('set-cookie') || '').split(';')[0]

  const form = new FormData()
  form.append('files', new Blob([fileBuffer]), fileName)
  form.append('maxAttempts', '3')
  form.append('anchorX', String(anchor.x))
  form.append('anchorY', String(anchor.y))
  form.append('anchorZ', String(anchor.z))

  const uploadRes = await fetch(`${serviceUrl}/api/dashboard/uploads`, {
    method: 'POST',
    headers: { cookie },
    body: form
  })
  if (!uploadRes.ok) {
    const text = await uploadRes.text()
    throw new Error(`Upload failed HTTP ${uploadRes.status}: ${text}`)
  }
  const result = await uploadRes.json()
  console.log(`[LIVE-LOAD] Upload succeeded: ${result.items?.length || 0} chunk slice(s) queued.`)
  return result
}

async function main() {
  const config = loadConfig()
  config.bot.reconnect = { ...(config.bot.reconnect || {}), enabled: false }
  const serviceUrl = config.dashboard?.serviceUrl || 'http://127.0.0.1:4080'
  const anchor = { x: -355, y: 66, z: -88 }
  const schemPath = path.resolve(__dirname, '../assets/schematics/cityfountain.schem')

  // Step 1: Upload the schematic with anchor -355, 66, -88
  const uploadResult = await uploadTestSchematic(serviceUrl, schemPath, anchor)
  const chunkItems = uploadResult.items || []
  if (chunkItems.length !== 4) {
    throw new Error(`Expected 4 chunk slices for cityfountain.schem, got ${chunkItems.length}`)
  }

  console.log('[LIVE-LOAD] Sliced chunks in dashboard queue:')
  for (const item of chunkItems) {
    console.log(`  - ${item.originalName}: fileId=${item.fileId}`)
  }

  // Step 2: Connect ComicBot to test server and pull chunk jobs
  console.log(`[LIVE-LOAD] Connecting ${config.bot.username} to ${config.bot.host}:${config.bot.port}...`)
  const bot = createBot(config)

  bot.once('spawn', async () => {
    try {
      await delay(2000)
      console.log(`[LIVE-LOAD] ${bot.username} spawned at ${bot.entity.position}`)

      // Pull chunks in batches (testing limit=2, then limit=5 as user requested: "pull 1 or 2 or 5 chunks")
      let round = 0
      while (true) {
        round++
        const limit = round === 1 ? 2 : 5
        const pullResult = await pullAndLoadChunkJobs(bot, config, { limit, anchor, deliveryStatus: 'completed' })
        if (pullResult.claimedCount === 0) {
          console.log('[LIVE-LOAD] All queued chunk jobs have been claimed and processed.')
          break
        }
        await delay(250)
      }

      const allLoaded = getLoadedChunkJobs(bot)
      console.log(`\n[LIVE-LOAD] Unique chunk jobs loaded in bot memory: ${allLoaded.length}`)

      const expectedKeys = ['-23,-6', '-23,-5', '-22,-6', '-22,-5']
      for (const key of expectedKeys) {
        const found = allLoaded.find((c) => c.key === key)
        if (!found) throw new Error(`Missing expected chunk ${key} in bot loaded memory!`)
        console.log(`  * Chunk ${found.key}: ${found.blockCount} blocks, bounds: X[${found.bounds?.minX}..${found.bounds?.maxX}] Y[${found.bounds?.minY}..${found.bounds?.maxY}] Z[${found.bounds?.minZ}..${found.bounds?.maxZ}]`)
      }

      const cityFountainChunks = allLoaded.filter((c) => c.structureName === 'cityfountain.schem' || c.fileName?.includes('cityfountain'))
      const totalBlocks = cityFountainChunks.reduce((sum, c) => sum + c.blockCount, 0)
      console.log(`[LIVE-LOAD] Total blocks across cityfountain chunks: ${totalBlocks} (expected 470)`)
      if (totalBlocks !== 470) {
        throw new Error(`Expected exactly 470 blocks loaded across cityfountain chunks, got ${totalBlocks}`)
      }

      // Verify that pulling again yields 0 because all chunks are assigned/claimed
      console.log('[LIVE-LOAD] Verifying queue exhaustion (should return 0)...')
      const emptyBatch = await pullAndLoadChunkJobs(bot, config, { limit: 1, anchor })
      if (emptyBatch.claimedCount !== 0) {
        throw new Error(`Expected 0 claimed items from exhausted queue, got ${emptyBatch.claimedCount}`)
      }
      console.log('[LIVE-LOAD] Confirmed: No duplicate chunk assignments.')

      console.log('\n[LIVE-LOAD] SUCCESS! Bot successfully loaded all litematic/schematic chunk data from dashboard.')
      bot.quit('Live test passed')
      process.exit(0)
    } catch (error) {
      console.error('[LIVE-LOAD-ERROR]', error)
      try { bot.quit('Live test failed') } catch { }
      process.exit(1)
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

