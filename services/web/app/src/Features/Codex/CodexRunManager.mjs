import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Errors from '../Errors/Errors.js'
import CodexProcessManager from './CodexProcessManager.mjs'
import CodexRunStore from './CodexRunStore.mjs'
import ProjectWorkspaceBuilder from './ProjectWorkspaceBuilder.mjs'
import ProjectDiffBuilder from './ProjectDiffBuilder.mjs'
import ProjectPatchApplier from './ProjectPatchApplier.mjs'
import CodexTrajectoryBuilder from './CodexTrajectoryBuilder.mjs'

const SANDBOX_MODES = new Set([
  'workspace-write',
  'danger-full-access',
  'read-only',
])
const APPROVAL_POLICIES = new Set([
  'never',
  'on-request',
  'on-failure',
  'untrusted',
])
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none'])

function isRunNotification(notification, threadId, turnId) {
  const params = notification.params ?? {}
  return (
    params.threadId === threadId ||
    params.turnId === turnId ||
    params.thread?.id === threadId ||
    params.turn?.id === turnId ||
    params.item?.threadId === threadId ||
    params.item?.turnId === turnId
  )
}

async function assertAccountReady(client) {
  const accountState = await client.request('account/read', {
    refreshToken: false,
  })
  if (accountState.requiresOpenaiAuth && !accountState.account) {
    throw new Errors.InvalidError('Codex account is not connected')
  }
}

function buildPrompt(userPrompt) {
  return [
    'You are editing an Overleaf LaTeX project exported to this workspace.',
    'Only modify existing text project files unless explicitly asked otherwise.',
    'Make the requested edit by changing the files in the workspace.',
    'Do not merely describe the edit when a file change is requested.',
    'If shell commands cannot run, report the failure instead of claiming the edit is done.',
    'Do not touch files outside this workspace.',
    'Keep changes minimal and explain them briefly.',
    '',
    userPrompt,
  ].join('\n')
}

function cleanString(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeChoice(value, allowedValues, defaultValue) {
  const candidate = cleanString(value)
  if (candidate && allowedValues.has(candidate)) {
    return candidate
  }
  if (allowedValues.has(defaultValue)) {
    return defaultValue
  }
  return Array.from(allowedValues)[0]
}

function normalizeOptions(options = {}) {
  const model = cleanString(options.model) || cleanString(Settings.codex.model)
  const effort =
    cleanString(options.effort) || cleanString(Settings.codex.reasoningEffort)
  return {
    model,
    effort,
    summary: normalizeChoice(
      options.summary,
      REASONING_SUMMARIES,
      Settings.codex.reasoningSummary || 'auto'
    ),
    approvalPolicy: normalizeChoice(
      options.approvalPolicy,
      APPROVAL_POLICIES,
      Settings.codex.approvalPolicy || 'never'
    ),
    sandboxMode: normalizeChoice(
      options.sandboxMode,
      SANDBOX_MODES,
      Settings.codex.sandboxMode || 'workspace-write'
    ),
    autoApply:
      typeof options.autoApply === 'boolean'
        ? options.autoApply
        : Boolean(Settings.codex.autoApply),
  }
}

function buildSandboxPolicy(sandboxMode, workspacePath) {
  switch (sandboxMode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [workspacePath],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
  }
}

function addOptionalTurnSettings(params, options) {
  if (options.model) {
    params.model = options.model
  }
  if (options.effort) {
    params.effort = options.effort
  }
  if (options.summary) {
    params.summary = options.summary
  }
}

async function writeTrajectoryHeader(run, workspace) {
  const trajectoryPath = Path.join(workspace.runRoot, 'trajectory.md')
  const lines = [
    `# Codex Run ${run.id}`,
    '',
    `- Project: ${run.projectId}`,
    `- User: ${run.userId}`,
    `- Created: ${run.createdAt.toISOString()}`,
    `- Workspace: ${workspace.workspacePath}`,
    `- Sandbox: ${run.options.sandboxMode}`,
    `- Approval: ${run.options.approvalPolicy}`,
    `- Auto apply: ${run.options.autoApply}`,
  ]
  if (run.options.model) {
    lines.push(`- Model: ${run.options.model}`)
  }
  if (run.options.effort) {
    lines.push(`- Reasoning effort: ${run.options.effort}`)
  }
  if (run.options.summary) {
    lines.push(`- Reasoning summary: ${run.options.summary}`)
  }
  lines.push('', '## Prompt', '', run.prompt, '', '## Timeline', '')
  await fs.writeFile(trajectoryPath, `${lines.join('\n')}\n`, 'utf8')
  return trajectoryPath
}

function appendTrajectoryFile(runId, trajectoryEntry) {
  if (!trajectoryEntry) {
    return
  }
  const run = CodexRunStore.get(runId)
  if (!run?.trajectoryPath) {
    return
  }
  fs.appendFile(
    run.trajectoryPath,
    CodexTrajectoryBuilder.formatMarkdownEntry(trajectoryEntry),
    'utf8'
  ).catch(error => {
    logger.warn({ err: error, runId }, 'failed to append codex trajectory')
  })
}

async function startRun({ userId, projectId, prompt, options }) {
  CodexProcessManager.assertEnabled()
  const normalizedOptions = normalizeOptions(options)
  const run = CodexRunStore.create({
    id: crypto.randomUUID(),
    userId: userId.toString(),
    projectId: projectId.toString(),
    prompt,
    options: normalizedOptions,
    status: 'queued',
  })

  executeRun(run.id).catch(error => {
    logger.error({ err: error, runId: run.id }, 'codex run failed')
    CodexRunStore.update(run.id, {
      status: 'failed',
      error: error.message,
    })
  })

  return run
}

async function executeRun(runId) {
  const run = CodexRunStore.get(runId)
  if (!run) {
    return
  }

  CodexRunStore.update(runId, { status: 'exporting' })
  const workspace = await ProjectWorkspaceBuilder.buildWorkspace({
    userId: run.userId,
    projectId: run.projectId,
    runId,
  })
  const trajectoryPath = await writeTrajectoryHeader(run, workspace)
  CodexRunStore.update(runId, {
    workspacePath: workspace.workspacePath,
    runRoot: workspace.runRoot,
    trajectoryPath,
    manifest: workspace.manifest,
    status: 'starting',
  })

  const client = await CodexProcessManager.getClient(run.userId)
  await assertAccountReady(client)

  const threadResult = await client.request('thread/start', {
    cwd: workspace.workspacePath,
    approvalPolicy: run.options.approvalPolicy,
    sandbox: run.options.sandboxMode,
    serviceName: 'overleaf_codex',
    ...(run.options.model ? { model: run.options.model } : {}),
  })
  const threadId = threadResult.thread.id
  CodexRunStore.update(runId, {
    threadId,
    status: 'running',
  })

  let turnId
  const onNotification = notification => {
    if (isRunNotification(notification, threadId, turnId)) {
      const stored = CodexRunStore.appendEvent(runId, notification)
      appendTrajectoryFile(runId, stored?.trajectoryEntry)
    }
  }
  client.on('notification', onNotification)
  try {
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: buildPrompt(run.prompt) }],
      cwd: workspace.workspacePath,
      approvalPolicy: run.options.approvalPolicy,
      sandboxPolicy: buildSandboxPolicy(
        run.options.sandboxMode,
        workspace.workspacePath
      ),
    }
    addOptionalTurnSettings(turnParams, run.options)
    const turnResult = await client.request('turn/start', turnParams)
    turnId = turnResult.turn.id
    CodexRunStore.update(runId, { turnId })

    await client.waitForNotification(
      'turn/completed',
      params =>
        params.turn?.id === turnId ||
        params.turnId === turnId ||
        params.id === turnId,
      Settings.codex.runTimeoutMs
    )
  } finally {
    client.off('notification', onNotification)
  }

  CodexRunStore.update(runId, { status: 'diffing' })
  const changes = await ProjectDiffBuilder.buildStructuredChanges(workspace)
  const diff = await ProjectDiffBuilder.buildGitDiff(workspace.workspacePath)
  const gitStatus = await ProjectDiffBuilder.buildGitStatus(
    workspace.workspacePath
  )
  const latestRun = CodexRunStore.get(runId)
  const sandboxFailure = CodexTrajectoryBuilder.findSandboxFailure(
    latestRun?.events ?? []
  )
  if (changes.length === 0 && sandboxFailure) {
    throw new Errors.InvalidError(
      'Codex command sandbox failed inside Docker. Use the danger-full-access sandbox mode for this Docker deployment or enable unprivileged user namespaces for workspace-write.'
    )
  }
  const systemError = CodexTrajectoryBuilder.findSystemError(
    latestRun?.events ?? []
  )
  if (changes.length === 0 && systemError) {
    const message = CodexTrajectoryBuilder.errorMessage(systemError)
    throw new Errors.InvalidError(
      `Codex App Server error while editing the project${message ? `: ${message}` : ''}`
    )
  }
  if (changes.length === 0) {
    throw new Errors.InvalidError(
      'Codex completed without modifying any project files. Check the activity log for the assistant response and try a more explicit edit request.'
    )
  }
  CodexRunStore.update(runId, {
    status: 'completed',
    changes,
    changesSummary: ProjectDiffBuilder.summarizeChanges(changes),
    diff,
    gitStatus,
  })

  if (run.options.autoApply && changes.some(change => change.type === 'modified')) {
    CodexRunStore.update(runId, { status: 'applying' })
    const result = await ProjectPatchApplier.applyChanges({
      projectId: run.projectId,
      userId: run.userId,
      manifest: workspace.manifest,
      changes,
    })
    CodexRunStore.update(runId, {
      status: 'applied',
      applied: result.applied,
    })
  }
}

async function cancelRun({ userId, projectId, runId }) {
  const run = requireRun({ userId, projectId, runId })
  if (!run.threadId || !run.turnId) {
    CodexRunStore.update(runId, { status: 'cancelled' })
    return CodexRunStore.get(runId)
  }
  const client = await CodexProcessManager.getClient(userId)
  await client.request('turn/interrupt', {
    threadId: run.threadId,
    turnId: run.turnId,
  })
  CodexRunStore.update(runId, { status: 'cancelled' })
  return CodexRunStore.get(runId)
}

async function applyRun({ userId, projectId, runId, paths }) {
  const run = requireRun({ userId, projectId, runId })
  if (run.status !== 'completed' && run.status !== 'apply_failed') {
    throw new Errors.InvalidError('Codex run is not ready to apply')
  }
  const result = await ProjectPatchApplier.applyChanges({
    projectId,
    userId,
    manifest: run.manifest,
    changes: run.changes,
    paths,
  })
  CodexRunStore.update(runId, {
    status: 'applied',
    applied: result.applied,
  })
  return result
}

function listRuns({ userId, projectId }) {
  return CodexRunStore.listForProject({ userId, projectId })
}

function getDefaultOptions() {
  return normalizeOptions()
}

function requireRun({ userId, projectId, runId }) {
  const run = CodexRunStore.get(runId)
  if (!run) {
    throw new Errors.NotFoundError('Codex run not found')
  }
  if (
    run.userId !== userId.toString() ||
    run.projectId !== projectId.toString()
  ) {
    throw new Errors.NotFoundError('Codex run not found')
  }
  return run
}

export default {
  startRun,
  getRun: CodexRunStore.get,
  listRuns,
  getDefaultOptions,
  serializeRun: CodexRunStore.serialize,
  requireRun,
  cancelRun,
  applyRun,
}
