# Docker Deployment Guide

This guide describes how to run this fork of Overleaf Community Edition with
the Codex and Project Git features enabled. It is focused on local testing and
development, but the same image and environment variables can be adapted for a
trusted private deployment.

For the original upstream Overleaf installation flow, see the
[Overleaf Toolkit](https://github.com/overleaf/toolkit/) and the
[upstream Overleaf repository](https://github.com/overleaf/overleaf).

## What Runs

The compose setup starts:

- `sharelatex`: the Overleaf web/runtime container.
- `mongo`: the Overleaf database.
- `redis`: the Overleaf cache/session backend.

This fork builds a custom `sharelatex` image named `overleaf-codex:local`. The
image includes the Codex CLI/App Server runtime and the frontend/backend changes
for the Codex rail panel and standalone Project Git rail panel.

## Security Model

Overleaf Community Edition is intended for trusted users. It does not provide
Server Pro sandboxed compiles.

The Codex integration is also intended for trusted local or private use:

- Codex runs in an exported project workspace, not directly in the Overleaf data
  directory.
- The backend enforces `workspace-write` sandbox mode by default.
- Approval mode is `on-request`.
- Network access is enabled by default.
- Commands matching `OVERLEAF_CODEX_BLOCKED_COMMAND_PATTERNS` are rejected
  before execution.
- Local smoke-test credential sharing mounts one copied Codex credential
  directory into the container. Do not use shared host credentials for a
  multi-user or production deployment.

## Requirements

- Docker with Compose v2.
- Git.
- At least 8 GB RAM available to Docker for comfortable builds.
- A local Codex login if you want to use the host-credential smoke-test path.

Check your Docker setup:

```bash
docker version
docker compose version
```

## Build The Image

From the repository root:

```bash
docker build \
  -f server-ce/Dockerfile \
  -t overleaf-codex:local \
  .
```

To pin a Codex package version:

```bash
docker build \
  -f server-ce/Dockerfile \
  --build-arg CODEX_NPM_PACKAGE=@openai/codex@0.142.2 \
  -t overleaf-codex:local \
  .
```

If you already have or want to build a matching base image, pass
`OVERLEAF_BASE_TAG`:

```bash
docker build \
  -f server-ce/Dockerfile-base \
  -t overleaf-base-codex:local \
  .

docker build \
  -f server-ce/Dockerfile \
  --build-arg OVERLEAF_BASE_TAG=overleaf-base-codex:local \
  -t overleaf-codex:local \
  .
```

## Prepare Local Codex Credentials

For local testing, copy the host Codex credentials into a temporary directory
and mount the copy into the `sharelatex` container. This avoids bind-mounting a
live `~/.codex` directory with runtime database files.

```bash
rm -rf /tmp/overleaf-codex-home
mkdir -p /tmp/overleaf-codex-home
cp ~/.codex/auth.json ~/.codex/config.toml /tmp/overleaf-codex-home/

docker run --rm \
  -v /tmp/overleaf-codex-home:/codex-home \
  overleaf-codex:local \
  chown -R 33:33 /codex-home
```

If your copied credential directory lives elsewhere:

```bash
export OVERLEAF_CODEX_HOST_CREDENTIALS_SOURCE=/absolute/path/to/copied-codex-home
```

For a real multi-user deployment, omit
`OVERLEAF_CODEX_HOST_CREDENTIALS_HOME` and let each Overleaf user connect their
own Codex account through the app.

## Platform: macOS With OrbStack

OrbStack is the recommended local backend for this repository on macOS because
it starts quickly and works well with bind mounts.

Build:

```bash
docker build \
  -f server-ce/Dockerfile \
  -t overleaf-codex:local \
  .
```

Start:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  -f docker-compose.orbstack.yml \
  up -d
```

Open:

```text
http://127.0.0.1:8080
```

The OrbStack overlay does three things:

- Adds `8080:80`, because host port 80 can be intercepted on macOS.
- Sets `security_opt: seccomp=unconfined`, which is needed for Codex
  `workspace-write` sandboxing under OrbStack.
- Pins Mongo to `mongo:8.0.17` to avoid current OrbStack kernel compatibility
  issues with some `mongo:8.0` image resolutions.

Stop:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  -f docker-compose.orbstack.yml \
  down
```

## Platform: macOS With Docker Desktop

Docker Desktop works for local development. Give Docker Desktop enough memory
for the image build and first startup.

Start with the Codex overlay:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  up -d
```

Open:

```text
http://127.0.0.1
```

If port 80 is unavailable, add a local override file such as
`docker-compose.local.yml`:

```yaml
services:
  sharelatex:
    ports:
      - 8080:80
```

Then start with:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  -f docker-compose.local.yml \
  up -d
```

If Codex runs fail with namespace or sandbox errors, add the same seccomp option
used by the OrbStack overlay:

```yaml
services:
  sharelatex:
    security_opt:
      - seccomp=unconfined
```

## Platform: Linux With Docker Engine

Install Docker Engine and the Compose plugin through your distribution package
manager or Docker's official packages.

Create persistent directories if you want explicit host paths:

```bash
mkdir -p ~/sharelatex_data ~/mongo_data ~/redis_data
```

Start:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  up -d
```

Open:

```text
http://localhost
```

If port 80 requires rootless Docker changes or conflicts with another service,
use a local override:

```yaml
services:
  sharelatex:
    ports:
      - 8080:80
```

Then open `http://localhost:8080`.

If Codex sandboxing fails because unprivileged user namespaces are disabled,
enable them on the host or use a trusted-development override with
`seccomp=unconfined`.

Example namespace check:

```bash
sysctl kernel.unprivileged_userns_clone
```

## Platform: Windows With WSL2

Use WSL2 with a Linux distribution such as Ubuntu. Run Docker either through
Docker Desktop's WSL integration or through Docker Engine installed inside WSL.

Recommended flow:

1. Clone this repository inside the WSL filesystem, not under `/mnt/c`, for much
   faster builds and file watching.
2. Build `overleaf-codex:local` from inside WSL.
3. Copy Codex credentials into a WSL path if using host-credential testing.
4. Start compose from inside WSL.

Commands:

```bash
docker build \
  -f server-ce/Dockerfile \
  -t overleaf-codex:local \
  .

docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  up -d
```

Open from Windows:

```text
http://localhost
```

Use a port override if Windows already owns port 80.

## Platform: Remote Linux Server

For a small trusted team, build or push `overleaf-codex:local` to the server and
run Compose there.

Minimum hardening checklist:

- Set a real `OVERLEAF_INVITE_TOKEN_SECRET`.
- Put Overleaf behind HTTPS using a reverse proxy.
- Use persistent volumes for `/var/lib/overleaf`, Mongo, Redis, Codex data, and
  Project Git data.
- Do not use `OVERLEAF_CODEX_HOST_CREDENTIALS_HOME`.
- Back up `/var/lib/overleaf`, Mongo, and Codex credential data with encryption.
- Keep access limited to trusted users.

Example production-style override:

```yaml
services:
  sharelatex:
    image: overleaf-codex:local
    environment:
      OVERLEAF_SITE_URL: https://overleaf.example.com
      OVERLEAF_CODEX_ENABLED: "true"
      OVERLEAF_CODEX_DATA_DIR: /var/lib/overleaf/codex
      OVERLEAF_PROJECT_GIT_DATA_DIR: /var/lib/overleaf/project-git
      OVERLEAF_CODEX_APPROVAL_POLICY: on-request
      OVERLEAF_CODEX_SANDBOX_MODE: workspace-write
      OVERLEAF_CODEX_NETWORK_ACCESS: "true"
      OVERLEAF_INVITE_TOKEN_SECRET: replace-with-a-long-random-secret
```

Generate the invite secret:

```bash
openssl rand -base64 32
```

## Compose Overlays

Base Overleaf:

```bash
docker compose -f docker-compose.yml up -d
```

Codex and Project Git enabled:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  up -d
```

Codex and Project Git enabled on OrbStack:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  -f docker-compose.orbstack.yml \
  up -d
```

## Important Environment Variables

Codex:

```text
OVERLEAF_CODEX_ENABLED=true
OVERLEAF_CODEX_BIN=codex
OVERLEAF_CODEX_DATA_DIR=/var/lib/overleaf/codex
OVERLEAF_CODEX_APPROVAL_POLICY=on-request
OVERLEAF_CODEX_SANDBOX_MODE=workspace-write
OVERLEAF_CODEX_NETWORK_ACCESS=true
OVERLEAF_CODEX_AUTO_APPLY=true
OVERLEAF_CODEX_MODEL=
OVERLEAF_CODEX_REASONING_EFFORT=medium
OVERLEAF_CODEX_REASONING_SUMMARY=auto
OVERLEAF_CODEX_BLOCKED_COMMAND_PATTERNS=
```

Codex local credential sharing:

```text
OVERLEAF_CODEX_HOST_CREDENTIALS_HOME=/host-codex-home
OVERLEAF_CODEX_HOST_CREDENTIALS_SOURCE=/tmp/overleaf-codex-home
```

Project Git:

```text
OVERLEAF_PROJECT_GIT_DATA_DIR=/var/lib/overleaf/project-git
OVERLEAF_PROJECT_GIT_MAX_PROJECT_BYTES=10485760
```

Resource limits:

```text
OVERLEAF_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS=30000
OVERLEAF_CODEX_APP_SERVER_IDLE_TIMEOUT_MS=1800000
OVERLEAF_CODEX_WORKSPACE_TTL_MS=86400000
OVERLEAF_CODEX_RUN_TIMEOUT_MS=600000
OVERLEAF_CODEX_MAX_DOCS=200
OVERLEAF_CODEX_MAX_PROJECT_BYTES=2097152
```

## First-Run Checklist

1. Build `overleaf-codex:local`.
2. Prepare copied Codex credentials, or plan to connect Codex from inside
   Overleaf after login.
3. Start Compose with the correct platform overlays.
4. Open the Overleaf URL.
5. Register or log in.
6. Open a project.
7. Open the Codex rail panel.
8. Start a new session or select a previous session.
9. Open Source Control if you want to initialize or import a Git repository.

## Useful Commands

Show container status:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  ps
```

Follow logs:

```bash
docker logs -f sharelatex
```

Check Codex in the container:

```bash
docker exec sharelatex bash -lc 'codex --version'
```

Check the web route:

```bash
curl -I http://127.0.0.1:8080/status
```

Repair local copied Codex credential permissions:

```bash
docker exec sharelatex chown -R 33:33 /host-codex-home
```

Rebuild and restart after code changes:

```bash
docker build \
  -f server-ce/Dockerfile \
  -t overleaf-codex:local \
  .

docker compose \
  -f docker-compose.yml \
  -f docker-compose.codex.yml \
  -f docker-compose.orbstack.yml \
  up -d sharelatex
```

## Troubleshooting

### `sharelatex` shows `502 Bad Gateway`

The web service is still starting or crashed. Check:

```bash
docker logs --tail 200 sharelatex
```

### Browser redirects to `/login` after restart

Container recreation can invalidate local sessions. Log in again.

### Codex cannot read `/host-codex-home/config.toml`

Fix ownership:

```bash
docker exec sharelatex chown -R 33:33 /host-codex-home
```

### Codex reports sandbox or namespace failures

Use `workspace-write` sandbox mode and verify the Docker backend permits
unprivileged user namespaces. On OrbStack, include
`docker-compose.orbstack.yml`.

### Mongo fails on OrbStack

Use `docker-compose.orbstack.yml`, which pins Mongo to `mongo:8.0.17`.

### Port 80 is unavailable

Use a compose override mapping `8080:80`, then open
`http://127.0.0.1:8080`.

### Project Git cannot push or pull

Remote authentication is provided by the runtime Git environment. Configure
SSH keys, HTTPS credentials, or a credential helper inside the container/runtime
environment before using authenticated remotes.
