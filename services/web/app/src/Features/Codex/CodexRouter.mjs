import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../infrastructure/RateLimiter.mjs'
import CodexController from './CodexController.mjs'

const rateLimiters = {
  account: new RateLimiter('codex-account', {
    points: 30,
    duration: 60,
  }),
  login: new RateLimiter('codex-login', {
    points: 5,
    duration: 60,
  }),
  run: new RateLimiter('codex-run', {
    points: 10,
    duration: 60,
  }),
  apply: new RateLimiter('codex-apply', {
    points: 20,
    duration: 60,
  }),
}

export default {
  apply(webRouter) {
    webRouter.get(
      '/user/codex/account',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.account),
      CodexController.getAccount
    )
    webRouter.get(
      '/user/codex/models',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.account),
      CodexController.getModels
    )
    webRouter.get(
      '/user/codex/options',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.account),
      CodexController.getOptions
    )
    webRouter.post(
      '/user/codex/login/start',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.login),
      CodexController.startLogin
    )
    webRouter.post(
      '/user/codex/login/cancel',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.login),
      CodexController.cancelLogin
    )
    webRouter.post(
      '/user/codex/logout',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.account),
      CodexController.logout
    )

    webRouter.post(
      '/project/:Project_id/codex/runs',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      RateLimiterMiddleware.rateLimit(rateLimiters.run, {
        params: ['Project_id'],
      }),
      CodexController.startRun
    )
    webRouter.get(
      '/project/:Project_id/codex/runs',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      CodexController.listRuns
    )
    webRouter.get(
      '/project/:Project_id/codex/runs/:runId',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      CodexController.getRun
    )
    webRouter.get(
      '/project/:Project_id/codex/runs/:runId/events',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      CodexController.getRunEvents
    )
    webRouter.get(
      '/project/:Project_id/codex/runs/:runId/diff',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      CodexController.getRunDiff
    )
    webRouter.post(
      '/project/:Project_id/codex/runs/:runId/apply',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.apply, {
        params: ['Project_id'],
      }),
      CodexController.applyRun
    )
    webRouter.post(
      '/project/:Project_id/codex/runs/:runId/cancel',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      CodexController.cancelRun
    )
  },
}
