'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const {
  buildStructureBoundsByName,
  canAutoStartAtCurrentPosition,
  checkAutoStartPrinting,
  ensureBotGears,
  getDashboardDataDir,
  queueRecordMatchesBot,
  restoreChunkPlanningMetadata,
  selectNextChunkForPrinting,
  startEmergencyElytraMonitor,
  stopPrinting,
  teleportMissingGearBotToStation
} = require('../src/printer-runtime')

test('fleet bot folders prefer the shared dashboard data directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'printer-dashboard-data-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const shared = path.join(parent, 'Mineflayer-Master-Printer', 'dashboard-service', 'data')
  const fleet = path.join(parent, 'Mineflayer-Master-Printer-ComicBot01')
  const stale = path.join(fleet, 'dashboard-service', 'data')
  fs.mkdirSync(shared, { recursive: true })
  fs.mkdirSync(stale, { recursive: true })

  assert.equal(getDashboardDataDir(fleet, null), shared)
})

test('buildStructureBoundsByName restores global bounds for legacy chunk payloads', () => {
  const bounds = buildStructureBoundsByName([
    { structureName: 'robot.schem', bounds: { minX: 0, maxX: 15, minY: 66, maxY: 214, minZ: 0, maxZ: 15 } },
    { structureName: 'robot.schem', bounds: { minX: 16, maxX: 31, minY: 80, maxY: 319, minZ: 16, maxZ: 31 } }
  ]).get('robot.schem')

  assert.deepEqual(bounds, { minX: 0, maxX: 31, minY: 66, maxY: 319, minZ: 0, maxZ: 31 })
})

test('restoreChunkPlanningMetadata keeps derived global bounds after dashboard download', () => {
  const restored = restoreChunkPlanningMetadata(
    { key: '1,2', structureBounds: null },
    { bounds: { maxY: 200 }, structureBounds: { maxY: 290 } }
  )

  assert.deepEqual(restored.bounds, { maxY: 200 })
  assert.deepEqual(restored.structureBounds, { maxY: 290 })
})

test('queueRecordMatchesBot rejects chunks assigned or actively claimed by another bot', () => {
  assert.equal(queueRecordMatchesBot({ targetBotName: 'ComicBot' }, 'ComicBot'), true)
  assert.equal(queueRecordMatchesBot({ assignedBotName: 'ComicBot01' }, 'ComicBot01'), true)
  assert.equal(queueRecordMatchesBot({ targetBotName: 'ComicBot01' }, 'ComicBot'), false)
  assert.equal(queueRecordMatchesBot({ queueStatus: 'printing', claimedByBotName: 'ComicBot01' }, 'ComicBot'), false)
  assert.equal(queueRecordMatchesBot({ queueStatus: 'printing', claimedByBotName: 'ComicBot', assignedBotName: 'ComicBot01' }, 'ComicBot'), true)
  assert.equal(queueRecordMatchesBot({ queueStatus: 'pending' }, 'ComicBot'), true)
})

test('ensureBotGears returns ready when bot already has pickaxe, elytra, and golden apples', async () => {
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'netherite_pickaxe', slot: 36 },
        { name: 'golden_apple', count: 64, slot: 9 }
      ],
      slots: {
        6: { name: 'elytra' }
      }
    },
    getEquipmentDestSlot: () => 6
  }

  const result = await ensureBotGears(mockBot, {}, {})
  assert.equal(result.ready, true)
})

test('missing-Elytra recovery stands still and uses home platform', async () => {
  const messages = []
  const anchor = { x: -326, y: 97, z: -100 }
  const bot = {
    entity: {
      onGround: true,
      position: new Vec3(-461.5, 68, -432.5),
      velocity: { set: () => {} }
    },
    pathfinder: { setGoal: () => {} },
    clearControlStates: () => {},
    chat: (message) => {
      messages.push(message)
      setTimeout(() => { bot.entity.position = new Vec3(-326, 98, -100) }, 20)
    }
  }

  assert.equal(await teleportMissingGearBotToStation(bot, anchor, 500), true)
  assert.deepEqual(messages, ['/home platform'])
})

test('low-durability monitor immediately interrupts printing and starts emergency return', async () => {
  let returns = 0
  let phase = null
  const bot = {
    __printingChunkActive: true,
    inventory: { slots: { 6: { name: 'elytra', maxDurability: 432, durabilityUsed: 423 } } }
  }
  const stop = startEmergencyElytraMonitor(bot, { x: -326, y: 97, z: -100 }, {
    setPhase: (nextPhase) => { phase = nextPhase },
    postStatus: async () => {}
  }, {
    intervalMs: 50,
    returnToStation: async () => { returns += 1; return true }
  })

  await bot.__elytraEmergencyReturnPromise
  stop()
  assert.equal(bot.__interruptPrintRequested, true)
  assert.equal(bot.__elytraEmergencyRestockRequested, true)
  assert.equal(returns, 1)
  assert.equal(phase, 'emergency-restock')
})

test('stopPrinting sets stop flags and pauses dashboard phase', () => {
  const mockBot = {
    __stopPrintingRequested: false,
    __interruptPrintRequested: false
  }
  let pausedPhase = null
  const mockDashboard = {
    setPhase: (p, reason) => { pausedPhase = { p, reason } }
  }

  const result = stopPrinting(mockBot, mockDashboard, 'operator requested stop')
  assert.equal(result.stopped, true)
  assert.equal(mockBot.__stopPrintingRequested, true)
  assert.equal(mockBot.__interruptPrintRequested, true)
  assert.equal(pausedPhase.p, 'paused')
  assert.equal(pausedPhase.reason, 'operator requested stop')
})

test('checkAutoStartPrinting returns false when bot is outside restock platform bounds', () => {
  const mockBot = {
    username: 'ComicBot',
    entity: {
      position: new Vec3(1000, 100, 1000) // Far away from platform (-326, 97, -100)
    }
  }
  const config = {
    storageRegistration: { anchor: { x: -326, y: 97, z: -100 } }
  }
  const dashboard = { state: { phase: 'idle' } }

  const started = checkAutoStartPrinting(mockBot, config, dashboard)
  assert.equal(started, false)
})

test('checkAutoStartPrinting honors failure backoff before reading queue work', () => {
  const mockBot = {
    username: 'ComicBot',
    __printingAutoRetryAt: Date.now() + 5000,
    entity: { position: new Vec3(-325.5, 98, -99.5) }
  }

  assert.equal(checkAutoStartPrinting(mockBot, { storageRegistration: { anchor: { x: -326, y: 97, z: -100 } } }, { state: { phase: 'error' } }), false)
})

test('recovered chunks may auto-resume outside restock bounds', () => {
  const mockBot = {
    activeChunkJob: { key: '-20,-2' },
    entity: { position: new Vec3(-310, 195, -26) }
  }
  assert.equal(canAutoStartAtCurrentPosition(mockBot, { x: -326, y: 97, z: -100 }), true)
})

test('selectNextChunkForPrinting always prioritizes the recovered active chunk', () => {
  const eligibleChunks = [
    { record: { fileId: 'new' }, chunkData: { key: '-20,0' } },
    { record: { fileId: 'recovered' }, chunkData: { key: '-20,-1' } }
  ]
  const selected = selectNextChunkForPrinting({ activeChunkJob: { fileId: 'recovered', key: '-20,-1' } }, eligibleChunks)
  assert.equal(selected.record.fileId, 'recovered')
})

test('selectNextChunkForPrinting refuses a new chunk when recovered work is absent', () => {
  const eligibleChunks = [{ record: { fileId: 'new' }, chunkData: { key: '-20,0' } }]
  const selected = selectNextChunkForPrinting({ activeChunkJob: { fileId: 'recovered', key: '-20,-1' } }, eligibleChunks)
  assert.equal(selected, null)
})

test('dashboardClient addChat formats entries with both ts/at and text/message', () => {
  const { createDashboardClient } = require('../src/dashboard-client')
  const mockBot = {
    username: 'ComicBot',
    on: () => {},
    once: () => {}
  }
  const config = {
    dashboard: { enabled: true, serviceUrl: 'http://127.0.0.1:4080' },
    connection: { active: 'testserver' }
  }

  const client = createDashboardClient(mockBot, config)
  client.addChat('Hello world')

  assert.equal(client.state.recentChat.length, 1)
  const entry = client.state.recentChat[0]
  assert.equal(entry.text, 'Hello world')
  assert.equal(entry.message, 'Hello world')
  assert.ok(entry.ts)
  assert.ok(entry.at)
})
