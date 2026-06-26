import CodexTrajectoryBuilder from './CodexTrajectoryBuilder.mjs'

const runs = new Map()

function create(run) {
  runs.set(run.id, {
    ...run,
    events: [],
    trajectory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  return runs.get(run.id)
}

function get(runId) {
  return runs.get(runId)
}

function update(runId, patch) {
  const run = get(runId)
  if (!run) {
    return null
  }
  Object.assign(run, patch, { updatedAt: new Date() })
  return run
}

function appendEvent(runId, event) {
  const run = get(runId)
  if (!run) {
    return null
  }
  const storedEvent = {
    ...event,
    receivedAt: new Date(),
  }
  run.events.push(storedEvent)
  if (run.events.length > 1000) {
    run.events.shift()
  }
  const trajectoryEntry = CodexTrajectoryBuilder.buildEntry(storedEvent)
  if (trajectoryEntry) {
    run.trajectory.push(trajectoryEntry)
    if (run.trajectory.length > 500) {
      run.trajectory.shift()
    }
  }
  run.updatedAt = new Date()
  return { event: storedEvent, trajectoryEntry }
}

function listForProject({ userId, projectId }) {
  return Array.from(runs.values())
    .filter(
      run =>
        run.userId === userId.toString() &&
        run.projectId === projectId.toString()
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

function serialize(run) {
  if (!run) {
    return null
  }
  return {
    id: run.id,
    userId: run.userId,
    projectId: run.projectId,
    status: run.status,
    prompt: run.prompt,
    error: run.error,
    options: run.options,
    model: run.options?.model ?? null,
    effort: run.options?.effort ?? null,
    summary: run.options?.summary ?? null,
    approvalPolicy: run.options?.approvalPolicy ?? null,
    sandboxMode: run.options?.sandboxMode ?? null,
    autoApply: run.options?.autoApply ?? null,
    threadId: run.threadId,
    turnId: run.turnId,
    diff: run.diff,
    gitStatus: run.gitStatus,
    changes: run.changesSummary,
    changeCount: run.changesSummary?.length ?? 0,
    applied: run.applied,
    trajectory: run.trajectory ?? [],
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

export default {
  create,
  get,
  update,
  appendEvent,
  listForProject,
  serialize,
}
