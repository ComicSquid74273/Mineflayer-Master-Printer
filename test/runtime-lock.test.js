'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { acquireBotRuntimeLock } = require('../src/runtime-lock')

test('runtime lock prevents two local ComicBot sessions and releases cleanly', () => {
  const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineflayer-runtime-lock-'))
  const identity = { username: 'ComicBot', host: '127.0.0.1', port: 25565 }
  const first = acquireBotRuntimeLock(identity, { lockDirectory })
  assert.throws(
    () => acquireBotRuntimeLock(identity, { lockDirectory, terminateExisting: false }),
    /Another local ComicBot runtime is already active/
  )
  first.release()
  const second = acquireBotRuntimeLock(identity, { lockDirectory })
  second.release()
  fs.rmSync(lockDirectory, { recursive: true, force: true })
})
