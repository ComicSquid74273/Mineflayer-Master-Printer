'use strict'

// Port of reference TpsScaledActionBudget.java
const NORMAL_SERVER_TPS = 20.0
const NANOS_PER_SECOND = 1_000_000_000n

class TpsScaledActionBudget {
  constructor(options = {}) {
    this.maximumActionsPerSecond = Math.max(0.1, Number(options.blocksPerSecond || 25))
    this.minimumTps = Math.max(0.1, Math.min(NORMAL_SERVER_TPS, Number(options.minimumTps || 10.0)))
    this.staleAfterSeconds = Math.max(
      30 / this.minimumTps,
      Math.max(0, Number(options.staleTickSeconds || 1.5))
    )
    this.perTickBurstCap = Math.max(1, Math.floor(Number(options.perTickBurstCap || 5)))
    
    this.initialized = false
    this.paused = false
    this.lastTickNanos = 0n
    this.fractionalCarry = 0.0
    this.remainingThisTick = 0
    this.pauseReason = 'NONE'
  }

  classifyPause(sampledTps, secondsSinceServerTick) {
    if (!Number.isFinite(sampledTps)) return 'INVALID_TPS'
    if (sampledTps < this.minimumTps) return 'BELOW_MINIMUM_TPS'
    if (!Number.isFinite(secondsSinceServerTick) || secondsSinceServerTick < 0) return 'INVALID_SERVER_TICK_AGE'
    if (secondsSinceServerTick > this.staleAfterSeconds) return 'STALE_SERVER_TICK'
    return 'NONE'
  }

  clearCredits() {
    this.fractionalCarry = 0.0
    this.remainingThisTick = 0
  }

  beginTick(sampledTps, secondsSinceServerTick) {
    const nowNanos = process.hrtime.bigint()
    let elapsedNanos = 0n

    if (this.initialized) {
      if (nowNanos < this.lastTickNanos) {
        throw new Error('Monotonic time cannot move backwards.')
      }
      elapsedNanos = nowNanos - this.lastTickNanos
    }

    const nextPauseReason = this.classifyPause(sampledTps, secondsSinceServerTick)
    if (nextPauseReason !== 'NONE') {
      this.initialized = true
      this.lastTickNanos = nowNanos
      this.paused = true
      this.pauseReason = nextPauseReason
      this.clearCredits()
      return 0
    }

    if (!this.initialized || this.paused) {
      this.initialized = true
      this.lastTickNanos = nowNanos
      this.paused = false
      this.pauseReason = 'NONE'
      this.clearCredits()
      return 0
    }

    this.lastTickNanos = nowNanos
    this.paused = false
    this.pauseReason = 'NONE'
    this.remainingThisTick = 0

    if (elapsedNanos === 0n) return 0

    const clampedTps = Math.min(sampledTps, NORMAL_SERVER_TPS)
    
    // earned = elapsedSeconds * maximumActionsPerSecond * (clampedTps / 20.0) + carry
    const elapsedSeconds = Number(elapsedNanos) / Number(NANOS_PER_SECOND)
    const earned = (elapsedSeconds * this.maximumActionsPerSecond * (clampedTps / NORMAL_SERVER_TPS)) + this.fractionalCarry

    const wholeCredits = Math.floor(earned)
    this.fractionalCarry = earned - wholeCredits

    let grantedThisTick = wholeCredits
    if (grantedThisTick >= this.perTickBurstCap) {
      grantedThisTick = this.perTickBurstCap
    }

    this.remainingThisTick = grantedThisTick
    return grantedThisTick
  }

  tryConsume(actions = 1) {
    if (actions < 0) throw new Error('Consumed action count cannot be negative.')
    if (actions > this.remainingThisTick) return false
    this.remainingThisTick -= actions
    return true
  }
}

module.exports = { TpsScaledActionBudget }
