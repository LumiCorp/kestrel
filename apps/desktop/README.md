# `@kestrel/desktop`

Kestrel Desktop is the flagship app in the Kestrel Suite.

It is the main local product surface for workspace-centric agent operation: persistent sessions, operator control, recovery, replay-aware visibility, and day-to-day use without living in the terminal or stitching together browser routes by hand.

## What This App Is

Desktop is the primary local Kestrel experience. It gives users a packaged app for:

- running agent workflows close to local workspace state
- keeping workspace catalog and session continuity visible
- inspecting runtime health, recovery, and operator actions in one place
- using the broader Kestrel runtime without assembling the suite manually

It is not a separate runtime implementation. It is the flagship local product surface on top of Kestrel Local Core and the shared runner/runtime contracts.

## Responsibilities

- present the main packaged user experience for Kestrel
- boot the Electron window and preload bridge
- manage desktop-specific IPC actions such as workspace picking, diagnostics reveal, and opening external URLs
- connect the renderer to Local Core's authenticated execution transport
- load the packaged static Vite renderer without a local web application server
- browse registered project files and launch managed project scripts through typed IPC
- discover local MCP servers without rendering discovered credentials
- expose Local Core readiness, database recovery, support bundle, and runtime reset actions
- inspect and update the authoritative Mission Control task queue and product board through runner-owned project snapshots
- navigate from Mission Control work items into validated runtime thread details and bounded active-run diagnosis, provenance, plan, and replay timelines

## Supporting Architecture

Desktop is implemented as an Electron app over the shared Kestrel surfaces. On startup, it:

- resolves desktop paths and resources
- starts or attaches to Kestrel Local Core
- connects to the execution protocol owned by Local Core
- loads the packaged Vite renderer into a context-isolated Electron window
- exposes capability-scoped, validated operations through the typed preload bridge

The renderer does not receive runner or Local Core credentials. Desktop settings are projected into an explicit non-secret view; hosted provider keys use a write-only IPC command and are never returned to the renderer.

The static renderer owns conversation, Mission Control task and product-board operations, project workspace, local MCP discovery, and diagnostics views. Mission Control reads runner-owned project snapshots, submits validated task and board actions, and projects runner-owned `operator.thread` and `operator.run` views through typed IPC; it does not maintain browser-local runtime state. The legacy embedded Next.js cockpit has been removed, and release checks reject Next.js or hosted-product source in packaged Desktop resources.

## 0.5.1 Upgrade Bridge

The 0.5.1 compatibility release mirrors the existing Desktop cockpit state into Local Core before the renderer moves from embedded Next.js to a static Vite build.

- Compatibility bridge version `2` exposes typed `getUiState` and `syncLegacyUiState` methods.
- The renderer can submit only the documented Desktop, thread, task, composer, theme, and Mission Control storage keys. Unknown keys and non-string values are rejected in the main process.
- Local Core persists the versioned `desktop-ui-state-v1` document at `settings/desktop-ui-state.json` through `/v1/desktop/ui-state`.
- Repeated snapshots with unchanged content are idempotent. The TUI's separate `ui-state.json` is never read or overwritten by this bridge.
- Local Core credentials remain in the Electron main process and are not exposed to the renderer.
- Static renderer bridge version `3` reads the migrated document, persists subsequent Vite-owned state, and adds typed runner commands plus write-only provider credential setup.

## Database Modes

Local Core settings support two database modes:

- `Default`: preserve existing desktop behavior.
  - Desktop uses embedded PGlite owned by Local Core.
  - The 0.6 state epoch is isolated from 0.5 data.
- `External`: use a hosted Postgres `DATABASE_URL` from Settings > Database.

`External` mode requires `DATABASE_URL`. Desktop validates connectivity during runtime startup/restart and surfaces failures through runtime health and recovery flows.

The static renderer shows the active database mode and recovery state but does not yet accept a new external URL. External database mode remains optional; packaged Desktop defaults to PGlite and does not ship a Postgres server.

## First-Run Setup

Packaged Desktop treats first-run onboarding as an explicit choice flow, not a silent OpenRouter default. A public 0.6 artifact must be Developer ID signed and notarized.

- Guided setup requires the user to choose one provider first: `openrouter`, `openai`, `anthropic`, `ollama`, or `lmstudio`.
- Hosted providers require a local desktop-stored API key before runs can start.
- Local providers (`ollama`, `lmstudio`) do not require an API key by default and use local OpenAI-compatible base URLs.
- If onboarding is incomplete, Desktop resumes the first unfinished milestone instead of routing provider setup through the blocked recovery screen.
- The static renderer exposes provider selection and write-only hosted-provider credential setup through Desktop IPC.

## 0.6 Release Boundaries

- macOS is the first clean-machine proof target.
- Release packaging fails unless the app is Developer ID signed, hardened, notarized, stapled, and accepted by Gatekeeper.
- Auto-update is out of scope.
- Local Core owns PGlite storage and execution; Desktop does not launch independent Postgres or runner processes.
- Code/dev-shell workflows and `kcron` automation are companion surfaces, not the default first-run promise.

## Local Development

From the repo root:

```bash
pnpm run desktop:dev
```

Renderer-only browser preview:

```bash
pnpm --filter @kestrel/desktop renderer:dev
```

Build:

```bash
pnpm run desktop:build
```

Package:

```bash
pnpm run desktop:package
```

Public macOS release package:

```bash
KESTREL_DESKTOP_RELEASE=1 \
KESTREL_DESKTOP_SIGN_IDENTITY="Developer ID Application: ..." \
KESTREL_DESKTOP_NOTARY_PROFILE="kestrel-notary" \
pnpm run desktop:package
```

`desktop:package-smoke` is an operator-supervised GUI check, not a CI task. It refuses to launch without explicit approval, rejects concurrent smoke runs, closes the launched process in a final cleanup path, and removes isolated state after both success and failure unless retention is explicitly requested for debugging. Local Core daemon children are forced into Electron's Node mode, and Desktop exits immediately if a daemon launch ever reaches application mode. Every run must begin and end with a process-list check.

## Related Code

- [Desktop main process](https://github.com/LumiCorp/kestrel/blob/main/apps/desktop/src/main.ts)
- [Vite renderer](https://github.com/LumiCorp/kestrel/blob/main/apps/desktop/renderer/src/DesktopApp.tsx)
- [Typed bridge contract](https://github.com/LumiCorp/kestrel/blob/main/src/desktopShell/contracts.ts)
- [Root README](https://github.com/LumiCorp/kestrel/blob/main/README.md)
