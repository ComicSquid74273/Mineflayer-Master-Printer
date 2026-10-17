'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { loadConfig } = require('../src/config')

test('default config selects ComicBot on the test server and preserves imported printer config', () => {
  const config = loadConfig({ argv: [], env: {} })
  assert.equal(config.connection.active, 'testserver')
  assert.equal(config.bot.username, 'ComicBot')
  assert.equal(config.bot.host, '127.0.0.1')
  assert.equal(config.bot.port, 25565)
  assert.equal(config.bot.auth, 'offline')
  assert.equal(config.dashboard.enabled, true)
  assert.ok(config.printer)
  assert.ok(config.machine)
})

test('the same loader switches to the 6b6t profile', () => {
  const config = loadConfig({ argv: ['--connection=6b6t', '--username=ExampleAccount'], env: {} })
  assert.equal(config.connection.active, '6b6t')
  assert.equal(config.bot.username, 'ExampleAccount')
  assert.equal(config.bot.auth, 'microsoft')
  assert.ok(String(config.bot.host).includes('6b6t'))
})

test('runtime host and credential overrides win over the selected profile', () => {
  const config = loadConfig({
    argv: ['--connection=testserver'],
    env: {
      MINECRAFT_HOST: '127.0.0.2',
      MINECRAFT_PORT: '25570',
      MINECRAFT_USERNAME: 'OverrideBot',
      MINECRAFT_LOGIN_PASSWORD: 'override-password'
    }
  })
  assert.equal(config.bot.host, '127.0.0.2')
  assert.equal(config.bot.port, 25570)
  assert.equal(config.bot.username, 'OverrideBot')
  assert.equal(config.bot.loginPassword, 'override-password')
})

test('Meteor Elytra defaults preserve upstream values except horizontal and vertical speed 2', () => {
  const defaults = loadConfig({ argv: ['--connection=testserver'], env: {} })
  assert.equal(defaults.elytraFly.mode, 'vanilla')
  assert.equal(defaults.elytraFly.fallMultiplier, 0.01)
  assert.equal(defaults.elytraFly.horizontalSpeed, 2)
  assert.equal(defaults.elytraFly.verticalSpeed, 2)
  assert.equal(defaults.elytraFly.acceleration, false)
  assert.equal(defaults.elytraFly.stopInWater, true)
  assert.equal(defaults.elytraFly.noUnloadedChunks, true)
})

test('runtime Elytra speed overrides use Meteor speed units', () => {
  const config = loadConfig({
    argv: ['--connection=testserver', '--elytra-horizontal-speed=3', '--elytra-vertical-speed=4'],
    env: {}
  })
  assert.equal(config.elytraFly.horizontalSpeed, 3)
  assert.equal(config.elytraFly.verticalSpeed, 4)
})
