'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

function safeKey(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_.-]+/gi, '_').toLowerCase()
}

function isProcessAlive(pid) {
  const parsedPid = Number(pid)
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return false
  try {
    process.kill(parsedPid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function killProcessTree(pid) {
  const parsedPid = Number(pid)
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${parsedPid}`, { stdio: 'ignore' })
    } else {
      process.kill(parsedPid, 'SIGKILL')
    }
  } catch {
    try { process.kill(parsedPid, 'SIGKILL') } catch {}
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

function acquireBotRuntimeLock(identity, options = {}) {
  const lockDirectory = path.resolve(options.lockDirectory || path.join(process.cwd(), 'logs', 'runtime-locks'))
  fs.mkdirSync(lockDirectory, { recursive: true })
  const lockPath = path.join(lockDirectory, `${safeKey(identity.username)}-${safeKey(identity.host)}-${safeKey(identity.port)}.lock.json`)
  const token = crypto.randomUUID()
  const metadata = {
    token,
    pid: process.pid,
    username: identity.username,
    host: identity.host,
    port: identity.port,
    startedAt: new Date().toISOString()
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fileDescriptor = null
    try {
      fileDescriptor = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(fileDescriptor, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      fs.closeSync(fileDescriptor)
      fileDescriptor = null
      let released = false
      return {
        lockPath,
        metadata,
        release() {
          if (released) return
          released = true
          const current = readLock(lockPath)
          if (current?.token !== token) return
          try { fs.unlinkSync(lockPath) } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        }
      }
    } catch (error) {
      if (fileDescriptor != null) {
        try { fs.closeSync(fileDescriptor) } catch { }
      }
      if (error?.code !== 'EEXIST') throw error
      const existing = readLock(lockPath)
      if (existing && isProcessAlive(existing.pid)) {
        if (options.terminateExisting !== false && existing.pid !== process.pid) {
          console.log(`[RUNTIME-LOCK] Terminating existing duplicate ${identity.username} process (PID ${existing.pid}) to prevent server disconnect loop...`)
          killProcessTree(existing.pid)
          const deadline = Date.now() + 1500
          while (isProcessAlive(existing.pid) && Date.now() < deadline) {
            // Wait for stale process to exit
          }
          try { fs.unlinkSync(lockPath) } catch (unlinkErr) {}
          continue
        }
        throw new Error(`Another local ${identity.username} runtime is already active (PID ${existing.pid}) for ${identity.host}:${identity.port}. Stop it before starting another live bot.`)
      }
      try { fs.unlinkSync(lockPath) } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }

  throw new Error(`Could not acquire runtime lock for ${identity.username} at ${identity.host}:${identity.port}.`)
}

module.exports = { acquireBotRuntimeLock, isProcessAlive, killProcessTree }