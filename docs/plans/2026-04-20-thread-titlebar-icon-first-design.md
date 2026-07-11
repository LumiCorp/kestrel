---
id: thread-titlebar-icon-first-2026-04-20
domain: web
status: proposed
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on:
  - ../index.md
  - ../../AGENTS.md
  - ../../apps/web/README.md
---

# Thread Titlebar Icon-First Design

## Goal

Redesign the desktop thread titlebar so it reads as clean, professional desktop chrome instead of a row of mixed pills and labels.

The approved direction is icon-first utility controls with hover and focus tooltips, while keeping the thread title and live status readable on the left.

## Approved Direction

Keep the titlebar as a two-zone layout:

- left zone for thread identity
- right zone for operator controls

The permanent visible controls are:

1. Script Launcher
2. Projects
3. Settings
4. More

The `More` menu owns the secondary controls:

- Runs
- Files
- Debug

This keeps the highest-value controls always visible without turning the titlebar into a crowded navigation strip.

## Layout

### Left Zone

- Show the thread title as the primary label.
- Show the subtitle only when it carries live status or similarly meaningful context.
- Keep both lines single-line and truncated rather than wrapping the bar taller.

### Right Zone

- Keep the Script Launcher visually distinct as the primary operator control.
- Render `Projects`, `Settings`, and `More` as icon-only buttons with a shared square footprint.
- Keep a slightly larger visual gap before `More` so the secondary cluster reads separately from the permanent actions.

## Visual Style

- Use lighter desktop utility chrome instead of pill-heavy button styling.
- Keep the titlebar itself thin with a soft surface tint and a clear bottom border.
- Make icon buttons quiet by default and stronger on hover or focus.
- Reserve the most visual weight for the Script Launcher only.

The titlebar should feel like workstation UI, not marketing UI. The action row should stay calm while the thread state changes.

## Interaction Model

- `Projects` toggles the project drawer directly.
- `Settings` opens the settings surface directly.
- `More` opens an anchored menu containing `Runs`, `Files`, and `Debug`.
- Only one auxiliary surface should be open at a time.
- Opening one surface should close any other open drawer or overflow menu first.

## Tooltip Rules

- Show tooltips for icon-only controls on hover and keyboard focus.
- Use short noun labels only: `Projects`, `Settings`, `More`.
- Reuse the app's existing route-header tooltip treatment where possible.
- Keep `aria-label` on every icon button so the tooltip is not the only accessible name.
- Do not add explanatory helper sentences to the tooltip copy.

The Script Launcher does not need extra tooltip text in this pass unless its internal controls also become icon-only later.

## State Rules

- Default state should be low-contrast and quiet.
- Hover and focus should raise contrast through surface and border treatment.
- Open drawers or menus should give their owning control a persistent active state.
- Busy thread state should be represented in the subtitle, not by coloring the action icons.

## Responsive Behavior

- Preserve `Settings` and `More` on narrower widths.
- Preserve `Projects` when space allows, but collapse it into `More` before collapsing `Settings`.
- Truncate title text before reducing the primary right-side controls.
- Do not introduce a separate mobile interaction model in this pass.

## Implementation Scope

The first implementation pass should stay narrow:

- convert the titlebar to icon-first permanent controls
- move `Runs`, `Files`, and `Debug` into `More`
- apply consistent tooltip behavior to icon-only buttons
- add explicit active styles for open drawers and menus
- keep Script Launcher behavior unchanged unless spacing cleanup is required for alignment

## Validation

- Add or update focused UI coverage for titlebar control rendering and overflow ownership.
- Add or update focused UI coverage for tooltip and open-state accessibility contracts where feasible.
- Run:
  - `pnpm run governance:check`
  - `pnpm run test`
  - `pnpm run prompt-suite`

This is a web-surface change, so `pnpm run evals:release-check` is optional unless the implementation touches shared runtime or core protocol code.

## Current References

- [Web app README](apps/web/README.md)
- [Workspace shell](apps/web/app/_components/WorkspaceShell.tsx)
- [Chat page client](apps/web/app/_components/ChatPageClient.tsx)
- [Global styles](apps/web/app/globals.css)
