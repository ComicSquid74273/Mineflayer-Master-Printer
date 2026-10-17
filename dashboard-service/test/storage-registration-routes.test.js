'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-printer-dashboard-storage-'))
process.env.DASHBOARD_DATA_DIR = dataDir
process.env.DASHBOARD_CONFIG_DIR = path.join(dataDir, 'config')
process.env.DASHBOARD_STRUCTURE_DIR = path.join(dataDir, 'schematics')
process.env.DASHBOARD_LOGS_DIR = path.join(dataDir, 'logs')
process.env.DASHBOARD_DELIVERY_RUNTIME_DIR = path.join(dataDir, 'delivery')
process.env.DASHBOARD_HOST = '127.0.0.1'
process.env.DASHBOARD_PORT = '0'
process.env.DASHBOARD_ADMIN_USERNAME = 'admin'
process.env.DASHBOARD_ADMIN_PASSWORD = 'test-admin-pass'

const { createDashboardServer, store } = require('../src/server')

let server
let baseUrl
let sessionCookie = ''

async function request(relativePath, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (sessionCookie) headers.cookie = sessionCookie
  const response = await fetch(`${baseUrl}${relativePath}`, { ...options, headers })
  const contentType = String(response.headers.get('content-type') || '')
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text()
  return { response, body }
}

function jsonPost(relativePath, payload) {
  return request(relativePath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

test.before(async () => {
  server = createDashboardServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`

  const login = await request('/api/dashboard/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-admin-pass' })
  })
  assert.equal(login.response.status, 200)
  const rawCookie = login.response.headers.get('set-cookie') || ''
  sessionCookie = rawCookie.split(';')[0]
})

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('queues storage registration for single bot and for all bots via pull queue', async () => {
  store.upsertBotStatus({ botName: 'ComicBot', runtime: 'mineflayer-master-printer', hostLabel: 'local', online: true, role: 'single', phase: 'idle' })
  store.upsertBotStatus({ botName: 'HelperBot', runtime: 'mineflayer-master-printer', hostLabel: 'local', online: true, role: 'single', phase: 'idle' })

  let res = await jsonPost('/api/dashboard/bots/ComicBot/commands/register-storage', {
    anchor: { x: -326, y: 97, z: -100 }
  })
  assert.equal(res.response.status, 201)
  assert.equal(res.body.command.commandType, 'register-storage')
  assert.deepEqual(res.body.anchor, { x: -326, y: 97, z: -100 })

  let pending = await request('/api/bots/ComicBot/commands')
  assert.equal(pending.response.status, 200)
  const command = pending.body.items.find((item) => item.commandType === 'register-storage')
  assert.ok(command)
  assert.deepEqual(command.payload.anchor, { x: -326, y: 97, z: -100 })

  const claimed = await request(`/api/bots/ComicBot/commands/${command.commandId}/claim`, { method: 'POST' })
  assert.equal(claimed.response.status, 200)
  assert.equal(claimed.body.command.status, 'claimed')

  const sampleRegistration = {
    botName: 'ComicBot',
    anchor: { x: -326, y: 97, z: -100 },
    landingTarget: { x: -326.5, y: 98, z: -100.5 },
    registeredAt: new Date().toISOString(),
    summary: { registeredContainerCount: 4, materialContainerCount: 1, dumpContainerCount: 3, shulkerCount: 2, materialTypeCount: 6 },
    dumpContainers: [
      { containerId: '-326,97,-99', position: { x: -326, y: 97, z: -99 }, order: 1, freeSlots: 27, full: false },
      { containerId: '-325,97,-99', position: { x: -325, y: 97, z: -99 }, order: 2, freeSlots: 27, full: false },
      { containerId: '-324,97,-99', position: { x: -324, y: 97, z: -99 }, order: 3, freeSlots: 27, full: false }
    ],
    materialIndex: { white_concrete: [{ containerId: '-320,97,-98', count: 64 }] },
    containers: [
      { containerId: '-320,97,-98', position: { x: -320, y: 97, z: -98 }, purpose: 'materials', usedSlots: 2 },
      { containerId: '-326,97,-99', position: { x: -326, y: 97, z: -99 }, purpose: 'dump', usedSlots: 0 },
      { containerId: '-325,97,-99', position: { x: -325, y: 97, z: -99 }, purpose: 'dump', usedSlots: 0 },
      { containerId: '-324,97,-99', position: { x: -324, y: 97, z: -99 }, purpose: 'dump', usedSlots: 0 }
    ],
    ignoredEmptyContainers: [
      { position: { x: -319, y: 97, z: -98 }, blockName: 'chest' },
      { position: { x: -318, y: 97, z: -98 }, blockName: 'chest' }
    ],
    errors: [
      { position: { x: -317, y: 97, z: -98 }, blockName: 'chest', message: 'open timeout' }
    ],
    enderChest: {
      position: { x: -328, y: 98, z: -103 },
      blockName: 'ender_chest',
      capacitySlots: 27,
      usedSlots: 2,
      freeSlots: 25,
      shulkerCount: 1
    },
    nestedContainerData: 'x'.repeat(6 * 1024 * 1024)
  }

  const completed = await jsonPost(`/api/bots/ComicBot/commands/${command.commandId}/result`, {
    status: 'succeeded',
    resultMessage: 'registered 4 containers',
    storageRegistration: sampleRegistration
  })
  assert.equal(completed.response.status, 200)

  const stored = await request('/api/bots/ComicBot/storage-registration')
  assert.equal(stored.response.status, 200)
  assert.equal(stored.body.registration.summary.dumpContainerCount, 3)

  const fleet = await request('/api/dashboard/snapshot')
  assert.equal(fleet.response.status, 200)
  const botCard = fleet.body.bots.find((item) => item.botName === 'ComicBot')
  assert.equal(botCard.storageRegistration.summary.dumpContainerCount, 3)
  assert.equal(botCard.storageRegistration.summary.nonEmptyContainerCount, 1)
  assert.equal(botCard.storageRegistration.summary.registeredEmptyContainerCount, 3)
  assert.equal(botCard.storageRegistration.summary.ignoredEmptyContainerCount, 2)
  assert.equal(botCard.storageRegistration.summary.emptyContainerCount, 5)
  assert.deepEqual(botCard.storageRegistration.errors, [
    { position: { x: -317, y: 97, z: -98 }, blockName: 'chest', message: 'open timeout' }
  ])
  assert.deepEqual(botCard.storageRegistration.enderChest, {
    position: { x: -328, y: 98, z: -103 },
    blockName: 'ender_chest',
    capacitySlots: 27,
    usedSlots: 2,
    freeSlots: 25,
    shulkerCount: 1
  })
  assert.deepEqual(botCard.storageRegistration.anchor, { x: -326, y: 97, z: -100 })

  res = await jsonPost('/api/dashboard/commands/register-storage-all', {
    anchor: { x: -326, y: 97, z: -100 }
  })
  assert.equal(res.response.status, 201)
  assert.equal(res.body.items.length, 2)
})
