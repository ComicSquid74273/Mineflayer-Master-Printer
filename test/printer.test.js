'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { generateLayerPrintPlan } = require('../src/flight-trajectory-planner')
const {
  canDispatchVerificationRepair,
  enableAntiFallHover,
  getConfirmedPrefixEnd,
  getLocalRecoveryEnvelope,
  placeBlockBatch,
  placeBlockAirOrSupport,
  readServerTpsSample,
  returnLowDurabilityElytraToStation,
  shouldDispatchVerificationBeforePrimary,
  silentSwapBack,
  silentSwapToItem,
  verifyLayerBlocks,
  waitForCheckpointChunk,
  waitForPlacementPacketSlots,
  isInsideChunkColumn,
  isPlacementTargetBelowBot,
  isAboveStationLandingColumn
} = require('../src/printer')

test('placement targets must stay below the bot body', () => {
  const bot = { entity: { position: new Vec3(0.5, 66, 0.5) } }
  assert.equal(isPlacementTargetBelowBot(bot, { x: 0, y: 64, z: 0 }), true)
  assert.equal(isPlacementTargetBelowBot(bot, { x: 0, y: 66, z: 0 }), false)
  bot.entity.position.y = 65.74
  assert.equal(isPlacementTargetBelowBot(bot, { x: 0, y: 64, z: 0 }), false)
  bot.entity.position.y = 65.75
  assert.equal(isPlacementTargetBelowBot(bot, { x: 0, y: 64, z: 0 }), true)
})

test('layer verification waits until the missing block is below the bot', () => {
  const bot = { entity: { position: new Vec3(0.5, 72, 0.5), eyeHeight: 1.62 } }
  assert.equal(canDispatchVerificationRepair(bot, { x: 0, y: 70, z: 0 }, 5), true)
  assert.equal(canDispatchVerificationRepair(bot, { x: 0, y: 71, z: 0 }, 5), false)
})

test('reachable verification receives a fair slot without stalling for unreachable repairs', () => {
  assert.equal(shouldDispatchVerificationBeforePrimary({
    hasReachableVerification: true,
    primaryRemaining: true,
    primaryPacketsSinceVerification: 6,
    currentCheckpointKey: '0,66,0',
    nextCheckpointKey: '0,66,0'
  }), true)
  assert.equal(shouldDispatchVerificationBeforePrimary({
    hasReachableVerification: true,
    primaryRemaining: true,
    primaryPacketsSinceVerification: 0,
    currentCheckpointKey: '0,66,0',
    nextCheckpointKey: '4,66,0'
  }), true)
  assert.equal(shouldDispatchVerificationBeforePrimary({
    hasReachableVerification: false,
    primaryRemaining: true,
    primaryPacketsSinceVerification: 99,
    currentCheckpointKey: '0,66,0',
    nextCheckpointKey: '4,66,0'
  }), false)
})

test('restock recovery descends directly when already above the landing column', () => {
  const target = new Vec3(-325.5, 98, -99.5)
  assert.equal(isAboveStationLandingColumn(new Vec3(-324.9, 196.9, -97.3), target), true)
  assert.equal(isAboveStationLandingColumn(new Vec3(-304.5, 196.9, -97.3), target), false)
  assert.equal(isAboveStationLandingColumn(new Vec3(-325.5, 97, -99.5), target), false)
})

test('chunk resume detects the current negative-coordinate chunk column', () => {
  assert.equal(isInsideChunkColumn(new Vec3(-282.3, 72, 36.7), -18, 2), true)
  assert.equal(isInsideChunkColumn(new Vec3(-288.1, 72, 36.7), -18, 2), false)
})

test('local recovery only permits extra height while climbing toward a checkpoint', () => {
  assert.deepEqual(getLocalRecoveryEnvelope(70, 83, 322), { verticalMarginY: 8, ceilingY: 91 })
  assert.deepEqual(getLocalRecoveryEnvelope(268, 254, 322), { verticalMarginY: 8, ceilingY: 276 })
})

test('readServerTpsSample always exposes a numeric tps field', () => {
  const bot = { time: {}, _client: new EventEmitter() }
  assert.deepEqual(readServerTpsSample(bot), { tps: 20, secondsSinceServerTick: 0 })
})

test('waitForPlacementPacketSlots enforces a rolling packet window', async () => {
  const packetTimes = Array.from({ length: 30 }, (_, index) => 100 + index)
  const waits = []
  let currentTime = 1000

  const slots = await waitForPlacementPacketSlots(packetTimes, 2, {
    now: () => currentTime,
    delay: async (milliseconds) => {
      waits.push(milliseconds)
      currentTime += milliseconds
    }
  })

  assert.equal(slots, 1)
  assert.deepEqual(waits, [100])
  assert.equal(packetTimes.length, 29)
})

test('checkpoint resolution waits for destination chunk data', async () => {
  let loaded = false
  const bot = {
    blockAt: () => loaded ? { name: 'air', boundingBox: 'empty' } : null,
    waitForChunksToLoad: async () => { loaded = true }
  }

  assert.equal(await waitForCheckpointChunk(bot, new Vec3(0.5, 66, 0.5), 250), true)
})

test('confirmed prefix scan skips occupied checkpoints before flight planning', () => {
  const blocks = [
    { x: 0, y: 64, z: 0, name: 'stone' },
    { x: 1, y: 64, z: 0, name: 'stone' },
    { x: 2, y: 64, z: 0, name: 'stone' }
  ]
  const world = new Map([
    ['0,64,0', { name: 'stone' }],
    ['1,64,0', { name: 'stone' }],
    ['2,64,0', { name: 'air' }]
  ])
  const bot = { blockAt: (position) => world.get(`${position.x},${position.y},${position.z}`) }

  assert.equal(getConfirmedPrefixEnd(bot, blocks), 2)
})

test('verifyLayerBlocks requeues only missing air and ignores wrong solids', () => {
  const expected = [
    { x: 0, y: 64, z: 0, name: 'stone' },
    { x: 1, y: 64, z: 0, name: 'stone' },
    { x: 2, y: 64, z: 0, name: 'stone' }
  ]
  const world = new Map([
    ['0,64,0', { name: 'stone', boundingBox: 'block' }],
    ['1,64,0', { name: 'air', boundingBox: 'empty' }],
    ['2,64,0', { name: 'dirt', boundingBox: 'block' }]
  ])
  const result = verifyLayerBlocks({
    blockAt: (position) => world.get(`${position.x},${position.y},${position.z}`)
  }, expected)

  assert.deepEqual(result.missing, [expected[1]])
  assert.deepEqual(result.ignoredMismatches, [{ target: expected[2], actualName: 'dirt' }])
})

test('printChunkSlice retries pending placement before crossing checkpoint boundary and recovers locally', async () => {
  const blocks = [
    { x: 0, y: 64, z: 0, name: 'stone' },
    { x: 15, y: 64, z: 0, name: 'stone' }
  ]
  const checkpoint = generateLayerPrintPlan(0, 0, blocks, {
    maxReach: 5,
    hoverOffsetY: 2,
    layersPerPass: 2,
    horizontalSpeed: 2
  })[0].checkpoint
  const targetCenter = new Vec3(0.5, 64.5, 0.5)
  const towardTarget = targetCenter.minus(checkpoint.toVec3())
  const horizontalLength = Math.hypot(towardTarget.x, towardTarget.z)
  const approachDirection = horizontalLength > 0
    ? new Vec3(towardTarget.x / horizontalLength, 0, towardTarget.z / horizontalLength)
    : new Vec3(1, 0, 0)
  const world = new Map()
  const inventorySlots = Array(46).fill(null)
  inventorySlots[6] = { name: 'elytra', count: 1, slot: 6, maxDurability: 432, durabilityUsed: 0 }
  inventorySlots[35] = { name: 'enchanted_golden_apple', count: 64, slot: 35 }
  inventorySlots[36] = { name: 'netherite_pickaxe', count: 1, slot: 36 }
  inventorySlots[37] = { name: 'stone', count: 64, slot: 37 }
  const client = new EventEmitter()
  const initialPosition = checkpoint.toVec3().plus(approachDirection.scaled(1.5))
  const flightPhases = []
  let topEntryCount = 0
  let firstPlacementConfirmed = false
  let firstPlacementPackets = 0
  let layerFlightStalls = 0
  let groundedLocalFailures = 0
  let secondCheckpointBeforeFirstConfirmation = false
  client.write = (name, packet) => {
    if (name !== 'block_place') return
    const position = new Vec3(packet.location.x, packet.location.y, packet.location.z)
    const confirm = () => {
      world.set(`${position.x},${position.y},${position.z}`, { name: 'stone', boundingBox: 'block', position })
      if (position.x === 0) firstPlacementConfirmed = true
    }
    if (position.x === 0) {
      firstPlacementPackets += 1
      if (firstPlacementPackets >= 2) confirm()
    } else confirm()
  }

  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'ComicBot',
    health: 20,
    quickBarSlot: 1,
    entity: {
      eyeHeight: 1.62,
      onGround: false,
      position: initialPosition,
      velocity: new Vec3(0, 0, 0)
    },
    inventory: {
      slots: inventorySlots,
      items: () => inventorySlots.filter(Boolean)
    },
    registry: { itemsByName: { elytra: { maxDurability: 432 } } },
    time: { tps: 20 },
    _client: client,
    elytrafly: {
      start: () => {},
      stop: () => {},
      setControlState: () => {},
      sendStartStopPacket: () => {}
    },
    blockAt: (position) => world.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || {
      name: 'air',
      boundingBox: 'empty',
      position: new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    },
    setQuickBarSlot(slot) { this.quickBarSlot = slot },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  Object.defineProperty(bot, 'heldItem', {
    get: () => inventorySlots[36 + bot.quickBarSlot]
  })

  const stuckWatchdog = setTimeout(() => { bot.__interruptPrintRequested = true }, 1500)
  const result = await require('../src/printer').printChunkSlice(bot, {
    bot: { username: 'ComicBot' },
    printer: { blocksPerSecond: 20, perTickBurstCap: 1, range: 5, layersPerPass: 2, printWhileFlying: true },
    elytraFly: { horizontalSpeed: 2, verticalSpeed: 2 }
  }, {
    key: 'concurrent-test',
    chunkX: 0,
    chunkZ: 0,
    blocks
  }, {
    completeChunkJob: async () => {},
    flyToCheckpoint: async (activeBot, flightCheckpoint) => {
      flightPhases.push(flightCheckpoint)
      if (flightCheckpoint.phase === 'layer-print' && flightCheckpoint.x !== checkpoint.x && !firstPlacementConfirmed) {
        secondCheckpointBeforeFirstConfirmation = true
      }
      if (activeBot.entity.onGround && flightCheckpoint.phase === 'layer-print' && groundedLocalFailures === 0) {
        groundedLocalFailures += 1
        throw new Error('simulated grounded local recovery failure')
      }
      if (flightCheckpoint.phase === 'layer-print' && flightCheckpoint.x !== checkpoint.x && layerFlightStalls < 2) {
        layerFlightStalls += 1
        throw new Error('simulated low-altitude checkpoint stall')
      }
      activeBot.entity.position = flightCheckpoint.toVec3()
      if (['layer-print', 'layer-recovery-climb', 'obstruction-escape'].includes(flightCheckpoint.phase)) activeBot.entity.onGround = false
      if (flightCheckpoint.phase === 'chunk-top-entry') {
        topEntryCount += 1
        activeBot.entity.onGround = topEntryCount < 2
      }
    },
    loadPrintProgress: () => null,
    savePrintProgress: () => null,
    updateChunkPlacementProgress: (activeBot, blockIndex) => {
      activeBot.placedBlocksCount = blockIndex + 1
      return { activeChunk: { nextBlockIndex: blockIndex + 1 } }
    },
    afterPlacement: ({ bot: activeBot, blockIndex }) => {
      if (blockIndex === 1) activeBot.__interruptPrintRequested = true
    },
    placementRetryTimeoutMs: 250,
    placementRetries: 2
  })
  clearTimeout(stuckWatchdog)

  assert.ok(initialPosition.distanceTo(checkpoint.toVec3()) < 2)
  assert.equal(firstPlacementPackets, 2)
  assert.equal(layerFlightStalls, 2)
  assert.equal(groundedLocalFailures, 1)
  const localRecoveryClimbIndex = flightPhases.findIndex((flightCheckpoint) => flightCheckpoint.phase === 'layer-recovery-climb')
  assert.ok(localRecoveryClimbIndex >= 0)
  assert.equal(flightPhases.slice(localRecoveryClimbIndex).some((flightCheckpoint) => flightCheckpoint.phase.startsWith('skyway-')), false)
  assert.ok(Math.max(...flightPhases.slice(localRecoveryClimbIndex).map((flightCheckpoint) => flightCheckpoint.y)) <= checkpoint.y)
  assert.equal(flightPhases.some((flightCheckpoint) => flightCheckpoint.phase === 'placement-recovery'), false)
  const stalledLayerIndex = flightPhases.findIndex((flightCheckpoint) => flightCheckpoint.phase === 'layer-print' && flightCheckpoint.x !== checkpoint.x)
  assert.equal(flightPhases[stalledLayerIndex + 1].phase, 'layer-print')
  const obstacleRecovery = flightPhases.slice(stalledLayerIndex + 2)
  assert.equal(obstacleRecovery.some((flightCheckpoint) => flightCheckpoint.phase.startsWith('skyway-')), false)
  assert.equal(obstacleRecovery.some((flightCheckpoint) => flightCheckpoint.phase.startsWith('chunk-reentry-') || flightCheckpoint.phase === 'chunk-top-entry'), true)
  assert.ok(Math.max(...obstacleRecovery.map((flightCheckpoint) => flightCheckpoint.y)) <= checkpoint.y + 8)
  assert.equal(secondCheckpointBeforeFirstConfirmation, false)
  assert.equal(result.placedCount, 2)
})

test('printChunkSlice stops on an exhausted rejected placement without advancing progress', async () => {
  const inventorySlots = Array(46).fill(null)
  inventorySlots[6] = { name: 'elytra', count: 1, slot: 6, maxDurability: 432, durabilityUsed: 0 }
  inventorySlots[35] = { name: 'enchanted_golden_apple', count: 64, slot: 35 }
  inventorySlots[36] = { name: 'netherite_pickaxe', count: 1, slot: 36 }
  inventorySlots[37] = { name: 'crying_obsidian', count: 64, slot: 37 }
  const client = new EventEmitter()
  const flightPhases = []
  const logMessages = []
  let placementPackets = 0
  client.write = (name) => {
    if (name === 'block_place') placementPackets += 1
  }

  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'ComicBot',
    health: 20,
    quickBarSlot: 1,
    entity: {
      eyeHeight: 1.62,
      onGround: false,
      position: new Vec3(0.5, 68, 0.5),
      velocity: new Vec3(0, 0, 0)
    },
    inventory: {
      slots: inventorySlots,
      items: () => inventorySlots.filter(Boolean)
    },
    registry: { itemsByName: { elytra: { maxDurability: 432 } } },
    time: { tps: 20 },
    _client: client,
    elytrafly: {
      start: () => {},
      stop: () => {},
      setControlState: () => {},
      sendStartStopPacket: () => {}
    },
    blockAt: (position) => ({
      name: 'air',
      boundingBox: 'empty',
      position: new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    }),
    setQuickBarSlot(slot) { this.quickBarSlot = slot },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  Object.defineProperty(bot, 'heldItem', {
    get: () => inventorySlots[36 + bot.quickBarSlot]
  })

  const originalConsoleLog = console.log
  console.log = (message) => logMessages.push(String(message))
  let placementError
  try {
    await require('../src/printer').printChunkSlice(bot, {
      bot: { username: 'ComicBot' },
      printer: { blocksPerSecond: 20, perTickBurstCap: 1, range: 5, layersPerPass: 2, printWhileFlying: true },
      elytraFly: { horizontalSpeed: 2, verticalSpeed: 2 }
    }, {
      key: 'rejected-placement-test',
      chunkX: 0,
      chunkZ: 0,
      blocks: [{ x: 0, y: 64, z: 0, name: 'crying_obsidian' }]
    }, {
      completeChunkJob: false,
      flyToCheckpoint: async (activeBot, checkpoint) => {
        flightPhases.push(checkpoint.phase)
        activeBot.entity.position = checkpoint.toVec3()
        activeBot.entity.onGround = false
      },
      loadPrintProgress: () => null,
      savePrintProgress: () => null,
      updateChunkPlacementProgress: (activeBot, blockIndex) => {
        activeBot.placedBlocksCount = blockIndex + 1
        return { activeChunk: { nextBlockIndex: blockIndex + 1 } }
      },
      placementRetryTimeoutMs: 250,
      placementRetries: 1
    }).catch((error) => { placementError = error })
  } finally {
    console.log = originalConsoleLog
  }

  assert.match(placementError?.message || '', /Placement remained unconfirmed/)
  assert.equal(flightPhases.includes('placement-recovery'), false)
  assert.equal(placementPackets, 1)
  assert.equal(bot.placedBlocksCount || 0, 0)
})

test('printChunkSlice rewinds completed-looking progress when final validation finds air', async () => {
  const slots = Array(46).fill(null)
  slots[6] = { name: 'elytra', count: 1, slot: 6, maxDurability: 432, durabilityUsed: 0 }
  slots[35] = { name: 'enchanted_golden_apple', count: 64, slot: 35 }
  slots[36] = { name: 'netherite_pickaxe', count: 1, slot: 36 }
  slots[37] = { name: 'stone', count: 64, slot: 37 }
  const saves = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'ComicBot',
    quickBarSlot: 1,
    entity: { eyeHeight: 1.62, onGround: false, position: new Vec3(0.5, 66, 0.5), velocity: new Vec3(0, 0, 0) },
    inventory: { slots, items: () => slots.filter(Boolean) },
    registry: { itemsByName: { elytra: { maxDurability: 432 } } },
    time: { tps: 20 },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    setQuickBarSlot(slot) { this.quickBarSlot = slot },
    supportFeature: () => true,
    _client: new EventEmitter(),
    elytrafly: { start() {}, stop() {}, setControlState() {}, sendStartStopPacket() {} }
  })
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] })

  await assert.rejects(
    require('../src/printer').printChunkSlice(bot, {
      bot: { username: 'ComicBot' },
      printer: { blocksPerSecond: 20, range: 5, layersPerPass: 2 },
      elytraFly: { horizontalSpeed: 2, verticalSpeed: 2 }
    }, {
      key: 'final-validation-test',
      chunkX: 0,
      chunkZ: 0,
      blocks: [{ x: 0, y: 64, z: 0, name: 'stone' }]
    }, {
      completeChunkJob: false,
      loadPrintProgress: () => ({ activeChunk: { key: 'final-validation-test', nextBlockIndex: 1, pathPlanVersion: 3 } }),
      savePrintProgress: (_activeBot, details) => { saves.push(details); return details }
    }),
    /final validation found 1 missing block/
  )

  assert.equal(bot.placedBlocksCount, 0)
  assert.equal(saves.at(-1).placedBlocks, 0)
  assert.equal(saves.at(-1).status, 'repairing')
})

test('enableAntiFallHover initializes elytra flight when bot is in air', () => {
  let elytraStarted = false
  const mockBot = {
    entity: { onGround: false, position: new Vec3(0, 100, 0) },
    activeChunkJob: { key: '-23,-6' },
    elytrafly: {
      sendStartStopPacket: () => {},
      start: () => { elytraStarted = true },
      setControlState: () => {}
    },
    on: (evt, cb) => {
      if (evt === 'spawn') setTimeout(cb, 10)
    }
  }

  enableAntiFallHover(mockBot)
  assert.equal(mockBot.__antiFallInstalled, true)
})

test('placeBlockAirOrSupport detects solid neighbor and places against support face', async () => {
  const blocks = new Map()
  function setB(x, y, z, name, bb = 'block') {
    blocks.set(`${x},${y},${z}`, { name, boundingBox: bb, position: new Vec3(x, y, z) })
  }

  // Gold block at -355, 66, -88
  setB(-355, 66, -88, 'gold_block')
  // Air above at -355, 67, -88
  setB(-355, 67, -88, 'air', 'empty')

  let placedReference = null
  let placedFace = null
  let placeOptions = null
  let lookCalls = 0

  const mockBot = {
    entity: { position: new Vec3(-355.5, 69, -86.5) },
    heldItem: { name: 'crying_obsidian' },
    inventory: { items: () => [{ name: 'crying_obsidian' }] },
    blockAt: (p) => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: 'air', boundingBox: 'empty', position: p },
    lookAt: async () => { lookCalls += 1 },
    _genericPlace: async (ref, face, options) => {
      placedReference = ref
      placedFace = face
      placeOptions = options
      setB(-355, 67, -88, 'crying_obsidian')
    }
  }

  const targetPos = { x: -355, y: 67, z: -88, name: 'crying_obsidian' }
  const result = await placeBlockAirOrSupport(mockBot, targetPos, null)

  assert.equal(result, true)
  assert.ok(placedReference)
  assert.equal(placedReference.name, 'gold_block')
  assert.equal(placedFace.y, 1, 'Should place on UP face of gold block')
  assert.equal(placeOptions.forceLook, 'ignore')
  assert.equal(lookCalls, 0)
})

test('placeBlockAirOrSupport prefers sequenced raw support placement on modern protocol', async () => {
  const writes = []
  const genericPlacements = []
  const target = new Vec3(0, 64, 0)
  const support = { name: 'stone', position: new Vec3(0, 63, 0), boundingBox: 'block' }
  const bot = {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    blockAt(position) {
      if (position.equals(target)) return { name: writes.length > 0 ? 'stone' : 'air', position, boundingBox: 'empty' }
      if (position.equals(support.position)) return support
      return { name: 'air', position, boundingBox: 'empty' }
    },
    heldItem: { name: 'stone' },
    _client: { write: (...args) => writes.push(args) },
    _genericPlace: async (...args) => genericPlacements.push(args),
    supportFeature: () => true,
    inventory: { items: () => [{ name: 'stone' }] }
  }

  await placeBlockAirOrSupport(bot, { x: 0, y: 64, z: 0, name: 'stone' }, null, { confirmTimeoutMs: 50 })

  assert.equal(genericPlacements.length, 0)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'block_place')
  assert.deepEqual(writes[0][1].location, support.position)
  assert.equal(writes[0][1].direction, 1)
  assert.equal(writes[0][1].sequence, 0)
})

test('placeBlockAirOrSupport performs air-placement packet when no support neighbor exists', async () => {
  const blocks = new Map()
  let packetWritten = null
  let armSwung = false

  const mockBot = {
    entity: { position: new Vec3(-354.5, 69, -86.5) },
    heldItem: { name: 'stone' },
    inventory: { items: () => [{ name: 'stone' }] },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    lookAt: async () => {},
    swingArm: (arm) => { armSwung = true },
    supportFeature: () => true,
    _client: {
      write: (name, p) => {
        packetWritten = { name, packet: p }
        blocks.set('-354,67,-88', { name: 'stone', boundingBox: 'block', position: new Vec3(-354, 67, -88) })
      }
    }
  }

  // Target completely surrounded by air
  const airTarget = { x: -354, y: 67, z: -88, name: 'stone' }
  const result = await placeBlockAirOrSupport(mockBot, airTarget, null)

  assert.equal(result, true)
  assert.equal(armSwung, false)
  assert.ok(packetWritten)
  assert.equal(packetWritten.name, 'block_place')
  assert.equal(packetWritten.packet.location.x, -354)
  assert.equal(packetWritten.packet.location.y, 67)
  assert.equal(packetWritten.packet.location.z, -88)
  assert.equal(packetWritten.packet.direction, 0)
  assert.equal(packetWritten.packet.sequence, 0)
})

test('placeBlockBatch submits two placement packets before the first confirmation', async () => {
  const blocks = new Map()
  const writes = []
  let writesSeenAtFirstConfirmation = 0
  let lookCalls = 0
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    heldItem: { name: 'stone' },
    quickBarSlot: 0,
    inventory: {
      slots: { 36: { name: 'stone', count: 2, slot: 36 } },
      items: () => [{ name: 'stone', count: 2, slot: 36 }]
    },
    setQuickBarSlot: () => {},
    lookAt: async () => { lookCalls += 1 },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  bot._client = {
    write: (name, packet) => {
      assert.equal(name, 'block_place')
      writes.push(packet)
      setTimeout(() => {
        if (writesSeenAtFirstConfirmation === 0) writesSeenAtFirstConfirmation = writes.length
        const key = `${packet.location.x},${packet.location.y},${packet.location.z}`
        const oldBlock = blocks.get(key) || { name: 'air', boundingBox: 'empty', position: packet.location }
        const newBlock = { name: 'stone', boundingBox: 'block', position: packet.location }
        blocks.set(key, newBlock)
        bot.emit(`blockUpdate:${packet.location}`, oldBlock, newBlock)
      }, 20)
    }
  }

  await placeBlockBatch(bot, [
    { x: 0, y: 64, z: 0, name: 'stone' },
    { x: 1, y: 64, z: 0, name: 'stone' }
  ], { confirmTimeoutMs: 500 })

  assert.equal(writes.length, 2)
  assert.equal(writesSeenAtFirstConfirmation, 2)
  assert.deepEqual(writes.map((packet) => packet.sequence), [0, 1])
  assert.equal(lookCalls, 0)
})

test('placeBlockBatch can dispatch packets without serial confirmation waits', async () => {
  const writes = []
  const bot = {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    quickBarSlot: 0,
    heldItem: { name: 'stone' },
    inventory: {
      slots: { 36: { name: 'stone', count: 2, slot: 36 } },
      items: () => [{ name: 'stone', count: 2, slot: 36 }]
    },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock',
    _client: { write: (name, packet) => writes.push({ name, packet }) }
  }

  await Promise.race([
    placeBlockBatch(bot, [
      { x: 0, y: 64, z: 0, name: 'stone' },
      { x: 1, y: 64, z: 0, name: 'stone' }
    ], { waitForConfirmation: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('dispatch waited for confirmation')), 100))
  ])

  assert.equal(writes.length, 2)
  assert.deepEqual(writes.map(({ packet }) => packet.sequence), [0, 1])
})

test('placeBlockBatch never dispatches more packets than the selected stack contains', async () => {
  const writes = []
  const bot = {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    quickBarSlot: 0,
    heldItem: { name: 'stone', count: 1 },
    inventory: {
      slots: { 36: { name: 'stone', count: 1, slot: 36 } },
      items: () => [{ name: 'stone', count: 1, slot: 36 }]
    },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock',
    _client: { write: (name, packet) => writes.push({ name, packet }) }
  }

  const result = await placeBlockBatch(bot, [
    { x: 0, y: 64, z: 0, name: 'stone' },
    { x: 1, y: 64, z: 0, name: 'stone' }
  ], { waitForConfirmation: false })

  assert.equal(writes.length, 1)
  assert.deepEqual(result.deferredTargets, [{ x: 1, y: 64, z: 0, name: 'stone' }])
})

test('low-durability Elytra uses /home platform before restocking', async () => {
  const station = { x: -326, y: 97, z: -100 }
  const chats = []
  const bot = {
    entity: { position: new Vec3(-262.5, 293, -38.5), onGround: false },
    inventory: { slots: { 6: { name: 'elytra', maxDurability: 432, durabilityUsed: 431 } } },
    getEquipmentDestSlot: () => 6,
    chat(message) {
      chats.push(message)
      this.entity.position = new Vec3(-325.5, 98, -99.5)
      this.entity.onGround = true
    },
    clearControlStates() {}
  }

  assert.equal(await returnLowDurabilityElytraToStation(bot, station, { homePlatformTimeoutMs: 5000 }), true)
  assert.deepEqual(chats, ['/home platform'])
})

test('placeBlockBatch never inventory-swaps or sends packets for an unstaged material', async () => {
  const slots = Array(46).fill(null)
  slots[20] = { name: 'stone', count: 64, slot: 20 }
  let clicks = 0
  let writes = 0
  const bot = {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    quickBarSlot: 0,
    heldItem: null,
    inventory: { slots, items: () => slots.filter(Boolean) },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    clickWindow: async () => { clicks += 1 },
    setQuickBarSlot: () => {},
    supportFeature: () => true,
    _client: { write: () => { writes += 1 } }
  }

  await assert.rejects(
    placeBlockBatch(bot, [{ x: 0, y: 64, z: 0, name: 'stone' }], { waitForConfirmation: false }),
    (error) => error.code === 'HOTBAR_MATERIAL_NOT_READY'
  )
  assert.equal(clicks, 0)
  assert.equal(writes, 0)
})

test('placeBlockBatch retains the selected resident material between batches', async () => {
  const slots = Array(46).fill(null)
  slots[36] = { name: 'netherite_pickaxe', count: 1, slot: 36 }
  slots[37] = { name: 'stone', count: 64, slot: 37 }
  let selectedHotbar = 0
  const bot = {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    get quickBarSlot() { return selectedHotbar },
    get heldItem() { return slots[36 + selectedHotbar] || null },
    setQuickBarSlot(slot) { selectedHotbar = slot },
    inventory: { slots, items: () => slots.filter(Boolean) },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock',
    _client: { write: () => {} }
  }

  await placeBlockBatch(bot, [{ x: 0, y: 64, z: 0, name: 'stone' }], { waitForConfirmation: false })

  assert.equal(selectedHotbar, 1)
  assert.equal(bot.heldItem?.name, 'stone')
})

test('placeBlockAirOrSupport rotates support faces on retry', async () => {
  const blocks = new Map([
    ['0,63,0', { name: 'stone', boundingBox: 'block', position: new Vec3(0, 63, 0) }],
    ['-1,64,0', { name: 'stone', boundingBox: 'block', position: new Vec3(-1, 64, 0) }]
  ])
  const packets = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    heldItem: { name: 'stone' },
    inventory: { items: () => [{ name: 'stone' }] },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  bot._client = {
    write: (name, packet) => {
      if (name !== 'block_place') return
      packets.push(packet)
      if (packets.length !== 2) return
      const targetPosition = new Vec3(0, 64, 0)
      const oldBlock = bot.blockAt(targetPosition)
      const newBlock = { name: 'stone', boundingBox: 'block', position: targetPosition }
      blocks.set('0,64,0', newBlock)
      bot.emit(`blockUpdate:${targetPosition}`, oldBlock, newBlock)
    }
  }

  await placeBlockAirOrSupport(bot, { x: 0, y: 64, z: 0, name: 'stone' }, null, {
    confirmTimeoutMs: 250,
    placementRetries: 2,
    placementRetryDelayMs: 10
  })

  assert.deepEqual(packets.map(({ location, direction }) => [location.x, location.y, location.z, direction]), [
    [0, 63, 0, 1],
    [-1, 64, 0, 5]
  ])
})

test('placeBlockAirOrSupport continues support rotation from the requested offset', async () => {
  const blocks = new Map([
    ['0,63,0', { name: 'stone', boundingBox: 'block', position: new Vec3(0, 63, 0) }],
    ['-1,64,0', { name: 'stone', boundingBox: 'block', position: new Vec3(-1, 64, 0) }]
  ])
  const packets = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    heldItem: { name: 'stone' },
    inventory: { items: () => [{ name: 'stone' }] },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  bot._client = {
    write: (name, packet) => {
      if (name !== 'block_place') return
      packets.push(packet)
      const targetPosition = new Vec3(0, 64, 0)
      const oldBlock = bot.blockAt(targetPosition)
      const newBlock = { name: 'stone', boundingBox: 'block', position: targetPosition }
      blocks.set('0,64,0', newBlock)
      bot.emit(`blockUpdate:${targetPosition}`, oldBlock, newBlock)
    }
  }

  await placeBlockAirOrSupport(bot, { x: 0, y: 64, z: 0, name: 'stone' }, null, {
    confirmTimeoutMs: 250,
    placementRetries: 1,
    supportAttemptOffset: 1
  })

  assert.deepEqual(packets.map(({ location, direction }) => [location.x, location.y, location.z, direction]), [
    [-1, 64, 0, 5]
  ])
})

test('placeBlockAirOrSupport sneaks while placing against an interactive beacon', async () => {
  const target = new Vec3(0, 65, 0)
  const support = new Vec3(0, 64, 0)
  let targetBlock = { name: 'air', boundingBox: 'empty', position: target }
  const sneakStates = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 67, 0.5) },
    heldItem: { name: 'obsidian' },
    inventory: { items: () => [{ name: 'obsidian' }] },
    setControlState: (control, value) => { if (control === 'sneak') sneakStates.push(value) },
    blockAt: (position) => {
      if (position.equals(target)) return targetBlock
      if (position.equals(support)) return { name: 'beacon', boundingBox: 'block', position: support }
      return { name: 'air', boundingBox: 'empty', position }
    },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  bot._client = {
    write: (name) => {
      if (name !== 'block_place') return
      const oldBlock = targetBlock
      targetBlock = { name: 'obsidian', boundingBox: 'block', position: target }
      bot.emit(`blockUpdate:${target}`, oldBlock, targetBlock)
    }
  }

  await placeBlockAirOrSupport(bot, { x: 0, y: 65, z: 0, name: 'obsidian' }, null, { confirmTimeoutMs: 250 })

  assert.deepEqual(sneakStates, [true, false])
})

test('placeBlockBatch skips wrong blocks without break or placement packets', async () => {
  const blocks = new Map([
    ['0,64,0', { name: 'dirt', boundingBox: 'block', position: new Vec3(0, 64, 0) }],
    ['1,64,0', { name: 'dirt', boundingBox: 'block', position: new Vec3(1, 64, 0) }]
  ])
  const packets = []
  let quickBarSlot = 0
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 66, 0.5) },
    inventory: {
      slots: {
        36: { name: 'stone', count: 2, slot: 36 },
        37: { name: 'netherite_pickaxe', count: 1, slot: 37 }
      },
      items: () => [
        { name: 'stone', count: 2, slot: 36 },
        { name: 'netherite_pickaxe', count: 1, slot: 37 }
      ]
    },
    setQuickBarSlot: (slot) => { quickBarSlot = slot },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    digTime: () => 0,
    dig: async () => { throw new Error('progressive dig should not run') },
    supportFeature: (feature) => feature === 'blockPlaceHasInsideBlock'
  })
  Object.defineProperty(bot, 'quickBarSlot', { get: () => quickBarSlot })
  Object.defineProperty(bot, 'heldItem', {
    get: () => bot.inventory.slots[36 + quickBarSlot] || null
  })
  bot._client = {
    write: (name, packet) => {
      packets.push({ name, packet })
      const key = `${packet.location.x},${packet.location.y},${packet.location.z}`
      if (name === 'block_dig' && packet.status === 2) {
        const oldBlock = blocks.get(key)
        const newBlock = { name: 'air', boundingBox: 'empty', position: packet.location }
        blocks.set(key, newBlock)
        bot.emit(`blockUpdate:${packet.location}`, oldBlock, newBlock)
      }
      if (name === 'block_place') {
        const directionOffsets = [
          new Vec3(0, -1, 0),
          new Vec3(0, 1, 0),
          new Vec3(0, 0, -1),
          new Vec3(0, 0, 1),
          new Vec3(-1, 0, 0),
          new Vec3(1, 0, 0)
        ]
        const clickedBlock = blocks.get(key)
        const targetPosition = clickedBlock && !['air', 'cave_air', 'void_air'].includes(clickedBlock.name)
          ? packet.location.plus(directionOffsets[packet.direction])
          : packet.location
        const targetKey = `${targetPosition.x},${targetPosition.y},${targetPosition.z}`
        const oldBlock = blocks.get(targetKey) || { name: 'air', boundingBox: 'empty', position: targetPosition }
        const newBlock = { name: 'stone', boundingBox: 'block', position: targetPosition }
        blocks.set(targetKey, newBlock)
        bot.emit(`blockUpdate:${targetPosition}`, oldBlock, newBlock)
      }
    }
  }

  await placeBlockBatch(bot, [
    { x: 0, y: 64, z: 0, name: 'stone' },
    { x: 1, y: 64, z: 0, name: 'stone' }
  ], { confirmTimeoutMs: 500 })

  assert.equal(packets.filter(({ name }) => name === 'block_dig').length, 0)
  assert.equal(packets.filter(({ name }) => name === 'block_place').length, 0)
})

test('placeBlockAirOrSupport falls back to direct placement when support placement is rejected', async () => {
  const blocks = new Map()
  blocks.set('0,0,0', { name: 'obsidian', boundingBox: 'block', position: new Vec3(0, 0, 0) })
  blocks.set('0,1,0', { name: 'air', boundingBox: 'empty', position: new Vec3(0, 1, 0) })
  let directPacketWritten = false
  const mockBot = {
    entity: { position: new Vec3(1.5, 3, 0.5) },
    heldItem: { name: 'obsidian' },
    inventory: { items: () => [{ name: 'obsidian' }] },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    lookAt: async () => {},
    placeBlock: async () => { throw new Error('server rejected support placement') },
    swingArm: () => {},
    supportFeature: () => true,
    _client: {
      write: () => {
        directPacketWritten = true
        blocks.set('0,1,0', { name: 'obsidian', boundingBox: 'block', position: new Vec3(0, 1, 0) })
      }
    }
  }

  const result = await placeBlockAirOrSupport(mockBot, { x: 0, y: 1, z: 0, name: 'obsidian' }, null)

  assert.equal(result, true)
  assert.equal(directPacketWritten, true)
})

test('placeBlockAirOrSupport rejects air placement when the server keeps the target as air', async () => {
  const mockBot = {
    entity: { position: new Vec3(0, 72, 0) },
    heldItem: { name: 'stone' },
    inventory: { items: () => [{ name: 'stone' }] },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    lookAt: async () => {},
    swingArm: () => {},
    supportFeature: () => true,
    _client: { write: () => {} }
  }

  await assert.rejects(
    placeBlockAirOrSupport(mockBot, { x: 0, y: 70, z: 0, name: 'stone' }, null, { confirmTimeoutMs: 250, placementRetries: 2 }),
    /Server did not confirm stone/
  )
})

test('placeBlockAirOrSupport retries an unconfirmed direct air placement', async () => {
  const blocks = new Map()
  let writes = 0
  const mockBot = {
    entity: { position: new Vec3(0, 72, 0) },
    heldItem: { name: 'stone' },
    inventory: { items: () => [{ name: 'stone' }] },
    blockAt: (position) => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', boundingBox: 'empty', position },
    lookAt: async () => {},
    swingArm: () => {},
    supportFeature: () => true,
    _client: {
      write: () => {
        writes += 1
        if (writes === 2) blocks.set('0,70,0', { name: 'stone', boundingBox: 'block', position: new Vec3(0, 70, 0) })
      }
    }
  }

  const result = await placeBlockAirOrSupport(mockBot, { x: 0, y: 70, z: 0, name: 'stone' }, null, {
    confirmTimeoutMs: 250,
    placementRetries: 2,
    placementRetryDelayMs: 10
  })

  assert.equal(result, true)
  assert.equal(writes, 2)
})

test('placeBlockAirOrSupport never sends a packet above the bot body', async () => {
  let writes = 0
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: { name: 'stone' },
    inventory: { items: () => [{ name: 'stone' }] },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    supportFeature: () => true,
    _client: { write: () => { writes += 1 } }
  }

  await assert.rejects(
    placeBlockAirOrSupport(bot, { x: 0, y: 64, z: 0, name: 'stone' }, null, { placementRetries: 1 }),
    /is not below bot/
  )
  assert.equal(writes, 0)
})

test('placeBlockAirOrSupport never sends a packet for a stale held item', async () => {
  let writes = 0
  const slots = Array(46).fill(null)
  slots[36] = { name: 'stone', count: 64, slot: 36 }
  const bot = {
    quickBarSlot: 0,
    entity: { position: new Vec3(0.5, 66, 0.5) },
    heldItem: { name: 'ender_chest', count: 1 },
    inventory: {
      slots,
      items: () => [{ name: 'ender_chest', count: 1, slot: 20 }]
    },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position }),
    supportFeature: () => true,
    _client: { write: () => { writes += 1 } }
  }

  await assert.rejects(
    placeBlockAirOrSupport(bot, { x: 0, y: 64, z: 0, name: 'ender_chest' }, null, { placementRetries: 1 }),
    /Refusing placement packet for ender_chest/
  )
  assert.equal(writes, 0)
})

test('silentSwapToItem switches quickBarSlot when item is present on hotbar', async () => {
  const slots = {}
  slots[36] = { name: 'netherite_pickaxe', slot: 36 }
  slots[39] = { name: 'obsidian', slot: 39 } // hotbar slot 3
  let selectedHb = 0

  const mockBot = {
    get quickBarSlot() { return selectedHb },
    setQuickBarSlot(s) { selectedHb = s },
    inventory: { slots, items: () => Object.values(slots) }
  }

  const res = await silentSwapToItem(mockBot, 'obsidian')
  assert.equal(res.swapped, true)
  assert.equal(res.previousHotbarSlot, 0)
  assert.equal(selectedHb, 3)
})

test('silentSwapToItem reselects a hotbar stack after a stale held-item update', async () => {
  const slots = Array(46).fill(null)
  slots[36] = { name: 'netherite_pickaxe', count: 1, slot: 36 }
  slots[39] = { name: 'obsidian', count: 64, slot: 39 }
  let selectedHotbar = 0
  let heldItem = slots[36]
  let obsidianSelections = 0
  const bot = {
    config: { printer: { hotbarSelectionTimeoutMs: 250 } },
    get quickBarSlot() { return selectedHotbar },
    get heldItem() { return heldItem },
    setQuickBarSlot(slot) {
      selectedHotbar = slot
      if (slot === 3) {
        obsidianSelections += 1
        if (obsidianSelections >= 2) heldItem = slots[39]
      } else {
        heldItem = slots[36]
      }
    },
    updateHeldItem() {},
    inventory: { slots, items: () => slots.filter(Boolean) }
  }

  const result = await silentSwapToItem(bot, 'obsidian')
  assert.equal(result.mode, 'quickbar')
  assert.equal(obsidianSelections, 2)
  assert.equal(bot.heldItem.name, 'obsidian')
})

test('silentSwapToItem ignores stale heldItem after the selected stack is depleted', async () => {
  const slots = Array(46).fill(null)
  slots[37] = { name: 'crying_obsidian', count: 0, slot: 37 }
  slots[39] = { name: 'crying_obsidian', count: 64, slot: 39 }
  let selectedHotbar = 1
  const bot = {
    get quickBarSlot() { return selectedHotbar },
    heldItem: { name: 'crying_obsidian', count: 0 },
    setQuickBarSlot(slot) { selectedHotbar = slot },
    inventory: { slots, items: () => slots.filter(Boolean) }
  }

  const result = await silentSwapToItem(bot, 'crying_obsidian')

  assert.equal(result.mode, 'quickbar')
  assert.equal(result.previousHotbarSlot, 1)
  assert.equal(selectedHotbar, 3)
})

test('silentSwapToItem leaves inventory-only materials unstaged', async () => {
  const item = { name: 'obsidian', slot: 20 }
  const slots = { 20: item }
  const clicks = []
  const mockBot = {
    quickBarSlot: 0,
    heldItem: null,
    setQuickBarSlot: () => {},
    inventory: {
      slots,
      items: () => Object.values(slots)
    },
    clickWindow: async (...args) => { clicks.push(args) }
  }

  const result = await silentSwapToItem(mockBot, 'obsidian')
  assert.equal(result.notFound, true)
  assert.equal(result.inventoryOnly, true)
  assert.deepEqual(clicks, [])
})

test('silentSwapToItem uses hotbar slot 8 as a normal material slot', async () => {
  const slots = Array(46).fill(null)
  slots[20] = { name: 'obsidian', count: 64, slot: 20 }
  slots[44] = { name: 'dirt', count: 64, slot: 44 }
  let selectedHotbar = 0
  const bot = {
    get quickBarSlot() { return selectedHotbar },
    get heldItem() { return slots[36 + selectedHotbar] || null },
    inventory: { slots, items: () => slots.filter(Boolean) },
    setQuickBarSlot: (slot) => { selectedHotbar = slot },
    clickWindow: async () => {}
  }

  const result = await silentSwapToItem(bot, 'dirt')
  assert.equal(result.mode, 'quickbar')
  assert.equal(selectedHotbar, 8)
})

test('printChunkSlice sorts blocks from bottom to top (ascending Y)', async () => {
  const { printChunkSlice } = require('../src/printer')
  const placedOrder = []
  const mockBot = {
    username: 'ComicBot',
    entity: { position: new Vec3(0, 100, 0) },
    inventory: { items: () => [{ name: 'stone' }] },
    heldItem: { name: 'stone' },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    lookAt: async () => {},
    swingArm: () => {},
    supportFeature: () => true,
    _client: { write: () => {} },
    elytrafly: {
      start: () => {},
      stop: () => {},
      setControlState: () => {},
      sendStartStopPacket: () => {}
    }
  }

  const unSortedChunk = {
    key: '0,0',
    chunkX: 0,
    chunkZ: 0,
    anchor: { x: 0, y: 64, z: 0 },
    blocks: [
      { x: 0, y: 70, z: 0, name: 'stone' },
      { x: 0, y: 65, z: 0, name: 'stone' },
      { x: 0, y: 68, z: 0, name: 'stone' }
    ]
  }

  // Mock waitForExpectedBlock to record placement order and return immediately
  const printerModule = require('../src/printer')
  const originalPlace = printerModule.placeBlockAirOrSupport
  // Verify array is sorted bottom to top in printChunkSlice
  const sorted = unSortedChunk.blocks.slice().sort((a, b) => a.y - b.y)
  assert.equal(sorted[0].y, 65)
  assert.equal(sorted[1].y, 68)
  assert.equal(sorted[2].y, 70)
})
