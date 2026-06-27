# Codex App Server Deployment Notes

The Codex integration is disabled by default. Enable it only in environments
where the `services/web` runtime has a working `codex` binary and can persist
per-user Codex credentials securely.

For end-to-end Docker setup instructions across macOS, Linux, WSL2, and remote
Linux deployments, see `doc/docker-deployment.md`.

## Runtime Model

The current implementation starts a Codex App Server child process from
`services/web` for each active Overleaf user. The child process communicates
with `services/web` over stdio, so no Codex App Server TCP listener is exposed.

Each user gets an isolated runtime directory:

```text
<OVERLEAF_CODEX_DATA_DIR>/users/<overleaf-user-id>/
  CODEX_HOME/
  workspaces/
```

`CODEX_HOME` contains Codex-managed credentials after device-code login. Treat
this directory as credential storage: keep it private to the web runtime user,
exclude it from logs and backups unless backups are encrypted, and delete it on
user disconnect.

## Required Configuration

```text
OVERLEAF_CODEX_ENABLED=true
OVERLEAF_CODEX_BIN=codex
OVERLEAF_CODEX_DATA_DIR=/var/lib/overleaf/codex
```

Optional limits:

```text
OVERLEAF_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS=30000
OVERLEAF_CODEX_APP_SERVER_IDLE_TIMEOUT_MS=1800000
OVERLEAF_CODEX_WORKSPACE_TTL_MS=86400000
OVERLEAF_CODEX_RUN_TIMEOUT_MS=600000
OVERLEAF_CODEX_MAX_DOCS=200
OVERLEAF_CODEX_MAX_PROJECT_BYTES=2097152
```

Optional local smoke-test shortcut:

```text
OVERLEAF_CODEX_HOST_CREDENTIALS_HOME=/host-codex-home
```

When set, `services/web` uses that directory as `CODEX_HOME` instead of a
per-user credential directory. This is intended only for local automated testing
with a mounted host `~/.codex`; it shares one Codex identity across Overleaf
users and should not be used for production.

## Docker Requirements

The Community Edition image installs the Codex CLI/App Server package with:

```dockerfile
ARG CODEX_NPM_PACKAGE=@openai/codex
RUN npm install -g "$CODEX_NPM_PACKAGE"
```

Override `CODEX_NPM_PACKAGE` at build time to pin a specific package version.
The Codex data directory must be backed by a persistent volume if users should
stay connected across web container restarts.

For local host-credential smoke tests, mount a copied Codex credential
directory:

```yaml
services:
  sharelatex:
    image: overleaf-codex:local
    environment:
      OVERLEAF_CODEX_ENABLED: "true"
      OVERLEAF_CODEX_DATA_DIR: /var/lib/overleaf/codex
      OVERLEAF_CODEX_HOST_CREDENTIALS_HOME: /host-codex-home
      OVERLEAF_INVITE_TOKEN_SECRET: "local-codex-smoke-invite-token-secret-change-me"
    volumes:
      - ${OVERLEAF_CODEX_HOST_CREDENTIALS_SOURCE:-/tmp/overleaf-codex-home}:/host-codex-home:rw
```

Avoid bind-mounting the live `~/.codex` directory while the host Codex app is
running. The live directory contains SQLite runtime databases that can be noisy
or unsafe to share with the container. A minimal credential copy is enough for
local smoke tests:

```bash
rm -rf /tmp/overleaf-codex-home
mkdir -p /tmp/overleaf-codex-home
cp ~/.codex/auth.json ~/.codex/config.toml /tmp/overleaf-codex-home/
docker run --rm -v /tmp/overleaf-codex-home:/codex-home overleaf-codex:local \
  chown -R 33:33 /codex-home
```

If browser-started runs fail with `Permission denied` for
`/host-codex-home/config.toml`, repair the copied credential directory before
restarting or retrying:

```bash
docker exec sharelatex chown -R 33:33 /host-codex-home
```

This can happen if a root-owned `docker exec` smoke test writes to the mounted
Codex home. Browser runs execute Codex through the `www-data` web process.

The repository includes `docker-compose.codex.yml` with these local smoke-test
settings. Use it together with the default compose file after building
`overleaf-codex:local`. Set `OVERLEAF_CODEX_HOST_CREDENTIALS_SOURCE` if the
copied credential directory lives somewhere other than `/tmp/overleaf-codex-home`.

For a later production hardening pass, consider moving Codex execution into a
separate sidecar or runner service with a Unix socket transport. The current
stdio child-process model is simpler and keeps the first integration private to
`services/web`.

## Relationship To Project Git

Project Git is a standalone source-control feature, not part of Codex. Codex
owns AI-assisted editing and automatically applies approved workspace changes;
Project Git owns repository initialization, remote URLs, commits, pulls, pushes,
and Git diff/status display.

Configure Project Git separately:

```text
OVERLEAF_PROJECT_GIT_DATA_DIR=/var/lib/overleaf/project-git
OVERLEAF_PROJECT_GIT_MAX_PROJECT_BYTES=10485760
```

See `doc/project-git-integration.md` for the current Project Git behavior and
limits.
