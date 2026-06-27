import fs from 'node:fs/promises'
import Path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Settings from '@overleaf/settings'
import Errors from '../Errors/Errors.js'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../Project/ProjectEntityUpdateHandler.mjs'

const execFileAsync = promisify(execFile)
const GIT_AUTHOR_ARGS = [
  '-c',
  'user.name=Overleaf',
  '-c',
  'user.email=git@overleaf.local',
]
const TEXT_EXTENSIONS = new Set([
  '.bib',
  '.bst',
  '.cls',
  '.clo',
  '.csv',
  '.latex',
  '.ltx',
  '.md',
  '.sty',
  '.tex',
  '.txt',
  '.yaml',
  '.yml',
])
const MAX_TEXT_FILE_BYTES = 1024 * 1024
const PROJECT_GIT_SOURCE = 'project-git'

function repoPath(projectId) {
  return Path.join(
    Settings.projectGit.dataDir,
    'projects',
    projectId.toString(),
    'repo'
  )
}

function toSafeRelativePath(projectPath) {
  const normalized = Path.posix.normalize(projectPath.replace(/\\/g, '/'))
  const relativePath = normalized.replace(/^\/+/, '')
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../') ||
    Path.posix.isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    relativePath.split('/').includes('.git')
  ) {
    throw new Errors.InvalidError(`invalid project path: ${projectPath}`)
  }
  return relativePath
}

function projectPath(relativePath) {
  return `/${relativePath.replace(/^\/+/, '')}`
}

function isManagedTextPath(relativePath) {
  const basename = Path.posix.basename(relativePath)
  if (basename === '.latexmkrc') {
    return true
  }
  return TEXT_EXTENSIONS.has(Path.posix.extname(relativePath).toLowerCase())
}

function validateRemoteUrl(remoteUrl) {
  if (
    typeof remoteUrl !== 'string' ||
    remoteUrl.trim() !== remoteUrl ||
    remoteUrl.length < 3 ||
    remoteUrl.length > 2000 ||
    remoteUrl.startsWith('-') ||
    /[\u0000-\u001f]/.test(remoteUrl)
  ) {
    throw new Errors.InvalidError('invalid git remote URL')
  }
}

async function pathExists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function isInitialized(projectId) {
  return await pathExists(Path.join(repoPath(projectId), '.git'))
}

async function runGit(cwd, args, { allowExitOne = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (error) {
    if (allowExitOne && error.code === 1) {
      return {
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : '',
      }
    }
    const message =
      (typeof error.stderr === 'string' && error.stderr.trim()) ||
      (typeof error.stdout === 'string' && error.stdout.trim()) ||
      error.message ||
      'git command failed'
    throw new Errors.InvalidError(message)
  }
}

async function ensureRepo(projectId) {
  const path = repoPath(projectId)
  if (!(await isInitialized(projectId))) {
    throw new Errors.NotFoundError('project git repository is not initialized')
  }
  return path
}

async function writeTextFile(root, relativePath, content) {
  const outputPath = Path.join(root, ...relativePath.split('/'))
  const resolvedOutputPath = Path.resolve(outputPath)
  const resolvedRoot = Path.resolve(root)
  if (!resolvedOutputPath.startsWith(`${resolvedRoot}${Path.sep}`)) {
    throw new Errors.InvalidError(`invalid project path: ${relativePath}`)
  }
  await fs.mkdir(Path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, content, 'utf8')
}

async function walkFiles(root, dir = root) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue
    }
    const absolutePath = Path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolutePath)))
      continue
    }
    if (entry.isFile()) {
      files.push(Path.relative(root, absolutePath).replace(/\\/g, '/'))
    }
  }
  return files
}

async function syncProjectToRepo(projectId, path) {
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  const projectRelativePaths = new Set()
  let totalBytes = 0

  for (const [pathInProject, doc] of Object.entries(docs)) {
    const relativePath = toSafeRelativePath(pathInProject)
    projectRelativePaths.add(relativePath)
    const content = doc.lines.join('\n')
    totalBytes += Buffer.byteLength(content, 'utf8')
    if (totalBytes > Settings.projectGit.maxProjectBytes) {
      throw new Errors.InvalidError('project is too large for git sync')
    }
    await writeTextFile(path, relativePath, content)
  }

  for (const relativePath of await walkFiles(path)) {
    if (!projectRelativePaths.has(relativePath) && isManagedTextPath(relativePath)) {
      await fs.rm(Path.join(path, ...relativePath.split('/')), { force: true })
    }
  }
}

async function getRemote(path) {
  try {
    const { stdout } = await runGit(path, ['remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

function parsePorcelainStatus(stdout) {
  const lines = stdout.split('\n').filter(Boolean)
  const branchLine = lines.find(line => line.startsWith('## '))
  const changes = []
  let branch = null
  let ahead = 0
  let behind = 0

  if (branchLine) {
    const branchText = branchLine.slice(3)
    branch = branchText.split(/[.\s[]/)[0] || null
    ahead = Number(branchText.match(/ahead (\d+)/)?.[1] ?? 0)
    behind = Number(branchText.match(/behind (\d+)/)?.[1] ?? 0)
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      continue
    }
    const index = line[0] || ' '
    const workingTree = line[1] || ' '
    const rawPath = line.slice(3)
    changes.push({
      path: rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath,
      index,
      workingTree,
      status: `${index}${workingTree}`.trim() || 'M',
    })
  }

  return {
    ahead,
    behind,
    branch,
    changes,
    clean: changes.length === 0,
  }
}

async function logCommits(path) {
  const { stdout } = await runGit(path, [
    'log',
    '--date=relative',
    '--pretty=format:%h%x00%s%x00%cr',
    '-n',
    '12',
  ]).catch(() => ({ stdout: '' }))

  return stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, subject, relativeTime] = line.split('\0')
      return { hash, subject, relativeTime }
    })
}

async function status(projectId, { sync = true, message, warning } = {}) {
  if (!(await isInitialized(projectId))) {
    return {
      initialized: false,
      branch: null,
      remoteUrl: null,
      clean: true,
      changes: [],
      diff: '',
      commits: [],
      message,
      warning,
    }
  }

  const path = repoPath(projectId)
  if (sync) {
    await syncProjectToRepo(projectId, path)
  }
  const [{ stdout: statusText }, { stdout: diff }, remoteUrl, commits] =
    await Promise.all([
      runGit(path, ['status', '--porcelain=v1', '-b']),
      runGit(path, ['diff', '--no-color', '--', '.'], { allowExitOne: true }),
      getRemote(path),
      logCommits(path),
    ])
  return {
    initialized: true,
    remoteUrl,
    diff,
    commits,
    message,
    warning,
    ...parsePorcelainStatus(statusText),
  }
}

async function init(projectId) {
  const path = repoPath(projectId)
  await fs.mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await isInitialized(projectId))) {
    await runGit(path, ['init', '-q'])
  }
  await syncProjectToRepo(projectId, path)
  await runGit(path, ['add', '-A'])
  const current = await status(projectId, { sync: false })
  if (!current.clean) {
    await runGit(path, [
      ...GIT_AUTHOR_ARGS,
      'commit',
      '-qm',
      'Initial Overleaf snapshot',
    ])
  }
  return await status(projectId, {
    message: 'Project Git repository initialized.',
  })
}

async function setRemote(projectId, remoteUrl) {
  validateRemoteUrl(remoteUrl)
  const path = await ensureRepo(projectId)
  if (await getRemote(path)) {
    await runGit(path, ['remote', 'set-url', 'origin', remoteUrl])
  } else {
    await runGit(path, ['remote', 'add', 'origin', remoteUrl])
  }
  return await status(projectId, { message: 'Remote URL updated.' })
}

async function commit(projectId, message) {
  if (!message?.trim()) {
    throw new Errors.InvalidError('commit message is required')
  }
  const path = await ensureRepo(projectId)
  await syncProjectToRepo(projectId, path)
  await runGit(path, ['add', '-A'])
  const current = await status(projectId, { sync: false })
  if (current.clean) {
    return await status(projectId, { message: 'No changes to commit.' })
  }
  await runGit(path, [...GIT_AUTHOR_ARGS, 'commit', '-m', message.trim()])
  return await status(projectId, { message: 'Committed project changes.' })
}

async function push(projectId) {
  const path = await ensureRepo(projectId)
  await runGit(path, ['push', '-u', 'origin', 'HEAD'])
  return await status(projectId, { message: 'Pushed to remote.' })
}

async function readRepoTextFiles(path) {
  const files = []
  for (const relativePath of await walkFiles(path)) {
    if (!isManagedTextPath(relativePath)) {
      continue
    }
    const absolutePath = Path.join(path, ...relativePath.split('/'))
    const stat = await fs.stat(absolutePath)
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      continue
    }
    let content
    try {
      content = await fs.readFile(absolutePath, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) {
      continue
    }
    files.push({ relativePath, content })
  }
  return files
}

async function applyRepoToProject(projectId, userId, path) {
  const files = await readRepoTextFiles(path)
  for (const file of files) {
    await ProjectEntityUpdateHandler.promises.upsertDocWithPath(
      projectId,
      projectPath(file.relativePath),
      file.content.replace(/\r\n/g, '\n').split('\n'),
      PROJECT_GIT_SOURCE,
      userId
    )
  }
  return files.length
}

async function pull(projectId, userId) {
  const path = await ensureRepo(projectId)
  await syncProjectToRepo(projectId, path)
  const current = await status(projectId, { sync: false })
  if (!current.clean) {
    throw new Errors.InvalidError('commit project changes before pulling')
  }
  await runGit(path, ['pull', '--ff-only'])
  const appliedCount = await applyRepoToProject(projectId, userId, path)
  return await status(projectId, {
    message: `Pulled remote changes and updated ${appliedCount} text file${
      appliedCount === 1 ? '' : 's'
    }.`,
  })
}

async function importRemote(projectId, userId, remoteUrl) {
  validateRemoteUrl(remoteUrl)
  const path = repoPath(projectId)
  await fs.rm(path, { recursive: true, force: true })
  await fs.mkdir(Path.dirname(path), { recursive: true, mode: 0o700 })
  await runGit(Path.dirname(path), ['clone', remoteUrl, path])
  const appliedCount = await applyRepoToProject(projectId, userId, path)
  return await status(projectId, {
    message: `Imported ${appliedCount} text file${
      appliedCount === 1 ? '' : 's'
    } from remote.`,
    warning: 'Binary files are kept in the Git repository but not imported into the Overleaf editor.',
  })
}

export default {
  commit,
  importRemote,
  init,
  pull,
  push,
  setRemote,
  status,
}
