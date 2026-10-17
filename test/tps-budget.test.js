'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { TpsScaledActionBudget } = require('../src/tps-budget')

test('TpsScaledActionBudget earns credits based on elapsed time and clamps to burst cap', async () => {
  const budget = new TpsScaledActionBudget({
    blocksPerSecond: 20,
    perTickBurstCap: 5,
    minimumTps: 10.0
  })

  // First tick initializes baseline and returns 0 credits
  const granted1 = budget.beginTick(20.0, 0.05)
  assert.equal(granted1, 0)
  assert.equal(budget.tryConsume(), false)

  // Simulate 100ms passing (~2 blocks earned at 20 bps)
  await new Promise((r) => setTimeout(r, 100))
  const granted2 = budget.beginTick(20.0, 0.05)
  assert.ok(granted2 >= 1 && granted2 <= 5)
  assert.equal(budget.tryConsume(1), true)
})

test('TpsScaledActionBudget pauses when TPS drops below minimum threshold', async () => {
  const budget = new TpsScaledActionBudget({
    blocksPerSecond: 20,
    minimumTps: 10.0
  })

  budget.beginTick(20.0, 0.05)
  await new Promise((r) => setTimeout(r, 50))

  // Server TPS drops to 8.0 < 10.0
  const granted = budget.beginTick(8.0, 0.05)
  assert.equal(granted, 0)
  assert.equal(budget.paused, true)
  assert.equal(budget.pauseReason, 'BELOW_MINIMUM_TPS')
})

test('TpsScaledActionBudget keeps the server-tick stale window valid at minimum TPS', () => {
  const budget = new TpsScaledActionBudget({ minimumTps: 10, staleTickSeconds: 1.5 })
  assert.equal(budget.staleAfterSeconds, 3)
})

test('TpsScaledActionBudget caps 30 BPS printing to two placements per client tick', async () => {
  const budget = new TpsScaledActionBudget({ blocksPerSecond: 30, perTickBurstCap: 2 })
  budget.beginTick(20, 0.05)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(budget.beginTick(20, 0.05), 2)
})

test('TpsScaledActionBudget lets 20 BPS recover timer drift with a two-placement burst', async () => {
  const budget = new TpsScaledActionBudget({ blocksPerSecond: 20, perTickBurstCap: 2 })
  budget.beginTick(20, 0.05)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(budget.beginTick(20, 0.05), 2)
})
