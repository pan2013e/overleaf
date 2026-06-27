import { beforeEach, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import sinon from 'sinon'

const modulePath =
  '../../../../app/src/Features/Codex/ProjectPatchApplier.mjs'

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

describe('ProjectPatchApplier', function () {
  beforeEach(async function (ctx) {
    ctx.projectId = 'project-1'
    ctx.userId = 'user-1'
    ctx.docId = 'doc-1'
    ctx.DocumentUpdaterHandler = {
      promises: {
        setDocument: sinon.stub().resolves(),
      },
    }
    ctx.ProjectEntityHandler = {
      promises: {
        getDoc: sinon.stub().resolves({
          lines: ['before'],
        }),
        getAllDocs: sinon.stub().resolves({}),
      },
    }
    ctx.ProjectEntityUpdateHandler = {
      promises: {
        upsertDocWithPath: sinon.stub().resolves({
          doc: { _id: { toString: () => 'doc-added' } },
          isNew: true,
        }),
      },
    }

    vi.doMock(
      '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
      () => ({
        default: ctx.DocumentUpdaterHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({
        default: ctx.ProjectEntityHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs',
      () => ({
        default: ctx.ProjectEntityUpdateHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Codex/ProjectWorkspaceBuilder.mjs',
      () => ({
        default: { hashContent },
      })
    )

    ctx.ProjectPatchApplier = (await import(modulePath)).default
  })

  it('applies modified docs through document-updater', async function (ctx) {
    const result = await ctx.ProjectPatchApplier.applyChanges({
      projectId: ctx.projectId,
      userId: ctx.userId,
      manifest: {
        '/main.tex': {
          docId: ctx.docId,
          hash: hashContent('before'),
        },
      },
      changes: [
        {
          type: 'modified',
          projectPath: '/main.tex',
          docId: ctx.docId,
          newContent: 'after\nline two',
        },
      ],
    })

    expect(result.applied).to.deep.equal([
      {
        projectPath: '/main.tex',
        docId: ctx.docId,
      },
    ])
    expect(
      ctx.DocumentUpdaterHandler.promises.setDocument
    ).to.have.been.calledWith(
      ctx.projectId,
      ctx.docId,
      ctx.userId,
      ['after', 'line two'],
      { kind: 'codex' }
    )
  })

  it('rejects stale snapshots before applying', async function (ctx) {
    await expect(
      ctx.ProjectPatchApplier.applyChanges({
        projectId: ctx.projectId,
        userId: ctx.userId,
        manifest: {
          '/main.tex': {
            docId: ctx.docId,
            hash: hashContent('older content'),
          },
        },
        changes: [
          {
            type: 'modified',
            projectPath: '/main.tex',
            docId: ctx.docId,
            newContent: 'after',
          },
        ],
      })
    ).to.be.rejectedWith('document changed since Codex run')

    expect(ctx.DocumentUpdaterHandler.promises.setDocument).not.to.have.been
      .called
  })

  it('creates added docs through project entity updates', async function (ctx) {
    const result = await ctx.ProjectPatchApplier.applyChanges({
      projectId: ctx.projectId,
      userId: ctx.userId,
      manifest: { docs: {} },
      changes: [
        {
          type: 'added',
          projectPath: '/sections/new.tex',
          newContent: 'new section\nline two',
        },
      ],
    })

    expect(result.applied).to.deep.equal([
      {
        projectPath: '/sections/new.tex',
        docId: 'doc-added',
      },
    ])
    expect(
      ctx.ProjectEntityUpdateHandler.promises.upsertDocWithPath
    ).to.have.been.calledWith(
      ctx.projectId,
      '/sections/new.tex',
      ['new section', 'line two'],
      { kind: 'codex' },
      ctx.userId
    )
  })

  it('rejects added docs when the project path now exists', async function (ctx) {
    ctx.ProjectEntityHandler.promises.getAllDocs.resolves({
      '/sections/new.tex': { _id: 'doc-existing' },
    })

    await expect(
      ctx.ProjectPatchApplier.applyChanges({
        projectId: ctx.projectId,
        userId: ctx.userId,
        manifest: { docs: {} },
        changes: [
          {
            type: 'added',
            projectPath: '/sections/new.tex',
            newContent: 'new section',
          },
        ],
      })
    ).to.be.rejectedWith('document already exists since Codex run')

    expect(ctx.ProjectEntityUpdateHandler.promises.upsertDocWithPath).not.to
      .have.been.called
  })
})
