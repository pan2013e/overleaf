import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import Path from "node:path";

const modulePath = "../../../../app/src/Features/Codex/CodexRunStore.mjs";

describe("CodexRunStore", function () {
  beforeEach(async function (ctx) {
    vi.resetModules();
    ctx.tmpRoot = await fs.mkdtemp(
      Path.join(os.tmpdir(), "overleaf-codex-store-test-"),
    );
    vi.doMock("@overleaf/settings", () => ({
      default: {
        codex: {
          dataDir: ctx.tmpRoot,
        },
      },
    }));
    vi.doMock("@overleaf/logger", () => ({
      default: {
        warn: vi.fn(),
      },
    }));
  });

  afterEach(async function (ctx) {
    if (ctx.tmpRoot) {
      await fs.rm(ctx.tmpRoot, { recursive: true, force: true });
    }
  });

  it("lists runs persisted under workspace directories", async function (ctx) {
    const firstStore = (await import(modulePath)).default;
    const run = firstStore.create({
      id: "run-1",
      sessionId: "run-1",
      userId: "user-1",
      projectId: "project-1",
      prompt: "Explain the project",
      options: {},
      status: "queued",
    });
    const runRoot = Path.join(
      ctx.tmpRoot,
      "users",
      "user-1",
      "workspaces",
      "run-1",
    );
    firstStore.update(run.id, {
      runRoot,
      workspacePath: Path.join(runRoot, "workspace"),
      status: "no_changes",
      changesSummary: [],
    });

    await vi.waitFor(async () => {
      await expect(
        fs.readFile(Path.join(runRoot, "run.json"), "utf8"),
      ).resolves.to.contain('"id": "run-1"');
    });

    vi.resetModules();
    const secondStore = (await import(modulePath)).default;
    const runs = await secondStore.listForProject({
      userId: "user-1",
      projectId: "project-1",
    });

    expect(runs).to.have.length(1);
    expect(runs[0]).to.deep.include({
      id: "run-1",
      status: "no_changes",
      prompt: "Explain the project",
    });
  });
});
