import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import Path from "node:path";
import sinon from "sinon";

const modulePath = "../../../../app/src/Features/Codex/CodexRunManager.mjs";

async function waitForRun(manager, runId, predicate) {
  for (let i = 0; i < 20; i++) {
    const run = manager.getRun(runId);
    if (run && predicate(run)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for run ${runId}`);
}

describe("CodexRunManager", function () {
  beforeEach(async function (ctx) {
    vi.resetModules();

    ctx.tmpRoot = await fs.mkdtemp(
      Path.join(os.tmpdir(), "overleaf-codex-run-test-"),
    );
    ctx.userId = "user-1";
    ctx.projectId = "project-1";
    ctx.changes = [
      {
        type: "modified",
        projectPath: "/main.tex",
        docId: "doc-1",
        oldHash: "old",
        newHash: "new",
        newContent: "after",
      },
    ];

    ctx.client = {
      on: sinon.stub(),
      off: sinon.stub(),
      waitForNotification: sinon.stub().resolves({}),
      request: sinon.stub().callsFake(async (method) => {
        switch (method) {
          case "account/read":
            return { requiresOpenaiAuth: false };
          case "thread/start":
            return { thread: { id: "thread-1" } };
          case "turn/start":
            return { turn: { id: `turn-${ctx.client.request.callCount}` } };
          default:
            return {};
        }
      }),
    };

    ctx.ProjectWorkspaceBuilder = {
      buildWorkspace: sinon.stub().callsFake(async ({ runId }) => {
        const runRoot = Path.join(ctx.tmpRoot, runId);
        await fs.mkdir(runRoot, { recursive: true });
        return {
          runRoot,
          workspacePath: Path.join(runRoot, "workspace"),
          manifest: {
            docs: {
              "/main.tex": {
                docId: "doc-1",
                hash: "old",
                relativePath: "main.tex",
              },
            },
          },
        };
      }),
    };
    ctx.ProjectDiffBuilder = {
      buildStructuredChanges: sinon.stub().resolves(ctx.changes),
      buildGitDiff: sinon.stub().resolves("diff --git a/main.tex b/main.tex"),
      buildGitStatus: sinon.stub().resolves(" M main.tex"),
      summarizeChanges: sinon.stub().callsFake((changes) =>
        changes.map((change) => ({
          type: change.type,
          projectPath: change.projectPath,
          docId: change.docId,
          oldHash: change.oldHash,
          newHash: change.newHash,
        })),
      ),
    };
    ctx.ProjectPatchApplier = {
      applyChanges: sinon.stub().resolves({ applied: [] }),
    };

    vi.doMock("@overleaf/settings", () => ({
      default: {
        codex: {
          model: null,
          reasoningEffort: "medium",
          reasoningSummary: "auto",
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          networkAccess: true,
          autoApply: false,
          runTimeoutMs: 1000,
        },
      },
    }));
    vi.doMock(
      "../../../../app/src/Features/Codex/CodexProcessManager.mjs",
      () => ({
        default: {
          assertEnabled: sinon.stub(),
          getClient: sinon.stub().resolves(ctx.client),
        },
      }),
    );
    vi.doMock(
      "../../../../app/src/Features/Codex/ProjectWorkspaceBuilder.mjs",
      () => ({
        default: ctx.ProjectWorkspaceBuilder,
      }),
    );
    vi.doMock(
      "../../../../app/src/Features/Codex/ProjectDiffBuilder.mjs",
      () => ({
        default: ctx.ProjectDiffBuilder,
      }),
    );
    vi.doMock(
      "../../../../app/src/Features/Codex/ProjectPatchApplier.mjs",
      () => ({
        default: ctx.ProjectPatchApplier,
      }),
    );

    ctx.CodexRunManager = (await import(modulePath)).default;
  });

  afterEach(async function (ctx) {
    if (ctx.tmpRoot) {
      await fs.rm(ctx.tmpRoot, { recursive: true, force: true });
    }
  });

  it("marks runs with no project edits as no_changes", async function (ctx) {
    ctx.ProjectDiffBuilder.buildStructuredChanges.resolves([]);

    const run = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Explain the project",
      options: {},
    });

    const finishedRun = await waitForRun(
      ctx.CodexRunManager,
      run.id,
      (item) => item.status === "no_changes",
    );

    expect(finishedRun.error).to.be.undefined;
    expect(finishedRun.changesSummary).to.deep.equal([]);
  });

  it("continues a previous session on the same Codex thread", async function (ctx) {
    const firstRun = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Fix the typo",
      options: {},
    });
    await waitForRun(
      ctx.CodexRunManager,
      firstRun.id,
      (item) => item.status === "applied",
    );

    const secondRun = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Also tighten the conclusion",
      continueRunId: firstRun.id,
      options: {},
    });
    const finishedRun = await waitForRun(
      ctx.CodexRunManager,
      secondRun.id,
      (item) => item.status === "applied",
    );

    const threadStarts = ctx.client.request
      .getCalls()
      .filter((call) => call.args[0] === "thread/start");
    const turnStarts = ctx.client.request
      .getCalls()
      .filter((call) => call.args[0] === "turn/start");

    expect(threadStarts).to.have.length(1);
    expect(turnStarts[1].args[1].threadId).to.equal("thread-1");
    expect(finishedRun.sessionId).to.equal(firstRun.sessionId);
    expect(finishedRun.continuedFromRunId).to.equal(firstRun.id);
  });

  it("recovers persisted follow-ups when the app-server thread is gone", async function (ctx) {
    const firstRun = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Fix the typo",
      options: {},
    });
    const finishedFirstRun = await waitForRun(
      ctx.CodexRunManager,
      firstRun.id,
      (item) => item.status === "applied",
    );

    ctx.client.request.resetHistory();
    ctx.client.request.callsFake(async (method, params) => {
      switch (method) {
        case "account/read":
          return { requiresOpenaiAuth: false };
        case "thread/start":
          return { thread: { id: "thread-2" } };
        case "turn/start":
          if (params.threadId === finishedFirstRun.threadId) {
            throw new Error(`thread not found: ${finishedFirstRun.threadId}`);
          }
          return { turn: { id: "turn-2" } };
        default:
          return {};
      }
    });

    const secondRun = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Also tighten the conclusion",
      continueRunId: firstRun.id,
      options: {},
    });
    const finishedSecondRun = await waitForRun(
      ctx.CodexRunManager,
      secondRun.id,
      (item) => item.status === "applied",
    );

    const threadStarts = ctx.client.request
      .getCalls()
      .filter((call) => call.args[0] === "thread/start");
    const turnStarts = ctx.client.request
      .getCalls()
      .filter((call) => call.args[0] === "turn/start");

    expect(threadStarts).to.have.length(1);
    expect(turnStarts).to.have.length(2);
    expect(turnStarts[0].args[1].threadId).to.equal(
      finishedFirstRun.threadId,
    );
    expect(turnStarts[1].args[1].threadId).to.equal("thread-2");
    expect(finishedSecondRun.threadId).to.equal("thread-2");
    expect(finishedSecondRun.sessionId).to.equal(firstRun.sessionId);
    expect(finishedSecondRun.continuedFromRunId).to.equal(firstRun.id);
  });

  it("rejects blocked command executions after the turn", async function (ctx) {
    ctx.client.waitForNotification.callsFake(async () => {
      const notification = {
        method: "item/completed",
        params: {
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "sudo rm -rf /",
            status: "completed",
          },
        },
      };
      const listener = ctx.client.on.firstCall.args[1];
      listener(notification);
    });

    const run = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Make an edit",
      options: {},
    });

    const finishedRun = await waitForRun(
      ctx.CodexRunManager,
      run.id,
      (item) => item.status === "failed",
    );

    expect(finishedRun.error).to.contain("blocked command pattern");
  });

  it("rejects untracked workspace files", async function (ctx) {
    ctx.ProjectDiffBuilder.buildStructuredChanges.resolves([]);
    ctx.ProjectDiffBuilder.buildGitStatus.resolves("?? outside.txt");

    const run = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Create a helper file",
      options: {},
    });

    const finishedRun = await waitForRun(
      ctx.CodexRunManager,
      run.id,
      (item) => item.status === "failed",
    );

    expect(finishedRun.error).to.contain("outside the editable project");
  });

  it("auto-applies safe added project files", async function (ctx) {
    const addedChanges = [
      {
        type: "added",
        projectPath: "/sections/new.tex",
        docId: null,
        oldHash: null,
        newHash: "new",
        newContent: "new section",
      },
    ];
    ctx.ProjectDiffBuilder.buildStructuredChanges.resolves(addedChanges);
    ctx.ProjectDiffBuilder.buildGitStatus.resolves("?? sections/new.tex");

    const run = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Create a new section file",
      options: {},
    });

    const finishedRun = await waitForRun(
      ctx.CodexRunManager,
      run.id,
      (item) => item.status === "applied",
    );

    expect(finishedRun.error).to.be.undefined;
    expect(finishedRun.changesSummary).to.deep.equal([
      {
        type: "added",
        projectPath: "/sections/new.tex",
        docId: null,
        oldHash: null,
        newHash: "new",
      },
    ]);
  });

  it("auto-applies added project files even when disabled by the client", async function (ctx) {
    const addedChanges = [
      {
        type: "added",
        projectPath: "/sections/auto.tex",
        docId: null,
        oldHash: null,
        newHash: "new",
        newContent: "auto section",
      },
    ];
    ctx.ProjectDiffBuilder.buildStructuredChanges.resolves(addedChanges);
    ctx.ProjectDiffBuilder.buildGitStatus.resolves("?? sections/auto.tex");

    const run = await ctx.CodexRunManager.startRun({
      userId: ctx.userId,
      projectId: ctx.projectId,
      prompt: "Create a new section file",
      options: { autoApply: false },
    });

    const finishedRun = await waitForRun(
      ctx.CodexRunManager,
      run.id,
      (item) => item.status === "applied",
    );

    expect(finishedRun.error).to.be.undefined;
    expect(ctx.ProjectPatchApplier.applyChanges).to.have.been.calledWith(
      sinon.match({
        projectId: ctx.projectId,
        userId: ctx.userId,
        changes: addedChanges,
      }),
    );
  });
});
