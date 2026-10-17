'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { Vec3 } = require('vec3')
const { METEOR_ELYTRA_DEFAULTS, MeteorElytraController } = require('../src/meteor-elytra-controller')
const {
  classifyRubberbanding,
  clampVelocity,
  engageElytraHover,
  escapeWaterForFlight,
  ensureElytraGliding,
  ensureElytraTakeoff,
  getLandingVelocity,
  getLandingApproachAltitude,
  getElytraTickListenerCount,
  installElytraFlightLifecycle,
  isClearLandingSpace,
  isFullBlockSurface,
  MAX_FLIGHT_ALTITUDE_Y,
  resolvePositionPacket,
  setElytraVerticalControl
} = require('../src/elytra-flight')

function createFlightBot(onGround = false) {
  const bot = new EventEmitter()
  bot.entity = { onGround, yaw: 0 }
  bot.look = async () => {}
  bot.setControlState = () => {}
  const flight = {
    tryingToTakeOff: false,
    onTick() {},
    start() {
      this.tryingToTakeOff = true
      bot.on('physicsTick', this.onTick)
    },
    stop() {
      bot.removeListener('physicsTick', this.onTick)
    },
    setControlState() {},
    sendStartStopPacket() {}
  }
  flight.onTick = flight.onTick.bind(flight)
  bot.elytrafly = flight
  return bot
}

test('Meteor Elytra settings keep upstream defaults with horizontal and vertical speed 2', () => {
  assert.equal(METEOR_ELYTRA_DEFAULTS.mode, 'vanilla')
  assert.equal(METEOR_ELYTRA_DEFAULTS.fallMultiplier, 0.01)
  assert.equal(METEOR_ELYTRA_DEFAULTS.horizontalSpeed, 2)
  assert.equal(METEOR_ELYTRA_DEFAULTS.verticalSpeed, 2)
  assert.equal(METEOR_ELYTRA_DEFAULTS.acceleration, false)
  assert.equal(METEOR_ELYTRA_DEFAULTS.stopInWater, true)
  assert.equal(METEOR_ELYTRA_DEFAULTS.noUnloadedChunks, true)
  assert.equal(METEOR_ELYTRA_DEFAULTS.noCrash, false)
  assert.equal(METEOR_ELYTRA_DEFAULTS.autoPilot, false)
})

test('Meteor Elytra controller suppresses natural fall and flies directly toward a 3D goal', () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: 0, y: -1, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }) } },
    yaw: 0,
    onGround: false,
    elytraFlying: true
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  const controller = new MeteorElytraController(bot)
  controller.start()
  bot.emit('physicsTick')
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.y, -0.01)
  assert.equal(bot.entity.velocity.z, 0)

  controller.setGoal({ x: 10, y: 102, z: 0 })
  bot.emit('physicsTick')
  assert.equal(bot.entity.velocity.x, 2)
  assert.equal(bot.entity.velocity.y, 1)
  assert.equal(bot.entity.velocity.z, 0)
  controller.stop()
})

test('Meteor Elytra controller preserves goal control and restarts after transient glide loss', () => {
  const bot = new EventEmitter()
  let restartPackets = 0
  bot.entity = {
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: 1, y: -1, z: 1, set(x, y, z) { Object.assign(this, { x, y, z }) } },
    yaw: 0,
    onGround: false,
    elytraFlying: false
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot.elytrafly = { sendStartStopPacket: () => { restartPackets += 1 } }
  const controller = new MeteorElytraController(bot, { restart: true, restartDelay: 1 })
  controller.setGoal({ x: 10, y: 102, z: 0 })
  controller.start()

  bot.emit('physicsTick')

  assert.equal(restartPackets, 1)
  assert.equal(bot.entity.velocity.x, 2)
  assert.equal(bot.entity.velocity.y, 1)
  assert.equal(bot.entity.velocity.z, 0)
  controller.stop()
})

test('Meteor Elytra controller prevents fast descent while recovering lost glide', () => {
  const bot = new EventEmitter()
  let restartPackets = 0
  bot.entity = {
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: 0, y: -1, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }) } },
    yaw: 0,
    onGround: false,
    elytraFlying: false
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot.elytrafly = { sendStartStopPacket: () => { restartPackets += 1 } }
  const controller = new MeteorElytraController(bot, { restart: true, restartDelay: 1 })
  controller.setGoal({ x: 0, y: 90, z: 0 })
  controller.start()

  bot.emit('physicsTick')

  assert.equal(restartPackets, 1)
  assert.equal(bot.entity.velocity.y, -0.02)
  controller.stop()
})

test('Meteor Elytra controller does not override goal-free landing motion during glide restart', () => {
  const bot = new EventEmitter()
  let restartPackets = 0
  bot.entity = {
    position: { x: 0, y: 120, z: 0 },
    velocity: { x: 0.25, y: -0.4, z: -0.25, set(x, y, z) { Object.assign(this, { x, y, z }) } },
    yaw: 0,
    onGround: false,
    elytraFlying: false
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot.elytrafly = { sendStartStopPacket: () => { restartPackets += 1 } }
  const controller = new MeteorElytraController(bot, { restart: true, restartDelay: 1 })
  controller.start()

  bot.emit('physicsTick')

  assert.equal(restartPackets, 1)
  assert.deepEqual(
    { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z },
    { x: 0.25, y: -0.4, z: -0.25 }
  )
  controller.stop()
})

test('vertical ElytraFly control preserves the requested single-axis direction', () => {
  let heightDirection = 0
  const bot = {
    elytrafly: {
      setControlState(state, value) {
        if (state === 'up') heightDirection = value ? 1 : 0
        if (state === 'down') heightDirection = value ? -1 : 0
      }
    }
  }

  setElytraVerticalControl(bot, 'down')
  assert.equal(heightDirection, -1)
  setElytraVerticalControl(bot, 'up')
  assert.equal(heightDirection, 1)
  setElytraVerticalControl(bot, 'neutral')
  assert.equal(heightDirection, 0)
})

test('MAX_FLIGHT_ALTITUDE_Y enforces hard ceiling at build height plus five', () => {
  assert.equal(MAX_FLIGHT_ALTITUDE_Y, 324)
  let upCalled = false
  const botAtCeiling = {
    entity: { position: { y: 324 } },
    elytrafly: {
      setControlState(state, value) {
        if (state === 'up' && value) upCalled = true
      }
    }
  }

  setElytraVerticalControl(botAtCeiling, 'up')
  assert.equal(upCalled, false, 'Should not command UP when at or above 324Y')

  // Velocity clamp stops upward velocity at 324Y
  const velBot = {
    entity: {
      position: { y: 324 },
      velocity: {
        x: 0,
        y: 0.5,
        z: 0,
        set(x, y, z) { this.x = x; this.y = y; this.z = z }
      }
    }
  }
  clampVelocity(velBot, 25, 8)
  assert.equal(velBot.entity.velocity.y, 0, 'Velocity Y must be zeroed when at or above 324Y')
})

test('resolves modern relative server position correction flags', () => {
  const resolved = resolvePositionPacket(
    { x: 10, y: 20, z: 30 },
    { x: 2, y: 50, z: -4, flags: { x: true, y: false, z: true } }
  )
  assert.deepEqual(resolved, { x: 12, y: 50, z: 26 })
})

test('resolves legacy relative server position correction flags', () => {
  const resolved = resolvePositionPacket(
    { x: 10, y: 20, z: 30 },
    { x: 2, y: 50, z: -4, flags: 5 }
  )
  assert.deepEqual(resolved, { x: 12, y: 50, z: 26 })
})

test('velocity clamp enforces horizontal and vertical blocks-per-second caps', () => {
  const velocity = {
    x: 2,
    y: 1,
    z: 0,
    set(x, y, z) {
      this.x = x
      this.y = y
      this.z = z
    }
  }
  const measured = clampVelocity({ entity: { velocity } }, 25, 8)
  assert.equal(measured.horizontal, 25)
  assert.equal(measured.vertical, 8)
  assert.equal(velocity.x, 1.25)
  assert.equal(velocity.y, 0.4)
})

test('velocity clamp supports the configured 50 BPS vertical cruise speed', () => {
  const velocity = {
    x: 0,
    y: 4,
    z: 0,
    set(x, y, z) {
      this.x = x
      this.y = y
      this.z = z
    }
  }
  const measured = clampVelocity({ entity: { velocity } }, 50, 50)
  assert.equal(measured.vertical, 50)
  assert.equal(velocity.y, 2.5)
})

test('landing flare slows terminal descent and corrects toward the pad', () => {
  const entry = getLandingVelocity({ x: 2, y: 5, z: 0 }, { x: 0, y: 0, z: 0 })
  assert.equal(entry.verticalBlocksPerSecond, 1.5)
  assert.equal(entry.horizontalBlocksPerSecond, 1.5)
  assert.ok(entry.x < 0)
  assert.equal(entry.y, -0.075)

  const resetFlare = getLandingVelocity({ x: 0.1, y: 4, z: 0.1 }, { x: 0, y: 0, z: 0 }, { liftBlocksPerSecond: 1.6 })
  assert.equal(resetFlare.y, 0.08)

  const touchdown = getLandingVelocity({ x: 0.1, y: 0.2, z: 0.1 }, { x: 0, y: 0, z: 0 })
  assert.equal(touchdown.verticalBlocksPerSecond, 0.08)
  assert.equal(touchdown.horizontalBlocksPerSecond, 0)
  assert.equal(touchdown.y, -0.004)
})

test('nearby landing approach keeps current altitude instead of climbing away from the pad', () => {
  assert.equal(getLandingApproachAltitude({ x: -325.2, y: 102, z: -105.3 }, { x: -325.5, y: 98, z: -99.5 }), 102)
  assert.equal(getLandingApproachAltitude({ x: -300, y: 102, z: -105.3 }, { x: -325.5, y: 98, z: -99.5 }), 110)
})

test('landing waits for server-confirmed Elytra state', async () => {
  const velocity = { x: 0, y: -0.1, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }) } }
  const bot = {
    entity: { elytraFlying: false, onGround: false, velocity },
    health: 20,
    getEquipmentDestSlot: () => 6,
    inventory: { slots: { 6: { name: 'elytra' } } },
    async elytraFly() {
      this.entity.elytraFlying = true
    }
  }
  assert.equal(await ensureElytraGliding(bot, { confirmationMs: 100 }), true)
})

test('Elytra takeoff handles a bot that settles onto the ground before launch', async () => {
  const velocity = { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }) } }
  const bot = {
    entity: { elytraFlying: false, onGround: true, velocity },
    health: 20,
    _client: { state: 'play' },
    getEquipmentDestSlot: () => 6,
    inventory: { slots: { 6: { name: 'elytra' } } },
    setControlState(state, value) {
      if (state === 'jump' && value) this.entity.onGround = false
    },
    async elytraFly() {
      this.entity.elytraFlying = true
    }
  }
  assert.equal(await ensureElytraTakeoff(bot, { airborneTimeoutMs: 100, confirmationMs: 100 }), true)
})

test('ensureElytraGliding swims upward before starting flight in water', async () => {
  const bot = createFlightBot(false)
  let glideRequests = 0
  bot.entity.isInWater = true
  bot.entity.elytraFlying = false
  bot.entity.velocity = {
    x: 0,
    y: 0,
    z: 0,
    set() { bot.entity.isInWater = false }
  }
  bot.inventory = { slots: { 6: { name: 'elytra' } } }
  bot.getEquipmentDestSlot = () => 6
  bot._client = { state: 'play' }
  bot.elytraFly = async () => {
    glideRequests += 1
    bot.entity.elytraFlying = true
  }

  await ensureElytraGliding(bot, { waterEscapeTimeoutMs: 1000 })

  assert.equal(bot.entity.isInWater, false)
  assert.equal(glideRequests, 1)
})

test('escapeWaterForFlight swims toward a nearby dry landing cell', async () => {
  const bot = createFlightBot(false)
  const controls = new Map()
  let lookedAt = null
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.entity.isInWater = true
  bot.entity.velocity = {
    x: 0,
    y: 0,
    z: 0,
    set(x, y, z) {
      Object.assign(this, { x, y, z })
      if (controls.get('forward')) bot.entity.isInWater = false
    }
  }
  bot.setControlState = (state, value) => controls.set(state, value)
  bot.lookAt = async (target) => { lookedAt = target }
  bot.blockAt = (position) => {
    if (Math.floor(position.x) === 2 && Math.floor(position.z) === 0 && Math.floor(position.y) === 63) {
      return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    if (Math.floor(position.x) === 2 && Math.floor(position.z) === 0 && [64, 65].includes(Math.floor(position.y))) {
      return { name: 'air', boundingBox: 'empty', shapes: [] }
    }
    return { name: 'water', boundingBox: 'empty', shapes: [] }
  }

  const results = await Promise.all([
    escapeWaterForFlight(bot, 1000),
    escapeWaterForFlight(bot, 1000)
  ])
  assert.deepEqual(results, [true, true])
  assert.equal(Math.floor(lookedAt.x), 2)
  assert.equal(controls.get('forward'), false)
  assert.equal(controls.get('jump'), false)
})

test('escapeWaterForFlight pathfinds to dry ground without digging or scaffolding', async () => {
  const bot = createFlightBot(false)
  const movements = {}
  let pathfinderCalls = 0
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.entity.isInWater = true
  bot.entity.onGround = false
  bot.blockAt = (position) => {
    if (Math.floor(position.x) === 2 && Math.floor(position.z) === 0 && Math.floor(position.y) === 63) {
      return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    }
    if (Math.floor(position.x) === 2 && Math.floor(position.z) === 0 && [64, 65].includes(Math.floor(position.y))) {
      return { name: 'air', boundingBox: 'empty', shapes: [] }
    }
    return { name: 'water', boundingBox: 'empty', shapes: [] }
  }
  bot.pathfinder = {
    movements,
    setMovements() {},
    setGoal() {},
    async goto(goal) {
      pathfinderCalls += 1
      assert.equal(goal.x, 2)
      assert.equal(goal.y, 64)
      assert.equal(goal.z, 0)
      bot.entity.isInWater = false
      bot.entity.onGround = true
    }
  }

  assert.equal(await escapeWaterForFlight(bot, 1000), true)
  assert.equal(pathfinderCalls, 1)
  assert.equal(movements.canDig, false)
  assert.deepEqual(movements.scafoldingBlocks, [])
})

test('landing checks reject liquids and accept a clear full block', () => {
  const fullBlock = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  const air = { name: 'air', boundingBox: 'empty', shapes: [] }
  const water = { name: 'water', boundingBox: 'empty', shapes: [] }
  assert.equal(isFullBlockSurface(fullBlock), true)
  assert.equal(isFullBlockSurface(water), false)
  assert.equal(isClearLandingSpace(air), true)
  assert.equal(isClearLandingSpace(water), false)
})

test('rubberbanding classification catches large and repeated corrections', () => {
  assert.equal(classifyRubberbanding({
    maximumCorrectionDistance: 0,
    backwardCorrectionCount: 0,
    correctionCount: 0,
    totalCorrectionDistance: 0
  }), false)
  assert.equal(classifyRubberbanding({
    maximumCorrectionDistance: 2,
    backwardCorrectionCount: 0,
    correctionCount: 1,
    totalCorrectionDistance: 2
  }), true)
})

test('ElytraFly lifecycle collapses duplicate physics listeners and makes start idempotent', () => {
  const bot = createFlightBot(false)
  bot.elytrafly.start()
  bot.elytrafly.start()
  assert.equal(getElytraTickListenerCount(bot), 2)

  installElytraFlightLifecycle(bot)
  bot.elytrafly.start()
  bot.elytrafly.start()

  assert.equal(getElytraTickListenerCount(bot), 1)
  assert.equal(bot.elytrafly.tryingToTakeOff, false)
})

test('repeated hover engagement keeps exactly one ElytraFly physics listener', () => {
  const bot = createFlightBot(false)
  installElytraFlightLifecycle(bot)
  engageElytraHover(bot)
  engageElytraHover(bot)
  engageElytraHover(bot)
  assert.equal(getElytraTickListenerCount(bot), 1)
})

test('hover descends to the configured path ceiling instead of holding an excessive correction height', () => {
  const bot = createFlightBot(false)
  bot.entity.position = new Vec3(0, 400, 0)
  bot.entity.velocity = new Vec3(0, 0, 0)
  bot.entity.elytraFlying = true
  bot.config = { elytraFly: { maxAltitudeY: 324, maxPathingY: 322 } }
  installElytraFlightLifecycle(bot)

  const hover = engageElytraHover(bot, { targetY: 400, sendStartPacket: false })

  assert.equal(hover.targetY, 322)
  assert.equal(bot.elytrafly.__meteorController.goal.y, 322)
})
