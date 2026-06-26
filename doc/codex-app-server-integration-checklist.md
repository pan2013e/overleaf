# Codex App Server Integration Checklist

This checklist tracks the Overleaf Codex integration implementation. The first
implementation uses per-user Codex App Server child processes over stdio, with a
per-user `CODEX_HOME`; the browser only talks to Overleaf.

## Backend Foundation

- [x] Save the implementation plan as a repo checklist.
- [x] Add feature flag and storage settings for Codex.
- [x] Add a per-user Codex App Server process manager.
- [x] Add a JSON-RPC client for App Server requests and notifications.
- [x] Add per-user Codex account endpoints using device-code login.
- [x] Add project-scoped run, status, diff, apply, and cancel endpoints.

## Project Workflow

- [x] Export Overleaf text docs to a temporary filesystem workspace.
- [x] Snapshot exported doc ids, revisions, and content hashes.
- [x] Run Codex turns against the exported workspace.
- [x] Build structured diffs from workspace changes.
- [x] Apply accepted existing-doc edits through document-updater.
- [x] Reject apply when the project changed since the snapshot.

## Safety And Operations

- [x] Keep App Server private to `services/web`.
- [x] Keep one user's `CODEX_HOME`, workspace, and App Server isolated from other users.
- [x] Add per-user and per-project rate limits.
- [x] Avoid logging project text or credentials.
- [x] Add cleanup for temp workspaces and stale child processes.
- [x] Add disconnect flow that logs out and deletes per-user credentials.

## Runtime And Docker

- [x] Use per-user App Server child processes over stdio for the first backend MVP.
- [x] Decide whether production should keep stdio child processes or move to a sidecar with Unix sockets.
- [x] Add Docker image/runtime changes that install the `codex` binary.
- [x] Add deployment documentation for `OVERLEAF_CODEX_ENABLED`, `OVERLEAF_CODEX_BIN`, and `OVERLEAF_CODEX_DATA_DIR`.

## Frontend UX

- [x] Add account settings UI for connecting, viewing, and disconnecting Codex.
- [x] Add device-code login UI that displays `verificationUrl` and `userCode`.
- [x] Add editor-side prompt panel for starting Codex runs.
- [x] Add run progress/events display.
- [x] Add diff review UI.
- [x] Add apply selected changes UI.

## Follow-Up UX And Execution Fixes

- [x] Add project-scoped Codex session history.
- [x] Add user-controllable run parameters for model, reasoning effort,
  reasoning summary, approval policy, sandbox mode, and auto-apply.
- [x] Replace raw event display with a human-readable trajectory stream.
- [x] Persist each run's human-readable trajectory as `trajectory.md` in the
  run workspace directory.
- [x] Detect Docker workspace-write sandbox failures instead of reporting an
  empty successful run.
- [x] Fail no-change edit runs instead of presenting an empty `completed`
  result.
- [x] Serialize structured App Server errors and unknown trajectory items in a
  human-readable form.
- [x] Default the local Docker compose deployment to `danger-full-access`
  sandbox mode so Codex can run commands inside the container.
- [x] Auto-apply changed files by default so completed edit runs update the
  Overleaf project without a second manual click.
- [x] Give the Codex rail a workbench-sized default/minimum width so session
  history, activity, diff, settings, and composer controls are usable.
- [x] Avoid a restored Codex rail tab crashing the editor before
  `react-resizable-panels` registers the dynamic panel id.
- [x] Show failed-run backend errors in the Activity tab instead of an empty
  `No activity` state.
- [x] Suppress the generic external-update modal for Codex-applied document
  edits.

## Verification

- [x] Static syntax check for new backend modules.
- [x] Unit coverage for workspace export, diffing, and apply conflict checks.
- [x] Controller coverage for auth, login, run, and apply paths.
- [x] Manual Docker smoke with a connected Codex account.
- [x] Selenium frontend smoke for account settings and editor rail UI.

Docker smoke evidence:

- Built `overleaf-codex:local` from `server-ce/Dockerfile`; latest verified
  image id: `sha256:a422fbe118c5c554e6103a8c1e1fd15d4a8c6ecfd60912f5e20059eb223d1325`.
- Recreated `sharelatex` with `docker-compose.yml` and `docker-compose.codex.yml`.
- Verified `codex --version` inside the image: `codex-cli 0.142.2`.
- Verified the mounted host Codex home is readable by the `www-data` web
  process after container recreation.
- Verified `GET /status` inside the container returns `200 OK`.
- Verified the deployed authenticated `GET /user/codex/account` route returns
  `200 OK` with a ChatGPT Codex account using a copied host Codex home.
- Installed Selenium 4.45.0 in the host Python user environment and verified a
  headless browser can reach the deployed container.
- Ran a Selenium smoke that created a temporary Overleaf user and project,
  activated the user in the browser, opened the project editor, opened the
  Codex rail panel, verified session history, activity/diff/settings tabs,
  model/effort/summary/sandbox/approval/auto-apply controls, entered a prompt,
  and verified the Run button enables.
- Verified the Codex rail opens at a usable workbench width in Selenium:
  `.codex-session-main` measured about `418px` wide at a `1440px` viewport,
  with the session history stacked above the active view.
- Verified a restored Codex rail tab can open the editor without the generic
  error screen after redeploy.
- Verified a final browser-submitted Codex turn on image
  `sha256:a422fbe118c5c554e6103a8c1e1fd15d4a8c6ecfd60912f5e20059eb223d1325`
  reached `applied`, rendered 36 trajectory entries, updated `main.tex`, and
  did not show the generic external-update modal.
- Exercised a real deployed Codex turn against the test project
  `6a3d8b55ac2743f0dbf9f491`: prompt
  `Write some random text in the Introduction section.` completed with status
  `applied`, one modified change for `/main.tex`, and an inserted sentence in
  the live Overleaf document.
- Verified the real run persisted a readable trajectory file at
  `/var/lib/overleaf/codex/users/6a3d8b55ac2743f0dbf9f485/workspaces/281aa484-2208-49b6-b6be-bfee0623d7b6/trajectory.md`.
- Verified the final deployed trajectory formatter serializes unknown App
  Server item types as structured JSON instead of opaque `Item completed`
  entries.
