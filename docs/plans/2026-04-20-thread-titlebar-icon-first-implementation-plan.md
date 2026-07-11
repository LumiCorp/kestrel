---
id: plan-thread-titlebar-icon-first-implementation-2026-04-20
domain: web
status: proposed
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on:
  - ../PLANS.md
  - ./2026-04-20-thread-titlebar-icon-first-design.md
  - ../../apps/web/README.md
---

# Thread Titlebar Icon-First Implementation Plan

See also: [Plans index](../PLANS.md).

**Goal:** Implement the approved desktop thread titlebar redesign so the permanent header controls are icon-first and the secondary actions move behind a single overflow menu.

**Architecture:** Keep the existing thread header ownership inside the web chat surface, but factor the titlebar rendering into a clearer permanent-actions cluster plus an overflow cluster. Reuse the existing tooltip treatment and menu state patterns rather than adding a new interaction system.

**Tech Stack:** Next.js, React, TypeScript, existing Kestrel web header/menu utilities, app-level CSS, Node test runner

---

## File Structure

### Files To Modify

- Modify: `apps/web/app/_components/ChatPageClient.tsx`
  - Replace the mixed text-and-icon desktop thread header actions with the approved permanent icon-first controls.
  - Move `Runs`, `Files`, and `Debug` into a single `More` menu.
  - Ensure only one auxiliary surface is open at a time when switching between `Projects`, `Settings`, and `More`.
  - Add explicit active-state wiring for open drawers and the overflow menu.
- Modify: `apps/web/app/_components/KestrelChrome.tsx`
  - Reuse existing icons where possible.
  - Add any missing icon variant needed for the refined `Projects` or overflow affordance only if the current set is insufficient.
  - Normalize tooltip-related props on icon-only header buttons if shared helper extraction is warranted.
- Modify: `apps/web/app/globals.css`
  - Reduce titlebar visual weight.
  - Add the icon-first titlebar spacing, active states, and tooltip alignment rules.
  - Add any desktop-only responsive behavior required to preserve `Settings` and `More` first.
- Modify: `apps/web/tests/ui-smoke.test.ts`
  - Update smoke assertions so the titlebar contract matches the new icon-first structure.

### Files To Create Only If Needed

- Create: `apps/web/app/_components/thread/ThreadTitlebar.tsx`
  - Extract the desktop thread header into a small component only if `ChatPageClient.tsx` becomes materially clearer.
  - Keep ownership local to the thread/chat surface rather than generalizing too early.
- Create: `apps/web/tests/thread-titlebar.test.ts`
  - Add focused coverage for overflow ownership and control active-state behavior if the existing smoke tests become too indirect.

### Files To Read During Implementation

- Read: `apps/web/app/_components/ChatPageClient.tsx`
- Read: `apps/web/app/_components/KestrelChrome.tsx`
- Read: `apps/web/app/_components/WorkspaceShell.tsx`
- Read: `apps/web/app/globals.css`
- Read: `apps/web/tests/ui-smoke.test.ts`
- Read: `docs/plans/2026-04-20-thread-titlebar-icon-first-design.md`

---

## Task 1: Restructure The Desktop Header Controls

**Files:**
- Modify: `apps/web/app/_components/ChatPageClient.tsx`

- [ ] Replace the current text `Runs` button and separate file/debug controls in the desktop header with:
  - Script Launcher
  - Projects icon button
  - Settings icon button
  - More icon button
- [ ] Move `Runs`, `Files`, and `Debug` into the `More` menu in that order unless a stronger code-local grouping appears during implementation.
- [ ] Ensure opening `Projects`, `Settings`, or `More` closes any other open auxiliary surface first.
- [ ] Keep the left-side title and subtitle behavior unchanged except for layout cleanup and truncation preservation.

## Task 2: Tighten Icon-First Chrome And Tooltip Behavior

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/_components/KestrelChrome.tsx`

- [ ] Reuse the existing tooltip language and trigger treatment for icon-only controls.
- [ ] Apply a shared square footprint and consistent hover/focus styling to `Projects`, `Settings`, and `More`.
- [ ] Add persistent active styling for the currently open drawer or menu owner.
- [ ] Preserve a visually stronger weight for the Script Launcher than for the icon-only utility controls.

## Task 3: Add Narrow Responsive Rules

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/_components/ChatPageClient.tsx`

- [ ] Ensure title truncation happens before the permanent controls collapse.
- [ ] Preserve `Settings` and `More` on narrow desktop widths.
- [ ] Collapse `Projects` into `More` before collapsing `Settings` if a width threshold is needed.
- [ ] Avoid creating a separate mobile interaction system in this pass.

## Task 4: Refresh Focused Coverage

**Files:**
- Modify: `apps/web/tests/ui-smoke.test.ts`
- Create if needed: `apps/web/tests/thread-titlebar.test.ts`

- [ ] Assert that the desktop titlebar exposes the permanent `Projects`, `Settings`, and `More` icon controls.
- [ ] Assert that `Runs`, `Files`, and `Debug` are owned by the overflow surface instead of the permanent titlebar row.
- [ ] Assert that tooltip or accessible-name contracts remain present for the icon-only controls.
- [ ] Prefer narrow tests against the header contract over broad unrelated snapshot churn.

## Validation

- Run focused web tests first for the titlebar and smoke coverage.
- Then run:
  - `pnpm run governance:check`
  - `pnpm run test`
  - `pnpm run prompt-suite`

`pnpm run evals:release-check` becomes required only if the implementation unexpectedly touches runtime/core behavior outside the web titlebar surface.

## Notes

- Do not expand the redesign into a larger shell-navigation refactor in this pass.
- Do not introduce heuristic visibility rules beyond the approved responsive collapse order.
- Prefer a small extraction over inventing a broad reusable header abstraction if the current code can stay understandable with a local component split.
