import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJSON, postJSON, FetchError } from '@/infrastructure/fetch-json'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'

type CodexAccount = {
  type: string
  email?: string
  planType?: string
  credentialSource?: string
}

type CodexAccountState = {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

type CodexLogin = {
  type: 'chatgptDeviceCode'
  loginId: string
  verificationUrl: string
  userCode: string
}

function getErrorMessage(error: unknown) {
  if (error instanceof FetchError) {
    return error.getUserFacingMessage()
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Something went wrong. Please try again.'
}

function getAccountLabel(account: CodexAccount | null) {
  if (!account) {
    return 'Not connected'
  }
  if (account.email) {
    return account.planType
      ? `${account.email} (${account.planType})`
      : account.email
  }
  if (account.type === 'amazonBedrock' && account.credentialSource) {
    return `Amazon Bedrock (${account.credentialSource})`
  }
  return account.type
}

export default function CodexAccountSettings() {
  const { codexEnabled } = getMeta('ol-ExposedSettings')
  const [accountState, setAccountState] = useState<CodexAccountState | null>(
    null
  )
  const [login, setLogin] = useState<CodexLogin | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account = accountState?.account ?? null
  const accountLabel = useMemo(() => getAccountLabel(account), [account])

  const refreshAccount = useCallback(async () => {
    const nextState = await getJSON<CodexAccountState>('/user/codex/account')
    setAccountState(nextState)
    if (nextState.account) {
      setLogin(null)
    }
    return nextState
  }, [])

  useEffect(() => {
    if (!codexEnabled) {
      return
    }
    refreshAccount().catch(err => {
      setError(getErrorMessage(err))
    })
  }, [codexEnabled, refreshAccount])

  useEffect(() => {
    if (!login) {
      return
    }
    const interval = window.setInterval(() => {
      refreshAccount().catch(err => {
        setError(getErrorMessage(err))
      })
    }, 3000)
    return () => window.clearInterval(interval)
  }, [login, refreshAccount])

  const startLogin = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const nextLogin = await postJSON<CodexLogin>('/user/codex/login/start')
      setLogin(nextLogin)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const cancelLogin = useCallback(async () => {
    if (!login) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await postJSON('/user/codex/login/cancel', {
        body: { loginId: login.loginId },
      })
      setLogin(null)
      await refreshAccount()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [login, refreshAccount])

  const disconnect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await postJSON('/user/codex/logout')
      setLogin(null)
      await refreshAccount()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [refreshAccount])

  if (!codexEnabled) {
    return null
  }

  return (
    <>
      <h3 id="codex">Codex</h3>
      <div className="settings-widgets-container codex-settings-container">
        <div className="settings-widget-container codex-settings-widget">
          <div>
            <MaterialIcon type="smart_toy" unfilled />
          </div>
          <div className="description-container">
            <div className="title-row">
              <h4>Codex</h4>
            </div>
            <p className="small">{accountLabel}</p>
            {accountState?.requiresOpenaiAuth === false && !account ? (
              <p className="small">OpenAI credentials are not required.</p>
            ) : null}
            {login ? (
              <div className="codex-device-login">
                <a
                  href={login.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {login.verificationUrl}
                </a>
                <div className="codex-device-code">{login.userCode}</div>
              </div>
            ) : null}
            {error ? <p className="text-danger small">{error}</p> : null}
          </div>
          <div className="codex-settings-actions">
            {login ? (
              <>
                <OLButton
                  variant="secondary"
                  href={login.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </OLButton>
                <OLButton
                  variant="secondary"
                  onClick={cancelLogin}
                  disabled={busy}
                >
                  Cancel
                </OLButton>
              </>
            ) : account ? (
              <OLButton
                variant="danger-ghost"
                onClick={disconnect}
                disabled={busy}
              >
                Disconnect
              </OLButton>
            ) : (
              <OLButton
                variant="secondary"
                onClick={startLogin}
                disabled={busy}
              >
                Connect
              </OLButton>
            )}
          </div>
        </div>
      </div>
      <hr />
    </>
  )
}
