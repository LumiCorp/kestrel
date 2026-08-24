---
id: cli-kchat-guide
domain: cli
status: active
owner: kestrel-cli
last_verified_at: 2026-08-18
depends_on: [../index.md]
---

# CLI Terminal Client

The CLI terminal client is an interactive terminal chat interface for Kestrel agents.
It now opens with a branded `KESTREL` splash and then renders an editorial chat cockpit by default:

- `conversation`: cleaner assistant/user/system message cards
- `status and updates`: compact session state, latest activity, and command hints
- `compose`: anchored multiline prompt with inline progress or wait context

Advanced screens remain on demand through the command palette (`:`):

- `sessions`: browse and switch sessions
- `activity feed`: inspect run log events (`run_started`, `step_started`, `step_committed`, terminal events, policy checkpoints, quality summaries)

The CLI runs as a thin client over Local Core's authenticated Unix-domain socket.
Workspace setup and scheduling guide: [docs/cli/workspaces.md](https://github.com/LumiCorp/kestrel/blob/main/docs/cli/workspaces.md).

## Launch

- Local dev: `pnpm run tui`
- Public install: `npm install -g @kestrel-agents/kestrel@0.8.8`
- Secondary macOS archive: `kestrel-cli-0.8.5-darwin-arm64.tar.gz`
- Packaged CLI bins: `kestrel`, `ks`, `kcron`
- Contributor shims: `pnpm run install:cli`

The npm package is canonical and supports Node.js 22 on verified macOS arm64
and Linux x64 environments. The secondary macOS arm64 archive contains
`bin/` launchers and a bundled `libexec/` runtime, uses the system Node runtime,
and does not require a repo checkout or repository `.env` file.

`pnpm run install:cli` remains a contributor convenience. It installs source-backed shims over the current checkout and should not be described as the external release install path.
The shims fingerprint the executable Local Core inputs on every new CLI process.
If the running daemon has a different build, an idle daemon is replaced
gracefully. Active work is never cancelled; the CLI reports the lifecycle
blockers and directs the operator to the waiting restart command.

Optional flags:

- `--profile <id>`
- `--session <name>`

Command mode:

- `kestrel core status` inspects the daemon and build identity without starting it
- `kestrel core restart` restarts an idle daemon or starts a stopped daemon
- `kestrel core restart --wait` waits until active work completes, then restarts
- `kestrel workspace status|list`
- `kestrel web [--host <host>] [--port <port>] [--token <token>]`
- `kcron start|stop|status|run-once|install|uninstall` for beta local scheduling

An already-open TUI is not hot-reloaded after a source edit. Build reconciliation
runs on a new CLI invocation, a Desktop connection or reconnection, or an
explicit `kestrel core restart`.

Release checks:

- `pnpm run cli:package`
- `pnpm run cli:release-check`

## Local Web Runner

Use `kestrel web` when a trusted local server-side integration needs TCP access to the same Local Core authority.

Behavior:

- starts an authenticated HTTP proxy to Local Core and keeps the proxy process attached
- binds to `127.0.0.1:43102` by default
- accepts overrides through `--host`, `--port`, `--token` or the corresponding `KESTREL_RUNNER_SERVICE_*` env vars
- generates a local auth token automatically when one is not supplied
- prints copy/paste-ready exports for `KESTREL_RUNNER_SERVICE_URL` and `KESTREL_RUNNER_SERVICE_TOKEN`
- leaves Local Core and durable runs alive when the proxy exits or shuts down on `Ctrl+C`

Example:

```bash
kestrel web
export KESTREL_RUNNER_SERVICE_URL='http://127.0.0.1:43102'
export KESTREL_RUNNER_SERVICE_TOKEN='...'
```

## Commands

- `/help`
- `/profiles`
- `/theme`
- `/new <name>`
- `/sessions`
- `/switch <name>`
- `/resume <name>`
- `/status`
- `/steer <message>` queues a durable follow-up for the focused thread and applies it at the next execution boundary
- `/stop [message]` cancels the active run and queues a stop-and-wait steer for the focused thread
- `/mcp ...`
- `/code ...`
- `/quit`

## Navigation

- `Space` dismiss the launch splash
- `F1` open keyboard help overlay
- `Ctrl+P` open command palette
- `Ctrl+F` contextual search (sessions/activity screens)
- `?` still opens help when not focused in composer

## Profiles (v10)

Profiles are loaded from `~/.kestrel/profiles.json` and bootstrapped automatically on first run.
Workspace catalog entries do not override the active profile.

V10 contains one canonical `kestrel` profile definition and one or more
environment bindings. Alternate profile and agent identities are rejected.
V2-V9 files migrate automatically with a byte-for-byte backup and migration
report; unsupported legacy or custom profile authority is omitted.

`request.mode` controls whether the provider is asked for a summary or its
provider-visible reasoning format. It does not request unavailable raw
reasoning. `retention.mode` is a separate policy: `live_only` is the default;
`provider_visible` is an explicit encrypted-retention opt-in for 1–30 days.
Encrypted continuation state is never shown or placed in transcript history.

## Sessions and History

- Sessions metadata: `~/.kestrel/sessions.json`
- Transcript history: `~/.kestrel/history.jsonl`

`sessions.json` is schema `version: 2`. Legacy files are reset to fresh defaults.

`WAITING` resume is event-type aware: the next turn uses the persisted `waitFor.eventType` from the prior run output.

## Finalize payload contract

The CLI enforces this assistant payload shape from `FinalizeAnswer`:

```json
{
  "message": "string",
  "data": { "optional": "object" }
}
```

If invalid, the UI shows a validation error and keeps the raw payload in history.
