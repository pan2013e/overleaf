function truncate(value, maxLength = 1200) {
  if (value == null) {
    return ''
  }
  let text
  if (typeof value === 'string') {
    text = value
  } else if (value instanceof Error) {
    text = value.stack || value.message
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 1)}...`
}

function contentToText(content) {
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(part => {
      if (typeof part?.text === 'string') {
        return part.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function valueToText(value) {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .map(part => {
      if (typeof part === 'string') {
        return part
      }
      if (typeof part?.text === 'string') {
        return part.text
      }
      if (typeof part?.summary === 'string') {
        return part.summary
      }
      if (Array.isArray(part?.content)) {
        return contentToText(part.content)
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function tokenUsageDetail(tokenUsage) {
  const total = tokenUsage?.total
  if (!total) {
    return ''
  }
  const parts = []
  if (total.inputTokens != null) {
    parts.push(`input ${total.inputTokens}`)
  }
  if (total.outputTokens != null) {
    parts.push(`output ${total.outputTokens}`)
  }
  if (total.reasoningOutputTokens != null) {
    parts.push(`reasoning ${total.reasoningOutputTokens}`)
  }
  if (total.totalTokens != null) {
    parts.push(`total ${total.totalTokens}`)
  }
  return parts.join(', ')
}

function itemTitle(item, phase = 'completed') {
  switch (item?.type) {
    case 'userMessage':
      return phase === 'started' ? 'User prompt received' : 'User prompt'
    case 'agentMessage':
      return phase === 'started' ? 'Assistant message started' : 'Assistant'
    case 'reasoning':
      return phase === 'started' ? 'Reasoning started' : 'Reasoning completed'
    case 'commandExecution':
      return phase === 'started' ? 'Command started' : 'Command completed'
    case 'mcpToolCall':
      return phase === 'started' ? 'Tool call started' : 'Tool call completed'
    default:
      if (item?.type) {
        return phase === 'started'
          ? `${item.type} started`
          : `${item.type} completed`
      }
      return phase === 'started' ? 'Item started' : 'Item completed'
  }
}

function buildItemEntry(event, phase) {
  const item = event.params?.item
  if (!item) {
    return null
  }

  const entry = {
    id: item.id || `${event.method}:${event.receivedAt?.toISOString?.()}`,
    time: event.receivedAt,
    method: event.method,
    kind: item.type || 'item',
    title: itemTitle(item, phase),
    status: item.status,
  }

  if (item.type === 'userMessage') {
    entry.detail = truncate(contentToText(item.content), 2000)
  } else if (item.type === 'agentMessage') {
    entry.detail = truncate(item.text, 4000)
  } else if (item.type === 'reasoning') {
    entry.detail = truncate(
      valueToText(item.summary) ||
        valueToText(item.text) ||
        contentToText(item.content),
      2000
    )
  } else if (item.type === 'commandExecution') {
    entry.command = item.command
    entry.cwd = item.cwd
    entry.status = item.status
    entry.exitCode = item.exitCode
    entry.detail = truncate(item.aggregatedOutput, 3000)
    if (phase === 'completed' && item.status === 'failed') {
      entry.severity = 'error'
    }
  } else if (item.type === 'mcpToolCall') {
    entry.tool = [item.server, item.tool].filter(Boolean).join('/')
    entry.status = item.status
    if (item.error) {
      entry.severity = 'error'
      entry.detail = truncate(item.error.message || item.error, 2000)
    } else if (item.result?.content) {
      entry.detail = truncate(contentToText(item.result.content), 2000)
    }
  } else {
    entry.detail = truncate(item, 3000)
  }

  return entry
}

function buildEntry(event) {
  const params = event.params ?? {}
  switch (event.method) {
    case 'thread/started':
      return {
        id: `thread:${params.thread?.id}`,
        time: event.receivedAt,
        method: event.method,
        kind: 'thread',
        title: 'Thread started',
        detail: params.thread?.cwd || '',
      }
    case 'thread/status/changed':
      return {
        id: `thread-status:${params.threadId}:${event.receivedAt?.getTime?.()}`,
        time: event.receivedAt,
        method: event.method,
        kind: params.status?.type === 'systemError' ? 'error' : 'status',
        severity: params.status?.type === 'systemError' ? 'error' : undefined,
        title: `Thread ${params.status?.type || 'status changed'}`,
        detail:
          params.status?.type === 'systemError'
            ? truncate(params.status?.error || params.status, 2000)
            : undefined,
      }
    case 'turn/started':
      return {
        id: `turn:${params.turn?.id}:started`,
        time: event.receivedAt,
        method: event.method,
        kind: 'turn',
        title: 'Turn started',
      }
    case 'turn/completed':
      return {
        id: `turn:${params.turn?.id || params.turnId || params.id}:completed`,
        time: event.receivedAt,
        method: event.method,
        kind: 'turn',
        title: 'Turn completed',
      }
    case 'thread/tokenUsage/updated': {
      const detail = tokenUsageDetail(params.tokenUsage)
      if (!detail) {
        return null
      }
      return {
        id: `tokens:${params.threadId}:${event.receivedAt?.getTime?.()}`,
        time: event.receivedAt,
        method: event.method,
        kind: 'usage',
        title: 'Token usage updated',
        detail,
      }
    }
    case 'item/started':
      return buildItemEntry(event, 'started')
    case 'item/completed':
      return buildItemEntry(event, 'completed')
    case 'error':
      return {
        id: `error:${event.receivedAt?.getTime?.()}`,
        time: event.receivedAt,
        method: event.method,
        kind: 'error',
        severity: 'error',
        title: 'Codex error',
        detail: truncate(params.message || params.error || params, 2000),
      }
    default:
      return null
  }
}

function formatMarkdownEntry(entry) {
  const timestamp =
    entry.time instanceof Date
      ? entry.time.toISOString()
      : new Date(entry.time).toISOString()
  const lines = [`- ${timestamp} ${entry.title}`]
  if (entry.command) {
    lines.push(`  - command: ${entry.command}`)
  }
  if (entry.cwd) {
    lines.push(`  - cwd: ${entry.cwd}`)
  }
  if (entry.status) {
    lines.push(`  - status: ${entry.status}`)
  }
  if (entry.exitCode != null) {
    lines.push(`  - exit code: ${entry.exitCode}`)
  }
  if (entry.detail) {
    lines.push('  - detail:')
    for (const line of String(entry.detail).split('\n')) {
      lines.push(`    ${line}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function findSandboxFailure(events) {
  return events.find(event => {
    if (event.method !== 'item/completed') {
      return false
    }
    const item = event.params?.item
    return (
      item?.type === 'commandExecution' &&
      item.status === 'failed' &&
      typeof item.aggregatedOutput === 'string' &&
      item.aggregatedOutput.includes('No permissions to create a new namespace')
    )
  })
}

function findSystemError(events) {
  return events.find(event => {
    if (event.method === 'error') {
      return true
    }
    if (event.method !== 'thread/status/changed') {
      return false
    }
    return event.params?.status?.type === 'systemError'
  })
}

function errorMessage(event) {
  if (!event) {
    return ''
  }
  const params = event.params ?? {}
  return truncate(
    params.message ||
      params.error?.message ||
      params.error ||
      params.status?.error?.message ||
      params.status?.error ||
      params.status ||
      params,
    2000
  )
}

export default {
  buildEntry,
  formatMarkdownEntry,
  findSandboxFailure,
  findSystemError,
  errorMessage,
}
