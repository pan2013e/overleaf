import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs/promises'
import Path from 'node:path'
import logger from '@overleaf/logger'

function isSafeWorkspaceGrantRoot(grantRoot, allowedUserRoot) {
  if (typeof grantRoot !== 'string' || typeof allowedUserRoot !== 'string') {
    return false
  }
  const resolvedGrantRoot = Path.resolve(grantRoot)
  const resolvedUserRoot = Path.resolve(allowedUserRoot)
  return (
    resolvedGrantRoot.startsWith(`${resolvedUserRoot}${Path.sep}workspaces${Path.sep}`) &&
    resolvedGrantRoot.endsWith(`${Path.sep}workspace`)
  )
}

function fileChangeGrantRoot(message) {
  return message?.params?.grantRoot ?? message?.params?.grant_root
}

function isFileChangeApprovalRequest(message) {
  return (
    message?.method === 'item/fileChange/requestApproval' &&
    message.id != null
  )
}

class CodexAppServerClient extends EventEmitter {
  constructor({ codexBin, codexHome, requestTimeoutMs, userRoot }) {
    super()
    this.codexBin = codexBin
    this.codexHome = codexHome
    this.requestTimeoutMs = requestTimeoutMs
    this.userRoot = userRoot
    this.nextRequestId = 1
    this.pendingRequests = new Map()
    this.notificationLog = []
    this.started = false
    this.closed = false
  }

  async start() {
    if (this.startPromise) {
      return await this.startPromise
    }
    this.startPromise = this._start()
    return await this.startPromise
  }

  async _start() {
    await fs.mkdir(this.codexHome, { recursive: true, mode: 0o700 })
    this.child = spawn(this.codexBin, ['app-server'], {
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.on('error', error => this._handleClose(error))
    this.child.on('exit', (code, signal) => {
      const error = new Error(
        `Codex app-server exited with code ${code ?? 'null'} and signal ${
          signal ?? 'null'
        }`
      )
      this._handleClose(error)
    })
    this.child.stderr.on('data', chunk => {
      logger.debug(
        { stderr: chunk.toString('utf8') },
        'codex app-server stderr'
      )
    })

    const reader = readline.createInterface({ input: this.child.stdout })
    reader.on('line', line => this._handleLine(line))

    await this.request('initialize', {
      clientInfo: {
        name: 'overleaf_codex',
        title: 'Overleaf Codex',
        version: '0.1.0',
      },
    })
    this.notify('initialized', {})
    this.started = true
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) {
      return Promise.reject(new Error('Codex app-server client is closed'))
    }

    const id = this.nextRequestId++
    const message = { method, id, params }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Timed out waiting for Codex app-server ${method}`))
      }, timeoutMs)
      timeout.unref?.()
      this.pendingRequests.set(id, { resolve, reject, timeout, method })
      this._send(message)
    })
  }

  notify(method, params = {}) {
    this._send({ method, params })
  }

  waitForNotification(method, predicate = () => true, timeoutMs) {
    for (const notification of this.notificationLog) {
      if (
        notification.method === method &&
        predicate(notification.params ?? {})
      ) {
        return Promise.resolve(notification.params)
      }
    }

    return new Promise((resolve, reject) => {
      const onNotification = notification => {
        if (
          notification.method === method &&
          predicate(notification.params ?? {})
        ) {
          cleanup()
          resolve(notification.params)
        }
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for Codex notification ${method}`))
      }, timeoutMs)
      timeout.unref?.()
      const cleanup = () => {
        clearTimeout(timeout)
        this.off('notification', onNotification)
      }
      this.on('notification', onNotification)
    })
  }

  close() {
    this.closed = true
    for (const { reject, timeout } of this.pendingRequests.values()) {
      clearTimeout(timeout)
      reject(new Error('Codex app-server client closed'))
    }
    this.pendingRequests.clear()
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
    }
  }

  _send(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error('Codex app-server stdin is not writable')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  _handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      logger.warn({ line }, 'failed to parse codex app-server output')
      return
    }

    if (message.id != null && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)
      this.pendingRequests.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        const error = new Error(message.error.message || pending.method)
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id != null && message.method) {
      if (this._handleServerRequest(message)) {
        return
      }
      logger.warn(
        { method: message.method },
        'unsupported codex app-server request'
      )
      this._send({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported request: ${message.method}`,
        },
      })
      return
    }

    if (message.method) {
      const notification = {
        method: message.method,
        params: message.params ?? {},
      }
      this.notificationLog.push(notification)
      if (this.notificationLog.length > 1000) {
        this.notificationLog.shift()
      }
      this.emit('notification', notification)
      if (message.method === 'error') {
        this.emit('codex-error', notification.params)
      } else {
        this.emit(message.method, notification.params)
      }
    }
  }

  _handleServerRequest(message) {
    if (!isFileChangeApprovalRequest(message)) {
      return false
    }
    const grantRoot = fileChangeGrantRoot(message)
    const decision = isSafeWorkspaceGrantRoot(
      grantRoot,
      this.userRoot
    )
      ? 'accept'
      : 'decline'
    this._send({
      id: message.id,
      result: {
        decision,
      },
    })
    return true
  }

  _handleClose(error) {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const { reject, timeout } of this.pendingRequests.values()) {
      clearTimeout(timeout)
      reject(error)
    }
    this.pendingRequests.clear()
    this.emit('close', error)
  }
}

export default CodexAppServerClient
