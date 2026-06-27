# Project Git Integration

The project Git integration is a standalone editor feature. It is intentionally
separate from Codex: Codex can edit project files, while Project Git owns source
control state, remotes, commits, pulls, and pushes.

## Runtime Model

Each Overleaf project can have a persistent Git working tree under:

```text
<OVERLEAF_PROJECT_GIT_DATA_DIR>/projects/<project-id>/repo/
```

The backend mirrors Overleaf text documents into that working tree before
status and commit operations. Git operations run through `execFile`, not a
shell.

## Configuration

```text
OVERLEAF_PROJECT_GIT_DATA_DIR=/var/lib/overleaf/project-git
OVERLEAF_PROJECT_GIT_MAX_PROJECT_BYTES=10485760
```

If `OVERLEAF_PROJECT_GIT_DATA_DIR` is not set, the web service uses
`services/web/data/project-git`.

## Supported Operations

- Initialize a project repository from the current Overleaf text documents.
- Import a remote Git repository and add supported text files to the Overleaf
  project.
- Set or update the `origin` remote URL.
- View branch state, recent commits, changed files, and a themed diff preview.
- Commit current Overleaf text document changes.
- Pull with `--ff-only` after the working tree is clean, then import supported
  text files into Overleaf.
- Push the current branch to `origin`.

## Current Limits

- The first implementation manages text files only. Binary files may remain in
  the Git working tree after import, but they are not imported into the Overleaf
  editor.
- Pull requires a clean working tree. Users should commit Overleaf changes
  before pulling.
- Remote authentication depends on the runtime Git environment. No credential UI
  is implemented yet.
- Deletions from remote repositories are not aggressively mirrored into Overleaf
  during import/pull; the first slice favors avoiding destructive project edits.
