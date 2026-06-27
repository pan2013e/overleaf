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

function projectPathFromRelativePath(relativePath) {
  const normalized = Path.posix.normalize(relativePath.replace(/\\/g, '/'))
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    Path.posix.isAbsolute(normalized) ||
    normalized.includes('\0')
  ) {
    return null
  }
  return `/${normalized}`
}

async function listGitPaths(workspacePath, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspacePath,
    maxBuffer: 1024 * 1024,
  })
  return stdout.split('\0').filter(Boolean)
}

async function listAddedRelativePaths(workspacePath) {
  const [untracked, staged] = await Promise.all([
    listGitPaths(workspacePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
    listGitPaths(workspacePath, [
      'diff',
      '--name-only',
      '--diff-filter=A',
      '--cached',
      '-z',
      'HEAD',
      '--',
      '.',
    ]),
  ])
  return [...new Set([...untracked, ...staged])].sort()
}

async function gitDiff(workspacePath, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workspacePath,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    if (error.code === 1 && typeof error.stdout === 'string') {
      return error.stdout
    }
    throw error
  }
}

async function buildStructuredChanges({ workspacePath, manifest }) {
  const changes = []
  const manifestRelativePaths = new Set()
  for (const [projectPath, doc] of Object.entries(manifest.docs)) {
    manifestRelativePaths.add(doc.relativePath)
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
  for (const relativePath of await listAddedRelativePaths(workspacePath)) {
    if (manifestRelativePaths.has(relativePath)) {
      continue
    }
    const projectPath = projectPathFromRelativePath(relativePath)
    if (!projectPath) {
      continue
    }
    const content = await readWorkspaceFile(workspacePath, relativePath)
    changes.push({
      type: 'added',
      projectPath,
      docId: null,
      oldHash: null,
      newHash: ProjectWorkspaceBuilder.hashContent(content),
      newContent: content,
    })
  }
  return changes
}

async function buildGitDiff(workspacePath) {
  const trackedDiff = await gitDiff(workspacePath, [
    'diff',
    '--no-color',
    'HEAD',
    '--',
    '.',
  ])
  const addedDiffs = await Promise.all(
    (await listGitPaths(workspacePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])).map(relativePath =>
      gitDiff(workspacePath, [
        'diff',
        '--no-color',
        '--no-index',
        '--',
        '/dev/null',
        relativePath,
      ])
    )
  )
  return [trackedDiff, ...addedDiffs].filter(Boolean).join('\n')
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
