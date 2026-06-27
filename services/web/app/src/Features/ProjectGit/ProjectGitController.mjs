import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../Authentication/SessionManager.mjs'
import Validation from '../../infrastructure/Validation.mjs'
import Errors from '../Errors/Errors.js'
import ProjectGitManager from './ProjectGitManager.mjs'

const { z, zz, parseReq } = Validation

const projectParamsSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
})

const remoteSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
  body: z.object({
    remoteUrl: z.string().min(1).max(2000),
  }),
})

const commitSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
  body: z.object({
    message: z.string().min(1).max(500),
  }),
})

function getUserId(req) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    throw new Errors.ForbiddenError('Git requires a logged-in user')
  }
  return userId
}

async function getStatus(req, res) {
  getUserId(req)
  const { params } = parseReq(req, projectParamsSchema)
  res.json(await ProjectGitManager.status(params.Project_id))
}

async function init(req, res) {
  getUserId(req)
  const { params } = parseReq(req, projectParamsSchema)
  res.status(202).json(await ProjectGitManager.init(params.Project_id))
}

async function importRemote(req, res) {
  const userId = getUserId(req)
  const { params, body } = parseReq(req, remoteSchema)
  res
    .status(202)
    .json(
      await ProjectGitManager.importRemote(
        params.Project_id,
        userId,
        body.remoteUrl
      )
    )
}

async function setRemote(req, res) {
  getUserId(req)
  const { params, body } = parseReq(req, remoteSchema)
  res.json(await ProjectGitManager.setRemote(params.Project_id, body.remoteUrl))
}

async function commit(req, res) {
  getUserId(req)
  const { params, body } = parseReq(req, commitSchema)
  res
    .status(202)
    .json(await ProjectGitManager.commit(params.Project_id, body.message))
}

async function pull(req, res) {
  const userId = getUserId(req)
  const { params } = parseReq(req, projectParamsSchema)
  res
    .status(202)
    .json(await ProjectGitManager.pull(params.Project_id, userId))
}

async function push(req, res) {
  getUserId(req)
  const { params } = parseReq(req, projectParamsSchema)
  res.status(202).json(await ProjectGitManager.push(params.Project_id))
}

export default {
  commit: expressify(commit),
  getStatus: expressify(getStatus),
  importRemote: expressify(importRemote),
  init: expressify(init),
  pull: expressify(pull),
  push: expressify(push),
  setRemote: expressify(setRemote),
}
