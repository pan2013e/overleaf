import crypto from "node:crypto";
import fs from "node:fs/promises";
import Path from "node:path";
import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import Errors from "../Errors/Errors.js";
import CodexProcessManager from "./CodexProcessManager.mjs";
import CodexRunStore from "./CodexRunStore.mjs";
import ProjectWorkspaceBuilder from "./ProjectWorkspaceBuilder.mjs";
import ProjectDiffBuilder from "./ProjectDiffBuilder.mjs";
import ProjectPatchApplier from "./ProjectPatchApplier.mjs";
import CodexTrajectoryBuilder from "./CodexTrajectoryBuilder.mjs";

const ENFORCED_SANDBOX_MODE = "workspace-write";
const ENFORCED_APPROVAL_POLICY = "on-request";
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "no_changes",
  "failed",
  "cancelled",
  "applied",
  "apply_failed",
]);
const FOLLOW_UP_MODES = new Set(["after_run", "after_next_tool"]);
const INTERRUPT_AFTER_TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
]);
const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  "\\bsudo\\b",
  "\\b(?:docker|podman|kubectl|mount|umount)\\b",
  "\\b(?:ssh|scp|rsync)\\b",
  "\\b(?:curl|wget)\\b[^\\n|;&]*(?:\\||;)\\s*(?:sh|bash|zsh)\\b",
  "\\brm\\s+-[^\\n]*[rf][^\\n]*\\s+/(?:\\s|$)",
  "\\b(?:chmod|chown)\\s+-R\\b[^\\n]*\\s+/",
  "\\b(?:npm|pnpm|yarn)\\s+(?:-g\\s+)?(?:install|add)\\b[^\\n]*\\s+-g\\b",
];

function isRunNotification(notification, threadId, turnId) {
  const params = notification.params ?? {};
  return (
    params.threadId === threadId ||
    params.turnId === turnId ||
    params.thread?.id === threadId ||
    params.turn?.id === turnId ||
    params.item?.threadId === threadId ||
    params.item?.turnId === turnId
  );
}

async function assertAccountReady(client) {
  const accountState = await client.request("account/read", {
    refreshToken: false,
  });
  if (accountState.requiresOpenaiAuth && !accountState.account) {
    throw new Errors.InvalidError("Codex account is not connected");
  }
}

function buildPrompt(userPrompt, workspacePath) {
  return [
    "You are editing an Overleaf LaTeX project exported to this workspace.",
    `Workspace root: ${workspacePath}`,
    "Project file references in the prompt such as @/main.tex refer to paths under this workspace root.",
    "Only modify existing text project files unless explicitly asked otherwise.",
    "If the user explicitly asks for a new text project file, create it inside the workspace using a safe relative path.",
    "Make the requested edit by changing the files in the workspace.",
    "Do not merely describe the edit when a file change is requested.",
    "If shell commands cannot run, report the failure instead of claiming the edit is done.",
    "Do not write, delete, chmod, chown, move, or copy files outside this workspace.",
    "Do not alter host or container configuration, credentials, SSH settings, git remotes, global package state, or system services.",
    "Do not run sudo, docker, podman, mount, ssh/scp/rsync, curl|sh, wget|sh, or destructive absolute-path commands.",
    "If the request requires an unsafe command or out-of-workspace modification, stop and explain the limitation.",
    "Keep changes minimal and explain them briefly.",
    "",
    userPrompt,
  ].join("\n");
}

function cleanString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeChoice(value, allowedValues, defaultValue) {
  const candidate = cleanString(value);
  if (candidate && allowedValues.has(candidate)) {
    return candidate;
  }
  if (allowedValues.has(defaultValue)) {
    return defaultValue;
  }
  return Array.from(allowedValues)[0];
}

function configuredNetworkAccess() {
  return Settings.codex.networkAccess !== false;
}

function configuredBlockedPatterns() {
  const raw = cleanString(Settings.codex.blockedCommandPatterns);
  if (!raw) {
    return DEFAULT_BLOCKED_COMMAND_PATTERNS;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string" && item.trim());
    }
  } catch {}

  return raw
    .split(/\n|\|\|/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptions(options = {}) {
  const model = cleanString(options.model) || cleanString(Settings.codex.model);
  const effort =
    cleanString(options.effort) || cleanString(Settings.codex.reasoningEffort);
  return {
    model,
    effort,
    summary: normalizeChoice(
      options.summary,
      REASONING_SUMMARIES,
      Settings.codex.reasoningSummary || "auto",
    ),
    approvalPolicy: ENFORCED_APPROVAL_POLICY,
    sandboxMode: ENFORCED_SANDBOX_MODE,
    networkAccess: configuredNetworkAccess(),
    autoApply: true,
  };
}

function buildSandboxPolicy(workspacePath) {
  return {
    type: "workspaceWrite",
    writableRoots: [workspacePath],
    networkAccess: configuredNetworkAccess(),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function compileBlockedPatterns() {
  const patterns = [];
  for (const pattern of configuredBlockedPatterns()) {
    try {
      patterns.push(new RegExp(pattern, "i"));
    } catch (error) {
      logger.warn(
        { err: error, pattern },
        "ignoring invalid Codex command block pattern",
      );
    }
  }
  return patterns;
}

function extractExecutedCommands(events) {
  return events
    .filter((event) => event.method === "item/completed")
    .map((event) => event.params?.item)
    .filter((item) => item?.type === "commandExecution")
    .map((item) => item.command)
    .filter((command) => typeof command === "string" && command.trim());
}

function assertNoBlockedCommands(events) {
  const patterns = compileBlockedPatterns();
  for (const command of extractExecutedCommands(events)) {
    const matchedPattern = patterns.find((pattern) => pattern.test(command));
    if (matchedPattern) {
      throw new Errors.InvalidError(
        `Codex attempted to run a blocked command pattern (${matchedPattern.source}).`,
      );
    }
  }
}

function gitStatusPath(line) {
  const raw = line.slice(3).trim();
  const renamedPath = raw.split(/\s+->\s+/).pop();
  return renamedPath?.replace(/^"|"$/g, "") ?? "";
}

function assertWorkspaceChangesAllowed({ gitStatus, changes, manifest }) {
  const allowedRelativePaths = new Set(
    Object.values(manifest.docs).map((doc) => doc.relativePath),
  );
  const modifiedRelativePaths = new Set(
    changes
      .filter((change) => change.type === "modified")
      .map((change) => manifest.docs[change.projectPath]?.relativePath)
      .filter(Boolean),
  );
  const addedRelativePaths = new Set(
    changes
      .filter((change) => change.type === "added")
      .map((change) => change.projectPath.replace(/^\/+/, ""))
      .filter(Boolean),
  );

  for (const line of gitStatus.split("\n").filter(Boolean)) {
    const status = line.slice(0, 2);
    const relativePath = gitStatusPath(line);
    if (
      (status === "??" || status.includes("A")) &&
      addedRelativePaths.has(relativePath)
    ) {
      continue;
    }
    if (
      status.includes("M") &&
      allowedRelativePaths.has(relativePath) &&
      modifiedRelativePaths.has(relativePath)
    ) {
      continue;
    }
    throw new Errors.InvalidError(
      "Codex produced files or modifications outside the editable project documents.",
    );
  }
}

function addOptionalTurnSettings(params, options) {
  if (options.model) {
    params.model = options.model;
  }
  if (options.effort) {
    params.effort = options.effort;
  }
  if (options.summary) {
    params.summary = options.summary;
  }
}

async function startCodexThread({ client, workspace, run }) {
  const threadResult = await client.request("thread/start", {
    cwd: workspace.workspacePath,
    approvalPolicy: run.options.approvalPolicy,
    sandbox: run.options.sandboxMode,
    serviceName: "overleaf_codex",
    ...(run.options.model ? { model: run.options.model } : {}),
  });
  return threadResult.thread.id;
}

function isMissingCodexThreadError(error) {
  return /thread not found/i.test(error?.message || "");
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

async function writeTrajectoryHeader(run, workspace) {
  const trajectoryPath = Path.join(workspace.runRoot, "trajectory.md");
  const lines = [
    `# Codex Run ${run.id}`,
    "",
    `- Project: ${run.projectId}`,
    `- User: ${run.userId}`,
    `- Created: ${run.createdAt.toISOString()}`,
    `- Workspace: ${workspace.workspacePath}`,
    `- Sandbox: ${run.options.sandboxMode}`,
    `- Approval: ${run.options.approvalPolicy}`,
    `- Network access: ${run.options.networkAccess ? "enabled" : "disabled"}`,
    `- Auto apply: ${run.options.autoApply}`,
  ];
  if (run.options.model) {
    lines.push(`- Model: ${run.options.model}`);
  }
  if (run.options.effort) {
    lines.push(`- Reasoning effort: ${run.options.effort}`);
  }
  if (run.options.summary) {
    lines.push(`- Reasoning summary: ${run.options.summary}`);
  }
  lines.push("", "## Prompt", "", run.prompt, "", "## Timeline", "");
  await fs.writeFile(trajectoryPath, `${lines.join("\n")}\n`, "utf8");
  return trajectoryPath;
}

function appendTrajectoryFile(runId, trajectoryEntry) {
  if (!trajectoryEntry) {
    return;
  }
  const run = CodexRunStore.get(runId);
  if (!run?.trajectoryPath) {
    return;
  }
  fs.appendFile(
    run.trajectoryPath,
    CodexTrajectoryBuilder.formatMarkdownEntry(trajectoryEntry),
    "utf8",
  ).catch((error) => {
    logger.warn({ err: error, runId }, "failed to append codex trajectory");
  });
}

function normalizeFollowUpMode(value) {
  return FOLLOW_UP_MODES.has(value) ? value : "after_run";
}

function updatePendingFollowUp(runId, patch) {
  const run = CodexRunStore.get(runId);
  if (!run?.pendingFollowUp) {
    return null;
  }
  return CodexRunStore.update(runId, {
    pendingFollowUp: {
      ...run.pendingFollowUp,
      ...patch,
      updatedAt: new Date(),
    },
  });
}

async function startPendingFollowUp(runId) {
  const run = CodexRunStore.get(runId);
  const pending = run?.pendingFollowUp;
  if (
    !run ||
    !pending ||
    pending.startedRunId ||
    !isTerminalStatus(run.status)
  ) {
    return null;
  }

  updatePendingFollowUp(runId, { status: "starting" });
  try {
    const nextRun = await startRun({
      userId: run.userId,
      projectId: run.projectId,
      prompt: pending.prompt,
      continueRunId: run.id,
      options: pending.options ?? run.options,
    });
    updatePendingFollowUp(runId, {
      status: "started",
      startedRunId: nextRun.id,
    });
    return nextRun;
  } catch (error) {
    logger.error(
      { err: error, runId },
      "failed to start queued Codex follow-up",
    );
    updatePendingFollowUp(runId, {
      status: "failed",
      error: error.message,
    });
    return null;
  }
}

function isRunTurnCompleted(notification, turnId) {
  const params = notification.params ?? {};
  return (
    notification.method === "turn/completed" &&
    (params.turn?.id === turnId ||
      params.turnId === turnId ||
      params.id === turnId)
  );
}

function isToolCompletion(notification) {
  const item = notification.params?.item;
  return (
    notification.method === "item/completed" &&
    INTERRUPT_AFTER_TOOL_ITEM_TYPES.has(item?.type)
  );
}

async function interruptAfterNextTool({ userId, runId }) {
  const run = CodexRunStore.get(runId);
  if (
    !run ||
    isTerminalStatus(run.status) ||
    !run.threadId ||
    !run.turnId ||
    !run.pendingFollowUp
  ) {
    return;
  }

  const { threadId, turnId } = run;
  const client = await CodexProcessManager.getClient(userId);
  let settled = false;
  const cleanup = () => {
    if (settled) {
      return false;
    }
    settled = true;
    client.off("notification", onNotification);
    return true;
  };
  const onNotification = (notification) => {
    if (!isRunNotification(notification, threadId, turnId)) {
      return;
    }
    if (isRunTurnCompleted(notification, turnId)) {
      cleanup();
      updatePendingFollowUp(runId, { status: "queued" });
      return;
    }
    if (!isToolCompletion(notification)) {
      return;
    }
    if (!cleanup()) {
      return;
    }
    updatePendingFollowUp(runId, { status: "interrupting" });
    client.request("turn/interrupt", { threadId, turnId }).catch((error) => {
      logger.warn(
        { err: error, runId },
        "failed to interrupt Codex after next tool call",
      );
      updatePendingFollowUp(runId, { status: "queued" });
    });
  };

  client.on("notification", onNotification);
}

async function startRun({ userId, projectId, prompt, options, continueRunId }) {
  CodexProcessManager.assertEnabled();
  const normalizedOptions = normalizeOptions(options);
  const continuedFromRun = continueRunId
    ? await requireRun({ userId, projectId, runId: continueRunId })
    : null;
  if (continuedFromRun && !isTerminalStatus(continuedFromRun.status)) {
    throw new Errors.InvalidError("Codex session is still running");
  }
  const runId = crypto.randomUUID();
  const run = CodexRunStore.create({
    id: runId,
    sessionId: continuedFromRun?.sessionId ?? continuedFromRun?.id ?? runId,
    continuedFromRunId: continuedFromRun?.id,
    userId: userId.toString(),
    projectId: projectId.toString(),
    prompt,
    options: normalizedOptions,
    status: "queued",
  });

  executeRun(run.id).catch((error) => {
    logger.error({ err: error, runId: run.id }, "codex run failed");
    CodexRunStore.update(run.id, {
      status: "failed",
      error: error.message,
    });
    startPendingFollowUp(run.id).catch((followUpError) => {
      logger.error(
        { err: followUpError, runId: run.id },
        "failed to process queued Codex follow-up after failed run",
      );
    });
  });

  return run;
}

async function executeRun(runId) {
  const run = CodexRunStore.get(runId);
  if (!run) {
    return;
  }

  CodexRunStore.update(runId, { status: "exporting" });
  const workspace = await ProjectWorkspaceBuilder.buildWorkspace({
    userId: run.userId,
    projectId: run.projectId,
    runId,
  });
  const trajectoryPath = await writeTrajectoryHeader(run, workspace);
  CodexRunStore.update(runId, {
    workspacePath: workspace.workspacePath,
    runRoot: workspace.runRoot,
    trajectoryPath,
    manifest: workspace.manifest,
    status: "starting",
  });

  const client = await CodexProcessManager.getClient(run.userId);
  await assertAccountReady(client);

  const continuedFromRun = run.continuedFromRunId
    ? CodexRunStore.get(run.continuedFromRunId)
    : null;
  let threadId = continuedFromRun?.threadId;
  if (!threadId) {
    threadId = await startCodexThread({ client, workspace, run });
  }
  CodexRunStore.update(runId, {
    threadId,
    status: "running",
  });

  let turnId;
  const onNotification = (notification) => {
    if (isRunNotification(notification, threadId, turnId)) {
      const stored = CodexRunStore.appendEvent(runId, notification);
      appendTrajectoryFile(runId, stored?.trajectoryEntry);
    }
  };
  client.on("notification", onNotification);
  try {
    const startTurn = async () => {
      const turnParams = {
        threadId,
        input: [
          {
            type: "text",
            text: buildPrompt(run.prompt, workspace.workspacePath),
          },
        ],
        cwd: workspace.workspacePath,
        approvalPolicy: run.options.approvalPolicy,
        sandboxPolicy: buildSandboxPolicy(workspace.workspacePath),
      };
      addOptionalTurnSettings(turnParams, run.options);
      const turnResult = await client.request("turn/start", turnParams);
      turnId = turnResult.turn.id;
      CodexRunStore.update(runId, { turnId });
    };

    try {
      await startTurn();
    } catch (error) {
      if (!continuedFromRun?.threadId || !isMissingCodexThreadError(error)) {
        throw error;
      }
      logger.warn(
        { err: error, runId, threadId },
        "restarting missing Codex app-server thread for persisted follow-up",
      );
      threadId = await startCodexThread({ client, workspace, run });
      turnId = undefined;
      CodexRunStore.update(runId, { threadId, turnId });
      await startTurn();
    }

    await client.waitForNotification(
      "turn/completed",
      (params) =>
        params.turn?.id === turnId ||
        params.turnId === turnId ||
        params.id === turnId,
      Settings.codex.runTimeoutMs,
    );
  } finally {
    client.off("notification", onNotification);
  }

  CodexRunStore.update(runId, { status: "diffing" });
  const changes = await ProjectDiffBuilder.buildStructuredChanges(workspace);
  const diff = await ProjectDiffBuilder.buildGitDiff(workspace.workspacePath);
  const gitStatus = await ProjectDiffBuilder.buildGitStatus(
    workspace.workspacePath,
  );
  const latestRun = CodexRunStore.get(runId);
  assertNoBlockedCommands(latestRun?.events ?? []);
  const sandboxFailure = CodexTrajectoryBuilder.findSandboxFailure(
    latestRun?.events ?? [],
  );
  if (changes.length === 0 && sandboxFailure) {
    throw new Errors.InvalidError(
      "Codex command sandbox failed inside Docker. The workspace-write sandbox is required for this deployment; enable unprivileged user namespaces or adjust the container runtime so workspace-write can run.",
    );
  }
  const systemError = CodexTrajectoryBuilder.findSystemError(
    latestRun?.events ?? [],
  );
  if (changes.length === 0 && systemError) {
    const message = CodexTrajectoryBuilder.errorMessage(systemError);
    throw new Errors.InvalidError(
      `Codex App Server error while editing the project${message ? `: ${message}` : ""}`,
    );
  }
  assertWorkspaceChangesAllowed({
    gitStatus,
    changes,
    manifest: workspace.manifest,
  });
  if (changes.length === 0) {
    CodexRunStore.update(runId, {
      status: "no_changes",
      changes,
      changesSummary: [],
      diff,
      gitStatus,
    });
    await startPendingFollowUp(runId);
    return;
  }
  CodexRunStore.update(runId, {
    status: "completed",
    changes,
    changesSummary: ProjectDiffBuilder.summarizeChanges(changes),
    diff,
    gitStatus,
  });

  const shouldAutoApply =
    run.options.autoApply &&
    changes.some((change) => ["added", "modified"].includes(change.type));
  if (!shouldAutoApply) {
    await startPendingFollowUp(runId);
    return;
  }

  CodexRunStore.update(runId, { status: "applying" });
  const result = await ProjectPatchApplier.applyChanges({
    projectId: run.projectId,
    userId: run.userId,
    manifest: workspace.manifest,
    changes,
  });
  CodexRunStore.update(runId, {
    status: "applied",
    applied: result.applied,
  });
  await startPendingFollowUp(runId);
}

async function queueFollowUp({
  userId,
  projectId,
  runId,
  prompt,
  mode,
  options,
}) {
  const run = await requireRun({ userId, projectId, runId });
  if (isTerminalStatus(run.status)) {
    return await startRun({
      userId,
      projectId,
      prompt,
      continueRunId: runId,
      options,
    });
  }

  const normalizedMode = normalizeFollowUpMode(mode);
  CodexRunStore.update(runId, {
    pendingFollowUp: {
      prompt,
      mode: normalizedMode,
      options: normalizeOptions(options ?? run.options),
      status:
        normalizedMode === "after_next_tool" ? "waiting_for_tool" : "queued",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  if (normalizedMode === "after_next_tool") {
    interruptAfterNextTool({ userId, runId }).catch((error) => {
      logger.warn(
        { err: error, runId },
        "failed to prepare Codex follow-up interrupt",
      );
      updatePendingFollowUp(runId, { status: "queued" });
    });
  }

  return CodexRunStore.get(runId);
}

async function cancelRun({ userId, projectId, runId }) {
  const run = await requireRun({ userId, projectId, runId });
  if (!run.threadId || !run.turnId) {
    CodexRunStore.update(runId, { status: "cancelled" });
    return CodexRunStore.get(runId);
  }
  const client = await CodexProcessManager.getClient(userId);
  await client.request("turn/interrupt", {
    threadId: run.threadId,
    turnId: run.turnId,
  });
  CodexRunStore.update(runId, { status: "cancelled" });
  return CodexRunStore.get(runId);
}

async function applyRun({ userId, projectId, runId, paths }) {
  const run = await requireRun({ userId, projectId, runId });
  if (run.status !== "completed" && run.status !== "apply_failed") {
    throw new Errors.InvalidError("Codex run is not ready to apply");
  }
  const result = await ProjectPatchApplier.applyChanges({
    projectId,
    userId,
    manifest: run.manifest,
    changes: run.changes,
    paths,
  });
  CodexRunStore.update(runId, {
    status: "applied",
    applied: result.applied,
  });
  return result;
}

async function listRuns({ userId, projectId }) {
  const runs = await CodexRunStore.listForProject({ userId, projectId });
  return runs.filter((run) => !run.archivedAt);
}

function getDefaultOptions() {
  return normalizeOptions();
}

function getSecurityOptions() {
  return {
    approvalPolicy: ENFORCED_APPROVAL_POLICY,
    sandboxMode: ENFORCED_SANDBOX_MODE,
    networkAccess: configuredNetworkAccess(),
  };
}

async function requireRun({ userId, projectId, runId }) {
  const run =
    CodexRunStore.get(runId) ??
    (await CodexRunStore.loadForProject({ userId, projectId, runId }));
  if (!run) {
    throw new Errors.NotFoundError("Codex run not found");
  }
  if (
    run.userId !== userId.toString() ||
    run.projectId !== projectId.toString()
  ) {
    throw new Errors.NotFoundError("Codex run not found");
  }
  return run;
}

async function archiveSession({ userId, projectId, runId }) {
  const run = await requireRun({ userId, projectId, runId });
  const currentSessionId = run.sessionId ?? run.id;
  const runs = await CodexRunStore.listForProject({ userId, projectId });
  const sessionRuns = runs.filter(
    (item) => (item.sessionId ?? item.id) === currentSessionId,
  );
  if (sessionRuns.some((item) => !isTerminalStatus(item.status))) {
    throw new Errors.InvalidError("Codex session is still running");
  }
  const archivedAt = new Date();
  return CodexRunStore.updateMany(
    sessionRuns.map((item) => item.id),
    { archivedAt },
  );
}

export default {
  startRun,
  getRun: CodexRunStore.get,
  listRuns,
  getDefaultOptions,
  getSecurityOptions,
  serializeRun: CodexRunStore.serialize,
  requireRun,
  queueFollowUp,
  cancelRun,
  applyRun,
  archiveSession,
};
