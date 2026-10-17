'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { getReconnectConfig, getReconnectDelayMs } = require('../src/connection-manager')

test('connection throttling uses the configurable longer reconnect delay', () => {
  const reconnect = getReconnectConfig({ bot: { reconnect: { enabled: true, delayMs: 5000, throttledDelayMs: 30000 } } })

  assert.equal(getReconnectDelayMs(reconnect, { endReason: 'kicked: Connection throttled! Please wait before reconnecting.' }), 30000)
  assert.equal(getReconnectDelayMs(reconnect, { endReason: 'socketClosed' }), 5000)
  assert.equal(getReconnectDelayMs(reconnect, { manualAction: 'reconnect' }), 1000)
})
