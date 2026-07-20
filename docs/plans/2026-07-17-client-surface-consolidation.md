---
id: client-surface-consolidation
domain: product
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-17
depends_on:
  - ../../apps/desktop/src/settingsStore.ts
  - ../../apps/web/app/_components/thread/ThreadComposer.tsx
  - ../../cli/ink/ActiveViewHost.tsx
  - ../../cli/app/PaletteController.ts
---

# Client Surface Consolidation

## Outcome

Desktop, web, and TUI expose only durable, executable operator affordances.
Client state is persisted at the authority that owns it, busy-thread input is
predictable, and navigation does not promote screens or actions without the
state required to execute them.

## Workstreams

### Desktop project library

Persist the added-project library in Desktop settings with normalized path and
label values. Complete the one-time migration from the legacy browser workspace
blob when no settings library exists. Keep panes, tabs, and file-inspector UI
state out of this migration.

### Composer and thread interaction

Deliver thread-scoped draft persistence, bounded image/text attachments,
prompt history, FIFO busy follow-ups, steering, compact approval/checkpoint
rows, and dictation state. Upload and attachment access remain server/Core
mediated; clients never use attachment metadata as a substitute for execution
authority. Unsupported image input fails before clearing a draft.

### Honest operator navigation

Keep only interaction surfaces with concrete behavior. TUI primary navigation
is chat, sessions, tasks, logs, and history. Workspace, MCP, code, delegation,
and recovery remain available through executable commands or contextual detail,
not as promoted snapshot screens. Palette and row actions appear only when
their exact checkpoint, child, server, or unread-state prerequisite exists.

Web/Desktop utility controls follow the same rule: the interface reflects
available state and current route ownership rather than a retired titlebar
component or a static control catalog.

## Acceptance Criteria

- Project folders survive relaunch and legacy library data migrates once.
- Composer drafts and queued follow-ups preserve text and bounded attachment
  references without losing user input.
- Busy follow-ups, steering, approval, and checkpoint actions preserve existing
  runtime semantics.
- Idle TUI palette output fits one screen and contains only executable actions.
- Hidden snapshot views and state-less actions remain reachable only through
  explicit commands where they are still supported.

## Non-Goals

- No generic shell-navigation redesign or mobile-specific interaction model.
- No fuzzy action ranking, visibility heuristics, or hidden fallbacks.
- No browser-owned authority for files, credentials, execution, or durable
  runtime state.

## Validation

- Focused settings, composer, palette, and accessibility tests for each slice.
- `pnpm run governance:check`, `pnpm run test`, and `pnpm run test-proofs:check`.
- Refresh mutation evidence when a slice changes high- or critical-risk behavior.
