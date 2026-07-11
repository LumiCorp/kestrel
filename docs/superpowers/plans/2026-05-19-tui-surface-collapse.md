---
id: tui-surface-collapse-plan-2026-05-19
domain: cli
status: draft
owner: kestrel-runtime
last_verified_at: 2026-07-03
depends_on:
  - ../../plans/2026-05-19-tui-surface-collapse-design.md
---

# TUI Surface Collapse Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the TUI around the surfaces and actions that currently work, and hide actions that cannot execute with available runtime state.

**Architecture:** Keep slash command handlers and existing view components in place, but stop promoting unproven snapshot views as primary operator destinations. Manual palette output becomes a small action surface; slash-triggered palette output remains the complete command catalog. Snapshot actions in `src/operatorShell.ts` become state-gated so rows do not offer commands that immediately fail for missing checkpoint, child, or fan-in state.

**Tech Stack:** TypeScript, Ink React components, Node test runner via `tsx`, existing TUI unit tests, existing TUI ops PTY tests.

---

## File Structure

- Modify `cli/app/PaletteController.ts`
  - Build the manual palette from retained views and concrete active-session actions.
  - Include the slash-command catalog only when the palette source is `slash` or the query starts with `/`.
- Modify `cli/app/TuiCommandInventory.ts`
  - Keep descriptor coverage and `/help` complete.
  - No runtime behavior changes.
- Modify `cli/ink/keymap.ts`
  - Make keyboard help describe the retained working surfaces.
- Modify `src/operatorShell.ts`
  - Gate MCP, delegation, and recovery snapshot actions by concrete state.
- Modify `tests/unit/cli-app-palette.test.ts`
  - Assert manual palette no longer promotes demoted destinations.
  - Assert slash palette still exposes complete slash-command roots.
- Modify `tests/unit/operator-shell.test.ts`
  - Assert absent fan-in/checkpoint/child actions when required IDs are missing.
  - Assert concrete actions appear when IDs are present.
- Keep `cli/ink/views/*WorkspaceView.tsx`, `DelegationReviewView.tsx`, and `RecoveryCenterView.tsx`
  - No deletion in this slice. They remain slash-reachable while no longer promoted as first-class default destinations.

## Task 1: Add Palette Collapse Tests

**Files:**
- Modify: `tests/unit/cli-app-palette.test.ts`

- [ ] **Step 1: Add `paletteSource` to existing palette test state objects**

Update every object passed to `buildPaletteActions` so the type includes manual palette source:

```ts
const state = {
  activeView: "chat" as const,
  paletteSource: "manual" as const,
  paletteQuery: "",
  activeProfile,
  themeMode: "light" as const,
  scroll: {
    chat: { offset: 0, cursor: 0, tailLocked: true },
    logs: { offset: 0, cursor: 0, tailLocked: true },
    sessions: { offset: 0, cursor: 0, tailLocked: false },
  },
  chatUnreadCount: 0,
  chatHighlightRunId: undefined,
  activeSession: makeSession({
    name: "active",
    sessionId: "s-active",
    updatedAt: "2026-03-05T11:00:00.000Z",
  }),
  sessions: [
    makeSession({ name: "active", sessionId: "s-active", updatedAt: "2026-03-05T11:00:00.000Z" }),
  ],
};
```

- [ ] **Step 2: Add a failing manual-palette demotion test**

Append this test near the existing `buildPaletteActions` tests:

```ts
test("manual palette only promotes proven top-level TUI surfaces", () => {
  const state = {
    activeView: "chat" as const,
    paletteSource: "manual" as const,
    paletteQuery: "",
    activeProfile,
    themeMode: "light" as const,
    scroll: {
      chat: { offset: 0, cursor: 0, tailLocked: true },
      logs: { offset: 0, cursor: 0, tailLocked: true },
      sessions: { offset: 0, cursor: 0, tailLocked: false },
    },
    chatUnreadCount: 0,
    chatHighlightRunId: undefined,
    activeSession: makeSession({
      name: "active",
      sessionId: "s-active",
      updatedAt: "2026-03-05T11:00:00.000Z",
    }),
    sessions: [
      makeSession({ name: "active", sessionId: "s-active", updatedAt: "2026-03-05T11:00:00.000Z" }),
    ],
  };

  const actions = buildPaletteActions(state, 1700000000000);
  const labels = actions.map((action) => action.label);

  assert.equal(labels.includes("Go to Chat"), true);
  assert.equal(labels.includes("Go to Sessions"), true);
  assert.equal(labels.includes("Go to Tasks"), true);
  assert.equal(labels.includes("Go to Activity Feed"), true);
  assert.equal(labels.includes("Go to History Home"), true);

  assert.equal(labels.includes("Go to Workspace"), false);
  assert.equal(labels.includes("Go to MCP Workspace"), false);
  assert.equal(labels.includes("Go to Code Workspace"), false);
  assert.equal(labels.includes("Go to Delegation Review"), false);
  assert.equal(labels.includes("Go to Recovery Center"), false);
  assert.equal(actions.some((action) => action.id === "journey.manage.mcp"), false);
  assert.equal(actions.some((action) => action.id === "journey.code.workflow"), false);
  assert.equal(actions.some((action) => action.id === "journey.review.delegation"), false);
  assert.equal(actions.some((action) => action.id === "journey.open.recovery"), false);
});
```

- [ ] **Step 3: Add a failing slash-catalog preservation test**

Append this test after the manual-palette test:

```ts
test("slash palette still exposes the full slash command catalog", () => {
  const state = {
    activeView: "chat" as const,
    paletteSource: "slash" as const,
    paletteQuery: "",
    activeProfile,
    themeMode: "light" as const,
    scroll: {
      chat: { offset: 0, cursor: 0, tailLocked: true },
      logs: { offset: 0, cursor: 0, tailLocked: true },
      sessions: { offset: 0, cursor: 0, tailLocked: false },
    },
    chatUnreadCount: 0,
    chatHighlightRunId: undefined,
    activeSession: makeSession({
      name: "active",
      sessionId: "s-active",
      updatedAt: "2026-03-05T11:00:00.000Z",
    }),
    sessions: [
      makeSession({ name: "active", sessionId: "s-active", updatedAt: "2026-03-05T11:00:00.000Z" }),
    ],
  };

  const actions = buildPaletteActions(state, 1700000000000);
  const discoveredRoots = new Set<string>();
  for (const action of actions) {
    const candidate = action.command ?? action.draft;
    if (candidate === undefined || candidate.startsWith("/") === false) {
      continue;
    }
    const root = candidate.slice(1).trim().split(/\s+/u)[0];
    if (root !== undefined && root.length > 0) {
      discoveredRoots.add(root);
    }
  }

  for (const root of TUI_SLASH_COMMANDS) {
    assert.equal(discoveredRoots.has(root), true, `Expected slash palette discoverability for '/${root}'`);
  }
});
```

- [ ] **Step 4: Run the focused failing test**

Run:

```bash
pnpm exec tsx --test tests/unit/cli-app-palette.test.ts
```

Expected: FAIL. The manual palette still includes demoted destinations, or the `paletteSource` field is not yet accepted by `buildPaletteActions`.

## Task 2: Collapse Manual Palette Promotion

**Files:**
- Modify: `cli/app/PaletteController.ts`
- Modify: `tests/unit/cli-app-palette.test.ts`

- [ ] **Step 1: Extend `buildPaletteActions` input**

In `cli/app/PaletteController.ts`, extend the `Pick<UiRuntimeState, ...>` for `buildPaletteActions`:

```ts
export function buildPaletteActions(
  state: Pick<
    UiRuntimeState,
    | "activeView"
    | "paletteSource"
    | "paletteQuery"
    | "activeProfile"
    | "activeSession"
    | "sessions"
    | "themeMode"
    | "scroll"
    | "chatUnreadCount"
    | "chatHighlightRunId"
  >,
  nowMs = Date.now(),
): PaletteCommand[] {
```

- [ ] **Step 2: Add retained view actions**

Inside `buildPaletteActions`, replace the hard-coded first ten view actions with this retained list:

```ts
  const retainedViewActions: PaletteCommand[] = [
    { id: "view.chat", label: "Go to Chat", detail: "Open chat screen" },
    { id: "view.history", label: "Go to History Home", detail: "Browse resumable work, launch summaries, and restart points" },
    { id: "view.sessions", label: "Go to Sessions", detail: "Browse sessions" },
    { id: "view.tasks", label: "Go to Tasks", detail: "Open the task inbox" },
    { id: "view.logs", label: "Go to Activity Feed", detail: "Inspect runtime activity" },
  ];
```

- [ ] **Step 3: Remove demoted journey promotion from manual palette**

Replace `journeyActions` with only actions that are backed by working slash handlers and are not demoted snapshot destinations:

```ts
  const journeyActions: PaletteCommand[] = [
    {
      id: "journey.start.task",
      label: "Start guided task launch",
      detail: `Choose title, profile, and mode before creating a session in ${state.activeProfile.id}`,
      command: "/start",
    },
    ...(resumeTarget !== undefined
      ? [
          {
            id: "journey.resume.recent",
            label: resumeTarget.recommendedLabel,
            detail: `${resumeTarget.title} · ${resumeTarget.detail}`,
            command: "/resume recent",
          },
        ]
      : []),
    {
      id: "journey.inspect.status",
      label: "Inspect operator status",
      detail: "Show shared runner, wait, and MCP state",
      command: "/status",
    },
  ];
```

- [ ] **Step 4: Gate static slash command catalog by palette source**

Keep slash commands complete when the palette is slash-driven or the operator typed a slash query:

```ts
  const includeSlashCatalog =
    state.paletteSource === "slash" ||
    state.paletteQuery.trim().startsWith("/");
  const staticCommands = includeSlashCatalog ? buildStaticPaletteActions(nowMs) : [];
```

- [ ] **Step 5: Return the collapsed action order**

Use this return order:

```ts
  return [
    ...retainedViewActions,
    ...journeyActions,
    ...chatActions,
    ...recentJourneyActions,
    ...skillActions,
    ...taskActions,
    ...mcpServerActions,
    ...listThemeModes().map((mode) => ({
      id: `theme.mode.${mode}`,
      label: `${mode === state.themeMode ? "Theme active:" : "Theme:"} ${mode}`,
      detail: "Switch cockpit color mode",
      command: `/theme ${mode}`,
    })),
    ...sessionActions,
    ...(state.activeSession.pendingWaitFor !== undefined
      ? [
          {
            id: "cmd.resume",
            label: `/resume ${state.activeSession.name}`,
            detail: "Resume the active waiting session",
            command: `/resume ${state.activeSession.name}`,
          },
        ]
      : []),
    ...staticCommands,
  ];
```

- [ ] **Step 6: Update old palette expectations**

In `tests/unit/cli-app-palette.test.ts`, remove assertions that expect manual palette actions for:

```ts
"Go to MCP Workspace"
"Go to Code Workspace"
"Go to Delegation Review"
"Go to Recovery Center"
"/mcp"
"/code"
"/checkpoint"
```

Keep these assertions in the slash-catalog test instead.

- [ ] **Step 7: Run focused palette tests**

Run:

```bash
pnpm exec tsx --test tests/unit/cli-app-palette.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the palette collapse**

Run:

```bash
git add cli/app/PaletteController.ts tests/unit/cli-app-palette.test.ts
git commit -m "fix(tui): collapse manual palette destinations"
```

Expected: a commit containing only the palette collapse and tests.

## Task 3: Gate Operator Shell Snapshot Actions

**Files:**
- Modify: `src/operatorShell.ts`
- Modify: `tests/unit/operator-shell.test.ts`

- [ ] **Step 1: Add failing delegation absence test**

In `tests/unit/operator-shell.test.ts`, add:

```ts
test("delegation workspace hides fan-in and child-target actions without concrete ids", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    delegation: {
      childThreads: [],
      childOutcomes: [],
    },
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/fanin accept"), false);
  assert.equal(actions.some((action) => action.command === "/fanin defer"), false);
  assert.equal(actions.some((action) => action.draft === "/child supersede "), false);
  assert.equal(actions.some((action) => action.draft === "/focus "), false);
  assert.equal(actions.some((action) => action.draft === "/child spawn "), true);
});
```

- [ ] **Step 2: Add failing delegation presence test**

In the same file, add:

```ts
test("delegation workspace uses concrete fan-in checkpoint and child focus actions", () => {
  const snapshot = buildOperatorDelegationWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    delegation: {
      childThreads: [
        {
          threadId: "thread-child-1",
          title: "Child work",
          status: "WAITING",
          waitEventType: "user.reply",
        },
      ],
      childOutcomes: [],
      fanInDisposition: {
        status: "PENDING",
        checkpointId: "fan-in-1",
      },
    },
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/fanin accept fan-in-1"), true);
  assert.equal(actions.some((action) => action.command === "/fanin defer fan-in-1"), true);
  assert.equal(actions.some((action) => action.command === "/focus thread-child-1"), true);
});
```

- [ ] **Step 3: Add failing recovery absence test**

Add:

```ts
test("recovery center hides checkpoint actions without concrete checkpoint state", () => {
  const snapshot = buildOperatorRecoveryCenter({
    sessionTitle: "active",
    profileLabel: "Reference",
    recovery: {},
    checkpoints: [],
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/checkpoint accept"), false);
  assert.equal(actions.some((action) => action.command === "/checkpoint defer"), false);
  assert.equal(actions.some((action) => action.command?.startsWith("/checkpoint inspect")), false);
  assert.equal(actions.some((action) => action.draft?.startsWith("/checkpoint restore")), false);
});
```

- [ ] **Step 4: Add failing recovery presence test**

Add:

```ts
test("recovery center uses concrete checkpoint ids for available actions", () => {
  const snapshot = buildOperatorRecoveryCenter({
    sessionTitle: "active",
    profileLabel: "Reference",
    recovery: {
      latestCheckpoint: {
        checkpointId: "context-1",
        status: "PENDING",
        recommendedAction: "compact",
        reason: "Context pressure",
      },
    },
    checkpoints: [
      {
        checkpointId: "workspace-1",
        sessionId: "session-1",
        threadId: "thread-1",
        workspaceRoot: "/tmp/workspace",
        label: "Workspace checkpoint",
        kind: "manual",
        reason: "Before risky edit",
        createdAt: "2026-03-05T11:00:00.000Z",
        captureStatus: "captured",
        fileCount: 2,
      },
    ],
  });

  const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
  assert.equal(actions.some((action) => action.command === "/checkpoint accept"), true);
  assert.equal(actions.some((action) => action.command === "/checkpoint defer"), true);
  assert.equal(actions.some((action) => action.command === "/checkpoint inspect workspace-1"), true);
  assert.equal(actions.some((action) => action.draft === "/checkpoint restore workspace-1 "), true);
});
```

- [ ] **Step 5: Add failing MCP concrete-remove test**

Add:

```ts
test("mcp workspace exposes concrete remove actions only for known servers", () => {
  const empty = buildOperatorMcpWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    status: {
      healthy: true,
      checkedAt: "2026-03-05T11:00:00.000Z",
      servers: [],
      tools: [],
    },
  });
  assert.equal(
    empty.primaryActions.concat(empty.secondaryActions).some((action) => action.draft === "/mcp remove "),
    false,
  );

  const withServer = buildOperatorMcpWorkspace({
    sessionTitle: "active",
    profileLabel: "Reference",
    status: {
      healthy: true,
      checkedAt: "2026-03-05T11:00:00.000Z",
      servers: [
        {
          id: "docker-gw",
          transport: "stdio",
          enabled: true,
          healthy: true,
          connected: true,
          toolCount: 3,
          checkedAt: "2026-03-05T11:00:00.000Z",
        },
      ],
      tools: [],
    },
  });
  assert.equal(
    withServer.primaryActions.concat(withServer.secondaryActions).some((action) => action.command === "/mcp remove docker-gw"),
    true,
  );
});
```

- [ ] **Step 6: Run tests to verify failures**

Run:

```bash
pnpm exec tsx --test tests/unit/operator-shell.test.ts
```

Expected: FAIL. Existing snapshot builders still expose generic actions.

- [ ] **Step 7: Gate MCP remove actions**

In `buildOperatorMcpWorkspace`, replace the generic remove draft:

```ts
{ id: "mcp.remove", label: "Prepare remove", draft: "/mcp remove " },
```

with concrete server-backed actions:

```ts
      ...((status?.servers ?? []).map((server) => ({
        id: `mcp.remove.${server.id}`,
        label: `Remove server ${server.id}`,
        command: `/mcp remove ${server.id}`,
      }))),
```

- [ ] **Step 8: Gate delegation actions**

In `buildOperatorDelegationWorkspace`, define concrete state:

```ts
  const fanInCheckpointId = input.delegation?.fanInDisposition?.checkpointId;
  const focusTarget = childThreads.find((child) => child.status === "WAITING" || child.status === "FAILED") ?? childThreads[0];
```

Replace `primaryActions` and `secondaryActions` with:

```ts
    primaryActions: [
      { id: "child.spawn", label: "Prepare child mission", draft: "/child spawn " },
      ...(fanInCheckpointId !== undefined
        ? [{ id: "fanin.accept", label: "Accept fan-in", command: `/fanin accept ${fanInCheckpointId}` }]
        : []),
    ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      ...(fanInCheckpointId !== undefined
        ? [{ id: "fanin.defer", label: "Defer fan-in", command: `/fanin defer ${fanInCheckpointId}` }]
        : []),
      ...(focusTarget !== undefined
        ? [{ id: "focus.child", label: `Focus child ${focusTarget.threadId}`, command: `/focus ${focusTarget.threadId}` }]
        : []),
    ],
```

Update the `nextActions.actions` array in the same function so it uses the same state-gated actions:

```ts
      actions: [
        { id: "child.spawn", label: "Prepare child mission", draft: "/child spawn " },
        ...(fanInCheckpointId !== undefined
          ? [
              { id: "fanin.accept", label: "Accept fan-in", command: `/fanin accept ${fanInCheckpointId}` },
              { id: "fanin.defer", label: "Defer fan-in", command: `/fanin defer ${fanInCheckpointId}` },
            ]
          : []),
        ...(focusTarget !== undefined
          ? [{ id: "focus.child", label: `Focus child ${focusTarget.threadId}`, command: `/focus ${focusTarget.threadId}` }]
          : []),
      ],
```

- [ ] **Step 9: Gate recovery actions**

In `buildOperatorRecoveryCenter`, define concrete checkpoint state after `latestWorkspaceCheckpoint`:

```ts
  const workspaceCheckpointId = latestWorkspaceCheckpoint?.checkpointId;
```

Replace `primaryActions` and `secondaryActions` with:

```ts
    primaryActions: [
      ...(workspaceCheckpointId !== undefined
        ? [
            { id: "checkpoint.inspect.latest", label: "Inspect latest workspace checkpoint", command: `/checkpoint inspect ${workspaceCheckpointId}` },
            { id: "checkpoint.restore.latest", label: "Prepare latest workspace restore", draft: `/checkpoint restore ${workspaceCheckpointId} ` },
          ]
        : []),
      ...(latestCheckpoint !== undefined
        ? [{ id: "checkpoint.accept", label: "Continue latest context checkpoint", command: "/checkpoint accept" }]
        : []),
      { id: "checkpoint.capture", label: "Capture workspace checkpoint", command: "/checkpoint capture" },
    ],
    secondaryActions: [
      buildBackWorkspaceAction(),
      ...(latestCheckpoint !== undefined
        ? [{ id: "checkpoint.defer", label: "Defer latest context checkpoint", command: "/checkpoint defer" }]
        : []),
      { id: "run.retry", label: "Retry run", command: "/retry" },
    ],
```

Update `nextActions.actions` to mirror the available action set:

```ts
      actions: [
        ...(workspaceCheckpointId !== undefined
          ? [
              { id: "checkpoint.inspect.latest", label: "Inspect latest workspace checkpoint", command: `/checkpoint inspect ${workspaceCheckpointId}` },
              { id: "checkpoint.restore.latest", label: "Prepare latest workspace restore", draft: `/checkpoint restore ${workspaceCheckpointId} ` },
            ]
          : []),
        ...(latestCheckpoint !== undefined
          ? [
              { id: "checkpoint.accept", label: "Continue latest context checkpoint", command: "/checkpoint accept" },
              { id: "checkpoint.defer", label: "Defer latest context checkpoint", command: "/checkpoint defer" },
            ]
          : []),
        { id: "checkpoint.capture", label: "Capture workspace checkpoint", command: "/checkpoint capture" },
      ],
```

- [ ] **Step 10: Update existing operator-shell expectations**

Adjust existing assertions that expect generic strings:

```ts
assert.equal(snapshot.primaryActions[0]?.draft, "/checkpoint inspect ");
assert.equal(snapshot.primaryActions[3]?.command, "/checkpoint capture");
assert.equal(snapshot.primaryActions[0]?.draft, "/child spawn ");
```

Use semantic `some` checks instead:

```ts
const actions = snapshot.primaryActions.concat(snapshot.secondaryActions);
assert.equal(actions.some((action) => action.draft === "/child spawn "), true);
assert.equal(actions.some((action) => action.command === "/checkpoint capture"), true);
```

- [ ] **Step 11: Run focused operator-shell tests**

Run:

```bash
pnpm exec tsx --test tests/unit/operator-shell.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit state-gated snapshot actions**

Run:

```bash
git add src/operatorShell.ts tests/unit/operator-shell.test.ts
git commit -m "fix(tui): gate snapshot actions by runtime state"
```

Expected: a commit containing only operator shell gating and tests.

## Task 4: Make Keyboard Help Honest

**Files:**
- Modify: `cli/ink/keymap.ts`
- Modify: `tests/unit/cli-app-root.test.ts` if snapshots assert help text.

- [ ] **Step 1: Update `HELP_LINES`**

Replace `HELP_LINES` in `cli/ink/keymap.ts` with:

```ts
export const HELP_LINES = [
  "Core: F1 help · Ctrl+P actions · / slash commands · Ctrl+C quit",
  "Composer: Enter send · Shift+Enter newline · Esc clear draft",
  "Views: Ctrl+1 sessions · Ctrl+2 chat · Ctrl+3 composer · Ctrl+4 logs · Tab cycle",
  "Lists: j/k move · PgUp/PgDn page · g/G bounds · Enter select · i details",
  "Search: Ctrl+F filters sessions/logs; opens actions elsewhere",
] as const;
```

- [ ] **Step 2: Run help/root tests**

Run:

```bash
pnpm exec tsx --test tests/unit/cli-app-root.test.ts tests/unit/cli-app-input.test.ts
```

Expected: PASS, or FAIL only where expected strings need to be updated.

- [ ] **Step 3: Update exact help text expectations if needed**

If `tests/unit/cli-app-root.test.ts` asserts old `HELP_LINES`, update those assertions to match the new strings from Step 1.

- [ ] **Step 4: Commit help simplification**

Run:

```bash
git add cli/ink/keymap.ts tests/unit/cli-app-root.test.ts
git commit -m "fix(tui): simplify keyboard help"
```

Expected: a commit containing only help text and matching test updates.

## Task 5: Run Integrated Validation

**Files:**
- No source edits unless validation exposes a concrete regression.

- [ ] **Step 1: Run focused TUI unit tests**

Run:

```bash
pnpm exec tsx --test tests/unit/cli-app-palette.test.ts tests/unit/cli-app-input.test.ts tests/unit/cli-app-commands.test.ts tests/unit/operator-shell.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run TUI ops tests**

Run:

```bash
pnpm run test:ops:tui
```

Expected: PASS. Slash commands for `/mcp`, `/code`, `/child`, and `/checkpoint` should still open their screens because handlers are unchanged.

- [ ] **Step 4: Run required governance gate**

Run:

```bash
pnpm run governance:check
```

Expected: PASS. If desktop resource preparation is required, run the existing project command used by current branch validation:

```bash
pnpm --filter @kestrel/desktop prepare:resources
pnpm run governance:check
```

- [ ] **Step 5: Run broad gates**

Run:

```bash
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

Expected: PASS.

- [ ] **Step 6: Final review**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- `git diff --check` exits 0.
- Dirty files are only the intentional implementation files for this slice.
- Existing unrelated dirty files are not staged or reverted.

## Self-Review

Spec coverage:

- Collapse promoted TUI surfaces: Task 1 and Task 2.
- Keep slash commands available: Task 1 slash-catalog test and Task 2 source gating.
- Hide actions lacking required state: Task 3.
- Make help honest: Task 4.
- Validate focused and broad gates: Task 5.

Placeholder scan:

- The plan avoids placeholder markers and defines concrete files, assertions, snippets, commands, and expected outcomes.

Type consistency:

- `paletteSource` and `paletteQuery` are existing `UiRuntimeState` fields.
- `buildOperatorDelegationWorkspace`, `buildOperatorRecoveryCenter`, and `buildOperatorMcpWorkspace` are existing exported functions.
- `OperatorWorkspaceAction` already supports `command` and `draft`.
