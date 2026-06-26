import { afterEach, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'

const workspaceBuilderPath =
  '../../../../app/src/Features/Codex/ProjectWorkspaceBuilder.mjs'
const diffBuilderPath =
  '../../../../app/src/Features/Codex/ProjectDiffBuilder.mjs'

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

describe('ProjectWorkspaceBuilder', function () {
  afterEach(async function (ctx) {
    if (ctx.tmpRoot) {
      await fs.rm(ctx.tmpRoot, { recursive: true, force: true })
    }
  })

  beforeEach(async function (ctx) {
    ctx.tmpRoot = await fs.mkdtemp(
      Path.join(os.tmpdir(), 'overleaf-codex-test-')
    )
    ctx.settings = {
      codex: {
        dataDir: ctx.tmpRoot,
        maxDocs: 10,
        maxProjectBytes: 1024 * 1024,
      },
    }
    ctx.docs = {
      '/main.tex': {
        _id: { toString: () => 'doc-main' },
        rev: 7,
        lines: ['hello', 'world'],
      },
      '/chapters/intro.tex': {
        _id: { toString: () => 'doc-intro' },
        rev: 3,
        lines: ['intro'],
      },
    }

    vi.doMock('@overleaf/settings', () => ({
      default: ctx.settings,
    }))
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({
        default: {
          promises: {
            getAllDocs: vi.fn().mockResolvedValue(ctx.docs),
          },
        },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Codex/CodexProcessManager.mjs',
      () => ({
        default: {
          getUserRoot(userId) {
            return Path.join(ctx.tmpRoot, 'users', userId.toString())
          },
        },
      })
    )

    ctx.ProjectWorkspaceBuilder = (await import(workspaceBuilderPath)).default
    ctx.ProjectDiffBuilder = (await import(diffBuilderPath)).default
  })

  it('exports docs to a workspace and writes a manifest', async function (ctx) {
    const workspace = await ctx.ProjectWorkspaceBuilder.buildWorkspace({
      userId: 'user-1',
      projectId: 'project-1',
      runId: 'run-1',
    })

    await expect(
      fs.readFile(Path.join(workspace.workspacePath, 'main.tex'), 'utf8')
    ).resolves.to.equal('hello\nworld')
    await expect(
      fs.readFile(
        Path.join(workspace.workspacePath, 'chapters', 'intro.tex'),
        'utf8'
      )
    ).resolves.to.equal('intro')

    expect(workspace.manifest.docs['/main.tex']).to.deep.include({
      docId: 'doc-main',
      rev: 7,
      hash: hashContent('hello\nworld'),
      relativePath: 'main.tex',
    })
  })

  it('builds structured changes from workspace edits', async function (ctx) {
    const workspace = await ctx.ProjectWorkspaceBuilder.buildWorkspace({
      userId: 'user-1',
      projectId: 'project-1',
      runId: 'run-2',
    })
    await fs.writeFile(
      Path.join(workspace.workspacePath, 'main.tex'),
      'hello\ncodex\n',
      'utf8'
    )

    const changes = await ctx.ProjectDiffBuilder.buildStructuredChanges(
      workspace
    )

    expect(changes).to.have.length(1)
    expect(changes[0]).to.deep.include({
      type: 'modified',
      projectPath: '/main.tex',
      docId: 'doc-main',
      oldHash: hashContent('hello\nworld'),
      newHash: hashContent('hello\ncodex\n'),
      newContent: 'hello\ncodex\n',
    })
  })
})
