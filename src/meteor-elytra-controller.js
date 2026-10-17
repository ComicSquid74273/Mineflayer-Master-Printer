'use strict'

const { Vec3 } = require('vec3')

const METEOR_ELYTRA_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'vanilla',
  autoTakeOff: true,
  fallMultiplier: 0.01,
  horizontalSpeed: 2,
  verticalSpeed: 2,
  acceleration: false,
  accelerationStep: 1,
  accelerationStart: 0,
  stopInWater: true,
  noUnloadedChunks: true,
  autoHover: false,
  noCrash: false,
  crashLookAhead: 5,
  instantDrop: false,
  pitch40LowerBounds: 180,
  pitch40UpperBounds: 220,
  pitch40RotateSpeedUp: 5.45,
  pitch40RotateSpeedDown: 0.9,
  autoJump: true,
  yawLock: 'smart',
  yaw: 0,
  pitchLock: true,
  pitch: 85,
  restart: true,
  restartDelay: 7,
  sprintConstantly: true,
  manualTakeoff: false,
  elytraReplace: false,
  replaceDurability: 2,
  chestSwap: 'never',
  replenishFireworks: false,
  replenishSlot: 9,
  autoPilot: false,
  useFireworks: false,
  fireworkDelay: 8,
  minimumHeight: 120,
  maxAltitudeY: 324,
  maxPathingY: 322,
  pathClearanceY: 3,
  pathEscapeSearchRadius: 24,
  glideHeight: 5
})

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeMeteorElytraSettings(value = {}) {
  const legacyHorizontal = value.speedBlocksPerSecond == null
    ? METEOR_ELYTRA_DEFAULTS.horizontalSpeed
    : finiteNumber(value.speedBlocksPerSecond, 40) / 20
  const legacyVertical = value.verticalBlocksPerSecond == null
    ? METEOR_ELYTRA_DEFAULTS.verticalSpeed
    : finiteNumber(value.verticalBlocksPerSecond, 20) / 10
  return {
    ...METEOR_ELYTRA_DEFAULTS,
    ...value,
    mode: String(value.mode || METEOR_ELYTRA_DEFAULTS.mode).toLowerCase(),
    fallMultiplier: Math.max(0, finiteNumber(value.fallMultiplier, METEOR_ELYTRA_DEFAULTS.fallMultiplier)),
    horizontalSpeed: Math.max(0, finiteNumber(value.horizontalSpeed, legacyHorizontal)),
    verticalSpeed: Math.max(0, finiteNumber(value.verticalSpeed, legacyVertical)),
    accelerationStep: Math.max(0.1, finiteNumber(value.accelerationStep, METEOR_ELYTRA_DEFAULTS.accelerationStep)),
    accelerationStart: Math.max(0, finiteNumber(value.accelerationStart, METEOR_ELYTRA_DEFAULTS.accelerationStart)),
    crashLookAhead: Math.max(1, finiteNumber(value.crashLookAhead, METEOR_ELYTRA_DEFAULTS.crashLookAhead)),
    maxAltitudeY: finiteNumber(value.maxAltitudeY, METEOR_ELYTRA_DEFAULTS.maxAltitudeY),
    maxPathingY: finiteNumber(value.maxPathingY, METEOR_ELYTRA_DEFAULTS.maxPathingY),
    pathClearanceY: Math.max(1, finiteNumber(value.pathClearanceY, METEOR_ELYTRA_DEFAULTS.pathClearanceY)),
    pathEscapeSearchRadius: Math.max(1, Math.min(64, Math.floor(finiteNumber(value.pathEscapeSearchRadius, METEOR_ELYTRA_DEFAULTS.pathEscapeSearchRadius)))),
    glideHeight: Math.max(2, finiteNumber(value.glideHeight, METEOR_ELYTRA_DEFAULTS.glideHeight))
  }
}

function hasElytra(bot) {
  const slot = bot.getEquipmentDestSlot?.('torso')
  return Number.isInteger(slot) && bot.inventory?.slots?.[slot]?.name === 'elytra'
}

function isLoaded(bot, x, y, z) {
  if (typeof bot.blockAt !== 'function') return true
  try {
    return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))) !== null
  } catch {
    return true
  }
}

function isSolid(block) {
  return Boolean(block && block.boundingBox !== 'empty' && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air')
}

class MeteorElytraController {
  constructor(bot, settings = {}) {
    this.bot = bot
    this.settings = normalizeMeteorElytraSettings(settings)
    this.controls = { forward: false, back: false, up: false, down: false }
    this.goal = null
    this.acceleration = 0
    this.enabled = false
    this.takeoffTicks = 0
    this.restartTicks = 0
    this.nextDebugAt = 0
    this.onTick = this.onTick.bind(this)
  }

  configure(settings = {}) {
    this.settings = normalizeMeteorElytraSettings({ ...this.settings, ...settings })
    return this.settings
  }

  start() {
    this.enabled = true
    this.bot.removeListener?.('physicsTick', this.onTick)
    this.bot.on?.('physicsTick', this.onTick)
    return this
  }

  stop() {
    this.enabled = false
    this.bot.removeListener?.('physicsTick', this.onTick)
    this.clearGoal()
    this.clearControls()
    return this
  }

  setControlState(state, value) {
    if (Object.hasOwn(this.controls, state)) this.controls[state] = Boolean(value)
  }

  getControlState(state) {
    return Boolean(this.controls[state])
  }

  clearControls() {
    for (const state of Object.keys(this.controls)) this.controls[state] = false
    this.acceleration = 0
  }

  setGoal(target, options = {}) {
    if (![target?.x, target?.y, target?.z].every((entry) => Number.isFinite(Number(entry)))) throw new TypeError('Meteor Elytra goal requires finite x, y, and z.')
    this.goal = {
      x: Number(target.x),
      y: Math.min(this.settings.maxAltitudeY, Number(target.y)),
      z: Number(target.z),
      horizontal: options.horizontal !== false,
      vertical: options.vertical !== false,
      horizontalTolerance: Math.max(0.05, finiteNumber(options.horizontalTolerance, 0.5)),
      verticalTolerance: Math.max(0.02, finiteNumber(options.verticalTolerance, 0.25))
    }
    return this.goal
  }

  clearGoal() {
    this.goal = null
  }

  horizontalSpeed() {
    const moving = this.goal?.horizontal || this.controls.forward || this.controls.back || this.settings.autoPilot
    if (!this.settings.acceleration) return this.settings.horizontalSpeed
    if (!moving) this.acceleration = 0
    this.acceleration = Math.min(
      this.acceleration + this.settings.accelerationStart + (this.settings.accelerationStep * 0.1),
      this.settings.horizontalSpeed
    )
    return this.acceleration
  }

  horizontalVelocity(position) {
    const speed = this.horizontalSpeed()
    if (this.goal?.horizontal) {
      const deltaX = this.goal.x - position.x
      const deltaZ = this.goal.z - position.z
      const remaining = Math.hypot(deltaX, deltaZ)
      const stopDistance = Math.min(0.1, this.goal.horizontalTolerance)
      if (remaining <= stopDistance || speed <= 0) return { x: 0, z: 0 }
      const magnitude = Math.min(speed, Math.max(0.05, remaining))
      return { x: deltaX / remaining * magnitude, z: deltaZ / remaining * magnitude }
    }

    const direction = (this.controls.back ? -1 : 0) + ((this.controls.forward || this.settings.autoPilot) ? 1 : 0)
    if (direction === 0 || speed <= 0) return { x: 0, z: 0 }
    return {
      x: -Math.sin(Number(this.bot.entity?.yaw || 0)) * speed * direction,
      z: -Math.cos(Number(this.bot.entity?.yaw || 0)) * speed * direction
    }
  }

  verticalVelocity(position, currentVelocity) {
    let velocity = Number(currentVelocity || 0)
    if (velocity < 0) velocity *= this.settings.fallMultiplier
    else if (velocity > 0) velocity = 0

    if (this.goal?.vertical) {
      const remaining = this.goal.y - position.y
      if (Math.abs(remaining) <= this.goal.verticalTolerance) return 0
      const maximum = this.settings.verticalSpeed * 0.5
      return Math.sign(remaining) * Math.min(maximum, Math.abs(remaining))
    }

    if (this.controls.up && position.y < this.settings.maxAltitudeY) velocity += this.settings.verticalSpeed * 0.5
    else if (this.controls.down) velocity -= this.settings.verticalSpeed * 0.5
    return velocity
  }

  blocksHorizontalMotion(position, velocity) {
    const nextX = position.x + velocity.x
    const nextZ = position.z + velocity.z
    if (this.settings.noUnloadedChunks && !isLoaded(this.bot, nextX, position.y, nextZ)) return true
    if (!this.settings.noCrash || Math.hypot(velocity.x, velocity.z) === 0 || typeof this.bot.blockAt !== 'function') return false
    const distance = this.settings.crashLookAhead
    const magnitude = Math.hypot(velocity.x, velocity.z)
    const lookX = position.x + velocity.x / magnitude * distance
    const lookZ = position.z + velocity.z / magnitude * distance
    return isSolid(this.bot.blockAt(new Vec3(Math.floor(lookX), Math.floor(position.y), Math.floor(lookZ)))) ||
      isSolid(this.bot.blockAt(new Vec3(Math.floor(lookX), Math.floor(position.y + 1), Math.floor(lookZ))))
  }

  debug(state, details = '') {
    if (this.bot.config?.printer?.debugLogging !== true || Date.now() < this.nextDebugAt) return
    this.nextDebugAt = Date.now() + 1000
    const position = this.bot.entity?.position
    const location = position ? ` position=${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}` : ''
    console.log(`[ELYTRA-METEOR] state=${state}${location}${details ? ` ${details}` : ''}`)
  }

  onTick() {
    if (!this.enabled || !this.bot.entity?.velocity || !this.bot.entity?.position) return
    if (!hasElytra(this.bot)) {
      this.debug('stopped', 'reason=no-elytra')
      return this.stop()
    }
    if (this.settings.stopInWater && this.bot.entity.isInWater) {
      this.debug('stopped', 'reason=water')
      return this.stop()
    }

    if (this.bot.entity.onGround) {
      this.debug('grounded', `gliding=${Boolean(this.bot.entity.elytraFlying)} controls=${JSON.stringify(this.controls)}`)
      this.restartTicks = 0
      if (this.settings.autoTakeOff) {
        this.takeoffTicks += 1
        this.bot.setControlState?.('jump', true)
        if (this.takeoffTicks >= 8) {
          this.takeoffTicks = 0
          this.bot.elytrafly?.sendStartStopPacket?.()
        }
      }
      return
    }
    this.takeoffTicks = 0
    if (!this.bot.entity.elytraFlying) {
      const position = this.bot.entity.position
      const maintainControlledMotion = Boolean(this.goal || this.controls.forward || this.controls.back || this.controls.up || this.controls.down || this.settings.autoPilot)
      let horizontal = { x: Number(this.bot.entity.velocity.x || 0), z: Number(this.bot.entity.velocity.z || 0) }
      let vertical = Number(this.bot.entity.velocity.y || 0)
      if (maintainControlledMotion) {
        horizontal = this.horizontalVelocity(position)
        const controlledVertical = this.verticalVelocity(position, vertical)
        vertical = controlledVertical < 0 ? Math.max(controlledVertical, -0.02) : controlledVertical
        if (position.y >= this.settings.maxAltitudeY && vertical > 0) vertical = 0
        this.bot.entity.velocity.set(horizontal.x, vertical, horizontal.z)
      }
      this.restartTicks += 1
      if (this.settings.restart && this.restartTicks >= Math.max(1, Math.floor(this.settings.restartDelay))) {
        this.restartTicks = 0
        if (typeof this.bot.elytraFly === 'function') {
          this.bot.elytraFly().catch(() => {})
        } else {
          this.bot.elytrafly?.sendStartStopPacket?.()
        }
      }
      this.debug('airborne', `gliding=false controls=${JSON.stringify(this.controls)} goal=${this.goal ? `${this.goal.x.toFixed(1)},${this.goal.y.toFixed(1)},${this.goal.z.toFixed(1)}` : 'none'} velocity=${horizontal.x.toFixed(3)},${vertical.toFixed(3)},${horizontal.z.toFixed(3)}`)
      return
    }
    this.restartTicks = 0

    const position = this.bot.entity.position
    const horizontal = this.horizontalVelocity(position)
    if (this.blocksHorizontalMotion(position, horizontal)) {
      horizontal.x = 0
      horizontal.z = 0
      this.acceleration = 0
    }
    let vertical = this.verticalVelocity(position, this.bot.entity.velocity.y)
    if (position.y >= this.settings.maxAltitudeY && vertical > 0) vertical = 0
    this.bot.entity.velocity.set(horizontal.x, vertical, horizontal.z)
    this.debug('flying', `controls=${JSON.stringify(this.controls)} goal=${this.goal ? `${this.goal.x.toFixed(1)},${this.goal.y.toFixed(1)},${this.goal.z.toFixed(1)}` : 'none'} velocity=${horizontal.x.toFixed(3)},${vertical.toFixed(3)},${horizontal.z.toFixed(3)}`)
  }
}

module.exports = {
  METEOR_ELYTRA_DEFAULTS,
  MeteorElytraController,
  normalizeMeteorElytraSettings
}
