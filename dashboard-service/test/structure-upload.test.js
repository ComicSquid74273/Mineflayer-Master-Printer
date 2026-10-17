'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-printer-dashboard-upload-'))
process.env.DASHBOARD_DATA_DIR = dataDir
process.env.DASHBOARD_CONFIG_DIR = path.join(dataDir, 'config')
process.env.DASHBOARD_STRUCTURE_DIR = path.join(dataDir, 'structures')
process.env.DASHBOARD_LOGS_DIR = path.join(dataDir, 'logs')
process.env.DASHBOARD_DELIVERY_RUNTIME_DIR = path.join(dataDir, 'delivery')
process.env.DASHBOARD_ADMIN_USERNAME = 'admin'
process.env.DASHBOARD_ADMIN_PASSWORD = 'dashboard-test-password'
process.env.DASHBOARD_HOST = '127.0.0.1'
process.env.DASHBOARD_PORT = '0'
process.env.DASHBOARD_SESSION_SECRET = 'structure-upload-test-secret'

const { createDashboardServer } = require('../src/server')

let server
let baseUrl

test.before(async () => {
  server = createDashboardServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('dashboard accepts litematic uploads through the operator API', async () => {
  const loginResponse = await fetch(`${baseUrl}/api/dashboard/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'dashboard-test-password' })
  })
  assert.equal(loginResponse.status, 200)
  const cookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie)

  const form = new FormData()
  form.append('files', new Blob([Buffer.from('demo-litematic')]), 'demo.litematic')
  const uploadResponse = await fetch(`${baseUrl}/api/dashboard/uploads`, {
    method: 'POST',
    headers: { cookie },
    body: form
  })
  const body = await uploadResponse.json()
  assert.equal(uploadResponse.status, 201)
  assert.equal(body.ok, true)
  assert.equal(body.items.length, 1)
  assert.equal(body.items[0].originalName, 'demo.litematic')
})
