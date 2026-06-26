import fs from 'node:fs/promises'
import Path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ProjectWorkspaceBuilder from './ProjectWorkspaceBuilder.mjs'

const execFileAsync = promisify(execFile)

async function readWorkspaceFile(workspacePath, relativePath) {
  const filePath = Path.join(workspacePath, ...relativePath.split('/'))
  return await fs.readFile(filePath, 'utf8')
}

async function buildStructuredChanges({ workspacePath, manifest }) {
  const changes = []
  for (const [projectPath, doc] of Object.entries(manifest.docs)) {
    let content
    try {
      content = await readWorkspaceFile(workspacePath, doc.relativePath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
      changes.push({
        type: 'deleted',
        projectPath,
        docId: doc.docId,
        oldHash: doc.hash,
        newHash: null,
        newContent: null,
      })
      continue
    }
    const newHash = ProjectWorkspaceBuilder.hashContent(content)
    if (newHash !== doc.hash) {
      changes.push({
        type: 'modified',
        projectPath,
        docId: doc.docId,
        oldHash: doc.hash,
        newHash,
        newContent: content,
      })
    }
  }
  return changes
}

async function buildGitDiff(workspacePath) {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--no-color', '--', '.'],
    { cwd: workspacePath, maxBuffer: 8 * 1024 * 1024 }
  )
  return stdout
}

async function buildGitStatus(workspacePath) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: workspacePath,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

function summarizeChanges(changes) {
  return changes.map(change => ({
    type: change.type,
    projectPath: change.projectPath,
    docId: change.docId,
    oldHash: change.oldHash,
    newHash: change.newHash,
  }))
}

export default {
  buildStructuredChanges,
  buildGitDiff,
  buildGitStatus,
  summarizeChanges,
}
