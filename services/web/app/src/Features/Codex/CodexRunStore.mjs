import fs from "node:fs/promises";
import Path from "node:path";
import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import CodexTrajectoryBuilder from "./CodexTrajectoryBuilder.mjs";

const runs = new Map();
const RUN_STORE_FILE = "run.json";
const TERMINAL_STATUSES = new Set([
  "completed",
  "no_changes",
  "failed",
  "cancelled",
  "applied",
  "apply_failed",
]);

function safeUserId(userId) {
  return userId.toString().replace(/[^A-Za-z0-9_.-]/g, "_");
}

function userRoot(userId) {
  return Path.join(Settings.codex.dataDir, "users", safeUserId(userId));
}

function runStorePath(run) {
  if (run?.runRoot) {
    return Path.join(run.runRoot, RUN_STORE_FILE);
  }
  if (run?.userId && run?.id) {
    return Path.join(userRoot(run.userId), "workspaces", run.id, RUN_STORE_FILE);
  }
  return null;
}

function reviveDate(value) {
  if (!value) {
    return value;
  }
  return value instanceof Date ? value : new Date(value);
}

function normalizeLoadedRun(run) {
  const normalized = {
    ...run,
    createdAt: reviveDate(run.createdAt),
    updatedAt: reviveDate(run.updatedAt),
    events: (run.events ?? []).map((event) => ({
      ...event,
      receivedAt: reviveDate(event.receivedAt),
    })),
    trajectory: run.trajectory ?? [],
    pendingFollowUp: run.pendingFollowUp
      ? {
          ...run.pendingFollowUp,
          createdAt: reviveDate(run.pendingFollowUp.createdAt),
          updatedAt: reviveDate(run.pendingFollowUp.updatedAt),
        }
      : undefined,
  };
  if (!TERMINAL_STATUSES.has(normalized.status)) {
    normalized.status = "failed";
    normalized.error =
      normalized.error || "Codex run was interrupted before it finished.";
    normalized.updatedAt = new Date();
  }
  return normalized;
}

async function persistRun(run) {
  const outputPath = runStorePath(run);
  if (!outputPath) {
    return;
  }
  await fs.mkdir(Path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, outputPath);
}

function persistRunSoon(run) {
  persistRun(run).catch((error) => {
    logger.warn({ err: error, runId: run?.id }, "failed to persist Codex run");
  });
}

async function readStoredRun(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return normalizeLoadedRun(JSON.parse(raw));
}

async function loadForProject({ userId, projectId, runId }) {
  const existing = runs.get(runId);
  if (
    existing?.userId === userId.toString() &&
    existing?.projectId === projectId.toString()
  ) {
    return existing;
  }
  const filePath = Path.join(userRoot(userId), "workspaces", runId, RUN_STORE_FILE);
  let run;
  try {
    run = await readStoredRun(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (
    run.userId !== userId.toString() ||
    run.projectId !== projectId.toString()
  ) {
    return null;
  }
  runs.set(run.id, run);
  return run;
}

function create(run) {
  runs.set(run.id, {
    ...run,
    events: [],
    trajectory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return runs.get(run.id);
}

function get(runId) {
  return runs.get(runId);
}

function update(runId, patch) {
  const run = get(runId);
  if (!run) {
    return null;
  }
  Object.assign(run, patch, { updatedAt: new Date() });
  persistRunSoon(run);
  return run;
}

function updateMany(runIds, patch) {
  return runIds
    .map((runId) => update(runId, patch))
    .filter(Boolean);
}

function appendEvent(runId, event) {
  const run = get(runId);
  if (!run) {
    return null;
  }
  const storedEvent = {
    ...event,
    receivedAt: new Date(),
  };
  run.events.push(storedEvent);
  if (run.events.length > 1000) {
    run.events.shift();
  }
  const trajectoryEntry = CodexTrajectoryBuilder.buildEntry(storedEvent);
  if (trajectoryEntry) {
    run.trajectory.push(trajectoryEntry);
    if (run.trajectory.length > 500) {
      run.trajectory.shift();
    }
  }
  run.updatedAt = new Date();
  persistRunSoon(run);
  return { event: storedEvent, trajectoryEntry };
}

async function listForProject({ userId, projectId }) {
  const workspacesRoot = Path.join(userRoot(userId), "workspaces");
  let workspaceDirs = [];
  try {
    workspaceDirs = await fs.readdir(workspacesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await Promise.all(
    workspaceDirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const run = await readStoredRun(
            Path.join(workspacesRoot, entry.name, RUN_STORE_FILE),
          );
          if (
            run.userId === userId.toString() &&
            run.projectId === projectId.toString()
          ) {
            runs.set(run.id, runs.get(run.id) ?? run);
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            logger.warn(
              { err: error, runId: entry.name },
              "failed to load persisted Codex run",
            );
          }
        }
      }),
  );

  return Array.from(runs.values())
    .filter(
      (run) =>
        run.userId === userId.toString() &&
        run.projectId === projectId.toString(),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function serialize(run) {
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    sessionId: run.sessionId,
    continuedFromRunId: run.continuedFromRunId,
    userId: run.userId,
    projectId: run.projectId,
    status: run.status,
    prompt: run.prompt,
    error: run.error,
    options: run.options,
    model: run.options?.model ?? null,
    effort: run.options?.effort ?? null,
    summary: run.options?.summary ?? null,
    approvalPolicy: run.options?.approvalPolicy ?? null,
    sandboxMode: run.options?.sandboxMode ?? null,
    autoApply: run.options?.autoApply ?? null,
    threadId: run.threadId,
    turnId: run.turnId,
    diff: run.diff,
    gitStatus: run.gitStatus,
    changes: run.changesSummary,
    changeCount: run.changesSummary?.length ?? 0,
    applied: run.applied,
    pendingFollowUp: run.pendingFollowUp
      ? {
          prompt: run.pendingFollowUp.prompt,
          mode: run.pendingFollowUp.mode,
          status: run.pendingFollowUp.status,
          startedRunId: run.pendingFollowUp.startedRunId,
          createdAt: run.pendingFollowUp.createdAt,
          updatedAt: run.pendingFollowUp.updatedAt,
        }
      : undefined,
    archivedAt: run.archivedAt,
    trajectory: run.trajectory ?? [],
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export default {
  create,
  get,
  loadForProject,
  update,
  updateMany,
  appendEvent,
  listForProject,
  serialize,
};
