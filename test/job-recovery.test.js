'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineflayer-printer-job-recovery-'))
process.env.PRINTER_STATE_DIR = testStateDir
const {
  saveJobCheckpoint,
  loadJobCheckpoint,
  CHECKPOINT_FILE
} = require('../src/job-manager')

test.after(() => fs.rmSync(testStateDir, { recursive: true, force: true }))

test('saveJobCheckpoint and loadJobCheckpoint retain active chunk and progress across restarts', () => {
  // Mock bot running before crash
  const mockBot = {
    username: 'ComicBot',
    jobStatus: 'printing',
    activeChunkJob: {
      key: '-23,-6',
      chunkX: -23,
      chunkZ: -6,
      structureName: 'cityfountain.schem',
      blockCount: 30,
      anchor: { x: -355, y: 66, z: -88 }
    },
    loadedChunkJobs: new Map([
      ['-23,-6', { key: '-23,-6', chunkX: -23, chunkZ: -6, blockCount: 30 }],
      ['-23,-5', { key: '-23,-5', chunkX: -23, chunkZ: -5, blockCount: 33 }]
    ]),
    completedChunkKeys: new Set(['-22,-6']),
    placedBlocksCount: 18
  }

  const saved = saveJobCheckpoint(mockBot, { placedBlocks: 18, status: 'printing' })
  assert.ok(saved)
  assert.equal(saved.botName, 'ComicBot')
  assert.equal(saved.activeChunkKey, '-23,-6')
  assert.equal(saved.progress.placedBlocks, 18)
  assert.equal(saved.progress.totalBlocks, 30)
  assert.equal(saved.progress.percent, 60)
  assert.deepEqual(saved.completedChunkKeys, ['-22,-6'])

  // Simulate complete bot crash and fresh startup with empty in-memory state
  const freshRestartedBot = {
    username: 'ComicBot'
  }

  const recovered = loadJobCheckpoint(freshRestartedBot)
  assert.ok(recovered)
  assert.equal(recovered.activeChunkKey, '-23,-6')
  assert.equal(freshRestartedBot.activeChunkJob.chunkX, -23)
  assert.equal(freshRestartedBot.activeChunkJob.chunkZ, -6)
  assert.equal(freshRestartedBot.activeChunkJob.blockCount, 30)
  assert.equal(freshRestartedBot.placedBlocksCount, 18)
  assert.ok(freshRestartedBot.completedChunkKeys.has('-22,-6'))
  assert.ok(freshRestartedBot.loadedChunkJobs.has('-23,-6'))

  // Clean up test file
  try { fs.unlinkSync(CHECKPOINT_FILE) } catch { }
})
