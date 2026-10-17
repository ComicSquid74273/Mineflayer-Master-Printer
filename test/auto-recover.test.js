'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineflayer-printer-auto-recover-'))
process.env.PRINTER_STATE_DIR = testStateDir
const {
  storeLocalChunkJson,
  deleteLocalChunkJson,
  savePrintProgress,
  loadPrintProgress,
  updateChunkPlacementProgress,
  completeChunkJob,
  autoRecoverActiveJob,
  PROGRESS_FILE,
  ACTIVE_CHUNKS_DIR
} = require('../src/job-manager')

test.after(() => fs.rmSync(testStateDir, { recursive: true, force: true }))

test('local chunk json is stored on disk and deleted once complete', async () => {
  try { fs.unlinkSync(PROGRESS_FILE) } catch { }
  const sampleChunk = {
    fileId: 'queue-file-123',
    fileName: 'cityfountain_chunk_-23_-6.json',
    structureName: 'cityfountain.schem',
    chunkX: -23,
    chunkZ: -6,
    key: '-23,-6',
    anchor: { x: -355, y: 66, z: -88 },
    blockCount: 4,
    materials: { stone: 4 },
    blocks: [
      { x: -355, y: 66, z: -88, name: 'stone', state: 'minecraft:stone' },
      { x: -354, y: 66, z: -88, name: 'stone', state: 'minecraft:stone' },
      { x: -353, y: 66, z: -88, name: 'stone', state: 'minecraft:stone' },
      { x: -352, y: 66, z: -88, name: 'stone', state: 'minecraft:stone' }
    ]
  }

  // 1. Store chunk JSON locally
  const localJsonPath = storeLocalChunkJson(sampleChunk)
  assert.ok(localJsonPath, 'localJsonPath must be returned')
  assert.ok(fs.existsSync(localJsonPath), 'Local chunk JSON file must exist on disk')

  const parsedDisk = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'))
  assert.equal(parsedDisk.chunkX, -23)
  assert.equal(parsedDisk.fileId, 'queue-file-123')
  assert.equal(parsedDisk.fileName, 'cityfountain_chunk_-23_-6.json')
  assert.equal(parsedDisk.chunkZ, -6)
  assert.equal(parsedDisk.blockCount, 4)
  assert.equal(parsedDisk.blocks.length, 4)

  // 2. Initialize progress file
  const mockBot = {
    username: 'ComicBot',
    activeChunkJob: sampleChunk,
    placedBlocksCount: 0,
    loadedChunkJobs: new Map([[sampleChunk.key, sampleChunk]])
  }

  const initialProgress = savePrintProgress(mockBot, {
    activeChunk: sampleChunk,
    status: 'printing',
    localJsonPath
  })

  assert.equal(initialProgress.status, 'printing')
  assert.equal(initialProgress.activeChunk.totalBlocks, 4)
  assert.equal(initialProgress.activeChunk.placedBlocks, 0)
  assert.equal(initialProgress.activeChunk.remainingBlocks, 4)
  assert.equal(initialProgress.activeChunk.nextBlockIndex, 0)
  assert.equal(initialProgress.activeChunk.nextBlock.x, -355)

  // 3. Simulate placing 2 blocks
  updateChunkPlacementProgress(mockBot, 0) // block 0 placed -> 1 placed
  const midProgress = updateChunkPlacementProgress(mockBot, 1) // block 1 placed -> 2 placed

  assert.equal(midProgress.activeChunk.placedBlocks, 2)
  assert.equal(midProgress.activeChunk.remainingBlocks, 2)
  assert.equal(midProgress.activeChunk.percent, 50)
  assert.equal(midProgress.activeChunk.nextBlockIndex, 2)
  assert.equal(midProgress.activeChunk.nextBlock.x, -353) // 3rd block is at -353

  // 4. Simulate a sudden crash! Create a fresh restarted bot instance with zero memory
  const crashedRestartedBot = {
    username: 'ComicBot'
  }

  const recoveryResult = await autoRecoverActiveJob(crashedRestartedBot, { autoRecover: true })
  assert.equal(recoveryResult.recovered, true)
  assert.equal(crashedRestartedBot.activeChunkJob.chunkX, -23)
  assert.equal(crashedRestartedBot.activeChunkJob.chunkZ, -6)
  assert.equal(crashedRestartedBot.activeChunkJob.fileId, 'queue-file-123')
  assert.equal(crashedRestartedBot.activeChunkJob.fileName, 'cityfountain_chunk_-23_-6.json')
  assert.equal(crashedRestartedBot.placedBlocksCount, 2)

  const recoveredProgress = recoveryResult.progress
  assert.equal(recoveredProgress.status, 'recovering')
  assert.equal(recoveredProgress.resumedCount, 1)
  assert.equal(recoveredProgress.activeChunk.placedBlocks, 2)
  assert.equal(recoveredProgress.activeChunk.remainingBlocks, 2)
  assert.equal(recoveredProgress.activeChunk.nextBlockIndex, 2)
  assert.equal(recoveredProgress.activeChunk.nextBlock.x, -353)
  assert.equal(recoveredProgress.activeChunk.nextBlock.name, 'stone')

  // 5. Simulate placing remaining blocks and completing the chunk
  updateChunkPlacementProgress(crashedRestartedBot, 2)
  updateChunkPlacementProgress(crashedRestartedBot, 3)

  // 6. Complete chunk job -> must delete local JSON file!
  await completeChunkJob(crashedRestartedBot, null, '-23,-6', { localJsonPath })

  assert.equal(fs.existsSync(localJsonPath), false, 'Local chunk JSON file must be deleted once complete')

  const finalProgress = loadPrintProgress()
  assert.equal(finalProgress.status, 'completed')
  assert.equal(finalProgress.activeChunk, null)
  assert.equal(finalProgress.completedChunks.length, 1)
  assert.equal(finalProgress.completedChunks[0].key, '-23,-6')

  // Clean up progress file
  try { fs.unlinkSync(PROGRESS_FILE) } catch { }
})

test('placement progress batches durable writes using files.progressSaveEvery', () => {
  try { fs.unlinkSync(PROGRESS_FILE) } catch {}
  const chunk = {
    structureName: 'throughput-test',
    key: '0,0',
    chunkX: 0,
    chunkZ: 0,
    blockCount: 4,
    blocks: [
      { x: 0, y: 64, z: 0, name: 'stone' },
      { x: 1, y: 64, z: 0, name: 'stone' },
      { x: 2, y: 64, z: 0, name: 'stone' },
      { x: 3, y: 64, z: 0, name: 'stone' }
    ]
  }
  const bot = {
    username: 'ComicBot',
    config: { files: { progressSaveEvery: 3 } },
    activeChunkJob: chunk,
    placedBlocksCount: 0
  }
  savePrintProgress(bot, { activeChunk: chunk, status: 'printing' })

  const first = updateChunkPlacementProgress(bot, 0)
  const second = updateChunkPlacementProgress(bot, 1)
  assert.equal(first.activeChunk.placedBlocks, 1)
  assert.equal(second.activeChunk.placedBlocks, 2)
  assert.equal(loadPrintProgress().activeChunk.placedBlocks, 0)

  updateChunkPlacementProgress(bot, 2)
  assert.equal(loadPrintProgress().activeChunk.placedBlocks, 3)
  updateChunkPlacementProgress(bot, 3)
  assert.equal(loadPrintProgress().activeChunk.placedBlocks, 4)
  try { fs.unlinkSync(PROGRESS_FILE) } catch {}
})

