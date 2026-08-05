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
- `External`: enter a hosted PostgreSQL connection URL in Settings > Runtime database.

`External` mode accepts a PostgreSQL connection URL in Settings. Local Core verifies it before replacing the last working value, stores it in macOS Keychain, and applies it on runtime restart; the URL is never returned to the renderer or written to Desktop settings. External database mode remains optional, and packaged Desktop defaults to PGlite.

## First-Run Setup

The Vite renderer owns one full-window launch experience from the first frame. The runner is not a prerequisite for setup: Desktop initializes Local Core, settings, secure-storage status, and PGlite first, then either renders onboarding or starts execution for an already completed installation.

- Setup is mandatory and requires one verified model plus one available project folder.
- OpenRouter is presented first as the recommended hosted path; OpenAI and Anthropic are equal alternatives. Ollama and LM Studio are grouped as local providers.
- Provider verification performs the provider's authenticated account check where required, then confirms the selected model through a bounded catalog request without sending an inference request. Local providers are checked only for endpoint reachability and loaded-model availability. Hosted credentials are write-only renderer inputs and are stored only by Local Core in the macOS Keychain.
- Project selection is inspect-then-confirm. Existing Git and non-empty non-Git folders are registered without mutation. Empty folders and Git repositories without a HEAD require an explicit disclosure before Kestrel creates an empty initial commit.
- Non-secret progress is stored in the versioned `DesktopOnboardingRecordV1`. Legacy completion markers remain readable and are dual-written when v1 completion succeeds.
- Runtime startup is deferred until the Review screen. Completion is persisted only after the runner handshake succeeds; a failed handshake preserves the verified provider and project for retry.
- Successful setup persists a stable one-time handoff and opens an empty conversation bound to the selected project and default model. The handoff is acknowledged only after that conversation reaches Local Core UI-state storage, so a crash cannot lose or duplicate it. No tutorial or paid model turn runs automatically.
- Missing credentials or projects after completion route to the relevant repair step. Optional tools, Apps, local execution, MCP, storage, and permissions remain Settings-owned after onboarding.
- The Vite renderer reports a generation-scoped readiness signal only after React commits and the launch stylesheet sentinel is present. Missing assets, renderer crashes, fatal bootstrap reports, and a ten-second bootstrap timeout open the static `boot.html` fallback, which exposes Restart and Diagnostics but no setup actions.

## 0.7 Release Boundaries

- macOS is the first clean-machine proof target.
- Release packaging fails unless the app is Developer ID signed, hardened, notarized, stapled, and accepted by Gatekeeper.
- Updates are manual check, download, and explicit restart/install. Kestrel refuses restart while Desktop or Local Core work is active and never cancels that work to install.
- Local Core owns PGlite storage and execution; Desktop does not launch independent Postgres or runner processes.
- Developer-shell and Docker-backed code capabilities expose their prerequisites and runtime policies in Settings; `kcron` automation remains a companion surface.

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
pnpm run desktop:package:dir
```

Public macOS release package:

```bash
KESTREL_DESKTOP_RELEASE=1 \
KESTREL_DESKTOP_SIGN_IDENTITY="Developer ID Application: ..." \
KESTREL_DESKTOP_NOTARY_PROFILE="kestrel-notary" \
KESTREL_SLACK_MCP_CLIENT_ID="your-pkce-enabled-slack-client-id" \
KESTREL_MICROSOFT_365_CLIENT_ID="your-entra-public-client-id" \
KESTREL_GOOGLE_WORKSPACE_CLIENT_ID="your-google-desktop-client-id" \
pnpm run desktop:package
```

The Slack, Microsoft 365, and Google Workspace client IDs are public application identities, not
credentials. Release packaging embeds them in `app-connections.json`; access
tokens, refresh tokens, and PKCE verifiers remain in Local Core's secure
credential store and are never packaged or returned to the renderer.

`desktop:package-smoke` is an operator-supervised GUI check, not a CI task. It refuses to launch without explicit approval, rejects concurrent smoke runs, closes the launched process in a final cleanup path, and removes isolated state after both success and failure unless retention is explicitly requested for debugging. Local Core daemon children are forced into Electron's Node mode, and Desktop exits immediately if a daemon launch ever reaches application mode. Every run must begin and end with a process-list check.

After producing a signed and notarized DMG, run the separate LaunchServices gate:

```bash
KESTREL_DESKTOP_RELEASE=1 \
KESTREL_DESKTOP_LAUNCH_SERVICES_SMOKE_APPROVED=1 \
pnpm run desktop:launch-services-smoke
```

This supervised macOS-only gate verifies the DMG, mounts it read-only, copies a
uniquely named temporary app into `/Applications`, re-verifies its Developer ID
signature, hardened runtime, stapled ticket, Gatekeeper assessment, bundle
identity, and version, then launches and relaunches it through `/usr/bin/open`.
It uses isolated Desktop and Local Core state, proves a deterministic offline
model turn and persistence across relaunch, writes evidence under
`apps/desktop/out/launch-services-smoke/`, unregisters the temporary app, and
removes only the exact installation it created. It refuses to overwrite an
existing application and is not a CI task.

Desktop update publication has two explicit operator phases:

```bash
# Upload and verify immutable versioned artifacts. This cannot move stable.
pnpm run desktop:upload-update

# After independent inspection and approval, move the stable channel pointer.
KESTREL_DESKTOP_PROMOTION_APPROVED=1 \
KESTREL_DESKTOP_UPDATE_CHANNEL=stable \
pnpm run desktop:promote-update -- --version 0.7.1
```

Upload validates every updater file entry against the local artifact's
base64 SHA-512 digest and byte size before writing any R2 object. It also
requires the legacy `path` and `sha512` fields to agree with the corresponding
file entry.

Promotion reads the immutable staged `latest-mac.yml` from R2, verifies its
hash and complete artifact set against the staged checksums, and uses a
conditional ETag write. It never derives the promoted version from mutable
local build output.

## Related Code

- [Desktop main process](https://github.com/LumiCorp/kestrel/blob/main/apps/desktop/src/main.ts)
- [Vite renderer](https://github.com/LumiCorp/kestrel/blob/main/apps/desktop/renderer/src/DesktopApp.tsx)
- [Typed bridge contract](https://github.com/LumiCorp/kestrel/blob/main/src/desktopShell/contracts.ts)
- [Root README](https://github.com/LumiCorp/kestrel/blob/main/README.md)
