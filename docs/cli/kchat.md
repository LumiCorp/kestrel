---
id: cli-kchat-guide
domain: cli
status: active
owner: kestrel-cli
last_verified_at: 2026-06-30
depends_on: [../index.md, kchat-protocol.md]
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
Protocol details: [docs/cli/kchat-protocol.md](https://github.com/LumiCorp/kestrel/blob/main/docs/cli/kchat-protocol.md).
Workspace setup and scheduling guide: [docs/cli/workspaces.md](https://github.com/LumiCorp/kestrel/blob/main/docs/cli/workspaces.md).

## Launch

- Local dev: `pnpm run tui`
- v0.5 beta CLI artifact: `kestrel-cli-0.5.0-beta.0-darwin-arm64.tar.gz`
- Packaged CLI bins: `kestrel`, `ks`, `kcron`
- Contributor shims: `pnpm run install:cli`

The v0.5 beta release path is a separate macOS ARM64 tarball shaped for future Homebrew installation. It contains `bin/` launchers and a bundled `libexec/` runtime, uses the system Node runtime, and does not require a repo checkout or repo `.env`.

`pnpm run install:cli` remains a contributor convenience. It installs source-backed shims over the current checkout and should not be described as the external release install path.

Optional flags:

- `--profile <id>`
- `--session <name>`

Command mode:

- `kestrel workspace status|list`
- `kestrel web [--host <host>] [--port <port>] [--token <token>]`
- `kcron start|stop|status|run-once|install|uninstall` (beta local automation in v0.5)

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

## Profiles (v3)

Profiles are loaded from `~/.kestrel/profiles.json` and bootstrapped automatically on first run.
Workspace catalog entries do not override the active profile.

Schema:

```json
{
  "version": 3,
  "profiles": [
    {
      "id": "reference",
      "label": "Reference React",
      "agent": "reference-react",
      "sessionPrefix": "reference",
      "toolAllowlist": ["free.hn.top", "free.time.current", "code.execute"],
      "codeMode": {
        "enabled": true,
        "languages": ["javascript", "python", "bash"],
        "sandbox": {
          "executor": "docker",
          "timeoutMs": 20000,
          "memoryMb": 256,
          "cpuShares": 256,
          "networkDefault": "off",
          "allowDependencyInstall": false
        },
        "retention": {
          "persistSummary": true,
          "persistArtifacts": true
        },
        "approvalMode": "auto"
      },
      "mcpServers": [],
      "default": true
    }
  ]
}
```

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
