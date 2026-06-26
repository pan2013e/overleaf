import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'
import MockRequest from '../helpers/MockRequest.mjs'
import MockResponse from '../helpers/MockResponse.mjs'

const modulePath = '../../../../app/src/Features/Codex/CodexController.mjs'

describe('CodexController', function () {
  beforeEach(async function (ctx) {
    vi.resetModules()

    ctx.userId = '123456123456123456123456'
    ctx.projectId = 'abcdefabcdefabcdefabcdef'
    ctx.req = new MockRequest(vi)
    ctx.res = new MockResponse(vi)
    ctx.next = sinon.stub()

    ctx.SessionManager = {
      getLoggedInUserId: sinon.stub().returns(ctx.userId),
    }
    ctx.CodexAccountManager = {
      readAccount: sinon.stub().resolves({
        account: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'plus',
        },
        requiresOpenaiAuth: true,
      }),
      startDeviceLogin: sinon.stub().resolves({
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      }),
      cancelLogin: sinon.stub().resolves(),
      logout: sinon.stub().resolves(),
      listModels: sinon.stub().resolves({
        data: [
          {
            id: 'gpt-5',
            model: 'gpt-5',
            displayName: 'GPT-5',
            isDefault: true,
          },
        ],
      }),
    }
    ctx.CodexRunManager = {
      startRun: sinon.stub().resolves({ id: 'run-1' }),
      listRuns: sinon.stub().returns([{ id: 'run-1', status: 'completed' }]),
      getDefaultOptions: sinon.stub().returns({
        model: null,
        effort: 'medium',
        summary: 'auto',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
        autoApply: true,
      }),
      serializeRun: sinon.stub().returns({
        id: 'run-1',
        status: 'queued',
      }),
      requireRun: sinon.stub().returns({
        events: [{ method: 'turn/completed' }],
        status: 'completed',
        diff: 'diff --git a/main.tex b/main.tex',
        gitStatus: ' M main.tex',
        changesSummary: [{ type: 'modified', projectPath: '/main.tex' }],
      }),
      applyRun: sinon.stub().resolves({
        applied: [{ projectPath: '/main.tex', docId: 'doc-1' }],
      }),
      cancelRun: sinon.stub().resolves({ id: 'run-1', status: 'cancelled' }),
    }

    vi.doMock(
      '../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: ctx.SessionManager,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Codex/CodexAccountManager.mjs',
      () => ({
        default: ctx.CodexAccountManager,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Codex/CodexRunManager.mjs',
      () => ({
        default: ctx.CodexRunManager,
      })
    )

    ctx.CodexController = (await import(modulePath)).default
  })

  it('requires a logged-in user', async function (ctx) {
    ctx.SessionManager.getLoggedInUserId.returns(null)

    await ctx.CodexController.getAccount(ctx.req, ctx.res, ctx.next)

    expect(ctx.next).to.have.been.calledOnce
    expect(ctx.next.firstCall.args[0].message).to.equal(
      'Codex requires a logged-in user'
    )
    expect(ctx.CodexAccountManager.readAccount).not.to.have.been.called
  })

  it('returns Codex account state', async function (ctx) {
    await ctx.CodexController.getAccount(ctx.req, ctx.res, ctx.next)

    expect(ctx.CodexAccountManager.readAccount).to.have.been.calledWith(
      ctx.userId
    )
    expect(ctx.res.json).toHaveBeenCalledWith({
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'plus',
      },
      requiresOpenaiAuth: true,
    })
    expect(ctx.next).not.to.have.been.called
  })

  it('starts device-code login', async function (ctx) {
    await ctx.CodexController.startLogin(ctx.req, ctx.res, ctx.next)

    expect(ctx.CodexAccountManager.startDeviceLogin).to.have.been.calledWith(
      ctx.userId
    )
    expect(ctx.res.status).toHaveBeenCalledWith(202)
    expect(ctx.res.json).toHaveBeenCalledWith({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    expect(ctx.next).not.to.have.been.called
  })

  it('starts a project Codex run', async function (ctx) {
    ctx.req.params.Project_id = ctx.projectId
    ctx.req.body.prompt = 'Fix the typo'
    ctx.req.body.options = {
      model: 'gpt-5',
      effort: 'high',
      summary: 'detailed',
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      autoApply: true,
    }

    await ctx.CodexController.startRun(ctx.req, ctx.res, ctx.next)

    expect(ctx.CodexRunManager.startRun).to.have.been.calledWith(
      sinon.match({
        userId: ctx.userId,
        projectId: ctx.projectId,
        prompt: 'Fix the typo',
        options: ctx.req.body.options,
      })
    )
    expect(ctx.CodexRunManager.serializeRun).to.have.been.calledWith({
      id: 'run-1',
    })
    expect(ctx.res.status).toHaveBeenCalledWith(202)
    expect(ctx.res.json).toHaveBeenCalledWith({
      id: 'run-1',
      status: 'queued',
    })
    expect(ctx.next).not.to.have.been.called
  })

  it('lists project Codex runs', async function (ctx) {
    ctx.req.params.Project_id = ctx.projectId

    await ctx.CodexController.listRuns(ctx.req, ctx.res, ctx.next)

    expect(ctx.CodexRunManager.listRuns).to.have.been.calledWith(
      sinon.match({
        userId: ctx.userId,
        projectId: ctx.projectId,
      })
    )
    expect(ctx.res.json).toHaveBeenCalledWith({
      runs: [{ id: 'run-1', status: 'queued' }],
    })
    expect(ctx.next).not.to.have.been.called
  })

  it('returns Codex run option defaults', async function (ctx) {
    await ctx.CodexController.getOptions(ctx.req, ctx.res, ctx.next)

    expect(ctx.res.json).toHaveBeenCalledWith(
      sinon.match({
        defaults: {
          model: null,
          effort: 'medium',
          summary: 'auto',
          approvalPolicy: 'never',
          sandboxMode: 'danger-full-access',
          autoApply: true,
        },
      })
    )
    expect(ctx.next).not.to.have.been.called
  })

  it('returns available Codex models', async function (ctx) {
    await ctx.CodexController.getModels(ctx.req, ctx.res, ctx.next)

    expect(ctx.CodexAccountManager.listModels).to.have.been.calledWith(
      ctx.userId
    )
    expect(ctx.res.json).toHaveBeenCalledWith({
      data: [
        {
          id: 'gpt-5',
          model: 'gpt-5',
          displayName: 'GPT-5',
          isDefault: true,
        },
      ],
    })
    expect(ctx.next).not.to.have.been.called
  })

  it('applies selected Codex changes', async function (ctx) {
    ctx.req.params.Project_id = ctx.projectId
    ctx.req.params.runId = 'run-1'
    ctx.req.body.paths = ['/main.tex']

    await ctx.CodexController.applyRun(ctx.req, ctx.res, ctx.next)

    expect(ctx.CodexRunManager.applyRun).to.have.been.calledWith(
      sinon.match({
        userId: ctx.userId,
        projectId: ctx.projectId,
        runId: 'run-1',
        paths: ['/main.tex'],
      })
    )
    expect(ctx.res.json).toHaveBeenCalledWith({
      applied: [{ projectPath: '/main.tex', docId: 'doc-1' }],
    })
    expect(ctx.next).not.to.have.been.called
  })
})
