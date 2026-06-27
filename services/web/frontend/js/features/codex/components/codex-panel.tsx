import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import classNames from "classnames";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getJSON, postJSON } from "@/infrastructure/fetch-json";
import { useProjectContext } from "@/shared/context/project-context";
import MaterialIcon from "@/shared/components/material-icon";
import { useFileTreeData } from "@/shared/context/file-tree-data-context";
import { useFileTreePathContext } from "@/features/file-tree/contexts/file-tree-path";
import { useEditorManagerContext } from "@/features/ide-react/context/editor-manager-context";

type CodexRunOptions = {
  model?: string | null;
  effort?: string | null;
  summary?: string | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  networkAccess?: boolean | null;
  autoApply?: boolean | null;
};

type CodexPendingFollowUp = {
  prompt: string;
  mode: SendMode;
  status: string;
  startedRunId?: string;
  createdAt?: string;
  updatedAt?: string;
};

type CodexRun = {
  id: string;
  sessionId?: string;
  continuedFromRunId?: string;
  archivedAt?: string;
  status: string;
  prompt: string;
  error?: string;
  diff?: string;
  gitStatus?: string;
  changes?: CodexChange[];
  changeCount?: number;
  applied?: CodexAppliedChange[];
  pendingFollowUp?: CodexPendingFollowUp;
  trajectory?: CodexTrajectoryEntry[];
  options?: CodexRunOptions;
  createdAt: string;
  updatedAt: string;
};

type CodexChange = {
  type: string;
  projectPath: string;
  docId: string;
};

type CodexAppliedChange = {
  projectPath: string;
  docId: string;
};

type CodexTrajectoryEntry = {
  id: string;
  time: string;
  method?: string;
  kind: string;
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
  severity?: string;
  isFinalMessage?: boolean;
  viewKind?: "working";
};

type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
};

type CodexOptionsResponse = {
  defaults: CodexRunOptions;
  security?: CodexSecurityOptions;
  reasoningSummaries: string[];
  reasoningEfforts: string[];
};

type CodexAccountState = {
  account?: unknown;
  requiresOpenaiAuth?: boolean;
  rateLimits?: unknown;
  rateLimitsError?: string;
};

type CodexSecurityOptions = {
  approvalPolicy: string;
  sandboxMode: string;
  networkAccess?: boolean;
};

type CodexEventResponse = {
  events: unknown[];
  trajectory: CodexTrajectoryEntry[];
};

type ActiveView = "activity" | "diff";
type SendMode = "after_run" | "after_next_tool";
type CodexProjectFile = {
  id: string;
  name: string;
  path: string;
  type: "doc" | "fileRef";
};
type FileReferenceQuery = {
  start: number;
  end: number;
  query: string;
  key: string;
};
type SelectionContext = {
  id: string;
  source: string;
  fileName?: string;
  location?: string;
  text: string;
};

type CodexDiffLine = {
  type: "add" | "delete" | "context" | "meta";
  oldLine?: number;
  newLine?: number;
  content: string;
};

type CodexDiffHunk = {
  header: string;
  lines: CodexDiffLine[];
};

type CodexDiffFile = {
  id: string;
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  hunks: CodexDiffHunk[];
};

const VIEW_CONFIG: Record<ActiveView, { icon: string; label: string }> = {
  activity: { icon: "timeline", label: "Activity" },
  diff: { icon: "difference", label: "Changes" },
};

const SEND_MODE_CONFIG: Record<
  SendMode,
  { description: string; icon: string; label: string; status: string }
> = {
  after_run: {
    description: "Send when the current run finishes.",
    icon: "schedule",
    label: "Queue",
    status: "Queued after run",
  },
  after_next_tool: {
    description: "Interrupt after the next tool or command completes.",
    icon: "low_priority",
    label: "After tool",
    status: "Waiting for next tool",
  },
};

const SLASH_COMMANDS = [
  {
    command: "/status",
    description: "Show run and security status.",
  },
  {
    command: "/model",
    description: "Show or set the model.",
  },
  {
    command: "/effort",
    description: "Show or set reasoning effort.",
  },
  {
    command: "/summary",
    description: "Show or set reasoning summary.",
  },
  {
    command: "/new",
    description: "Start a fresh session draft.",
  },
  {
    command: "/help",
    description: "List Codex commands.",
  },
];

const FALLBACK_OPTIONS: Required<CodexRunOptions> = {
  model: "",
  effort: "medium",
  summary: "auto",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  networkAccess: true,
  autoApply: true,
};

const FALLBACK_SECURITY: CodexSecurityOptions = {
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  networkAccess: true,
};

const REASONING_EFFORTS = ["minimal", "low", "medium", "high"];
const REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"];
const SLASH_COMMANDS_WITH_ARGUMENTS = new Set([
  "/model",
  "/effort",
  "/summary",
]);
const SELECTION_CONTEXT_LIMIT = 4000;
const ACTIVITY_FOLD_THRESHOLD = 10;

const MARKDOWN_PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "#text",
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  ALLOWED_ATTR: [
    "class",
    "data-codex-project-path",
    "href",
    "rel",
    "target",
    "title",
  ],
};

const MARKDOWN_INLINE_PURIFY_CONFIG = {
  ALLOWED_TAGS: ["#text", "a", "br", "code", "del", "em", "strong"],
  ALLOWED_ATTR: ["data-codex-project-path", "href", "rel", "target", "title"],
};

const LINK_REL = "noreferrer noopener";
const LINK_TARGET = "_blank";
const ALLOWED_MARKDOWN_LINK_PROTOCOLS = new Set(["http", "https", "mailto"]);

type MarkedToken = Record<string, any>;

function sanitizeHtml(
  value: string,
  config:
    | typeof MARKDOWN_PURIFY_CONFIG
    | typeof MARKDOWN_INLINE_PURIFY_CONFIG = MARKDOWN_PURIFY_CONFIG,
) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") {
      const element = node as Element;
      const href = element.getAttribute("href");
      const projectPath = projectPathFromMarkdownHref(href);
      if (projectPath) {
        element.setAttribute("href", "#");
        element.setAttribute("data-codex-project-path", projectPath);
        element.removeAttribute("rel");
        element.removeAttribute("target");
        return;
      }
      if (!isSafeMarkdownHref(href)) {
        element.removeAttribute("href");
        element.removeAttribute("rel");
        element.removeAttribute("target");
        element.setAttribute("data-codex-disabled-link", "true");
        return;
      }
      element.setAttribute("rel", LINK_REL);
      element.setAttribute("target", LINK_TARGET);
    }
  });

  try {
    return DOMPurify.sanitize(value, config);
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

function isSafeMarkdownHref(href?: string | null) {
  const value = href?.trim();
  if (!value) {
    return false;
  }
  if (value.startsWith("#")) {
    return true;
  }
  const protocolMatch = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (!protocolMatch) {
    return false;
  }
  return ALLOWED_MARKDOWN_LINK_PROTOCOLS.has(protocolMatch[1].toLowerCase());
}

function projectPathFromMarkdownHref(href?: string | null) {
  const raw = href?.trim();
  if (!raw || raw.startsWith("#")) {
    return null;
  }
  const protocolMatch = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (
    protocolMatch &&
    !["file", "sandbox"].includes(protocolMatch[1].toLowerCase())
  ) {
    return null;
  }

  let value = raw.replace(/^sandbox:/i, "");
  if (/^file:/i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      value = value.replace(/^file:\/*/i, "/");
    }
  }
  value = value.split(/[?#]/)[0].replace(/:\d+(?::\d+)?$/, "");
  try {
    value = decodeURIComponent(value);
  } catch {}

  const workspaceMarker = "/workspace/";
  const workspaceIndex = value.lastIndexOf(workspaceMarker);
  if (workspaceIndex >= 0) {
    value = value.slice(workspaceIndex + workspaceMarker.length);
  }
  value = value.replace(/^\.?\//, "").replace(/^\/+/, "");
  if (
    !value ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    /[\u0000-\u001f]/.test(value) ||
    value.startsWith("project/") ||
    value.startsWith("user/")
  ) {
    return null;
  }
  return `/${value}`;
}

function normalizeLanguage(value?: string) {
  const language =
    value
      ?.trim()
      .split(/\s+/)[0]
      .replace(/[^A-Za-z0-9_+#.-]/g, "")
      .slice(0, 32) || "";
  return language || "text";
}

const LANGUAGE_ALIASES: Record<string, string> = {
  cplusplus: "cpp",
  dockerfile: "docker",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  tex: "latex",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};

function canonicalLanguage(value?: string) {
  const language = normalizeLanguage(value).toLowerCase();
  return LANGUAGE_ALIASES[language] ?? language;
}

function detectCodeLanguage(value: string, declaredLanguage?: string) {
  if (declaredLanguage?.trim()) {
    return canonicalLanguage(declaredLanguage);
  }

  const text = value.trim();
  if (!text) {
    return "text";
  }

  if (
    /^diff --git\b/m.test(text) ||
    /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(text)
  ) {
    return "diff";
  }
  try {
    JSON.parse(text);
    if (/^[{[]/.test(text)) {
      return "json";
    }
  } catch {}
  if (/\\(documentclass|usepackage|begin|end|section|cite|ref)\b/.test(text)) {
    return "latex";
  }
  if (/^\s*(FROM|RUN|COPY|CMD|ENTRYPOINT|ENV|ARG|WORKDIR)\b/im.test(text)) {
    return "docker";
  }
  if (/^\s*[\w.-]+:\s*(?:$|[#\w"'[\]{|-])/m.test(text) && !/[;{}]/.test(text)) {
    return "yaml";
  }
  if (
    /^#!.*\b(?:bash|sh|zsh)\b/.test(text) ||
    /^\s*(?:npm|pnpm|yarn|docker|git|curl|cd|ls|mkdir|rm|cat|sed|rg|grep|export)\b/m.test(
      text,
    )
  ) {
    return "bash";
  }
  if (
    /(^|\n)\s*(?:def|class)\s+\w+.*:/.test(text) ||
    /\b(?:from|import)\s+\w+/.test(text) ||
    /\bprint\(/.test(text)
  ) {
    return "python";
  }
  if (
    /\b(?:interface|type)\s+\w+\b/.test(text) ||
    (/\b(?:import|export|const|let|function|return)\b/.test(text) &&
      /:\s*(?:string|number|boolean|unknown|any)\b/.test(text))
  ) {
    return "typescript";
  }
  if (
    /\b(?:const|let|var|function|console\.|=>|import\s+.*from)\b/.test(text)
  ) {
    return "javascript";
  }
  if (/^\s*<\??[\w!]/.test(text)) {
    return "html";
  }
  if (/^\s*[.#]?[A-Za-z0-9_-]+\s*\{/.test(text)) {
    return "css";
  }
  return "text";
}

function fencedCode(value: string, language = "text") {
  const longestFence = Math.max(
    2,
    ...(value.match(/`{3,}/g)?.map((match) => match.length) ?? []),
  );
  const fence = "`".repeat(longestFence + 1);
  return `${fence}${normalizeLanguage(language)}\n${value}\n${fence}`;
}

function MarkdownInline({ value }: { value: string }) {
  const html = useMemo(
    () =>
      sanitizeHtml(
        marked.parseInline(value, {
          breaks: true,
          gfm: true,
        }) as string,
        MARKDOWN_INLINE_PURIFY_CONFIG,
      ),
    [value],
  );

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function SanitizedMarkdownHtml({ html }: { html: string }) {
  const sanitizedHtml = useMemo(() => sanitizeHtml(html), [html]);

  return <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
}

function CodeBlock({ language, value }: { language?: string; value: string }) {
  const detectedLanguage = detectCodeLanguage(value, language);
  const syntaxLanguage =
    detectedLanguage === "text" ? undefined : detectedLanguage;

  return (
    <SyntaxHighlighter
      className="codex-code-block"
      language={syntaxLanguage}
      useInlineStyles={false}
    >
      {value.replace(/\n$/, "")}
    </SyntaxHighlighter>
  );
}

function MarkdownTokens({ tokens }: { tokens: MarkedToken[] }) {
  return <>{tokens.map((token, index) => renderMarkdownToken(token, index))}</>;
}

function renderHeading(token: MarkedToken, key: string) {
  const content = <MarkdownInline value={token.text || ""} />;
  switch (Math.min(Math.max(Number(token.depth) || 2, 1), 6)) {
    case 1:
      return <h1 key={key}>{content}</h1>;
    case 2:
      return <h2 key={key}>{content}</h2>;
    case 3:
      return <h3 key={key}>{content}</h3>;
    case 4:
      return <h4 key={key}>{content}</h4>;
    case 5:
      return <h5 key={key}>{content}</h5>;
    default:
      return <h6 key={key}>{content}</h6>;
  }
}

function renderMarkdownToken(token: MarkedToken, index: number) {
  const key = `${token.type || "token"}-${index}`;

  switch (token.type) {
    case "space":
      return null;
    case "heading":
      return renderHeading(token, key);
    case "paragraph":
    case "text":
      return (
        <p key={key}>
          <MarkdownInline value={token.text || token.raw || ""} />
        </p>
      );
    case "code":
      return (
        <CodeBlock key={key} language={token.lang} value={token.text || ""} />
      );
    case "blockquote":
      return (
        <blockquote key={key}>
          {token.tokens?.length ? (
            <MarkdownTokens tokens={token.tokens} />
          ) : (
            <p>
              <MarkdownInline value={token.text || ""} />
            </p>
          )}
        </blockquote>
      );
    case "list": {
      const items = (token.items || []).map(
        (item: MarkedToken, itemIndex: number) => {
          const itemTokens = item.tokens?.length
            ? item.tokens
            : [{ type: "text", text: item.text || "" }];
          return (
            <li key={`${key}-item-${itemIndex}`}>
              <MarkdownTokens tokens={itemTokens} />
            </li>
          );
        },
      );
      return token.ordered ? (
        <ol key={key} start={token.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "hr":
      return <hr key={key} />;
    case "table":
      return (
        <SanitizedMarkdownHtml
          key={key}
          html={(marked as any).parser([token], {
            breaks: true,
            gfm: true,
          })}
        />
      );
    default:
      if (!token.raw || token.type === "html") {
        return null;
      }
      return (
        <p key={key}>
          <MarkdownInline value={token.raw} />
        </p>
      );
  }
}

function MarkdownBlock({
  className,
  compact = false,
  value,
}: {
  className?: string;
  compact?: boolean;
  value: string;
}) {
  const tokens = useMemo(
    () =>
      marked.lexer(value, {
        breaks: true,
        gfm: true,
      }) as MarkedToken[],
    [value],
  );

  return (
    <div
      className={classNames(
        "codex-markdown",
        { "codex-markdown-compact": compact },
        className,
      )}
    >
      <MarkdownTokens tokens={tokens} />
    </div>
  );
}

function statusIsTerminal(status?: string) {
  return [
    "completed",
    "no_changes",
    "failed",
    "cancelled",
    "applied",
    "apply_failed",
  ].includes(status || "");
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function compactDate(value?: string) {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function displayStatus(status?: string) {
  if (!status) {
    return "idle";
  }
  return status.replace(/_/g, " ");
}

function runTitle(run: CodexRun) {
  const firstLine = run.prompt.split("\n").find(Boolean) || "Codex session";
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}...` : firstLine;
}

function pendingFollowUpLabel(pending?: CodexPendingFollowUp) {
  if (!pending) {
    return "";
  }
  if (pending.startedRunId) {
    return "Started follow-up";
  }
  switch (pending.status) {
    case "waiting_for_tool":
      return SEND_MODE_CONFIG.after_next_tool.status;
    case "interrupting":
      return "Inserting after tool";
    case "starting":
      return "Starting follow-up";
    case "failed":
      return "Follow-up failed";
    default:
      return SEND_MODE_CONFIG[pending.mode]?.status ?? "Queued";
  }
}

function slashCommandQuery(value: string) {
  const match = value.match(/^\/([a-z-]*)$/i);
  return match ? match[1].toLowerCase() : null;
}

function parseSlashCommand(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return {
    command: `/${match[1].toLowerCase()}`,
    argument: match[2]?.trim() ?? "",
  };
}

function changeIcon(change: CodexChange) {
  switch (change.type) {
    case "added":
    case "created":
      return "add";
    case "deleted":
    case "removed":
      return "delete";
    case "renamed":
      return "drive_file_rename_outline";
    default:
      return "edit_document";
  }
}

function changeSummary(run?: CodexRun | null) {
  const count = run?.changeCount ?? run?.changes?.length ?? 0;
  if (!count) {
    return "No changes";
  }
  return `${count} change${count === 1 ? "" : "s"}`;
}

function changeSummaryForChanges(changes: CodexChange[]) {
  const count = changes.length;
  if (!count) {
    return "No changes";
  }
  return `${count} change${count === 1 ? "" : "s"}`;
}

function formatDuration(start?: string, end?: string) {
  if (!start || !end) {
    return "";
  }
  const elapsedMs = Math.max(
    0,
    new Date(end).getTime() - new Date(start).getTime(),
  );
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function completionSummary(run?: CodexRun | null) {
  const duration = formatDuration(run?.createdAt, run?.updatedAt);
  return duration ? `Completed in ${duration}` : "Completed";
}

function sessionId(run: CodexRun) {
  return run.sessionId || run.id;
}

function normalizeProjectPath(value?: string | null) {
  const projectPath = projectPathFromMarkdownHref(value) ?? value ?? "";
  return projectPath.replace(/^\/+/, "").trim();
}

function flattenProjectFiles(folder: any, parentPath = ""): CodexProjectFile[] {
  if (!folder) {
    return [];
  }
  const currentPath =
    !folder.name || folder.name === "rootFolder"
      ? parentPath
      : [parentPath, folder.name].filter(Boolean).join("/");
  const prefix = currentPath ? `${currentPath}/` : "";
  const docs = (folder.docs ?? []).map((doc: any) => ({
    id: doc._id,
    name: doc.name,
    path: `${prefix}${doc.name}`,
    type: "doc" as const,
  }));
  const fileRefs = (folder.fileRefs ?? []).map((fileRef: any) => ({
    id: fileRef._id,
    name: fileRef.name,
    path: `${prefix}${fileRef.name}`,
    type: "fileRef" as const,
  }));
  const nested = (folder.folders ?? []).flatMap((subFolder: any) =>
    flattenProjectFiles(subFolder, currentPath),
  );
  return [...docs, ...fileRefs, ...nested];
}

function projectFilePathById(
  projectFiles: CodexProjectFile[],
  entityId?: string | null,
) {
  if (!entityId) {
    return undefined;
  }
  return projectFiles.find((file) => file.id === entityId)?.path;
}

function sanitizeSelectedContextPromptLabels(
  value: string,
  projectFiles: CodexProjectFile[],
) {
  if (!value || !projectFiles.length) {
    return value;
  }
  return value.replace(
    /file:\s*([^,\n]+?)(?=,\s*location:|,\s*source:|\n|$)/gi,
    (match, label) => {
      const cleaned = cleanSelectionFileName(label, projectFiles);
      return cleaned ? `file: ${cleaned}` : match;
    },
  );
}

function aggregateSessionChanges(runs: CodexRun[]) {
  const changesByKey = new Map<string, CodexChange>();
  for (const item of runs) {
    for (const change of item.changes ?? []) {
      changesByKey.set(`${change.projectPath}:${change.type}`, change);
    }
  }
  return Array.from(changesByKey.values());
}

function aggregateSessionDiff(runs: CodexRun[]) {
  return runs
    .map((item) => item.diff?.trim())
    .filter(Boolean)
    .join("\n\n");
}

function fileReferenceQuery(
  value: string,
  cursor: number,
): FileReferenceQuery | null {
  const beforeCursor = value.slice(0, cursor);
  const start = beforeCursor.lastIndexOf("@");
  if (start < 0) {
    return null;
  }
  if (start > 0 && !/[\s([{,]/.test(beforeCursor[start - 1])) {
    return null;
  }
  const token = beforeCursor.slice(start + 1);
  if (/[\s`]/.test(token)) {
    return null;
  }
  return {
    start,
    end: cursor,
    query: token.replace(/^\/+/, "").toLowerCase(),
    key: `${start}:${token}`,
  };
}

function scoreFileReference(file: CodexProjectFile, query: string) {
  if (!query) {
    return 1;
  }
  const path = file.path.toLowerCase();
  const name = file.name.toLowerCase();
  if (path === query || path === query.replace(/^\/+/, "")) {
    return 100;
  }
  if (name.startsWith(query)) {
    return 80;
  }
  if (path.startsWith(query)) {
    return 70;
  }
  if (name.includes(query)) {
    return 50;
  }
  if (path.includes(query)) {
    return 40;
  }
  return 0;
}

function elementFromNode(node: Node | null) {
  if (!node) {
    return null;
  }
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function selectionSourceLabel(element: Element | null) {
  if (!element) {
    return "Selection";
  }
  if (
    element.closest(
      ".pdf-viewer, .pdfjs-viewer, .pdfjs, .pdf-container, .pdf-preview, .pdf-viewer-pane",
    )
  ) {
    return "PDF selection";
  }
  if (
    element.closest(
      ".cm-editor, .cm-content, .source-editor, .ace_editor, textarea",
    )
  ) {
    return "Editor selection";
  }
  return "Selection";
}

function trimSelectionText(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= SELECTION_CONTEXT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, SELECTION_CONTEXT_LIMIT).trimEnd()}\n\n[Selection truncated]`;
}

function visibleText(element: Element | null) {
  return element?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function cleanSelectionFileName(
  value: string | undefined | null,
  projectFiles: CodexProjectFile[],
) {
  const label = value?.replace(/^\/+/, "").replace(/\s+/g, " ").trim();
  if (!label) {
    return undefined;
  }
  const exact = projectFiles.find(
    (file) => file.path === label || file.name === label,
  );
  if (exact) {
    return exact.path;
  }
  const contained = projectFiles.find(
    (file) => label.includes(file.path) || label.includes(file.name),
  );
  if (contained) {
    return contained.path;
  }
  if (
    label.length > 120 ||
    /more_vert|menu|description|source editor/i.test(label)
  ) {
    return undefined;
  }
  return label;
}

function inferSelectionFileName(
  element: Element | null,
  {
    currentFilePath,
    projectFiles,
  }: {
    currentFilePath?: string | null;
    projectFiles: CodexProjectFile[];
  },
) {
  const attributeElement = element?.closest(
    "[data-file-name], [data-filename], [data-path], [data-doc-path]",
  );
  const attributeValue =
    attributeElement?.getAttribute("data-file-name") ||
    attributeElement?.getAttribute("data-filename") ||
    attributeElement?.getAttribute("data-doc-path") ||
    attributeElement?.getAttribute("data-path");
  const attributeFileName = cleanSelectionFileName(attributeValue, projectFiles);
  if (attributeFileName) {
    return attributeFileName;
  }
  if (currentFilePath) {
    return currentFilePath;
  }

  const selectedFile =
    document.querySelector(".file-tree .selected, .file-tree .active") ||
    document.querySelector(".ide-react-editor-tab.active") ||
    document.querySelector(".editor-tabs .active") ||
    document.querySelector("[role='tab'][aria-selected='true']");
  return cleanSelectionFileName(visibleText(selectedFile), projectFiles);
}

function inferSelectionLocation(element: Element | null) {
  if (!element) {
    return undefined;
  }
  const pageElement = element.closest("[data-page-number], .page");
  const pageNumber =
    pageElement?.getAttribute("data-page-number") ||
    pageElement?.getAttribute("data-page") ||
    pageElement?.getAttribute("aria-label")?.match(/\d+/)?.[0];
  if (pageNumber) {
    return `page ${pageNumber}`;
  }

  const lineElement = element.closest(".cm-line, .ace_line");
  if (lineElement?.parentElement) {
    const siblings = Array.from(lineElement.parentElement.children).filter(
      (child) =>
        child.classList.contains("cm-line") ||
        child.classList.contains("ace_line"),
    );
    const index = siblings.indexOf(lineElement);
    if (index >= 0) {
      return `around line ${index + 1}`;
    }
  }
  return undefined;
}

function selectionContextId() {
  return `selection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readExternalSelectionContext(
  codexPanel: HTMLElement | null,
  context: {
    currentFilePath?: string | null;
    projectFiles: CodexProjectFile[];
  },
): SelectionContext | null {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLInputElement
  ) {
    if (codexPanel?.contains(activeElement)) {
      return null;
    }
    const start = activeElement.selectionStart ?? 0;
    const end = activeElement.selectionEnd ?? 0;
    if (end > start) {
      const text = trimSelectionText(activeElement.value.slice(start, end));
      const lineNumber = activeElement.value.slice(0, start).split("\n").length;
      return text
        ? {
            id: selectionContextId(),
            source: selectionSourceLabel(activeElement),
            fileName: inferSelectionFileName(activeElement, context),
            location: `around line ${lineNumber}`,
            text,
          }
        : null;
    }
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return null;
  }
  const element =
    elementFromNode(selection.anchorNode) ??
    elementFromNode(selection.focusNode);
  if (element && codexPanel?.contains(element)) {
    return null;
  }
  const text = trimSelectionText(selection.toString());
  return text
    ? {
        id: selectionContextId(),
        source: selectionSourceLabel(element),
        fileName: inferSelectionFileName(element, context),
        location: inferSelectionLocation(element),
        text,
      }
    : null;
}

function selectionContextTitle(context: SelectionContext) {
  return [context.fileName, context.location].filter(Boolean).join(" · ");
}

function selectedContextPromptBlock(context: SelectionContext, index: number) {
  const source = [
    context.source,
    context.fileName ? `file: ${context.fileName}` : "",
    context.location ? `location: ${context.location}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `[Selected Context ${index + 1}] ${source}`,
    fencedCode(context.text, "text"),
  ].join("\n\n");
}

function buildPromptWithSelectedContexts(
  value: string,
  selectedContexts: SelectionContext[],
) {
  const trimmedPrompt = value.trim();
  if (!selectedContexts.length) {
    return trimmedPrompt;
  }
  return [
    trimmedPrompt,
    "Use the following selected context where relevant:",
    ...selectedContexts.map(selectedContextPromptBlock),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stripDiffPathPrefix(value: string) {
  const path = value.trim().split(/\s+/)[0] || "";
  if (path === "/dev/null") {
    return path;
  }
  return path.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(diff?: string): CodexDiffFile[] {
  if (!diff?.trim()) {
    return [];
  }
  const files: CodexDiffFile[] = [];
  let currentFile: CodexDiffFile | null = null;
  let currentHunk: CodexDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = () => {
    if (!currentFile) {
      currentFile = {
        id: `diff-${files.length}`,
        oldPath: "Changes",
        newPath: "Changes",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(currentFile);
    }
    return currentFile;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const [, oldPath = "Changes", newPath = "Changes"] =
        line.match(/^diff --git\s+(.+?)\s+(.+)$/) ?? [];
      currentFile = {
        id: `${files.length}:${line}`,
        oldPath: stripDiffPathPrefix(oldPath),
        newPath: stripDiffPathPrefix(newPath),
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      currentHunk = null;
      files.push(currentFile);
      continue;
    }
    if (line.startsWith("new file mode")) {
      ensureFile().status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      ensureFile().status = "deleted";
      continue;
    }
    if (line.startsWith("--- ")) {
      const file = ensureFile();
      file.oldPath = stripDiffPathPrefix(line.slice(4));
      if (file.oldPath === "/dev/null") {
        file.status = "added";
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const file = ensureFile();
      file.newPath = stripDiffPathPrefix(line.slice(4));
      if (file.newPath === "/dev/null") {
        file.status = "deleted";
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const file = ensureFile();
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      currentHunk = { header: line, lines: [] };
      file.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        newLine,
        content: line.slice(1),
      });
      ensureFile().additions += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "delete",
        oldLine,
        content: line.slice(1),
      });
      ensureFile().deletions += 1;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        oldLine,
        newLine,
        content: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    currentHunk.lines.push({ type: "meta", content: line });
  }

  return files.filter((file) => file.hunks.length > 0);
}

function usageValue(value: any) {
  if (value == null) {
    return "";
  }
  if (typeof value === "number") {
    return `${value}`;
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function formatUsageLimits(rateLimits: unknown) {
  if (!rateLimits || typeof rateLimits !== "object") {
    return "Usage limits: unavailable";
  }
  const lines: string[] = [];
  const visit = (value: any, label: string) => {
    if (!value || typeof value !== "object" || lines.length >= 4) {
      return;
    }
    const remaining =
      value.remaining ?? value.remaining_requests ?? value.remainingTokens;
    const limit = value.limit ?? value.total ?? value.quota;
    const used = value.used ?? value.used_requests ?? value.usedTokens;
    if (remaining != null || limit != null || used != null) {
      lines.push(
        `${label}: ${[
          remaining != null ? `${usageValue(remaining)} remaining` : "",
          limit != null ? `${usageValue(limit)} limit` : "",
          used != null ? `${usageValue(used)} used` : "",
        ]
          .filter(Boolean)
          .join(", ")}`,
      );
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, label ? `${label}.${key}` : key);
    }
  };
  visit(rateLimits, "usage");
  return lines.length ? lines.join(" · ") : "Usage limits: connected";
}

function entryMeta(entry: CodexTrajectoryEntry) {
  return [
    entry.viewKind === "working"
      ? ""
      : entry.status
        ? displayStatus(entry.status)
        : "",
    entry.exitCode != null ? `exit ${entry.exitCode}` : "",
    compactDate(entry.time),
  ]
    .filter(Boolean)
    .join(" · ");
}

function normalizeDetail(detail?: string, kind?: string) {
  const normalized = detail?.trim().replace(/\n{3,}/g, "\n\n") ?? "";
  if (kind === "reasoning" && ["[]", "{}", "null"].includes(normalized)) {
    return "";
  }
  return normalized;
}

function isNarrativeEntry(entry: CodexTrajectoryEntry) {
  return ["agentMessage", "reasoning", "userMessage"].includes(entry.kind);
}

function isStartedEntry(entry: CodexTrajectoryEntry) {
  return entry.method === "item/started" || entry.title.endsWith("started");
}

function isCompletedEntry(entry: CodexTrajectoryEntry) {
  return (
    entry.method === "item/completed" ||
    entry.title.endsWith("completed") ||
    (entry.kind === "commandExecution" && entry.status !== "inProgress")
  );
}

function activityTitle(entry: CodexTrajectoryEntry) {
  if (entry.viewKind === "working") {
    return "Working";
  }
  if (entry.severity === "error" || entry.kind === "error") {
    return entry.title || "Error";
  }
  switch (entry.kind) {
    case "agentMessage":
      return "Assistant";
    case "reasoning":
      return "Reasoning";
    case "commandExecution":
      return "Command";
    case "mcpToolCall":
      return "Tool";
    default:
      return entry.title;
  }
}

function previewText(value: string, maxLength = 180) {
  const normalized = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>~[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Details";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function CollapsibleEntryDetail({
  children,
  label,
  preview,
}: {
  children: ReactNode;
  label: string;
  preview: string;
}) {
  return (
    <details className="codex-entry-details">
      <summary>
        <span className="codex-entry-details-label">{label}</span>
        <span className="codex-entry-details-preview">{preview}</span>
        <MaterialIcon type="expand_more" />
      </summary>
      <div className="codex-entry-details-body">{children}</div>
    </details>
  );
}

function EntryDetail({
  entry,
  isFinalMessage = false,
}: {
  entry: CodexTrajectoryEntry;
  isFinalMessage?: boolean;
}) {
  const detail = normalizeDetail(entry.detail, entry.kind);
  if (entry.viewKind === "working") {
    return entry.command ? (
      <MarkdownBlock
        className="codex-command-markdown"
        compact
        value={fencedCode(entry.command, "bash")}
      />
    ) : null;
  }
  if (entry.command) {
    return (
      <CollapsibleEntryDetail
        label="Command"
        preview={previewText(entry.command || detail || "Command details")}
      >
        <MarkdownBlock
          className="codex-command-markdown"
          compact
          value={fencedCode(entry.command, "bash")}
        />
        {detail ? (
          <MarkdownBlock
            className="codex-output-markdown"
            compact
            value={fencedCode(detail, "text")}
          />
        ) : null}
      </CollapsibleEntryDetail>
    );
  }
  if (!detail) {
    return null;
  }
  if (entry.kind === "reasoning") {
    return (
      <CollapsibleEntryDetail label="Reasoning" preview={previewText(detail)}>
        <MarkdownBlock compact value={detail} />
      </CollapsibleEntryDetail>
    );
  }
  return (
    <MarkdownBlock
      className={classNames({
        "codex-message-text": isNarrativeEntry(entry),
        "codex-final-message": isFinalMessage,
      })}
      compact
      value={detail}
    />
  );
}

function ActivityEntryView({
  entry,
  index,
}: {
  entry: CodexTrajectoryEntry;
  index: number;
}) {
  const isFinalMessage = entry.isFinalMessage === true;
  return (
    <div
      key={`${entry.id}-${index}`}
      className={classNames("codex-trajectory-entry", {
        error: entry.severity === "error",
        final: isFinalMessage,
        user: entry.kind === "userMessage",
        working: entry.viewKind === "working",
      })}
    >
      <MaterialIcon type={isFinalMessage ? "task_alt" : iconForEntry(entry)} />
      <div>
        <div className="codex-trajectory-title">
          <strong>
            {isFinalMessage ? "Final answer" : activityTitle(entry)}
            {entry.viewKind === "working" ? (
              <span className="codex-working-ellipsis" aria-hidden="true">
                ...
              </span>
            ) : null}
          </strong>
          <span>{entryMeta(entry)}</span>
        </div>
        <EntryDetail entry={entry} isFinalMessage={isFinalMessage} />
      </div>
    </div>
  );
}

function RunActivityGroup({
  entries,
  run,
}: {
  entries: CodexTrajectoryEntry[];
  run: CodexRun;
}) {
  const promptEntry = entries.find((entry) => entry.kind === "userMessage");
  const codexEntries = entries.filter((entry) => entry.kind !== "userMessage");
  const shouldFold =
    statusIsTerminal(run.status) && codexEntries.length > ACTIVITY_FOLD_THRESHOLD;
  const finalEntries = codexEntries.filter((entry) => entry.isFinalMessage);
  const foldedEntries = shouldFold
    ? codexEntries.filter((entry) => !entry.isFinalMessage)
    : [];
  const visibleEntries = shouldFold
    ? finalEntries.length
      ? finalEntries
      : codexEntries.slice(-1)
    : codexEntries;

  return (
    <div className="codex-run-activity-group">
      {promptEntry ? (
        <ActivityEntryView entry={promptEntry} index={0} />
      ) : null}
      {shouldFold && foldedEntries.length ? (
        <details className="codex-activity-fold">
          <summary>
            <MaterialIcon type="history" />
            <span className="codex-activity-fold-title">
              {completionSummary(run)}
            </span>
            <small>
              {foldedEntries.length} intermediate event
              {foldedEntries.length === 1 ? "" : "s"}
            </small>
            <MaterialIcon type="expand_more" />
          </summary>
          <div className="codex-activity-fold-body">
            {foldedEntries.map((entry, index) => (
              <ActivityEntryView
                key={`${entry.id}-${index}`}
                entry={entry}
                index={index}
              />
            ))}
          </div>
        </details>
      ) : null}
      {visibleEntries.map((entry, index) => (
        <ActivityEntryView
          key={`${entry.id}-${index}`}
          entry={entry}
          index={index}
        />
      ))}
    </div>
  );
}

function DiffLineView({ line }: { line: CodexDiffLine }) {
  return (
    <div className={classNames("codex-diff-line", `line-${line.type}`)}>
      <span className="codex-diff-line-number">{line.oldLine ?? ""}</span>
      <span className="codex-diff-line-number">{line.newLine ?? ""}</span>
      <span className="codex-diff-line-marker">
        {line.type === "add"
          ? "+"
          : line.type === "delete"
            ? "-"
            : line.type === "meta"
              ? "\\"
              : ""}
      </span>
      <code>{line.content || " "}</code>
    </div>
  );
}

function DiffViewer({ diff }: { diff?: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!files.length) {
    return null;
  }
  return (
    <div className="codex-structured-diff">
      {files.map((file) => (
        <section className="codex-diff-file" key={file.id}>
          <header className="codex-diff-file-header">
            <span className="codex-diff-file-icon">
              <MaterialIcon
                type={
                  file.status === "added"
                    ? "add"
                    : file.status === "deleted"
                      ? "delete"
                      : "edit_document"
                }
              />
            </span>
            <span className="codex-diff-file-path">
              {file.newPath === "/dev/null" ? file.oldPath : file.newPath}
            </span>
            <span className="codex-diff-stats">
              <span className="codex-diff-additions">+{file.additions}</span>
              <span className="codex-diff-deletions">-{file.deletions}</span>
            </span>
          </header>
          {file.hunks.map((hunk, index) => (
            <div className="codex-diff-hunk" key={`${file.id}:hunk:${index}`}>
              <div className="codex-diff-hunk-header">{hunk.header}</div>
              <div className="codex-diff-lines">
                {hunk.lines.map((line, lineIndex) => (
                  <DiffLineView
                    key={`${file.id}:line:${index}:${lineIndex}`}
                    line={line}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function iconForEntry(entry: CodexTrajectoryEntry) {
  if (entry.viewKind === "working") {
    return "progress_activity";
  }
  if (entry.severity === "error" || entry.kind === "error") {
    return "error";
  }
  switch (entry.kind) {
    case "commandExecution":
      return "terminal";
    case "mcpToolCall":
      return "build";
    case "usage":
      return "data_usage";
    case "turn":
      return "sync";
    case "thread":
      return "forum";
    case "agentMessage":
      return "smart_toy";
    case "userMessage":
      return "person";
    default:
      return "circle";
  }
}

function readableTrajectoryEntries({
  isRunning,
  run,
  trajectory,
}: {
  isRunning: boolean;
  run?: CodexRun | null;
  trajectory: CodexTrajectoryEntry[];
}) {
  const completedIds = new Set(
    trajectory.filter(isCompletedEntry).map((entry) => entry.id),
  );
  const visible: CodexTrajectoryEntry[] = [];
  let showingGeneralWorking = false;

  for (const entry of trajectory) {
    if (entry.severity === "error") {
      visible.push(entry);
      continue;
    }
    if (entry.kind === "commandExecution") {
      if (entry.status === "inProgress") {
        if (!completedIds.has(entry.id)) {
          visible.push({
            ...entry,
            title: "Working",
            viewKind: "working",
          });
        }
        continue;
      }
      visible.push({ ...entry, title: "Command" });
      continue;
    }

    if (entry.kind === "agentMessage") {
      if (isStartedEntry(entry)) {
        if (!completedIds.has(entry.id) && !showingGeneralWorking) {
          visible.push({
            ...entry,
            detail: undefined,
            title: "Working",
            viewKind: "working",
          });
          showingGeneralWorking = true;
        }
        continue;
      }
      if (normalizeDetail(entry.detail, entry.kind)) {
        visible.push({ ...entry, title: "Assistant" });
      }
      continue;
    }

    if (entry.kind === "reasoning") {
      if (isStartedEntry(entry)) {
        if (!completedIds.has(entry.id) && !showingGeneralWorking) {
          visible.push({
            ...entry,
            detail: undefined,
            title: "Working",
            viewKind: "working",
          });
          showingGeneralWorking = true;
        }
        continue;
      }
      if (normalizeDetail(entry.detail, entry.kind)) {
        visible.push({ ...entry, title: "Reasoning" });
      }
      continue;
    }

    if (entry.kind === "mcpToolCall") {
      if (isStartedEntry(entry)) {
        if (!completedIds.has(entry.id)) {
          visible.push({
            ...entry,
            detail: undefined,
            title: "Working",
            viewKind: "working",
          });
        }
        continue;
      }
      if (normalizeDetail(entry.detail, entry.kind) || entry.status) {
        visible.push({ ...entry, title: "Tool" });
      }
    }
  }

  if (isRunning && !visible.some((entry) => entry.viewKind === "working")) {
    visible.push({
      id: `waiting:${run?.id ?? "run"}:${trajectory.length}`,
      time: run?.updatedAt ?? new Date().toISOString(),
      kind: "status",
      title: "Working",
      status: run?.status,
      viewKind: "working",
    });
  }

  if (statusIsTerminal(run?.status)) {
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const entry = visible[index];
      if (entry.kind === "agentMessage" && entry.viewKind !== "working") {
        visible[index] = {
          ...entry,
          isFinalMessage: true,
          title: "Final answer",
        };
        break;
      }
    }
  }

  return visible;
}

function normalizeOptions(
  options?: CodexRunOptions,
): Required<CodexRunOptions> {
  return {
    model: options?.model || FALLBACK_OPTIONS.model,
    effort: options?.effort || FALLBACK_OPTIONS.effort,
    summary: options?.summary || FALLBACK_OPTIONS.summary,
    approvalPolicy: options?.approvalPolicy || FALLBACK_OPTIONS.approvalPolicy,
    sandboxMode: options?.sandboxMode || FALLBACK_OPTIONS.sandboxMode,
    networkAccess:
      typeof options?.networkAccess === "boolean"
        ? options.networkAccess
        : FALLBACK_OPTIONS.networkAccess,
    autoApply: FALLBACK_OPTIONS.autoApply,
  };
}

export default function CodexPanel() {
  const { projectId } = useProjectContext();
  const { fileTreeData } = useFileTreeData();
  const { findEntityByPath } = useFileTreePathContext();
  const { getCurrentDocumentId, openDocWithId, openFileWithId } =
    useEditorManagerContext();
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<CodexRun | null>(null);
  const [runs, setRuns] = useState<CodexRun[]>([]);
  const [trajectory, setTrajectory] = useState<CodexTrajectoryEntry[]>([]);
  const [trajectoriesByRunId, setTrajectoriesByRunId] = useState<
    Record<string, CodexTrajectoryEntry[]>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("activity");
  const [sendMode, setSendMode] = useState<SendMode>("after_run");
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [activeFileReferenceIndex, setActiveFileReferenceIndex] = useState(0);
  const [composerCursor, setComposerCursor] = useState(0);
  const [dismissedFileReferenceKey, setDismissedFileReferenceKey] = useState<
    string | null
  >(null);
  const [selectionContext, setSelectionContext] =
    useState<SelectionContext | null>(null);
  const [dismissedSelectionText, setDismissedSelectionText] = useState<
    string | null
  >(null);
  const [options, setOptions] =
    useState<Required<CodexRunOptions>>(FALLBACK_OPTIONS);
  const [security, setSecurity] =
    useState<CodexSecurityOptions>(FALLBACK_SECURITY);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [accountState, setAccountState] = useState<CodexAccountState | null>(
    null,
  );
  const [selectedContexts, setSelectedContexts] = useState<SelectionContext[]>(
    [],
  );
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activityRef = useRef<HTMLDivElement | null>(null);
  const runStatusByIdRef = useRef(new Map<string, string>());
  const recompiledAppliedRunsRef = useRef(new Set<string>());

  const isRunning = run ? !statusIsTerminal(run.status) : false;
  const isFollowUp = Boolean(run && statusIsTerminal(run.status));
  const projectFiles = useMemo(
    () => flattenProjectFiles(fileTreeData),
    [fileTreeData],
  );
  const currentFilePath = projectFilePathById(
    projectFiles,
    getCurrentDocumentId(),
  );
  const sessionRuns = useMemo(() => {
    const seen = new Set<string>();
    return runs.filter((item) => {
      if (item.archivedAt) {
        return false;
      }
      const id = sessionId(item);
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  }, [runs]);
  const currentSessionRuns = useMemo(() => {
    if (!run) {
      return [];
    }
    const currentSessionId = sessionId(run);
    const byRunId = new Map<string, CodexRun>();
    [...runs, run].forEach((item) => {
      if (sessionId(item) === currentSessionId) {
        byRunId.set(item.id, item);
      }
    });
    return [...byRunId.values()].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [run, runs]);
  const changes = useMemo(
    () => aggregateSessionChanges(currentSessionRuns),
    [currentSessionRuns],
  );
  const sessionDiff = useMemo(
    () => aggregateSessionDiff(currentSessionRuns),
    [currentSessionRuns],
  );
  const slashSuggestions = useMemo(() => {
    const query = slashCommandQuery(prompt);
    if (query == null) {
      return [];
    }
    return SLASH_COMMANDS.filter((item) =>
      item.command.slice(1).startsWith(query),
    );
  }, [prompt]);
  const fileReference = useMemo(
    () => fileReferenceQuery(prompt, composerCursor),
    [composerCursor, prompt],
  );
  const fileSuggestions = useMemo(() => {
    if (!fileReference) {
      return [];
    }
    return projectFiles
      .map((file) => ({
        file,
        score: scoreFileReference(file, fileReference.query),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.file.path.localeCompare(b.file.path, undefined, {
            sensitivity: "base",
          }),
      )
      .slice(0, 8)
      .map((item) => item.file);
  }, [fileReference, projectFiles]);
  const showFileMenu = Boolean(
    fileReference &&
      fileSuggestions.length > 0 &&
      dismissedFileReferenceKey !== fileReference.key,
  );
  const showSlashMenu = slashSuggestions.length > 0 && !showFileMenu;
  const activityGroups = useMemo(() => {
    return currentSessionRuns.map((item) => {
      const source =
        trajectoriesByRunId[item.id] ??
        (item.id === run?.id ? trajectory : (item.trajectory ?? []));
      const entries: CodexTrajectoryEntry[] = [
        {
          id: `${item.id}:prompt`,
          time: item.createdAt,
          method: "prompt",
          kind: "userMessage",
          title: "User",
          detail: sanitizeSelectedContextPromptLabels(item.prompt, projectFiles),
          status: item.status,
        },
        ...readableTrajectoryEntries({
          isRunning: item.id === run?.id && isRunning,
          run: item,
          trajectory: source,
        }),
      ].map((entry) => ({
        ...entry,
        id: `${item.id}:${entry.id}`,
      }));
      return { run: item, entries };
    });
  }, [
    currentSessionRuns,
    isRunning,
    projectFiles,
    run?.id,
    trajectoriesByRunId,
    trajectory,
  ]);

  const hasActivity = activityGroups.some((group) => group.entries.length > 0);

  const triggerRecompile = useCallback((runId: string) => {
    if (recompiledAppliedRunsRef.current.has(runId)) {
      return;
    }
    recompiledAppliedRunsRef.current.add(runId);
    window.dispatchEvent(new Event("pdf:recompile"));
  }, []);

  const loadRuns = useCallback(async () => {
    const response = await getJSON<{ runs: CodexRun[] }>(
      `/project/${projectId}/codex/runs`,
    );
    setRuns(response.runs ?? []);
  }, [projectId]);

  const loadOptions = useCallback(async () => {
    const response = await getJSON<CodexOptionsResponse>("/user/codex/options");
    setOptions(normalizeOptions(response.defaults));
    setSecurity(response.security ?? FALLBACK_SECURITY);
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const response = await getJSON<{ data: CodexModel[] }>(
        "/user/codex/models",
      );
      setModels(response.data ?? []);
    } catch {
      setModels([]);
    }
  }, []);

  const loadAccountState = useCallback(async () => {
    try {
      const response = await getJSON<CodexAccountState>("/user/codex/account");
      setAccountState(response);
    } catch {
      setAccountState(null);
    }
  }, []);

  useEffect(() => {
    loadRuns().catch((err) => {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err));
    });
    loadOptions().catch((err) => {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err));
    });
    loadModels();
    loadAccountState();
  }, [loadAccountState, loadModels, loadOptions, loadRuns]);

  const hydrateRun = useCallback(
    async (runId: string) => {
      const nextRun = await getJSON<CodexRun>(
        `/project/${projectId}/codex/runs/${runId}`,
      );
      const nextEvents = await getJSON<CodexEventResponse>(
        `/project/${projectId}/codex/runs/${runId}/events`,
      );
      let hydratedRun = nextRun;
      if (statusIsTerminal(nextRun.status)) {
        const diffRun = await getJSON<CodexRun>(
          `/project/${projectId}/codex/runs/${runId}/diff`,
        );
        hydratedRun = { ...nextRun, ...diffRun };
      }
      const previousStatus = runStatusByIdRef.current.get(hydratedRun.id);
      runStatusByIdRef.current.set(hydratedRun.id, hydratedRun.status);
      const nextTrajectory =
        nextEvents.trajectory ?? hydratedRun.trajectory ?? [];
      setRun(hydratedRun);
      setTrajectory(nextTrajectory);
      setTrajectoriesByRunId((current) => ({
        ...current,
        [hydratedRun.id]: nextTrajectory,
      }));
      setRuns((current) =>
        current.map((item) =>
          item.id === hydratedRun.id ? hydratedRun : item,
        ),
      );
      if (
        previousStatus &&
        previousStatus !== "applied" &&
        hydratedRun.status === "applied" &&
        hydratedRun.applied?.length
      ) {
        triggerRecompile(hydratedRun.id);
      }
      return hydratedRun;
    },
    [projectId, triggerRecompile],
  );

  const refreshRun = useCallback(async () => {
    if (!run?.id) {
      return;
    }
    await hydrateRun(run.id);
    await loadRuns();
  }, [hydrateRun, loadRuns, run?.id]);

  useEffect(() => {
    if (!run?.id || statusIsTerminal(run.status)) {
      return;
    }
    const interval = window.setInterval(() => {
      refreshRun().catch((err) => {
        setError(err.getUserFacingMessage?.() || getErrorMessage(err));
      });
    }, 2000);
    return () => window.clearInterval(interval);
  }, [refreshRun, run?.id, run?.status]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashSuggestions.length]);

  useEffect(() => {
    setActiveFileReferenceIndex(0);
  }, [fileSuggestions.length]);

  useEffect(() => {
    setDismissedFileReferenceKey(null);
  }, [prompt]);

  useEffect(() => {
    const updateSelection = () => {
      window.setTimeout(() => {
        const codexPanel =
          textareaRef.current?.closest<HTMLElement>(".codex-panel") ?? null;
        const nextSelection = readExternalSelectionContext(codexPanel, {
          currentFilePath,
          projectFiles,
        });
        setSelectionContext(
          nextSelection && nextSelection.text !== dismissedSelectionText
            ? nextSelection
            : null,
        );
      }, 0);
    };
    document.addEventListener("selectionchange", updateSelection);
    window.addEventListener("mouseup", updateSelection);
    window.addEventListener("keyup", updateSelection);
    return () => {
      document.removeEventListener("selectionchange", updateSelection);
      window.removeEventListener("mouseup", updateSelection);
      window.removeEventListener("keyup", updateSelection);
    };
  }, [currentFilePath, dismissedSelectionText, projectFiles]);

  const completeSlashCommand = useCallback((command: string) => {
    setPrompt(`${command} `);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      const cursor = `${command} `.length;
      textareaRef.current?.setSelectionRange(cursor, cursor);
      setComposerCursor(cursor);
    }, 0);
  }, []);

  const executeSlashCommand = useCallback(
    (value: string) => {
      const parsed = parseSlashCommand(value);
      if (!parsed) {
        return false;
      }
      if (!SLASH_COMMANDS.some((item) => item.command === parsed.command)) {
        setComposerNotice(`Unknown command ${parsed.command}. Use /help.`);
        setPrompt("");
        return true;
      }

      switch (parsed.command) {
        case "/status":
          loadAccountState();
          setComposerNotice(
            [
              `Run: ${run ? displayStatus(run.status) : "ready"}`,
              `Changes: ${changeSummaryForChanges(changes).toLowerCase()}`,
              `Security: ${security.sandboxMode}, ${security.approvalPolicy}, network ${security.networkAccess === false ? "off" : "on"}`,
              accountState?.rateLimitsError
                ? `Usage limits: ${accountState.rateLimitsError}`
                : formatUsageLimits(accountState?.rateLimits),
            ].join(" · "),
          );
          break;
        case "/model": {
          if (!parsed.argument) {
            setComposerNotice(
              `Model: ${options.model || "server default"}. Use /model <model-id> to change it.`,
            );
            break;
          }
          const requested = parsed.argument;
          const matchedModel = models.find(
            (model) =>
              model.model === requested ||
              model.id === requested ||
              model.displayName?.toLowerCase() === requested.toLowerCase(),
          );
          const nextModel = matchedModel?.model ?? requested;
          setOptions((current) => ({ ...current, model: nextModel }));
          setComposerNotice(`Model set to ${nextModel}.`);
          break;
        }
        case "/effort": {
          if (!parsed.argument) {
            setComposerNotice(
              `Reasoning effort: ${options.effort}. Use /effort ${REASONING_EFFORTS.join("|")}.`,
            );
            break;
          }
          if (!REASONING_EFFORTS.includes(parsed.argument)) {
            setComposerNotice(
              `Unknown effort ${parsed.argument}. Use ${REASONING_EFFORTS.join(", ")}.`,
            );
            break;
          }
          setOptions((current) => ({ ...current, effort: parsed.argument }));
          setComposerNotice(`Reasoning effort set to ${parsed.argument}.`);
          break;
        }
        case "/summary": {
          if (!parsed.argument) {
            setComposerNotice(
              `Reasoning summary: ${options.summary}. Use /summary ${REASONING_SUMMARIES.join("|")}.`,
            );
            break;
          }
          if (!REASONING_SUMMARIES.includes(parsed.argument)) {
            setComposerNotice(
              `Unknown summary ${parsed.argument}. Use ${REASONING_SUMMARIES.join(", ")}.`,
            );
            break;
          }
          setOptions((current) => ({ ...current, summary: parsed.argument }));
          setComposerNotice(`Reasoning summary set to ${parsed.argument}.`);
          break;
        }
        case "/new":
          if (isRunning) {
            setComposerNotice(
              "Stop the current run before starting a new session.",
            );
            break;
          }
          setRun(null);
          setTrajectory([]);
          setSelectedContexts([]);
          setActiveView("activity");
          setError(null);
          setComposerNotice("New session ready.");
          break;
        case "/help":
          setComposerNotice(
            SLASH_COMMANDS.map(
              (item) => `${item.command} - ${item.description}`,
            ).join(" · "),
          );
          break;
      }
      setPrompt("");
      return true;
    },
    [
      isRunning,
      accountState,
      loadAccountState,
      models,
      options.effort,
      options.model,
      options.summary,
      run,
      security,
    ],
  );

  const selectSlashCommand = useCallback(
    (command: string) => {
      if (SLASH_COMMANDS_WITH_ARGUMENTS.has(command)) {
        completeSlashCommand(command);
        return;
      }
      executeSlashCommand(command);
    },
    [completeSlashCommand, executeSlashCommand],
  );

  const insertFileReference = useCallback(
    (file: CodexProjectFile) => {
      if (!fileReference) {
        return;
      }
      const insertion = `@/${file.path} `;
      const nextPrompt = `${prompt.slice(0, fileReference.start)}${insertion}${prompt.slice(fileReference.end)}`;
      const nextCursor = fileReference.start + insertion.length;
      setPrompt(nextPrompt);
      setComposerNotice(null);
      setDismissedFileReferenceKey(null);
      window.setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
        setComposerCursor(nextCursor);
      }, 0);
    },
    [fileReference, prompt],
  );

  const addSelectionContext = useCallback(() => {
    if (!selectionContext) {
      return;
    }
    setSelectedContexts((current) => {
      if (current.some((item) => item.text === selectionContext.text)) {
        return current;
      }
      return [...current, selectionContext];
    });
    setSelectionContext(null);
    setDismissedSelectionText(selectionContext.text);
    window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [selectionContext]);

  const openProjectPath = useCallback(
    async (path: string) => {
      const normalizedPath = normalizeProjectPath(path);
      if (!normalizedPath) {
        return false;
      }
      const result = findEntityByPath(normalizedPath);
      if (result?.type === "doc") {
        await openDocWithId(result.entity._id);
        return true;
      }
      if (result?.type === "fileRef") {
        openFileWithId(result.entity._id);
        return true;
      }
      return false;
    },
    [findEntityByPath, openDocWithId, openFileWithId],
  );

  const handlePanelClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest?.("a[data-codex-project-path]");
      if (!link) {
        return;
      }
      event.preventDefault();
      const path = link.getAttribute("data-codex-project-path") ?? "";
      openProjectPath(path)
        .then((opened) => {
          if (!opened) {
            setComposerNotice(`Could not open ${path}.`);
          }
        })
        .catch((err) => {
          setComposerNotice(getErrorMessage(err));
        });
    },
    [openProjectPath],
  );

  const startRun = useCallback(async () => {
    if (executeSlashCommand(prompt)) {
      return;
    }
    const trimmedPrompt = prompt.trim();
    if ((!trimmedPrompt && !selectedContexts.length) || busy) {
      return;
    }
    const promptWithContext = buildPromptWithSelectedContexts(
      trimmedPrompt,
      selectedContexts,
    );
    setBusy(true);
    setError(null);
    setComposerNotice(null);
    try {
      if (isRunning && run?.id) {
        const nextRun = await postJSON<CodexRun>(
          `/project/${projectId}/codex/runs/${run.id}/follow-up`,
          {
            body: {
              prompt: promptWithContext,
              mode: sendMode,
              options: {
                model: options.model || undefined,
                effort: options.effort,
                summary: options.summary,
              },
            },
          },
        );
        runStatusByIdRef.current.set(nextRun.id, nextRun.status);
        setRun(nextRun);
        setRuns((current) => {
          const exists = current.some((item) => item.id === nextRun.id);
          if (exists) {
            return current.map((item) =>
              item.id === nextRun.id ? nextRun : item,
            );
          }
          return [nextRun, ...current];
        });
        setPrompt("");
        setSelectedContexts([]);
        setComposerCursor(0);
        return;
      }
      const nextRun = await postJSON<CodexRun>(
        `/project/${projectId}/codex/runs`,
        {
          body: {
            prompt: promptWithContext,
            continueRunId: isFollowUp ? run?.id : undefined,
            options: {
              model: options.model || undefined,
              effort: options.effort,
              summary: options.summary,
            },
          },
        },
      );
      runStatusByIdRef.current.set(nextRun.id, nextRun.status);
      setRun(nextRun);
      setRuns((current) => [nextRun, ...current]);
      if (isFollowUp) {
        setTrajectoriesByRunId((current) => ({ ...current, [nextRun.id]: [] }));
      } else {
        setTrajectory([]);
        setTrajectoriesByRunId({ [nextRun.id]: [] });
      }
      setActiveView("activity");
      setPrompt("");
      setSelectedContexts([]);
      setComposerCursor(0);
    } catch (err: any) {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    executeSlashCommand,
    isFollowUp,
    isRunning,
    options,
    projectId,
    prompt,
    selectedContexts,
    run?.id,
    sendMode,
  ]);

  const handlePromptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showFileMenu) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveFileReferenceIndex(
            (index) => (index + 1) % fileSuggestions.length,
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveFileReferenceIndex(
            (index) =>
              (index - 1 + fileSuggestions.length) % fileSuggestions.length,
          );
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          event.preventDefault();
          insertFileReference(
            fileSuggestions[activeFileReferenceIndex] ?? fileSuggestions[0],
          );
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDismissedFileReferenceKey(fileReference?.key ?? null);
          return;
        }
      }
      if (showSlashMenu) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveSlashIndex((index) => (index + 1) % slashSuggestions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveSlashIndex(
            (index) =>
              (index - 1 + slashSuggestions.length) % slashSuggestions.length,
          );
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          event.preventDefault();
          const selectedCommand =
            slashSuggestions[activeSlashIndex]?.command ??
            slashSuggestions[0].command;
          if (event.key === "Enter") {
            selectSlashCommand(selectedCommand);
            return;
          }
          completeSlashCommand(selectedCommand);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setPrompt("");
          return;
        }
      }
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }

      event.preventDefault();
      startRun();
    },
    [
      activeFileReferenceIndex,
      activeSlashIndex,
      completeSlashCommand,
      fileReference?.key,
      fileSuggestions,
      insertFileReference,
      selectSlashCommand,
      showFileMenu,
      showSlashMenu,
      slashSuggestions,
      startRun,
    ],
  );

  const cancelRun = useCallback(async () => {
    if (!run?.id) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextRun = await postJSON<CodexRun>(
        `/project/${projectId}/codex/runs/${run.id}/cancel`,
      );
      setRun(nextRun);
      await loadRuns();
    } catch (err: any) {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [loadRuns, projectId, run?.id]);

  const selectRun = useCallback(
    (nextRun: CodexRun) => {
      hydrateRun(nextRun.id).catch((err) => {
        setError(err.getUserFacingMessage?.() || getErrorMessage(err));
      });
      setActiveView("activity");
    },
    [hydrateRun],
  );

  const startNewSession = useCallback(() => {
    setRun(null);
    setTrajectory([]);
    setPrompt("");
    setSelectedContexts([]);
    setComposerCursor(0);
    setActiveView("activity");
    setError(null);
  }, []);

  const archiveSession = useCallback(
    async (item: CodexRun) => {
      if (!statusIsTerminal(item.status)) {
        setComposerNotice("Stop the session before archiving it.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await postJSON<{ runs: CodexRun[] }>(
          `/project/${projectId}/codex/runs/${item.id}/archive`,
        );
        const archivedSessionId = sessionId(item);
        setRuns((current) =>
          current.filter((candidate) => sessionId(candidate) !== archivedSessionId),
        );
        if (run && sessionId(run) === archivedSessionId) {
          startNewSession();
        }
        setComposerNotice("Session archived.");
      } catch (err: any) {
        setError(err.getUserFacingMessage?.() || getErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [projectId, run, startNewSession],
  );

  const hasPrompt = Boolean(prompt.trim() || selectedContexts.length);
  const mainComposerActionIsStop = isRunning && !hasPrompt;
  const composerLabel = isRunning
    ? "Message"
    : isFollowUp
      ? "Follow-up"
      : "Prompt";
  const composerStatus = run?.pendingFollowUp
    ? pendingFollowUpLabel(run.pendingFollowUp)
    : isRunning
      ? displayStatus(run?.status)
      : "Ready";
  const headerTitle = run ? runTitle(run) : "Codex";
  const headerSubtitle = run
    ? [displayStatus(run.status), changeSummaryForChanges(changes)]
        .filter(Boolean)
        .join(" · ")
    : "Select a session or start a new one";
  const handleActivityScroll = useCallback(() => {
    const element = activityRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setShowBackToBottom(distanceFromBottom > 120);
  }, []);
  const scrollActivityToBottom = useCallback(() => {
    const element = activityRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setShowBackToBottom(false);
  }, []);

  return (
    <div className="codex-panel" onClick={handlePanelClick}>
      <div className="codex-panel-header">
        <div className="codex-panel-title">
          <span className="codex-panel-title-icon">
            <MaterialIcon type="smart_toy" />
          </span>
          <span className="codex-panel-title-copy">
            <strong>{headerTitle}</strong>
            <small>{headerSubtitle}</small>
          </span>
        </div>
        <div className="codex-panel-actions">
          <button
            className="btn btn-link btn-sm codex-icon-button"
            onClick={startNewSession}
            disabled={busy}
            title="Switch sessions"
            type="button"
          >
            <MaterialIcon type="forum" accessibilityLabel="Switch sessions" />
          </button>
          <button
            className="btn btn-link btn-sm codex-icon-button"
            onClick={() => {
              loadRuns().catch((err) => {
                setError(err.getUserFacingMessage?.() || getErrorMessage(err));
              });
            }}
            disabled={busy}
            title="Refresh sessions"
            type="button"
          >
            <MaterialIcon type="refresh" accessibilityLabel="Refresh" />
          </button>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="codex-workbench">
        <main className="codex-session-main">
          {!run ? (
            <div
              className="codex-session-list codex-session-list-panel"
              aria-label="Codex sessions"
            >
              <div className="codex-session-list-header">
                <span>Recent sessions</span>
                <span className="codex-session-list-header-actions">
                  <small>{sessionRuns.length}</small>
                </span>
              </div>
              {sessionRuns.length ? (
                sessionRuns.map((item) => (
                  <div className="codex-session" key={item.id}>
                    <button
                      className="codex-session-main-button"
                      onClick={() => selectRun(item)}
                      type="button"
                    >
                      <span className="codex-session-row">
                        <span
                          className={classNames(
                            "codex-session-status-dot",
                            `status-${item.status}`,
                          )}
                        />
                        <span className="codex-session-title">
                          {runTitle(item)}
                        </span>
                      </span>
                      <span className="codex-session-meta">
                        <span>{compactDate(item.createdAt)}</span>
                        <span>{displayStatus(item.status)}</span>
                        <span>{changeSummary(item)}</span>
                      </span>
                    </button>
                    <button
                      className="btn btn-link btn-sm codex-icon-button"
                      disabled={busy || !statusIsTerminal(item.status)}
                      onClick={() => archiveSession(item)}
                      title="Archive session"
                      type="button"
                    >
                      <MaterialIcon type="archive" accessibilityLabel="Archive" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="codex-empty-state">
                  <MaterialIcon type="forum" />
                  <span>No sessions yet</span>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="codex-tabs" role="tablist">
                {(["activity", "diff"] as ActiveView[]).map((view) => (
                  <button
                    key={view}
                    className={classNames("codex-tab", {
                      active: activeView === view,
                    })}
                    onClick={() => setActiveView(view)}
                    role="tab"
                    aria-selected={activeView === view}
                    type="button"
                  >
                    <MaterialIcon type={VIEW_CONFIG[view].icon} />
                    <span>{VIEW_CONFIG[view].label}</span>
                    {view === "diff" && changes.length ? (
                      <span className="codex-tab-count">{changes.length}</span>
                    ) : null}
                  </button>
                ))}
              </div>

              {activeView === "activity" ? (
            <div
              className="codex-activity"
              onScroll={handleActivityScroll}
              ref={activityRef}
            >
              {run?.pendingFollowUp && !run.pendingFollowUp.startedRunId ? (
                <div className="codex-follow-up-card">
                  <MaterialIcon
                    type={SEND_MODE_CONFIG[run.pendingFollowUp.mode].icon}
                  />
                  <div>
                    <strong>{pendingFollowUpLabel(run.pendingFollowUp)}</strong>
                    <MarkdownBlock compact value={run.pendingFollowUp.prompt} />
                  </div>
                </div>
              ) : null}
              {run?.status === "failed" && run.error ? (
                <div className="alert alert-danger codex-run-error">
                  <strong>Run failed</strong>
                  <MarkdownBlock
                    compact
                    value={fencedCode(run.error, "text")}
                  />
                </div>
              ) : null}
              {hasActivity ? (
                <>
                  {activityGroups.map((group) => (
                    <RunActivityGroup
                      key={group.run.id}
                      entries={group.entries}
                      run={group.run}
                    />
                  ))}
                  {showBackToBottom ? (
                    <button
                      className="codex-back-to-bottom"
                      onClick={scrollActivityToBottom}
                      type="button"
                    >
                      <MaterialIcon type="keyboard_arrow_down" />
                      <span>Back to bottom</span>
                    </button>
                  ) : null}
                </>
              ) : run?.status === "failed" && run.error ? null : (
                <div className="codex-empty-state">
                  <MaterialIcon type="timeline" />
                  <span>No activity</span>
                </div>
              )}
            </div>
              ) : null}

              {activeView === "diff" ? (
            <div className="codex-diff-view">
              {changes.length ? (
                <div className="codex-change-list">
                  {changes.map((change) => (
                    <div
                      key={change.projectPath}
                      className="codex-change codex-change-readonly"
                    >
                      <span className="codex-change-icon">
                        <MaterialIcon type={changeIcon(change)} />
                      </span>
                      <span className="codex-change-main">
                        <span className="codex-change-path">
                          {change.projectPath}
                        </span>
                        <small>{displayStatus(change.type)}</small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="codex-empty-state">
                  <MaterialIcon type="difference" />
                  <span>No file changes</span>
                </div>
              )}

              <DiffViewer diff={sessionDiff} />

              <div className="codex-diff-actions">
                {changes.length ? (
                  <span className="codex-apply-note">
                    Changes are applied automatically
                  </span>
                ) : null}
                {run?.status === "applied" ? (
                  <span className="codex-apply-note">
                    Applied {run.applied?.length ?? 0} file
                    {(run.applied?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                ) : null}
                {run?.status === "apply_failed" ? (
                  <span className="codex-apply-note codex-apply-note-error">
                    Auto-apply failed
                  </span>
                ) : null}
              </div>
            </div>
              ) : null}
            </>
          )}
        </main>
      </div>

      <div className="codex-composer">
        <div className="codex-composer-meta">
          <span>{composerLabel}</span>
          <span>{composerStatus}</span>
        </div>
        {isRunning ? (
          <div className="codex-send-mode" role="group" aria-label="Send mode">
            {(Object.keys(SEND_MODE_CONFIG) as SendMode[]).map((mode) => (
              <button
                key={mode}
                className={classNames("codex-send-mode-button", {
                  active: sendMode === mode,
                })}
                onClick={() => setSendMode(mode)}
                title={SEND_MODE_CONFIG[mode].description}
                type="button"
              >
                <MaterialIcon type={SEND_MODE_CONFIG[mode].icon} />
                <span>{SEND_MODE_CONFIG[mode].label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {composerNotice ? (
          <div className="codex-composer-notice">{composerNotice}</div>
        ) : null}
        {selectionContext ? (
          <div className="codex-selection-context">
            <MaterialIcon type="content_paste_go" />
            <span>
              <strong>Add selected context?</strong>
              {selectionContextTitle(selectionContext) ? (
                <small>{selectionContextTitle(selectionContext)}</small>
              ) : null}
              <small>{previewText(selectionContext.text, 96)}</small>
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={addSelectionContext}
              type="button"
            >
              Add
            </button>
            <button
              className="btn btn-link btn-sm codex-icon-button"
              onClick={() => {
                setDismissedSelectionText(selectionContext.text);
                setSelectionContext(null);
              }}
              title="Dismiss selection"
              type="button"
            >
              <MaterialIcon type="close" accessibilityLabel="Dismiss" />
            </button>
          </div>
        ) : null}
        {selectedContexts.length ? (
          <div className="codex-selected-context-list">
            {selectedContexts.map((context, index) => (
              <span className="codex-selected-context-chip" key={context.id}>
                <MaterialIcon type="content_paste" />
                <span>
                  <strong>[Selected Context {index + 1}]</strong>
                  <small>
                    {selectionContextTitle(context) || context.source}
                  </small>
                </span>
                <button
                  className="btn btn-link btn-sm codex-icon-button"
                  onClick={() => {
                    setSelectedContexts((current) =>
                      current.filter((item) => item.id !== context.id),
                    );
                  }}
                  title="Remove selected context"
                  type="button"
                >
                  <MaterialIcon type="close" accessibilityLabel="Remove" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="codex-input-shell">
          <textarea
            ref={textareaRef}
            className="form-control"
            data-enable-grammarly="false"
            data-gramm="false"
            data-gramm_editor="false"
            rows={3}
            spellCheck={false}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setComposerCursor(event.target.selectionStart ?? 0);
              setComposerNotice(null);
            }}
            onClick={(event) => {
              setComposerCursor(event.currentTarget.selectionStart ?? 0);
            }}
            onKeyDown={handlePromptKeyDown}
            onKeyUp={(event) => {
              setComposerCursor(event.currentTarget.selectionStart ?? 0);
            }}
            onSelect={(event) => {
              setComposerCursor(event.currentTarget.selectionStart ?? 0);
            }}
            placeholder={
              isRunning
                ? "Message Codex during this run"
                : isFollowUp
                  ? "Ask a follow-up in this session"
                  : "Start a new Codex session"
            }
            disabled={busy && !isRunning}
          />
          {showSlashMenu ? (
            <div className="codex-slash-menu" role="listbox">
              {slashSuggestions.map((item, index) => (
                <button
                  key={item.command}
                  className={classNames("codex-slash-command", {
                    active: index === activeSlashIndex,
                  })}
                  onClick={() => selectSlashCommand(item.command)}
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  type="button"
                >
                  <span>{item.command}</span>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
          ) : null}
          {showFileMenu ? (
            <div
              className="codex-slash-menu codex-reference-menu"
              role="listbox"
            >
              {fileSuggestions.map((file, index) => (
                <button
                  key={`${file.type}:${file.id}`}
                  className={classNames(
                    "codex-slash-command",
                    "codex-file-reference",
                    {
                      active: index === activeFileReferenceIndex,
                    },
                  )}
                  onClick={() => insertFileReference(file)}
                  role="option"
                  aria-selected={index === activeFileReferenceIndex}
                  type="button"
                >
                  <MaterialIcon
                    type={file.type === "doc" ? "description" : "draft"}
                  />
                  <span>@/{file.path}</span>
                  <small>{file.type === "doc" ? "Document" : "File"}</small>
                </button>
              ))}
            </div>
          ) : null}
          <div className="codex-input-actions">
            <button
              className={classNames("btn btn-sm codex-send-button", {
                "btn-primary": !mainComposerActionIsStop,
                "btn-danger": mainComposerActionIsStop,
              })}
              onClick={mainComposerActionIsStop ? cancelRun : startRun}
              disabled={
                busy ||
                (!mainComposerActionIsStop && !hasPrompt) ||
                (!run && isRunning)
              }
              title={
                mainComposerActionIsStop
                  ? "Stop run"
                  : isRunning
                    ? SEND_MODE_CONFIG[sendMode].status
                    : isFollowUp
                      ? "Send follow-up"
                      : "Run Codex"
              }
              type="button"
            >
              <MaterialIcon
                type={mainComposerActionIsStop ? "stop" : "send"}
                accessibilityLabel={
                  mainComposerActionIsStop
                    ? "Stop run"
                    : isRunning
                      ? "Send message"
                      : isFollowUp
                        ? "Send follow-up"
                        : "Run Codex"
                }
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
