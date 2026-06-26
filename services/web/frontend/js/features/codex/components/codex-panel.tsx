import { useCallback, useEffect, useMemo, useState } from 'react'
import classNames from 'classnames'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import { useProjectContext } from '@/shared/context/project-context'
import MaterialIcon from '@/shared/components/material-icon'

type CodexRunOptions = {
  model?: string | null
  effort?: string | null
  summary?: string | null
  approvalPolicy?: string | null
  sandboxMode?: string | null
  autoApply?: boolean | null
}

type CodexRun = {
  id: string
  status: string
  prompt: string
  error?: string
  diff?: string
  gitStatus?: string
  changes?: CodexChange[]
  changeCount?: number
  applied?: CodexAppliedChange[]
  trajectory?: CodexTrajectoryEntry[]
  options?: CodexRunOptions
  createdAt: string
  updatedAt: string
}

type CodexChange = {
  type: string
  projectPath: string
  docId: string
}

type CodexAppliedChange = {
  projectPath: string
  docId: string
}

type CodexTrajectoryEntry = {
  id: string
  time: string
  kind: string
  title: string
  detail?: string
  command?: string
  cwd?: string
  status?: string
  exitCode?: number
  severity?: string
}

type CodexModel = {
  id: string
  model: string
  displayName: string
  description: string
  isDefault: boolean
}

type CodexOptionsResponse = {
  defaults: CodexRunOptions
  sandboxModes: string[]
  approvalPolicies: string[]
  reasoningSummaries: string[]
  reasoningEfforts: string[]
}

type CodexEventResponse = {
  events: unknown[]
  trajectory: CodexTrajectoryEntry[]
}

type ActiveView = 'activity' | 'diff' | 'settings'

const FALLBACK_OPTIONS: Required<CodexRunOptions> = {
  model: '',
  effort: 'medium',
  summary: 'auto',
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  autoApply: true,
}

function statusIsTerminal(status?: string) {
  return ['completed', 'failed', 'cancelled', 'applied', 'apply_failed'].includes(
    status || ''
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return 'Something went wrong. Please try again.'
}

function compactDate(value?: string) {
  if (!value) {
    return ''
  }
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function displayStatus(status?: string) {
  if (!status) {
    return 'idle'
  }
  return status.replace(/_/g, ' ')
}

function runTitle(run: CodexRun) {
  const firstLine = run.prompt.split('\n').find(Boolean) || 'Codex session'
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}...` : firstLine
}

function iconForEntry(entry: CodexTrajectoryEntry) {
  if (entry.severity === 'error' || entry.kind === 'error') {
    return 'error'
  }
  switch (entry.kind) {
    case 'commandExecution':
      return 'terminal'
    case 'mcpToolCall':
      return 'build'
    case 'usage':
      return 'data_usage'
    case 'turn':
      return 'sync'
    case 'thread':
      return 'forum'
    case 'agentMessage':
      return 'smart_toy'
    case 'userMessage':
      return 'person'
    default:
      return 'circle'
  }
}

function normalizeOptions(options?: CodexRunOptions): Required<CodexRunOptions> {
  return {
    model: options?.model || FALLBACK_OPTIONS.model,
    effort: options?.effort || FALLBACK_OPTIONS.effort,
    summary: options?.summary || FALLBACK_OPTIONS.summary,
    approvalPolicy: options?.approvalPolicy || FALLBACK_OPTIONS.approvalPolicy,
    sandboxMode: options?.sandboxMode || FALLBACK_OPTIONS.sandboxMode,
    autoApply:
      typeof options?.autoApply === 'boolean'
        ? options.autoApply
        : FALLBACK_OPTIONS.autoApply,
  }
}

export default function CodexPanel() {
  const { projectId } = useProjectContext()
  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<CodexRun | null>(null)
  const [runs, setRuns] = useState<CodexRun[]>([])
  const [trajectory, setTrajectory] = useState<CodexTrajectoryEntry[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<ActiveView>('activity')
  const [options, setOptions] = useState<Required<CodexRunOptions>>(
    FALLBACK_OPTIONS
  )
  const [optionLists, setOptionLists] = useState<CodexOptionsResponse | null>(
    null
  )
  const [models, setModels] = useState<CodexModel[]>([])

  const changes = run?.changes ?? []
  const hasApplicableChanges = useMemo(
    () =>
      (run?.status === 'completed' || run?.status === 'apply_failed') &&
      changes.some(change => change.type === 'modified'),
    [changes, run?.status]
  )
  const isRunning = run ? !statusIsTerminal(run.status) : false

  const loadRuns = useCallback(async () => {
    const response = await getJSON<{ runs: CodexRun[] }>(
      `/project/${projectId}/codex/runs`
    )
    setRuns(response.runs ?? [])
  }, [projectId])

  const loadOptions = useCallback(async () => {
    const response = await getJSON<CodexOptionsResponse>('/user/codex/options')
    setOptionLists(response)
    setOptions(normalizeOptions(response.defaults))
  }, [])

  const loadModels = useCallback(async () => {
    try {
      const response = await getJSON<{ data: CodexModel[] }>(
        '/user/codex/models'
      )
      setModels(response.data ?? [])
    } catch {
      setModels([])
    }
  }, [])

  useEffect(() => {
    loadRuns().catch(err => {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err))
    })
    loadOptions().catch(err => {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err))
    })
    loadModels()
  }, [loadModels, loadOptions, loadRuns])

  const hydrateRun = useCallback(
    async (runId: string) => {
      const nextRun = await getJSON<CodexRun>(
        `/project/${projectId}/codex/runs/${runId}`
      )
      const nextEvents = await getJSON<CodexEventResponse>(
        `/project/${projectId}/codex/runs/${runId}/events`
      )
      let hydratedRun = nextRun
      if (statusIsTerminal(nextRun.status)) {
        const diffRun = await getJSON<CodexRun>(
          `/project/${projectId}/codex/runs/${runId}/diff`
        )
        hydratedRun = { ...nextRun, ...diffRun }
      }
      setRun(hydratedRun)
      setTrajectory(nextEvents.trajectory ?? hydratedRun.trajectory ?? [])
      setRuns(current =>
        current.map(item => (item.id === hydratedRun.id ? hydratedRun : item))
      )
      if (hydratedRun.status === 'completed') {
        const modifiedPaths = (hydratedRun.changes ?? [])
          .filter(change => change.type === 'modified')
          .map(change => change.projectPath)
        setSelectedPaths(current =>
          current.size === 0 ? new Set(modifiedPaths) : current
        )
      }
      return hydratedRun
    },
    [projectId]
  )

  const refreshRun = useCallback(async () => {
    if (!run?.id) {
      return
    }
    await hydrateRun(run.id)
    await loadRuns()
  }, [hydrateRun, loadRuns, run?.id])

  useEffect(() => {
    if (!run?.id || statusIsTerminal(run.status)) {
      return
    }
    const interval = window.setInterval(() => {
      refreshRun().catch(err => {
        setError(err.getUserFacingMessage?.() || getErrorMessage(err))
      })
    }, 2000)
    return () => window.clearInterval(interval)
  }, [refreshRun, run?.id, run?.status])

  const startRun = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const nextRun = await postJSON<CodexRun>(
        `/project/${projectId}/codex/runs`,
        {
          body: {
            prompt,
            options: {
              model: options.model || undefined,
              effort: options.effort,
              summary: options.summary,
              approvalPolicy: options.approvalPolicy,
              sandboxMode: options.sandboxMode,
              autoApply: options.autoApply,
            },
          },
        }
      )
      setRun(nextRun)
      setRuns(current => [nextRun, ...current])
      setTrajectory([])
      setSelectedPaths(new Set())
      setActiveView('activity')
    } catch (err: any) {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [options, projectId, prompt])

  const applyRun = useCallback(async () => {
    if (!run?.id) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await postJSON(`/project/${projectId}/codex/runs/${run.id}/apply`, {
        body: { paths: [...selectedPaths] },
      })
      await hydrateRun(run.id)
      await loadRuns()
    } catch (err: any) {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [hydrateRun, loadRuns, projectId, run?.id, selectedPaths])

  const cancelRun = useCallback(async () => {
    if (!run?.id) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const nextRun = await postJSON<CodexRun>(
        `/project/${projectId}/codex/runs/${run.id}/cancel`
      )
      setRun(nextRun)
      await loadRuns()
    } catch (err: any) {
      setError(err.getUserFacingMessage?.() || getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [loadRuns, projectId, run?.id])

  const togglePath = useCallback((path: string) => {
    setSelectedPaths(current => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const selectRun = useCallback(
    (nextRun: CodexRun) => {
      setSelectedPaths(new Set())
      hydrateRun(nextRun.id).catch(err => {
        setError(err.getUserFacingMessage?.() || getErrorMessage(err))
      })
    },
    [hydrateRun]
  )

  return (
    <div className="codex-panel">
      <div className="codex-panel-header">
        <div className="codex-panel-title">
          <MaterialIcon type="smart_toy" accessibilityLabel="Codex" />
          <strong>Codex</strong>
        </div>
        <div className="codex-panel-actions">
          {run?.status ? (
            <span className={`codex-status-label status-${run.status}`}>
              {displayStatus(run.status)}
            </span>
          ) : null}
          <button
            className="btn btn-link btn-sm codex-icon-button"
            onClick={() => {
              loadRuns().catch(err => {
                setError(err.getUserFacingMessage?.() || getErrorMessage(err))
              })
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
        <aside className="codex-session-list" aria-label="Codex sessions">
          {runs.length ? (
            runs.map(item => (
              <button
                key={item.id}
                className={classNames('codex-session', {
                  active: item.id === run?.id,
                })}
                onClick={() => selectRun(item)}
                type="button"
              >
                <span>{runTitle(item)}</span>
                <small>
                  {compactDate(item.createdAt)} · {displayStatus(item.status)}
                </small>
              </button>
            ))
          ) : (
            <div className="codex-empty-state">No sessions</div>
          )}
        </aside>

        <main className="codex-session-main">
          <div className="codex-tabs" role="tablist">
            {(['activity', 'diff', 'settings'] as ActiveView[]).map(view => (
              <button
                key={view}
                className={classNames('codex-tab', {
                  active: activeView === view,
                })}
                onClick={() => setActiveView(view)}
                type="button"
              >
                {view}
              </button>
            ))}
          </div>

          {activeView === 'activity' ? (
            <div className="codex-activity">
              {run ? (
                <div className="codex-prompt-card">
                  <div className="codex-prompt-meta">
                    <span>{compactDate(run.createdAt)}</span>
                    <span>{displayStatus(run.status)}</span>
                  </div>
                  <div>{run.prompt}</div>
                </div>
              ) : null}
              {run?.status === 'failed' && run.error ? (
                <div className="alert alert-danger codex-run-error">
                  <strong>Run failed</strong>
                  <pre>{run.error}</pre>
                </div>
              ) : null}
              {trajectory.length ? (
                trajectory.map((entry, index) => (
                  <div
                    key={`${entry.id}-${index}`}
                    className={classNames('codex-trajectory-entry', {
                      error: entry.severity === 'error',
                    })}
                  >
                    <MaterialIcon
                      type={iconForEntry(entry)}
                      accessibilityLabel={entry.kind}
                    />
                    <div>
                      <div className="codex-trajectory-title">
                        <strong>{entry.title}</strong>
                        <span>{compactDate(entry.time)}</span>
                      </div>
                      {entry.command ? (
                        <code className="codex-command">{entry.command}</code>
                      ) : null}
                      {entry.detail ? <pre>{entry.detail}</pre> : null}
                    </div>
                  </div>
                ))
              ) : run?.status === 'failed' && run.error ? null : (
                <div className="codex-empty-state">No activity</div>
              )}
            </div>
          ) : null}

          {activeView === 'diff' ? (
            <div className="codex-diff-view">
              {changes.length ? (
                <div className="codex-change-list">
                  {changes.map(change => (
                    <label key={change.projectPath} className="codex-change">
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(change.projectPath)}
                        disabled={change.type !== 'modified' || busy}
                        onChange={() => togglePath(change.projectPath)}
                      />
                      <span>{change.projectPath}</span>
                      <small>{change.type}</small>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="codex-empty-state">No file changes</div>
              )}

              {run?.diff ? (
                <pre className="codex-diff">{run.diff}</pre>
              ) : null}

              <div className="codex-diff-actions">
                {run?.status === 'applied' ? (
                  <span className="codex-apply-note">
                    Applied {run.applied?.length ?? 0} file
                    {(run.applied?.length ?? 0) === 1 ? '' : 's'}
                  </span>
                ) : null}
                {hasApplicableChanges ? (
                  <button
                    className="btn btn-success btn-sm"
                    onClick={applyRun}
                    disabled={busy || selectedPaths.size === 0}
                    type="button"
                  >
                    <MaterialIcon type="check" accessibilityLabel="Apply" />
                    Apply
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeView === 'settings' ? (
            <div className="codex-settings-grid">
              <label>
                <span>Model</span>
                <select
                  className="form-select form-select-sm"
                  value={options.model || ''}
                  onChange={event =>
                    setOptions(current => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  disabled={isRunning}
                >
                  <option value="">Server default</option>
                  {models.map(model => (
                    <option key={model.id} value={model.model}>
                      {model.displayName || model.model}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Effort</span>
                <select
                  className="form-select form-select-sm"
                  value={options.effort || ''}
                  onChange={event =>
                    setOptions(current => ({
                      ...current,
                      effort: event.target.value,
                    }))
                  }
                  disabled={isRunning}
                >
                  {(optionLists?.reasoningEfforts ?? [
                    'minimal',
                    'low',
                    'medium',
                    'high',
                  ]).map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Summary</span>
                <select
                  className="form-select form-select-sm"
                  value={options.summary || 'auto'}
                  onChange={event =>
                    setOptions(current => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                  disabled={isRunning}
                >
                  {(optionLists?.reasoningSummaries ?? [
                    'auto',
                    'concise',
                    'detailed',
                    'none',
                  ]).map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Sandbox</span>
                <select
                  className="form-select form-select-sm"
                  value={options.sandboxMode || 'danger-full-access'}
                  onChange={event =>
                    setOptions(current => ({
                      ...current,
                      sandboxMode: event.target.value,
                    }))
                  }
                  disabled={isRunning}
                >
                  {(optionLists?.sandboxModes ?? [
                    'danger-full-access',
                    'workspace-write',
                    'read-only',
                  ]).map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Approval</span>
                <select
                  className="form-select form-select-sm"
                  value={options.approvalPolicy || 'never'}
                  onChange={event =>
                    setOptions(current => ({
                      ...current,
                      approvalPolicy: event.target.value,
                    }))
                  }
                  disabled={isRunning}
                >
                  {(optionLists?.approvalPolicies ?? [
                    'never',
                    'on-request',
                    'on-failure',
                    'untrusted',
                  ]).map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label className="codex-checkbox-setting">
                <input
                  type="checkbox"
                  checked={Boolean(options.autoApply)}
                  onChange={event =>
                    setOptions(current => ({
                      ...current,
                      autoApply: event.target.checked,
                    }))
                  }
                  disabled={isRunning}
                />
                <span>Auto apply</span>
              </label>
            </div>
          ) : null}
        </main>
      </div>

      <div className="codex-composer">
        <textarea
          className="form-control"
          rows={4}
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          placeholder="Ask Codex to edit this project"
          disabled={busy || isRunning}
        />
        <div className="codex-button-row">
          <button
            className="btn btn-primary btn-sm"
            onClick={startRun}
            disabled={!prompt.trim() || busy || isRunning}
            type="button"
          >
            <MaterialIcon type="play_arrow" accessibilityLabel="Run" />
            Run
          </button>
          {run && isRunning ? (
            <button
              className="btn btn-secondary btn-sm"
              onClick={cancelRun}
              disabled={busy}
              type="button"
            >
              <MaterialIcon type="stop" accessibilityLabel="Cancel" />
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
