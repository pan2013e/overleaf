# Overleaf With Codex

An AI-assisted fork of Overleaf Community Edition for writing, editing, and
maintaining LaTeX projects with Codex directly inside the editor.

This fork keeps the familiar Overleaf editing experience and adds a modern
Codex workspace: chat with your project, apply changes automatically, review
structured diffs, bring in selected editor or PDF context, and manage source
control without leaving the document.

> This project is based on
> [Overleaf Community Edition](https://github.com/overleaf/overleaf). For the
> original project, official installation flow, and upstream documentation, see
> the [Overleaf repository](https://github.com/overleaf/overleaf),
> [Overleaf Toolkit](https://github.com/overleaf/toolkit/), and
> [official docs](https://docs.overleaf.com/).

## Why This Fork

LaTeX projects are rarely just text. They include figures, references, build
errors, document history, source control, reviewer comments, and many small
editing decisions. This fork brings Codex into that workflow as a project-aware
assistant rather than a separate chat window.

Use it to ask for focused edits, explain parts of a paper, clean up LaTeX,
inspect files, make changes across a project, and keep the PDF moving while you
stay in the Overleaf editor.

## Highlights

### Codex In The Editor

Open the Codex rail beside your source and PDF preview. Start a session, ask for
an edit or explanation, then keep working with follow-ups in the same context.

- Project-aware chat for LaTeX documents.
- Session navigator for previous Codex work.
- Follow-up messages during or after a run.
- Slash commands for Codex status and session control.
- `@` file references in the composer.

### Context From What You See

Turn selected text into prompt context without copying and pasting manually.
Selections from the source editor or PDF preview can be attached with file and
location information, so Codex knows what part of the project you mean.

### Changes You Can Trust

Codex edits are auto-applied to the Overleaf project, then shown as structured,
session-specific diffs. The Changes panel is read-only by design: it is for
reviewing what changed, not juggling patch state.

- Themed diff hunks instead of raw patch text.
- Session-scoped change summaries.
- Automatic PDF recompilation after edits.
- Clickable file links in Codex responses.

### Activity That Reads Like Work

The activity stream is designed for humans, not raw event logs. Long runs fold
intermediate steps behind a concise completion summary while keeping the user
prompt and final answer visible.

- Markdown and code block rendering.
- Syntax highlighting and compact code styling.
- Distinct final answers.
- Dark-mode aware Codex UI.
- Back-to-bottom control for long sessions.

### Source Control Built In

Project Git is a standalone rail panel, independent from Codex. Initialize a
repo, import from a remote, inspect changes, commit, pull, and push from inside
Overleaf.

## Built For Local And Private Workflows

This fork is aimed at trusted local development and private team deployments.
Codex is designed with practical guardrails for project editing, while keeping
the deployment story simple for local and private environments. For
production-style use, read the deployment and security notes before exposing the
service to others.

## Get Started

For platform-specific Docker setup, use the deployment guide:

- [Docker Deployment Guide](doc/docker-deployment.md)

For feature-specific implementation and operating notes:

- [Codex App Server Deployment Notes](doc/codex-app-server-deployment.md)
- [Project Git Integration](doc/project-git-integration.md)
- [Codex Integration Checklist](doc/codex-app-server-integration-checklist.md)

The deployment guide covers Docker builds, platform-specific compose overlays,
credential setup, and troubleshooting.

## Original Overleaf Resources

This repository does not replace the upstream Overleaf documentation. Use these
for the original Community Edition project, upgrade notes, and general Overleaf
operations:

- [Original Overleaf repository](https://github.com/overleaf/overleaf)
- [Overleaf Toolkit](https://github.com/overleaf/toolkit/)
- [Overleaf wiki](https://github.com/overleaf/overleaf/wiki)
- [Official Overleaf documentation](https://docs.overleaf.com/)

## Security Notice

Overleaf Community Edition is intended for environments where all users are
trusted. This fork inherits that assumption. Do not expose shared Codex host
credentials or an unreviewed local deployment to untrusted users.

For shared use, require HTTPS, restrict access, keep Codex credentials private,
and follow the guidance in [Docker Deployment Guide](doc/docker-deployment.md).

## License

This repository follows the upstream Overleaf license. The code is released
under the GNU Affero General Public License, version 3. See [LICENSE](LICENSE).

Original copyright: Overleaf, 2014-2025.
