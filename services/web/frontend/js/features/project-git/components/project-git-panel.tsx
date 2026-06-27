import { useCallback, useEffect, useMemo, useState } from 'react'
import classNames from 'classnames'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import MaterialIcon from '@/shared/components/material-icon'
import { useProjectContext } from '@/shared/context/project-context'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

type ProjectGitChange = {
  path: string
  index: string
  workingTree: string
  status: string
}

type ProjectGitStatus = {
  initialized: boolean
  branch?: string | null
  remoteUrl?: string | null
  ahead?: number
  behind?: number
  clean: boolean
  changes: ProjectGitChange[]
  diff?: string
  commits?: Array<{
    hash: string
    subject: string
    relativeTime?: string
  }>
  message?: string
  warning?: string
}

type GitDiffLine = {
  type: 'add' | 'delete' | 'context' | 'meta'
  oldLine?: number
  newLine?: number
  content: string
}

type GitDiffHunk = {
  header: string
  lines: GitDiffLine[]
}

type GitDiffFile = {
  id: string
  path: string
  additions: number
  deletions: number
  hunks: GitDiffHunk[]
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return 'Git operation failed.'
}

function stripDiffPathPrefix(value: string) {
  const path = value.trim().split(/\s+/)[0] || ''
  if (path === '/dev/null') {
    return path
  }
  return path.replace(/^[ab]\//, '')
}

function parseUnifiedDiff(diff?: string): GitDiffFile[] {
  if (!diff?.trim()) {
    return []
  }

  const files: GitDiffFile[] = []
  let currentFile: GitDiffFile | null = null
  let currentHunk: GitDiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const ensureFile = () => {
    if (!currentFile) {
      currentFile = {
        id: `diff-${files.length}`,
        path: 'Changes',
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      files.push(currentFile)
    }
    return currentFile
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const [, , newPath = 'Changes'] =
        line.match(/^diff --git\s+(.+?)\s+(.+)$/) ?? []
      currentFile = {
        id: `${files.length}:${line}`,
        path: stripDiffPathPrefix(newPath),
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      currentHunk = null
      files.push(currentFile)
      continue
    }
    if (line.startsWith('+++ ')) {
      const file = ensureFile()
      const path = stripDiffPathPrefix(line.slice(4))
      if (path !== '/dev/null') {
        file.path = path
      }
      continue
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/)
      oldLine = Number(match?.[1] ?? 0)
      newLine = Number(match?.[2] ?? 0)
      currentHunk = { header: line, lines: [] }
      ensureFile().hunks.push(currentHunk)
      continue
    }
    if (!currentHunk) {
      continue
    }
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', newLine, content: line.slice(1) })
      ensureFile().additions += 1
      newLine += 1
      continue
    }
    if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'delete',
        oldLine,
        content: line.slice(1),
      })
      ensureFile().deletions += 1
      oldLine += 1
      continue
    }
    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        oldLine,
        newLine,
        content: line.slice(1),
      })
      oldLine += 1
      newLine += 1
      continue
    }
    currentHunk.lines.push({ type: 'meta', content: line })
  }

  return files.filter(file => file.hunks.length > 0)
}

function changeIcon(change: ProjectGitChange) {
  if (change.status.includes('A') || change.status === '??') {
    return 'add'
  }
  if (change.status.includes('D')) {
    return 'delete'
  }
  if (change.status.includes('R')) {
    return 'drive_file_rename_outline'
  }
  return 'edit_document'
}

function changeLabel(change: ProjectGitChange) {
  if (change.status === '??') {
    return 'untracked'
  }
  if (change.status.includes('A')) {
    return 'added'
  }
  if (change.status.includes('D')) {
    return 'deleted'
  }
  if (change.status.includes('R')) {
    return 'renamed'
  }
  return 'modified'
}

function DiffPreview({ diff }: { diff?: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  if (!files.length) {
    return null
  }
  return (
    <div className="project-git-diff">
      {files.map(file => (
        <section className="project-git-diff-file" key={file.id}>
          <header>
            <span>{file.path}</span>
            <small>
              <span className="project-git-added">+{file.additions}</span>
              <span className="project-git-deleted">-{file.deletions}</span>
            </small>
          </header>
          {file.hunks.map((hunk, hunkIndex) => (
            <div className="project-git-diff-hunk" key={`${file.id}:${hunkIndex}`}>
              <div className="project-git-diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  className={classNames('project-git-diff-line', line.type)}
                  key={`${file.id}:${hunkIndex}:${lineIndex}`}
                >
                  <span>{line.oldLine ?? ''}</span>
                  <span>{line.newLine ?? ''}</span>
                  <code>{line.content || ' '}</code>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

export default function ProjectGitPanel() {
  const { projectId } = useProjectContext()
  const [status, setStatus] = useState<ProjectGitStatus | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    const nextStatus = await getJSON<ProjectGitStatus>(
      `/project/${projectId}/git/status`
    )
    setStatus(nextStatus)
    setRemoteUrl(nextStatus.remoteUrl ?? '')
    return nextStatus
  }, [projectId])

  useEffect(() => {
    loadStatus().catch(err => setError(getErrorMessage(err)))
  }, [loadStatus])

  const runAction = useCallback(
    async (
      action: () => Promise<ProjectGitStatus>,
      { clearCommit = false } = {}
    ) => {
      setBusy(true)
      setError(null)
      try {
        const nextStatus = await action()
        setStatus(nextStatus)
        setRemoteUrl(nextStatus.remoteUrl ?? '')
        if (clearCommit) {
          setCommitMessage('')
        }
      } catch (err) {
        setError(getErrorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const branchStatus = [
    status?.branch || 'main',
    status?.ahead ? `ahead ${status.ahead}` : '',
    status?.behind ? `behind ${status.behind}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="project-git-panel">
      <RailPanelHeader title="Source Control" />
      <div className="project-git-body">
        {error ? <div className="alert alert-danger">{error}</div> : null}
        {status?.message ? (
          <div className="project-git-message">{status.message}</div>
        ) : null}
        {status?.warning ? (
          <div className="project-git-warning">{status.warning}</div>
        ) : null}

        {!status?.initialized ? (
          <div className="project-git-card">
            <MaterialIcon type="call_split" />
            <div>
              <strong>Initialize Git for this project</strong>
              <p>
                Create a project repository from the current Overleaf text
                files, or import text files from a remote repository.
              </p>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() =>
                  runAction(() =>
                    postJSON<ProjectGitStatus>(
                      `/project/${projectId}/git/init`
                    )
                  )
                }
                type="button"
              >
                Initialize repository
              </button>
            </div>
          </div>
        ) : null}

        <div className="project-git-remote">
          <input
            className="form-control"
            onChange={event => setRemoteUrl(event.target.value)}
            placeholder="Remote URL"
            value={remoteUrl}
          />
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy || !remoteUrl.trim()}
            onClick={() =>
              runAction(() =>
                postJSON<ProjectGitStatus>(
                  status?.initialized
                    ? `/project/${projectId}/git/remote`
                    : `/project/${projectId}/git/import`,
                  { body: { remoteUrl: remoteUrl.trim() } }
                )
              )
            }
            type="button"
          >
            {status?.initialized ? 'Set remote' : 'Import'}
          </button>
        </div>

        {status?.initialized ? (
          <>
            <div className="project-git-toolbar">
              <span className="project-git-branch">
                <MaterialIcon type="call_split" />
                {branchStatus}
              </span>
              <button
                className="btn btn-link btn-sm project-git-icon-button"
                disabled={busy}
                onClick={() => runAction(loadStatus)}
                title="Refresh"
                type="button"
              >
                <MaterialIcon type="refresh" accessibilityLabel="Refresh" />
              </button>
              <button
                className="btn btn-link btn-sm project-git-icon-button"
                disabled={busy}
                onClick={() =>
                  runAction(() =>
                    postJSON<ProjectGitStatus>(
                      `/project/${projectId}/git/pull`
                    )
                  )
                }
                title="Pull"
                type="button"
              >
                <MaterialIcon type="download" accessibilityLabel="Pull" />
              </button>
              <button
                className="btn btn-link btn-sm project-git-icon-button"
                disabled={busy || !status.remoteUrl}
                onClick={() =>
                  runAction(() =>
                    postJSON<ProjectGitStatus>(
                      `/project/${projectId}/git/push`
                    )
                  )
                }
                title="Push"
                type="button"
              >
                <MaterialIcon type="upload" accessibilityLabel="Push" />
              </button>
            </div>

            <div className="project-git-commit">
              <textarea
                className="form-control"
                disabled={busy}
                onChange={event => setCommitMessage(event.target.value)}
                placeholder={`Message (${branchStatus})`}
                rows={2}
                value={commitMessage}
              />
              <button
                className="btn btn-primary"
                disabled={busy || !commitMessage.trim() || status.clean}
                onClick={() =>
                  runAction(
                    () =>
                      postJSON<ProjectGitStatus>(
                        `/project/${projectId}/git/commit`,
                        { body: { message: commitMessage } }
                      ),
                    { clearCommit: true }
                  )
                }
                type="button"
              >
                <MaterialIcon type="check" />
                <span>Commit</span>
              </button>
            </div>

            <section className="project-git-section">
              <header>
                <span>Changes</span>
                <small>{status.changes.length}</small>
              </header>
              {status.changes.length ? (
                <div className="project-git-changes">
                  {status.changes.map(change => (
                    <div className="project-git-change" key={change.path}>
                      <MaterialIcon type={changeIcon(change)} />
                      <span>{change.path}</span>
                      <small>{changeLabel(change)}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="project-git-empty">No changes</div>
              )}
            </section>

            {status.commits?.length ? (
              <section className="project-git-section">
                <header>
                  <span>History</span>
                </header>
                <div className="project-git-commits">
                  {status.commits.map(commit => (
                    <div className="project-git-commit-row" key={commit.hash}>
                      <span>{commit.subject}</span>
                      <small>
                        {commit.hash} · {commit.relativeTime}
                      </small>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <DiffPreview diff={status.diff} />
          </>
        ) : null}
      </div>
    </div>
  )
}
