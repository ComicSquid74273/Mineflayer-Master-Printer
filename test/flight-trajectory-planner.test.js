'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { engageElytraHover, installElytraFlightLifecycle } = require('../src/elytra-flight')
const {
  FlightCheckpoint,
  findVerticalShaftEscapePath,
  flyToCheckpoint,
  getReachableLayersPerPass,
  getSkywayAltitude,
  generateLandingTransitCheckpoints,
  generateObstacleAwareReentryCheckpoints,
  generateMacroTransitCheckpoints,
  generateLayerCheckpoints,
  generateLayerPrintPlan,
  resolveSafeLayerCheckpoint
} = require('../src/flight-trajectory-planner')

test('findVerticalShaftEscapePath routes horizontally to a clear climb column', () => {
  const air = { name: 'air', boundingBox: 'empty' }
  const solid = { name: 'obsidian', boundingBox: 'block' }
  const bot = {
    entity: { position: new Vec3(0.5, 2, 0.5) },
    blockAt(position) {
      if (position.x === 0 && position.z === 0 && position.y === 6) return solid
      return air
    }
  }

  assert.deepEqual(findVerticalShaftEscapePath(bot, 10, { searchRadius: 2 }), [
    { x: 1.5, y: 2, z: 0.5 }
  ])
})

test('findVerticalShaftEscapePath centers the bot inside an already clear climb column', () => {
  const bot = {
    entity: { position: new Vec3(0.1, 2, 0.9) },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  }

  assert.deepEqual(findVerticalShaftEscapePath(bot, 10, { searchRadius: 2 }), [
    { x: 0.5, y: 2, z: 0.5 }
  ])
})

test('findVerticalShaftEscapePath never adds vertical motion beneath an obstruction', () => {
  const air = { name: 'air', boundingBox: 'empty' }
  const solid = { name: 'obsidian', boundingBox: 'block' }
  const bot = {
    entity: { position: new Vec3(0.5, 95.2, 0.5) },
    blockAt(position) {
      if (position.x === 0 && position.z === 0 && position.y === 97) return solid
      return air
    }
  }

  const path = findVerticalShaftEscapePath(bot, 322, { searchRadius: 2 })
  assert.equal(path[0].y, 95.2)
})

test('resolveSafeLayerCheckpoint moves a blocked top-entry to a clear reachable shaft', () => {
  const air = { name: 'air', boundingBox: 'empty' }
  const solid = { name: 'obsidian', boundingBox: 'block' }
  const bot = {
    entity: { position: new Vec3(2, 80, 2), eyeHeight: 1.62 },
    blockAt(position) {
      if (position.x === 2 && position.z === 2 && position.y === 66) return solid
      return air
    }
  }
  const blocked = new FlightCheckpoint(2, 66, 2, 'layer-print', 2)
  const resolved = resolveSafeLayerCheckpoint(bot, blocked, [{ x: 1, y: 64, z: 1 }], {
    chunkX: 0,
    chunkZ: 0,
    maxReach: 5,
    skywayY: 100,
    requireVerticalShaft: true
  })

  assert.notDeepEqual(resolved.toVec3(), blocked.toVec3())
  assert.deepEqual(resolved.toVec3(), new Vec3(1.5, 66, 1.5))
})

test('flyToCheckpoint requires server-confirmed Elytra glide and accepts half-block server jitter', async () => {
  const bot = new EventEmitter()
  let glideRequests = 0
  bot.entity = {
    position: new Vec3(0, 99.51, 0),
    velocity: new Vec3(0, -0.1, 0),
    onGround: false,
    elytraFlying: false,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.setControlState = () => {}
  bot.lookAt = async () => {}
  bot.elytraFly = async () => {
    glideRequests += 1
    bot.entity.elytraFlying = true
  }
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    options: { speed: 0.05, velocityUpRate: 0.1, proportionalSpeed: false },
    setControlState() {},
    sendStartStopPacket() {}
  }

  await flyToCheckpoint(bot, new FlightCheckpoint(0, 99.6, 0, 'test', 2), { verticalTolerance: 0.25, timeoutMs: 10 })
  assert.equal(glideRequests, 1)
  assert.equal(bot.entity.elytraFlying, true)
  assert.equal(bot.listeners('physicsTick').length, 1)
})

test('flyToCheckpoint exits immediately when emergency printing interrupt is requested', async () => {
  const bot = { __interruptPrintRequested: true, elytrafly: {} }
  await assert.rejects(
    flyToCheckpoint(bot, new FlightCheckpoint(0, 100, 0, 'layer-print', 2)),
    (error) => error.code === 'PRINT_INTERRUPTED'
  )
})

test('flyToCheckpoint accepts tiny server jitter beyond configured layer tolerances', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0.5001, 99.7499, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: false,
    elytraFlying: true,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.setControlState = () => {}
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    setControlState() {},
    sendStartStopPacket() {}
  }

  await flyToCheckpoint(bot, new FlightCheckpoint(0, 100, 0, 'layer-print', 2), {
    horizontalTolerance: 0.5,
    verticalTolerance: 0.25,
    timeoutMs: 10
  })
  assert.equal(bot.elytrafly.__meteorController.settings.maxAltitudeY, 100.5)
})

test('flyToCheckpoint rejects checkpoints above the configured path ceiling', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0, 99, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: false,
    elytraFlying: true,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.setControlState = () => {}
  bot.config = { elytraFly: { maxPathingY: 100 } }
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    setControlState() {},
    sendStartStopPacket() {}
  }

  await assert.rejects(
    flyToCheckpoint(bot, new FlightCheckpoint(0, 101, 0, 'placement-recovery', 2)),
    (error) => error.code === 'CHECKPOINT_ABOVE_PATH_CEILING'
  )
})

test('flyToCheckpoint follows one smooth 3D goal without look-direction pulses', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0, 97, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: false,
    elytraFlying: true,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.setControlState = () => {}
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    options: { speed: 0.05, velocityUpRate: 0.1, proportionalSpeed: false },
    setControlState() {},
    sendStartStopPacket() {}
  }
  installElytraFlightLifecycle(bot)
  engageElytraHover(bot, { targetY: bot.entity.position.y, sendStartPacket: false })
  let nullGoalTicks = 0

  const simulation = setInterval(() => {
    if (bot.__checkpointFlightActive && !bot.elytrafly.__meteorController.goal) nullGoalTicks += 1
    bot.entity.position = bot.entity.position.plus(bot.entity.velocity)
    bot.emit('physicsTick')
  }, 10)
  try {
    await flyToCheckpoint(bot, new FlightCheckpoint(10, 100, 0, 'layer-print', 2), { timeoutMs: 500 })
  } finally {
    clearInterval(simulation)
  }

  assert.ok(Math.abs(bot.entity.position.x - 10) <= 2)
  assert.ok(Math.abs(bot.entity.position.y - 100) <= 1.5)
  assert.equal(nullGoalTicks, 0)
})

test('flyToCheckpoint locks X/Z before and during vertical top-entry', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(2, 110, -1),
    velocity: new Vec3(0, 0, 0),
    onGround: false,
    elytraFlying: true,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.config = { elytraFly: { horizontalSpeed: 2, verticalSpeed: 2 } }
  bot.setControlState = () => {}
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    options: { speed: 0.05, velocityUpRate: 0.1, proportionalSpeed: false },
    setControlState() {},
    sendStartStopPacket() {}
  }

  let lowestYBeforeColumnLock = bot.entity.position.y
  const simulation = setInterval(() => {
    bot.entity.position = bot.entity.position.plus(bot.entity.velocity)
    if (Math.hypot(bot.entity.position.x, bot.entity.position.z) > 0.4) {
      lowestYBeforeColumnLock = Math.min(lowestYBeforeColumnLock, bot.entity.position.y)
    }
    bot.emit('physicsTick')
  }, 10)
  try {
    await flyToCheckpoint(bot, new FlightCheckpoint(0, 100, 0, 'chunk-top-entry', 2), {
      verticalTolerance: 0.25,
      timeoutMs: 1000
    })
  } finally {
    clearInterval(simulation)
  }

  assert.ok(lowestYBeforeColumnLock >= 109.8)
  assert.ok(Math.hypot(bot.entity.position.x, bot.entity.position.z) <= 0.15)
  assert.ok(Math.abs(bot.entity.position.y - 100) <= 0.3)
  assert.equal(bot.elytrafly.__meteorController.settings.verticalSpeed, 2)
})

test('flyToCheckpoint does not accept top-entry one block above its target', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0, 101, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: false,
    elytraFlying: true,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.config = { elytraFly: { horizontalSpeed: 2, verticalSpeed: 2, glideHeight: 5 } }
  bot.setControlState = () => {}
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    setControlState() {},
    sendStartStopPacket() {}
  }

  const simulation = setInterval(() => {
    bot.entity.position = bot.entity.position.plus(bot.entity.velocity)
    bot.emit('physicsTick')
  }, 10)
  try {
    await flyToCheckpoint(bot, new FlightCheckpoint(0, 100, 0, 'chunk-top-entry', 2), { timeoutMs: 500 })
  } finally {
    clearInterval(simulation)
  }

  assert.ok(Math.abs(bot.entity.position.y - 100) <= 0.3)
})

test('flyToCheckpoint fails fast when horizontal flight makes no progress', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0, 100, 0),
    velocity: new Vec3(0, 0, 0),
    eyeHeight: 1.62,
    onGround: false,
    elytraFlying: true
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    options: { speed: 0.05, velocityUpRate: 0.1, proportionalSpeed: false },
    setControlState() {},
    sendStartStopPacket() {}
  }
  bot.lookAt = async () => {}

  await assert.rejects(
    flyToCheckpoint(bot, new FlightCheckpoint(20, 100, 0, 'skyway-cruise', 2), {
      timeoutMs: 5000,
      stallTimeoutMs: 250
    }),
    /Stalled reaching skyway-cruise/
  )
})

test('flyToCheckpoint keeps the planned skyway after a grounded obstruction', async () => {
  const bot = new EventEmitter()
  let obstructionTriggered = false
  bot.entity = {
    position: new Vec3(0, 207, 0),
    velocity: new Vec3(0, 0, 0),
    eyeHeight: 1.62,
    onGround: false,
    elytraFlying: true
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.config = { elytraFly: { horizontalSpeed: 2, verticalSpeed: 2, pathClearanceY: 5, maxPathingY: 324 } }
  bot.setControlState = (state, value) => {
    if (state !== 'jump' || !value || !bot.entity.onGround) return
    bot.entity.onGround = false
    bot.entity.position.y += 0.8
    bot.entity.velocity.y = -0.1
  }
  bot.elytraFly = async () => { bot.entity.elytraFlying = true }
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    options: { speed: 0.05, velocityUpRate: 0.1, proportionalSpeed: false },
    setControlState() {},
    sendStartStopPacket() {}
  }

  const simulation = setInterval(() => {
    bot.entity.position = bot.entity.position.plus(bot.entity.velocity)
    bot.emit('physicsTick')
    if (!obstructionTriggered && bot.entity.position.x >= 4) {
      obstructionTriggered = true
      bot.entity.position.y = 206
      bot.entity.velocity.set(0, 0, 0)
      bot.entity.onGround = true
      bot.entity.elytraFlying = false
    }
  }, 10)
  try {
    await flyToCheckpoint(bot, new FlightCheckpoint(20, 207, 0, 'skyway-cruise', 2), {
      timeoutMs: 1500,
      stallTimeoutMs: 500
    })
  } finally {
    clearInterval(simulation)
  }

  assert.equal(obstructionTriggered, true)
  assert.equal(bot.__adaptiveSkywayY, undefined)
  assert.ok(bot.entity.position.y < 208.5)
})

test('flyToCheckpoint keeps a grounded first skyway checkpoint at its planned altitude', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0, 206, 0),
    velocity: new Vec3(0, 0, 0),
    eyeHeight: 1.62,
    onGround: true,
    elytraFlying: false
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.config = { elytraFly: { horizontalSpeed: 2, verticalSpeed: 2, pathClearanceY: 5, maxPathingY: 324 } }
  bot.setControlState = (state, value) => {
    if (state !== 'jump' || !value || !bot.entity.onGround) return
    bot.entity.onGround = false
    bot.entity.position.y += 0.8
    bot.entity.velocity.y = -0.1
  }
  bot.elytraFly = async () => { bot.entity.elytraFlying = true }
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    options: { speed: 0.05, velocityUpRate: 0.1, proportionalSpeed: false },
    setControlState() {},
    sendStartStopPacket() {}
  }

  const simulation = setInterval(() => {
    bot.entity.position = bot.entity.position.plus(bot.entity.velocity)
    bot.emit('physicsTick')
  }, 10)
  try {
    await flyToCheckpoint(bot, new FlightCheckpoint(0, 207, 0, 'skyway-climb', 2), {
      timeoutMs: 1000,
      stallTimeoutMs: 500
    })
  } finally {
    clearInterval(simulation)
  }

  assert.equal(bot.__adaptiveSkywayY, undefined)
  assert.ok(bot.entity.position.y < 208.5)
})

test('flyToCheckpoint folds same-cell centering into the climb instead of hovering at ground height', async () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0.1, 99, 0.9),
    velocity: new Vec3(0, 0, 0),
    onGround: false,
    elytraFlying: true,
    eyeHeight: 1.62
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.setControlState = () => {}
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
  bot.config = { elytraFly: { horizontalSpeed: 2, verticalSpeed: 2, maxPathingY: 322 } }
  bot.elytrafly = {
    onTick() {},
    start() {},
    stop() {},
    setControlState() {},
    sendStartStopPacket() {}
  }
  const phases = []
  bot.on('physicsTick', () => phases.push(bot.elytrafly.__meteorController?.goal?.y))

  const flight = flyToCheckpoint(bot, new FlightCheckpoint(0.1, 100, 0.9, 'skyway-climb', 2), { timeoutMs: 500 })
  const timer = setInterval(() => {
    const goal = bot.elytrafly.__meteorController?.goal
    if (!goal) return
    bot.entity.position.set(goal.x, goal.y, goal.z)
  }, 10)
  await flight.finally(() => clearInterval(timer))

  assert.equal(phases.includes(99), false)
  assert.equal(bot.entity.position.y, 100)
})

test('FlightCheckpoint creates 3D waypoint with Meteor horizontal speed', () => {
  const cp = new FlightCheckpoint(10, 150, 20, 'skyway-cruise', 2)
  assert.equal(cp.x, 10)
  assert.equal(cp.y, 150)
  assert.equal(cp.z, 20)
  assert.equal(cp.phase, 'skyway-cruise')
  assert.equal(cp.horizontalSpeed, 2)
  assert.deepEqual(cp.toVec3(), new Vec3(10, 150, 20))
})

test('getSkywayAltitude uses the lowest safe transit altitude below the configured ceiling', () => {
  const stationAnchor = { x: -326, y: 97, z: -100 }
  const chunkSlice = {
    blocks: [
      { x: -321, y: 161, z: -8 },
      { x: -321, y: 214, z: -8 } // Max Y is 214
    ]
  }

  const skywayY = getSkywayAltitude(stationAnchor, chunkSlice)
  assert.equal(skywayY, 217)
})

test('getSkywayAltitude validates the configured ceiling against the whole build', () => {
  const chunkSlice = {
    bounds: { maxY: 100 },
    structureBounds: { maxY: 210 },
    blocks: [{ x: 0, y: 100, z: 0 }]
  }

  assert.equal(getSkywayAltitude({ y: 97 }, chunkSlice, { pathClearanceY: 3, maxPathingY: 220 }), 213)
  assert.equal(getSkywayAltitude({ y: 97 }, { structureBounds: { maxY: 80 } }, { stationMaxY: 102, maxPathingY: 107 }), 105)
  assert.equal(getSkywayAltitude({ y: 97 }, { structureBounds: { maxY: 319 } }), 322)
  assert.throws(
    () => getSkywayAltitude({ y: 97 }, chunkSlice, { pathClearanceY: 3, maxPathingY: 212 }),
    /maxPathingY=212 is below safe transit Y213/
  )
})

test('generateMacroTransitCheckpoints produces Top-Exit, Skyway Cruise, and Top-Entry', () => {
  const fromPos = new Vec3(-326, 98, -100) // Station pad
  const toTarget = new Vec3(-321, 163.4, -8) // Chunk target clearance
  const skywayY = 230

  const checkpoints = generateMacroTransitCheckpoints(fromPos, toTarget, skywayY, 2)
  assert.equal(checkpoints.length, 6)

  // 1. Top-Exit: Vertical climb directly out of start position
  assert.equal(checkpoints[0].phase, 'skyway-climb')
  assert.equal(checkpoints[0].x, fromPos.x)
  assert.equal(checkpoints[0].y, skywayY)
  assert.equal(checkpoints[0].z, fromPos.z)

  // 2. High-speed horizontal cruise at skyway altitude
  assert.equal(checkpoints[1].phase, 'skyway-cruise')
  assert.equal(checkpoints[4].x, toTarget.x)
  assert.equal(checkpoints[4].y, skywayY)
  assert.equal(checkpoints[4].z, toTarget.z)
  assert.equal(checkpoints[4].horizontalSpeed, 2)

  // 3. Top-Entry: Vertical descent directly through the top of the chunk into target
  assert.equal(checkpoints[5].phase, 'chunk-top-entry')
  assert.equal(checkpoints[5].x, toTarget.x)
  assert.equal(checkpoints[5].y, toTarget.y)
  assert.equal(checkpoints[5].z, toTarget.z)
})

test('generateMacroTransitCheckpoints uses the configured Meteor horizontal speed', () => {
  const checkpoints = generateMacroTransitCheckpoints(new Vec3(0, 100, 0), new Vec3(20, 80, 20), 120, 2)

  assert.ok(checkpoints.every((checkpoint) => checkpoint.horizontalSpeed === 2))
})

test('generateLandingTransitCheckpoints stops above the landing target for controlled glide descent', () => {
  const checkpoints = generateLandingTransitCheckpoints(new Vec3(-322, 208, 3), new Vec3(-325.5, 98, -99.5), 219, 2)

  assert.equal(checkpoints[0].phase, 'skyway-climb')
  assert.ok(checkpoints.slice(1).every((checkpoint) => checkpoint.phase === 'skyway-cruise'))
  assert.deepEqual(checkpoints.at(-1).toVec3(), new Vec3(-325.5, 219, -99.5))
})

test('generateObstacleAwareReentryCheckpoints routes around a solid roof from above', () => {
  const bot = {
    blockAt(position) {
      const insideChunk = position.x >= 0 && position.x < 16 && position.z >= 0 && position.z < 16
      if (insideChunk && position.y === 4) return { name: 'stone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
  }

  const checkpoints = generateObstacleAwareReentryCheckpoints(
    bot,
    new Vec3(1.5, 6, 1.5),
    new FlightCheckpoint(1.5, 2, 1.5, 'layer-print', 2),
    { chunkX: 0, chunkZ: 0, searchMargin: 2, horizontalSpeed: 2 }
  )

  assert.equal(checkpoints.some((checkpoint) => checkpoint.x < 0), true)
  assert.equal(checkpoints.at(-1).y, 2)
  assert.equal(checkpoints.at(-1).phase, 'chunk-top-entry')
})

test('local checkpoint recovery never climbs more than two blocks above its endpoints', () => {
  const bot = {
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position })
  }
  const from = new Vec3(0.5, 64, 0.5)
  const target = new FlightCheckpoint(8.5, 70, 8.5, 'layer-print', 2)
  const checkpoints = generateObstacleAwareReentryCheckpoints(bot, from, target, {
    chunkX: 0,
    chunkZ: 0,
    verticalMarginY: 2
  })

  assert.ok(checkpoints.every((checkpoint) => checkpoint.y <= 76))
  assert.equal(checkpoints.some((checkpoint) => checkpoint.phase.startsWith('skyway-')), false)
  assert.equal(checkpoints.at(-1).y, 70)
})

test('generateMacroTransitCheckpoints descends vertically when starting above skyway', () => {
  const checkpoints = generateMacroTransitCheckpoints(new Vec3(0, 250, 0), new Vec3(100, 100, 100), 220, 2)

  assert.equal(checkpoints[0].phase, 'skyway-descent')
  assert.deepEqual(checkpoints[0].toVec3(), new Vec3(0, 220, 0))
  assert.deepEqual(checkpoints.at(-2).toVec3(), new Vec3(100, 220, 100))
})

test('generateLayerCheckpoints keeps bot hovering strictly above target blocks and skips air', () => {
  const chunkX = -21
  const chunkZ = -1
  const layerY = 161
  const layerBlocks = [
    { x: -321, y: 161, z: -8, name: 'netherite_block' }, // near lane 3 (-21 * 16 + 14 = -322)
    { x: -322, y: 161, z: -7, name: 'netherite_block' }
  ]

  const checkpoints = generateLayerCheckpoints(chunkX, chunkZ, layerY, layerBlocks, { horizontalSpeed: 2, hoverOffsetY: 1.5 })
  assert.ok(checkpoints.length >= 2, 'Must generate at least one lane of checkpoints')

  // User requirement: bot will always be printing blocks which are bottom to it, never above it
  for (const cp of checkpoints) {
    assert.ok(cp.y > layerY, `Bot hover Y (${cp.y}) must be strictly above block layer Y (${layerY})`)
    assert.equal(cp.y, layerY + 2)
  }
})

test('generateLayerPrintPlan covers every non-air block exactly once in bottom-to-top serpentine checkpoints', () => {
  const blocks = []
  for (const y of [64, 65]) {
    for (let z = 0; z < 16; z += 1) {
      for (let x = 0; x < 16; x += 1) blocks.push({ x, y, z, name: 'stone' })
    }
  }
  blocks.push({ x: 0, y: 66, z: 0, name: 'air' })

  const plan = generateLayerPrintPlan(0, 0, blocks, { horizontalSpeed: 2, maxReach: 4.8, layersPerPass: 2 })
  const plannedBlocks = plan.flatMap((segment) => segment.blocks)
  const uniquePositions = new Set(plannedBlocks.map((block) => `${block.x},${block.y},${block.z}`))

  assert.equal(plannedBlocks.length, 512)
  assert.equal(uniquePositions.size, 512)
  assert.deepEqual([...new Set(plan.flatMap((segment) => segment.layers))], [64, 65])
  assert.equal(plan.some((segment) => segment.checkpoint.phase === 'layer-print-fallback'), false)

  for (const segment of plan) {
    assert.equal(segment.checkpoint.y, 67)
    assert.equal(segment.checkpoint.horizontalSpeed, 2)
    for (const block of segment.blocks) {
      assert.ok(block.y + 1 <= segment.checkpoint.y - 0.75, `Target Y${block.y} must stay below bot feet Y${segment.checkpoint.y}`)
      const eyePosition = segment.checkpoint.toVec3().offset(0, 1.62, 0)
      const blockCenter = new Vec3(block.x + 0.5, block.y + 0.5, block.z + 0.5)
      assert.ok(eyePosition.distanceTo(blockCenter) <= 4.8)
    }
  }

  assert.ok(plan.every((segment) => segment.layerMinY === 64 && segment.layerMaxY === 65))
})

test('getReachableLayersPerPass caps requested layers using reach and two-block clearance', () => {
  assert.equal(getReachableLayersPerPass({ maxReach: 5, hoverOffsetY: 2, eyeHeight: 1.62, layersPerPass: 3 }), 2)
  assert.equal(getReachableLayersPerPass({ maxReach: 4, hoverOffsetY: 2, eyeHeight: 1.62, layersPerPass: 3 }), 1)
  assert.equal(getReachableLayersPerPass({ maxReach: 5, hoverOffsetY: 2, eyeHeight: 1.62, layersPerPass: 1 }), 1)
})
