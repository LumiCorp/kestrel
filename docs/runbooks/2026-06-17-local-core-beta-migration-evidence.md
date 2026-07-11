---
id: local-core-beta-migration-evidence
domain: release
status: draft
owner: kestrel-suite
last_verified_at: 2026-06-17
depends_on:
  - ../plans/2026-06-17-kestrel-local-core-shell-model.md
  - ../analysis/2026-06-17-kestrel-local-core-state-inventory.md
  - ../../scripts/local-core-legacy-state.ts
---

# Kestrel Local Core Beta Migration Evidence

See also: [Local Core shell model](../plans/2026-06-17-kestrel-local-core-shell-model.md), [Local Core state inventory](../analysis/2026-06-17-kestrel-local-core-state-inventory.md), and [Desktop plus CLI clean-machine smoke](./2026-06-16-desktop-v0.5-beta-clean-machine-smoke.md).

## Purpose

Kestrel Local Core is the shared local source of truth for Desktop, CLI/TUI, and `kcron`. The v0.5 beta transition must detect legacy shell-specific state without silently moving, merging, or deleting it.

This runbook defines the evidence expected before clean-machine smoke and before any future migration/import behavior is enabled.

## Detection Command

Run the non-destructive detector:

```bash
node --import tsx scripts/local-core-legacy-state.ts
node --import tsx scripts/local-core-legacy-state.ts --json
```

The detector reports:

- active Kestrel Local Core home and whether isolated/dev mode is active
- existing Local Core manifest, lock, API socket, API token file, settings, workspaces, diagnostics, and Postgres paths when present
- old Desktop state under `~/Library/Application Support/@kestrel/desktop`
- old CLI state under `~/.kestrel`

The detector must not move, overwrite, delete, archive, import, or merge state.

## Required Messages

The release evidence must preserve these user-facing classifications:

- `found old Desktop state`: old Desktop app data exists and needs a future explicit migration/import choice.
- `found old CLI state`: old CLI home data exists and needs a future explicit migration/import choice.
- `using Kestrel Local Core home`: the shell or diagnostic path is using the shared product root.
- `isolated/dev mode active`: `KESTREL_HOME` or another explicit override is intentionally separate from packaged default state.
- `do not move or overwrite automatically`: beta migration detection is report-only.

## Evidence Template

```text
Machine/profile:
Artifact versions:
Command:
Core home:
Core home source:
Isolated/dev mode:
Local Core evidence:
Local Core API socket:
Local Core token file present, value not captured:
Local Core lock owner:
Old Desktop state:
Old CLI state:
Action taken:
Notes:
```

`Action taken` should be `reported only` for v0.5 beta unless a separate migration/import story is approved.

## Release Gate

Desktop and CLI release checks must fail if the packaged release surface no longer carries the Local Core contract or if smoke/checklist coverage drops these cases:

- Desktop-first then CLI attach
- CLI-first then Desktop attach
- concurrent launch
- stale lock repair
- inherited `DATABASE_URL` rejection in packaged default mode
- Core-owned shell-state API coverage and `kcron` duplicate lease prevention through `pnpm run local-core:release-smoke`

The clean-machine smoke should not proceed until these checks either pass against the implemented Core/Shell lanes or are explicitly marked blocked by the deep review gate.
