import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import Path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Settings from '@overleaf/settings'
import Errors from '../Errors/Errors.js'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import CodexProcessManager from './CodexProcessManager.mjs'

const execFileAsync = promisify(execFile)

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function toSafeRelativePath(projectPath) {
  const normalized = Path.posix.normalize(projectPath)
  const relativePath = normalized.replace(/^\/+/, '')
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../') ||
    relativePath.includes('\0')
  ) {
    throw new Errors.InvalidError(`invalid project path: ${projectPath}`)
  }
  return relativePath
}

async function writeDoc(workspacePath, relativePath, content) {
  const outputPath = Path.join(workspacePath, ...relativePath.split('/'))
  const resolvedOutputPath = Path.resolve(outputPath)
  const resolvedWorkspacePath = Path.resolve(workspacePath)
  if (!resolvedOutputPath.startsWith(`${resolvedWorkspacePath}${Path.sep}`)) {
    throw new Errors.InvalidError(`invalid project path: ${relativePath}`)
  }
  await fs.mkdir(Path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, content, 'utf8')
}

async function createGitSnapshot(workspacePath) {
  await execFileAsync('git', ['init', '-q'], { cwd: workspacePath })
  await execFileAsync('git', ['add', '--', '.'], { cwd: workspacePath })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Overleaf',
      '-c',
      'user.email=codex@overleaf.local',
      'commit',
      '-qm',
      'initial overleaf snapshot',
    ],
    { cwd: workspacePath }
  )
}

async function buildWorkspace({ userId, projectId, runId }) {
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  const docEntries = Object.entries(docs)
  if (docEntries.length === 0) {
    throw new Errors.InvalidError('project has no text docs for Codex')
  }
  if (docEntries.length > Settings.codex.maxDocs) {
    throw new Errors.InvalidError('project has too many docs for Codex')
  }

  const userRoot = CodexProcessManager.getUserRoot(userId)
  const runRoot = Path.join(userRoot, 'workspaces', runId)
  const workspacePath = Path.join(runRoot, 'workspace')
  await fs.rm(runRoot, { recursive: true, force: true })
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 })

  const manifest = {
    projectId: projectId.toString(),
    runId,
    createdAt: new Date().toISOString(),
    docs: {},
  }

  let totalBytes = 0
  for (const [projectPath, doc] of docEntries) {
    const relativePath = toSafeRelativePath(projectPath)
    const content = doc.lines.join('\n')
    totalBytes += Buffer.byteLength(content, 'utf8')
    if (totalBytes > Settings.codex.maxProjectBytes) {
      throw new Errors.InvalidError('project is too large for Codex')
    }
    await writeDoc(workspacePath, relativePath, content)
    manifest.docs[projectPath] = {
      docId: doc._id.toString(),
      rev: doc.rev,
      hash: hashContent(content),
      relativePath,
    }
  }

  await fs.writeFile(
    Path.join(runRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  await createGitSnapshot(workspacePath)

  return {
    runRoot,
    workspacePath,
    manifest,
  }
}

export default {
  buildWorkspace,
  hashContent,
}
