import fs from 'node:fs/promises'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import Errors from '../Errors/Errors.js'
import CodexAppServerClient from './CodexAppServerClient.mjs'
import logger from '@overleaf/logger'

const clients = new Map()

function assertEnabled() {
  if (!Settings.codex?.enabled) {
    throw new Errors.ServiceNotConfiguredError('Codex is not enabled')
  }
}

function safeUserId(userId) {
  return userId.toString().replace(/[^A-Za-z0-9_.-]/g, '_')
}

function getUserRoot(userId) {
  return Path.join(Settings.codex.dataDir, 'users', safeUserId(userId))
}

async function getClient(userId) {
  assertEnabled()
  const key = userId.toString()
  const existing = clients.get(key)
  if (existing && !existing.client.closed) {
    existing.lastUsed = Date.now()
    return existing.client
  }

  const userRoot = getUserRoot(userId)
  const codexHome =
    Settings.codex.hostCredentialsHome || Path.join(userRoot, 'CODEX_HOME')
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 })

  const client = new CodexAppServerClient({
    codexBin: Settings.codex.bin,
    codexHome,
    requestTimeoutMs: Settings.codex.appServerRequestTimeoutMs,
    userRoot,
  })
  client.on('close', error => {
    logger.warn({ err: error, userId }, 'codex app-server closed')
    clients.delete(key)
  })
  await client.start()
  clients.set(key, { client, lastUsed: Date.now() })
  return client
}

async function stopClient(userId) {
  const key = userId.toString()
  const existing = clients.get(key)
  if (!existing) {
    return
  }
  existing.client.close()
  clients.delete(key)
}

async function logoutAndDelete(userId) {
  assertEnabled()
  const client = await getClient(userId)
  try {
    await client.request('account/logout')
  } finally {
    await stopClient(userId)
    if (!Settings.codex.hostCredentialsHome) {
      await fs.rm(getUserRoot(userId), { recursive: true, force: true })
    }
  }
}

async function cleanupIdleClients() {
  const idleTimeoutMs = Settings.codex?.appServerIdleTimeoutMs
  if (!idleTimeoutMs) {
    return
  }
  const now = Date.now()
  for (const [userId, entry] of clients.entries()) {
    if (now - entry.lastUsed > idleTimeoutMs) {
      logger.debug({ userId }, 'stopping idle codex app-server')
      entry.client.close()
      clients.delete(userId)
    }
  }
}

async function cleanupStaleWorkspaces() {
  const workspaceTtlMs = Settings.codex?.workspaceTtlMs
  if (!workspaceTtlMs) {
    return
  }

  const usersRoot = Path.join(Settings.codex.dataDir, 'users')
  let userDirs
  try {
    userDirs = await fs.readdir(usersRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }
    throw error
  }

  const cutoff = Date.now() - workspaceTtlMs
  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) {
      continue
    }
    const workspacesRoot = Path.join(usersRoot, userDir.name, 'workspaces')
    let workspaceDirs
    try {
      workspaceDirs = await fs.readdir(workspacesRoot, {
        withFileTypes: true,
      })
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue
      }
      throw error
    }
    for (const workspaceDir of workspaceDirs) {
      if (!workspaceDir.isDirectory()) {
        continue
      }
      const workspacePath = Path.join(workspacesRoot, workspaceDir.name)
      let stats
      try {
        stats = await fs.stat(workspacePath)
      } catch (error) {
        if (error.code === 'ENOENT') {
          continue
        }
        throw error
      }
      if (stats.mtimeMs < cutoff) {
        logger.debug(
          { workspacePath },
          'removing stale codex workspace directory'
        )
        await fs.rm(workspacePath, { recursive: true, force: true })
      }
    }
  }
}

async function cleanup() {
  await cleanupIdleClients()
  await cleanupStaleWorkspaces()
}

const cleanupInterval = setInterval(() => {
  cleanup().catch(error => {
    logger.warn({ err: error }, 'codex cleanup failed')
  })
}, 60 * 1000)
cleanupInterval.unref?.()

export default {
  assertEnabled,
  getClient,
  stopClient,
  logoutAndDelete,
  cleanup,
  cleanupIdleClients,
  cleanupStaleWorkspaces,
  getUserRoot,
}
