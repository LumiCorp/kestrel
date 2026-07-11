---
id: tui-surface-collapse-design-2026-05-19
domain: cli
status: draft
owner: kestrel-runtime
last_verified_at: 2026-07-03
depends_on:
  - ../../ARCHITECTURE.md
  - ../../cli/app/PaletteController.ts
  - ../../cli/ink/ActiveViewHost.tsx
  - ../../src/operatorShell.ts
---

# TUI Surface Collapse Design

See also: [Plans index](../PLANS.md).

## Problem

The current TUI presents more surface area than the code can honestly support. `AppView` exposes ten views: `chat`, `history`, `workspace`, `logs`, `sessions`, `tasks`, `mcp`, `code`, `delegation`, and `recovery`. The implementation proves that only a smaller core behaves like real operator UI.

The proven core is:

- `chat`: composer, transcript, live progress, wait prompts, and slash command entry.
- `sessions`: selectable sessions, search, detail drawer, and session switching.
- `tasks`: child task list and task switching.
- `logs`: runtime activity list, filtering, and jump-to-run behavior.
- `history`: resumable session list and return navigation.

The remaining top-level views are mostly wrappers over generated snapshots:

- `workspace`
- `mcp`
- `code`
- `delegation`
- `recovery`

Those views use the same generic action-list handling in `App.activatePrimaryAction`: selected rows either go back, open history, submit a slash command, or seed a draft. Some rows are shown even when required runtime state is absent, so selecting them produces usage text or "no active checkpoint" style responses instead of meaningful action.

## Goal

Collapse the TUI to the surfaces that work, and hide actions that cannot execute with the state currently available.

This is an operator simplification pass, not a command-catalog polish pass. The right outcome is a smaller TUI that stops pretending every runtime concept is already a mature screen.

## Non-Goals

- Do not remove slash command support.
- Do not remove runtime command handlers.
- Do not change replay, runner protocol, or operator control semantics.
- Do not add fuzzy ranking, heuristic scoring, or policy inference.
- Do not redesign the entire Ink layout.
- Do not make the snapshot views prettier while keeping them as first-class destinations.

## Design

### 1. Retain Five Top-Level Surfaces

Keep these as the only first-class TUI destinations:

- `chat`
- `sessions`
- `tasks`
- `logs`
- `history`

These are the surfaces with concrete interaction behavior already present in `App.ts`, `ActiveViewHost.tsx`, and focused tests.

### 2. Demote Snapshot Views

Remove first-class navigation to:

- `workspace`
- `mcp`
- `code`
- `delegation`
- `recovery`

These concepts remain accessible through slash commands and through details on real surfaces, but they should not appear as primary "Go to ..." destinations in the palette or keyboard flow unless the implementation has concrete state and an executable command.

The implementation can leave the view components in the repo for now if that keeps the change reversible. The operator-facing entry points should stop promoting them.

### 3. Add State-Gated Action Builders

Palette actions and row actions must be gated by explicit state:

- Show fan-in accept/defer only when a fan-in checkpoint id is known.
- Show context checkpoint accept/defer only when `operatorState.latestCheckpoint` exists.
- Show checkpoint inspect/restore only when a concrete workspace checkpoint id exists.
- Show child supersede/focus only when a concrete child thread or delegation id exists.
- Show MCP remove only for configured MCP servers.
- Show jump-to-live only when chat is not tail-locked or has unread rows.

Absence matters. If state is missing, the action should not be shown.

### 4. Shrink The Default Palette

The default palette should stop opening as a mixed catalog of everything. It should show:

1. Executable actions for the active session.
2. Executable actions for the selected task/session when applicable.
3. Navigation to retained surfaces.
4. A lower-priority command catalog fallback.

The fallback keeps coverage and discoverability, but it no longer dominates first-screen operator use.

### 5. Make Help Honest

Keyboard help should describe the retained surfaces and actual keys. Slash command help can remain complete, but the TUI help overlay should stop implying that every top-level surface is equally real.

## Acceptance Criteria

- The palette no longer promotes `workspace`, `mcp`, `code`, `delegation`, or `recovery` as default first-class destinations.
- No fan-in accept/defer action appears without a fan-in checkpoint id.
- No checkpoint accept/defer action appears without an active context checkpoint.
- No checkpoint inspect/restore action appears without a concrete workspace checkpoint id.
- No child supersede/focus action appears without a concrete child/delegation target.
- Idle-session palette output is small enough to scan on one screen.
- The five retained views remain reachable and tested.
- Existing slash commands still work.
- Focused TUI/unit tests cover both presence and absence of state-gated actions.

## Validation

Run focused validation first:

```bash
pnpm exec tsx --test tests/unit/cli-app-palette.test.ts tests/unit/cli-app-input.test.ts tests/unit/cli-app-commands.test.ts
pnpm run typecheck
pnpm run test:ops:tui
```

Then run broader gates before shipping:

```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

## Notes

This design intentionally favors deletion and hiding over new UI concepts. If a future slice makes `workspace`, `mcp`, `code`, `delegation`, or `recovery` genuinely interactive, each can return as a first-class destination with its own focused tests.
