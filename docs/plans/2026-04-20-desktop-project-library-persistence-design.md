---
id: desktop-project-library-persistence-2026-04-20
domain: desktop
status: proposed
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on:
  - ../index.md
  - ../../AGENTS.md
  - ../../apps/desktop/src/settingsStore.ts
  - ../../apps/web/lib/client/desktopShell.ts
---

# Desktop Project Library Persistence Design

See also: [Plans index](../PLANS.md).

## Problem

Kestrel Desktop currently stores the added project-folder library in the web client's `localStorage` workspace blob. The embedded desktop web server binds an ephemeral local port on launch, so the browser origin can change between launches and the project library disappears even though Electron settings persist.

## Decision

Persist the added Desktop project folders as app-level state in Electron-backed settings.

This change only moves the project library. It does not move pane layout, open tabs, file inspector state, or other desktop workspace UI state out of `localStorage`.

## Approach

1. Extend `DesktopSettings` with a persisted `projects` array of `{ path, label }`.
2. Normalize project paths and labels when reading and writing settings.
3. Hydrate `desktopWorkspace.projects` in the web client from Electron settings on launch.
4. One-time migrate legacy `localStorage` projects into Electron settings when settings do not already contain a project library.
5. Persist add/remove/setup-driven project library changes back through `desktop:save-settings` without restarting the runtime.

## Non-Goals

- Move tabs, panes, restore notices, or file inspector state into Electron persistence.
- Change managed run persistence behavior.
- Pin the embedded web app to a stable port.

## Validation

- Add settings-store coverage for project round-trip and normalization.
- Add workspace-state coverage for syncing persisted projects into the local desktop workspace model.
- Run `pnpm run governance:check`
- Run `pnpm run test`
- Run `pnpm run prompt-suite`
- Run `pnpm run evals:release-check`
