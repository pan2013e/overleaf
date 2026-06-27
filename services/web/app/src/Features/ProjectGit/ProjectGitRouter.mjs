import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../infrastructure/RateLimiter.mjs'
import ProjectGitController from './ProjectGitController.mjs'

const rateLimiters = {
  read: new RateLimiter('project-git-read', {
    points: 60,
    duration: 60,
  }),
  write: new RateLimiter('project-git-write', {
    points: 20,
    duration: 60,
  }),
}

export default {
  apply(webRouter) {
    webRouter.get(
      '/project/:Project_id/git/status',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      RateLimiterMiddleware.rateLimit(rateLimiters.read, {
        params: ['Project_id'],
      }),
      ProjectGitController.getStatus
    )

    webRouter.post(
      '/project/:Project_id/git/init',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.write, {
        params: ['Project_id'],
      }),
      ProjectGitController.init
    )

    webRouter.post(
      '/project/:Project_id/git/import',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.write, {
        params: ['Project_id'],
      }),
      ProjectGitController.importRemote
    )

    webRouter.post(
      '/project/:Project_id/git/remote',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.write, {
        params: ['Project_id'],
      }),
      ProjectGitController.setRemote
    )

    webRouter.post(
      '/project/:Project_id/git/commit',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.write, {
        params: ['Project_id'],
      }),
      ProjectGitController.commit
    )

    webRouter.post(
      '/project/:Project_id/git/pull',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.write, {
        params: ['Project_id'],
      }),
      ProjectGitController.pull
    )

    webRouter.post(
      '/project/:Project_id/git/push',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.write, {
        params: ['Project_id'],
      }),
      ProjectGitController.push
    )
  },
}
