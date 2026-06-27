import Errors from '../Errors/Errors.js'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../Project/ProjectEntityUpdateHandler.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectWorkspaceBuilder from './ProjectWorkspaceBuilder.mjs'

const CODEX_HISTORY_ORIGIN = { kind: 'codex' }

function contentToLines(content) {
  return content.replace(/\r\n/g, '\n').split('\n')
}

async function assertUnchanged(projectId, change, snapshot) {
  const currentDoc = await ProjectEntityHandler.promises.getDoc(
    projectId,
    change.docId
  )
  const currentHash = ProjectWorkspaceBuilder.hashContent(
    currentDoc.lines.join('\n')
  )
  if (currentHash !== snapshot.hash) {
    throw new Errors.InvalidError(
      `document changed since Codex run: ${change.projectPath}`
    )
  }
}

function manifestDocs(manifest) {
  return manifest.docs ?? manifest
}

function projectPathToElementPath(projectPath) {
  return projectPath.startsWith('/') ? projectPath : `/${projectPath}`
}

async function assertPathStillMissing(projectId, projectPath) {
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  if (docs[projectPath]) {
    throw new Errors.InvalidError(
      `document already exists since Codex run: ${projectPath}`
    )
  }
}

async function applyChanges({ projectId, userId, manifest, changes, paths }) {
  const pathFilter = paths == null ? null : new Set(paths)
  const applied = []
  const docs = manifestDocs(manifest)

  for (const change of changes) {
    if (pathFilter && !pathFilter.has(change.projectPath)) {
      continue
    }
    if (change.type === 'added') {
      await assertPathStillMissing(projectId, change.projectPath)
      const { doc } =
        await ProjectEntityUpdateHandler.promises.upsertDocWithPath(
          projectId,
          projectPathToElementPath(change.projectPath),
          contentToLines(change.newContent),
          CODEX_HISTORY_ORIGIN,
          userId
        )
      applied.push({
        projectPath: change.projectPath,
        docId: doc._id?.toString?.() ?? doc._id,
      })
      continue
    }
    if (change.type !== 'modified') {
      throw new Errors.InvalidError(
        `unsupported Codex change type: ${change.type}`
      )
    }
    const snapshot = docs[change.projectPath]
    if (!snapshot) {
      throw new Errors.InvalidError(`missing snapshot: ${change.projectPath}`)
    }
    await assertUnchanged(projectId, change, snapshot)
    await DocumentUpdaterHandler.promises.setDocument(
      projectId,
      change.docId,
      userId,
      contentToLines(change.newContent),
      CODEX_HISTORY_ORIGIN
    )
    applied.push({
      projectPath: change.projectPath,
      docId: change.docId,
    })
  }

  return { applied }
}

export default {
  applyChanges,
}
