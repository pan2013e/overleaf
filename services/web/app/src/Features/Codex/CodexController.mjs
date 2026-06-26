import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../Authentication/SessionManager.mjs'
import Validation from '../../infrastructure/Validation.mjs'
import CodexAccountManager from './CodexAccountManager.mjs'
import CodexRunManager from './CodexRunManager.mjs'
import Errors from '../Errors/Errors.js'

const { z, zz, parseReq } = Validation

const runOptionsSchema = z
  .object({
    model: z.string().min(1).max(120).optional(),
    effort: z.string().min(1).max(40).optional(),
    summary: z.enum(['auto', 'concise', 'detailed', 'none']).optional(),
    approvalPolicy: z
      .enum(['never', 'on-request', 'on-failure', 'untrusted'])
      .optional(),
    sandboxMode: z
      .enum(['workspace-write', 'danger-full-access', 'read-only'])
      .optional(),
    autoApply: z.boolean().optional(),
  })
  .optional()

const projectRunParamsSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
  body: z.object({
    prompt: z.string().min(1).max(20_000),
    options: runOptionsSchema,
  }),
})

const projectParamsSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
})

const projectRunIdParamsSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
    runId: z.string().min(1),
  }),
})

const applyRunSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
    runId: z.string().min(1),
  }),
  body: z.object({
    paths: z.array(z.string()).optional(),
  }),
})

const cancelLoginSchema = z.object({
  body: z.object({
    loginId: z.string().min(1),
  }),
})

function getUserId(req) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    throw new Errors.ForbiddenError('Codex requires a logged-in user')
  }
  return userId
}

async function getAccount(req, res) {
  const userId = getUserId(req)
  const account = await CodexAccountManager.readAccount(userId)
  res.json(account)
}

async function getModels(req, res) {
  const userId = getUserId(req)
  const models = await CodexAccountManager.listModels(userId)
  res.json(models)
}

async function getOptions(req, res) {
  getUserId(req)
  res.json({
    defaults: CodexRunManager.getDefaultOptions(),
    sandboxModes: ['danger-full-access', 'workspace-write', 'read-only'],
    approvalPolicies: ['never', 'on-request', 'on-failure', 'untrusted'],
    reasoningSummaries: ['auto', 'concise', 'detailed', 'none'],
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  })
}

async function startLogin(req, res) {
  const userId = getUserId(req)
  const login = await CodexAccountManager.startDeviceLogin(userId)
  res.status(202).json(login)
}

async function cancelLogin(req, res) {
  const userId = getUserId(req)
  const { body } = parseReq(req, cancelLoginSchema)
  await CodexAccountManager.cancelLogin(userId, body.loginId)
  res.sendStatus(204)
}

async function logout(req, res) {
  const userId = getUserId(req)
  await CodexAccountManager.logout(userId)
  res.sendStatus(204)
}

async function startRun(req, res) {
  const userId = getUserId(req)
  const { params, body } = parseReq(req, projectRunParamsSchema)
  const run = await CodexRunManager.startRun({
    userId,
    projectId: params.Project_id,
    prompt: body.prompt,
    options: body.options,
  })
  res.status(202).json(CodexRunManager.serializeRun(run))
}

async function listRuns(req, res) {
  const userId = getUserId(req)
  const { params } = parseReq(req, projectParamsSchema)
  const runs = CodexRunManager.listRuns({
    userId,
    projectId: params.Project_id,
  })
  res.json({
    runs: runs.map(run => CodexRunManager.serializeRun(run)),
  })
}

async function getRun(req, res) {
  const userId = getUserId(req)
  const { params } = parseReq(req, projectRunIdParamsSchema)
  const run = CodexRunManager.requireRun({
    userId,
    projectId: params.Project_id,
    runId: params.runId,
  })
  res.json(CodexRunManager.serializeRun(run))
}

async function getRunEvents(req, res) {
  const userId = getUserId(req)
  const { params } = parseReq(req, projectRunIdParamsSchema)
  const run = CodexRunManager.requireRun({
    userId,
    projectId: params.Project_id,
    runId: params.runId,
  })
  res.json({ events: run.events, trajectory: run.trajectory ?? [] })
}

async function getRunDiff(req, res) {
  const userId = getUserId(req)
  const { params } = parseReq(req, projectRunIdParamsSchema)
  const run = CodexRunManager.requireRun({
    userId,
    projectId: params.Project_id,
    runId: params.runId,
  })
  res.json({
    status: run.status,
    diff: run.diff ?? '',
    gitStatus: run.gitStatus ?? '',
    changes: run.changesSummary ?? [],
  })
}

async function applyRun(req, res) {
  const userId = getUserId(req)
  const { params, body } = parseReq(req, applyRunSchema)
  const result = await CodexRunManager.applyRun({
    userId,
    projectId: params.Project_id,
    runId: params.runId,
    paths: body.paths,
  })
  res.json(result)
}

async function cancelRun(req, res) {
  const userId = getUserId(req)
  const { params } = parseReq(req, projectRunIdParamsSchema)
  const run = await CodexRunManager.cancelRun({
    userId,
    projectId: params.Project_id,
    runId: params.runId,
  })
  res.json(CodexRunManager.serializeRun(run))
}

export default {
  getAccount: expressify(getAccount),
  getModels: expressify(getModels),
  getOptions: expressify(getOptions),
  startLogin: expressify(startLogin),
  cancelLogin: expressify(cancelLogin),
  logout: expressify(logout),
  listRuns: expressify(listRuns),
  startRun: expressify(startRun),
  getRun: expressify(getRun),
  getRunEvents: expressify(getRunEvents),
  getRunDiff: expressify(getRunDiff),
  applyRun: expressify(applyRun),
  cancelRun: expressify(cancelRun),
}
