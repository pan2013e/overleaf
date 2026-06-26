import Errors from '../Errors/Errors.js'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectWorkspaceBuilder from './ProjectWorkspaceBuilder.mjs'

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

async function applyChanges({ projectId, userId, manifest, changes, paths }) {
  const pathFilter = paths == null ? null : new Set(paths)
  const applied = []

  for (const change of changes) {
    if (pathFilter && !pathFilter.has(change.projectPath)) {
      continue
    }
    if (change.type !== 'modified') {
      throw new Errors.InvalidError(
        `unsupported Codex change type: ${change.type}`
      )
    }
    const snapshot = manifest.docs[change.projectPath]
    if (!snapshot) {
      throw new Errors.InvalidError(`missing snapshot: ${change.projectPath}`)
    }
    await assertUnchanged(projectId, change, snapshot)
    await DocumentUpdaterHandler.promises.setDocument(
      projectId,
      change.docId,
      userId,
      contentToLines(change.newContent),
      'codex'
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
