---
id: kestrel-local-core-shell-model
domain: architecture
status: historical
owner: kestrel-suite
last_verified_at: 2026-06-17
depends_on:
  - ../../ARCHITECTURE.md
  - ../../apps/desktop/README.md
  - ../analysis/2026-06-17-kestrel-local-core-state-inventory.md
  - ./2026-06-16-kestrel-suite-v0.5-release-roadmap.md
---

# Kestrel Local Core And Shell Model

> Superseded for Kestrel 0.6 by the [Kestrel local platform architecture](2026-07-13-kestrel-local-platform-architecture.md). This record preserves the 0.5 child-daemon and managed-Postgres decisions for release history.

See also: [Local Core state inventory](../analysis/2026-06-17-kestrel-local-core-state-inventory.md), [v0.5 release roadmap](2026-06-16-kestrel-suite-v0.5-release-roadmap.md), and [suite inventory](../analysis/2026-06-16-kestrel-suite-v0.5-codebase-inventory.md).

## Purpose

This design record locks the v0.5 product architecture before the next implementation wave.

The release invariant is:

> Kestrel Local Core is the single local source of truth. Desktop, CLI/TUI, and `kcron` are shells over that Core.

This replaces the current implementation framing where Desktop owns a packaged managed database path and CLI/TUI can create independent state under `~/.kestrel`.

## Canonical Terms

| Term | Meaning |
| --- | --- |
| Kestrel Local Core | The local product runtime that owns database lifecycle, migrations, runtime state, settings, workspace registry, diagnostics, and background-service coordination. |
| Core daemon | The v0.5 child process started by shells on demand. It serves the Local Core API over `core/api.sock` with bearer-token auth from `core/api.token`; it is not installed through launchd in v0.5. |
| Local Core API | The local HTTP API over the Unix socket used by Desktop, CLI/TUI, and `kcron` for Core health, status, settings, provider readiness, workspaces, sessions, diagnostics, support bundles, repair/restart, and legacy-state detection. |
| Shell | A user-facing entrypoint that starts, connects to, or displays Core state. Desktop, CLI/TUI, and `kcron` are shells. |
| Canonical data root | The default per-user filesystem root for Kestrel Local Core state. On macOS this should become a Kestrel product root such as `~/Library/Application Support/Kestrel`, not a Desktop-specific app root. |
| Managed database | The Core-owned local database started and repaired by Kestrel from bundled or explicitly installed resources. |
| External database | An Advanced-mode user-supplied Postgres endpoint. It is explicit configuration, not a default fallback. |
| Isolated/dev mode | An explicit mode for contributor, test, or advanced workflows that uses a separate home/store. It must not be the packaged user default. |

## Locked Decisions

- Kestrel has one default local source of truth per user account.
- Desktop, CLI/TUI, and `kcron` do not own separate product stores by default.
- Kestrel Local Core owns database lifecycle, migrations, runtime state, provider settings, workspace registry, diagnostics, and background-service coordination.
- Packaged defaults must not depend on host Postgres, Docker, Homebrew Postgres, an inherited `DATABASE_URL`, or a repo checkout.
- Direct shell-to-database access is not the public product contract. Shells should start or connect to Core and use a supported Core boundary.
- v0.5 Core runs as a child daemon started by shells. Shell startup resolves the Core home, probes the Unix socket, spawns the daemon if the Core is missing or stale, and then uses the Local Core API.
- The daemon lock records owner pid, daemon executable, version, schema version, API socket, database socket, and heartbeat.
- The Core API uses bearer-token auth from `core/api.token`; API responses are JSON and use machine-readable error codes for failures.
- External Postgres remains Advanced mode and must be intentionally selected.
- Isolated/dev state remains available only when deliberately selected and visibly labeled.
- Shared Local Core is a release blocker before a credible Desktop plus CLI clean-machine smoke.

## v0.5 Defaults

- macOS is the first platform proof.
- Desktop remains the primary user-facing shell.
- CLI/TUI is the companion terminal shell over the same local Core state.
- `kcron` is beta and must use Core state when enabled.
- The managed Postgres implementation is being promoted into Core ownership; remaining release proof must confirm the packaged daemon owns the default DB lifecycle.
- The current CLI PGlite fallback is acceptable for dev/isolated mode, but not as the default packaged user source of truth.

## Deferred Decisions

- The final Homebrew formula shape and whether Core resources are installed once or duplicated in artifacts.
- Signing, notarization, update channel, and installer behavior.
- Non-macOS support.
- Full legacy-state import/merge policy beyond detection, classification, and non-destructive messaging.
- Whether a future release promotes Core from child daemon to installed launchd service or another long-lived service model.

## Required Next Waves

1. Add a canonical Core home resolver.
2. Add Core manifest, lock, heartbeat, and compatibility handshake.
3. Move managed database ownership from Desktop to Core.
4. Make Core the only migration owner.
5. Make Desktop connect to or start Core as a shell.
6. Make CLI/TUI connect to or start Core as a shell.
7. Align `kcron` with Core lifecycle and scheduling state.
8. Expand shell usage from readiness/status into the full Local Core API wherever endpoints now exist.
9. Update release checks and clean-machine smoke to prove one shared source of truth.
