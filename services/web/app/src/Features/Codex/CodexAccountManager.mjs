import CodexProcessManager from './CodexProcessManager.mjs'

async function readAccount(userId, { refreshToken = false } = {}) {
  const client = await CodexProcessManager.getClient(userId)
  return await client.request('account/read', { refreshToken })
}

async function startDeviceLogin(userId) {
  const client = await CodexProcessManager.getClient(userId)
  return await client.request('account/login/start', {
    type: 'chatgptDeviceCode',
  })
}

async function cancelLogin(userId, loginId) {
  const client = await CodexProcessManager.getClient(userId)
  return await client.request('account/login/cancel', { loginId })
}

async function logout(userId) {
  await CodexProcessManager.logoutAndDelete(userId)
  return {}
}

async function readRateLimits(userId) {
  const client = await CodexProcessManager.getClient(userId)
  return await client.request('account/rateLimits/read')
}

async function listModels(userId) {
  const client = await CodexProcessManager.getClient(userId)
  return await client.request('model/list', {
    limit: 50,
    includeHidden: false,
  })
}

export default {
  readAccount,
  startDeviceLogin,
  cancelLogin,
  logout,
  readRateLimits,
  listModels,
}
