import test from "node:test";
import assert from "node:assert/strict";

import { buildPaletteActions } from "../../cli/app/PaletteController.js";
import {
  assertTuiCommandDescriptorCoverage,
  buildTuiCommandHelp,
  TUI_COMMAND_DESCRIPTORS,
  TUI_SLASH_COMMANDS,
} from "../../cli/app/TuiCommandInventory.js";
import type { TuiSessionMeta } from "../../cli/contracts.js";

const activeProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react" as const,
  sessionPrefix: "reference",
  mcpServers: [
    {
      id: "docker-gw",
      transport: "stdio" as const,
      command: "docker",
      args: ["mcp", "gateway", "run"],
    },
  ],
};

function makeSession(input: {
  name: string;
  sessionId: string;
  updatedAt: string;
  pendingWaitFor?: { kind: "effect" | "approval" | "user" | "region_merge"; eventType: string };
}): TuiSessionMeta {
  return {
    name: input.name,
    sessionId: input.sessionId,
    profileId: "reference",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    started: true,
    ...(input.pendingWaitFor !== undefined ? { pendingWaitFor: input.pendingWaitFor } : {}),
  };
}

test("buildPaletteActions adds recent session switch actions sorted by updatedAt", () => {
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
      makeSession({ name: "older", sessionId: "s-older", updatedAt: "2026-03-04T10:00:00.000Z" }),
      makeSession({ name: "newer", sessionId: "s-newer", updatedAt: "2026-03-05T12:00:00.000Z" }),
      makeSession({ name: "active", sessionId: "s-active", updatedAt: "2026-03-05T11:00:00.000Z" }),
    ],
  };

  const actions = buildPaletteActions(state, 1_700_000_000_000);
  const switchActions = actions.filter((action) => action.id.startsWith("session.switch."));

  assert.equal(switchActions.length, 2);
  assert.equal(switchActions[0]?.label, "Switch session: newer");
  assert.equal(switchActions[1]?.label, "Switch session: older");
  assert.equal(actions.some((action) => action.label === "Go to Activity Feed"), true);
  assert.equal(actions.some((action) => action.label === "Go to History Home"), true);
  assert.equal(actions.some((action) => action.label === "Go to Chat"), true);
  assert.equal(actions.some((action) => action.label === "Go to Sessions"), true);
  assert.equal(actions.some((action) => action.label === "Go to Tasks"), true);
  assert.equal(actions.some((action) => action.id === "journey.start.task"), true);
  assert.equal(actions.some((action) => action.id === "journey.inspect.status"), true);
  assert.equal(
    actions.some((action) => action.command === "/start"),
    true,
  );
  assert.equal(actions.some((action) => action.label === "Go to Workspace"), false);
  assert.equal(actions.some((action) => action.label === "Go to MCP Workspace"), false);
  assert.equal(actions.some((action) => action.label === "Go to Code Workspace"), false);
  assert.equal(actions.some((action) => action.label === "Go to Delegation Review"), false);
  assert.equal(actions.some((action) => action.label === "Go to Recovery Center"), false);
  assert.equal(actions.some((action) => action.id === "journey.manage.mcp"), false);
  assert.equal(actions.some((action) => action.id === "journey.code.workflow"), false);
  assert.equal(actions.some((action) => action.id === "journey.review.delegation"), false);
  assert.equal(actions.some((action) => action.id === "journey.open.recovery"), false);
  assert.equal(actions.some((action) => action.command === "/theme light"), true);
  assert.equal(actions.some((action) => action.command === "/mcp remove docker-gw"), true);
});

test("slash palette keeps the full slash command catalog", () => {
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

  const actions = buildPaletteActions(state, 1_700_000_000_000);

  assert.equal(actions.some((action) => action.command === "/child"), true);
  assert.equal(actions.some((action) => action.command === "/checkpoint"), false);
  assert.equal(actions.some((action) => action.command === "/theme"), true);
  assert.equal(actions.some((action) => action.command === "/mode build"), true);
  assert.equal(actions.some((action) => action.command === "/mcp"), true);
  assert.equal(actions.some((action) => action.command === "/workspace"), true);
  assert.equal(actions.some((action) => action.command === "/workspace use detached"), true);
  assert.equal(actions.some((action) => action.command === "/workspace status"), true);
  assert.equal(actions.some((action) => action.command === "/snapshot"), true);
  assert.equal(actions.some((action) => action.command === "/restore"), true);
  assert.equal(actions.some((action) => action.command === "/approve"), true);
  assert.equal(actions.some((action) => action.command === "/deny"), true);
  assert.equal(actions.some((action) => action.command === "/reject"), false);
  assert.equal(actions.some((action) => action.command === "/retry"), true);
  assert.equal(actions.some((action) => action.command === "/assembly approve"), true);
  assert.equal(actions.some((action) => action.command === "/checkpoint accept"), false);
  assert.equal(actions.some((action) => action.command === "/code"), true);
  assert.equal(actions.some((action) => action.command === "/code enable"), true);
  assert.equal(actions.some((action) => action.draft === "/profiles use "), true);
  assert.equal(actions.some((action) => action.draft === "/reply "), true);
  assert.equal(actions.some((action) => action.draft === "/focus "), true);
  assert.equal(actions.some((action) => action.draft === "/workspace use "), true);
  assert.equal(actions.some((action) => action.draft === "/steer "), true);
  assert.equal(actions.some((action) => action.draft === "/stop "), true);
  assert.equal(actions.some((action) => action.draft === "/child spawn "), true);
});

test("buildPaletteActions caps switch actions and adds resume action when waiting", () => {
  const sessions = Array.from({ length: 20 }, (_, index) =>
    makeSession({
      name: `session-${index}`,
      sessionId: `session-id-${index}`,
      updatedAt: `2026-03-05T10:${String(index).padStart(2, "0")}:00.000Z`,
    }),
  );

  const state = {
    activeView: "chat" as const,
    paletteSource: "manual" as const,
    paletteQuery: "",
    activeProfile,
    themeMode: "light" as const,
    scroll: {
      chat: { offset: 0, cursor: 0, tailLocked: false },
      logs: { offset: 0, cursor: 0, tailLocked: true },
      sessions: { offset: 0, cursor: 0, tailLocked: false },
    },
    chatUnreadCount: 3,
    chatHighlightRunId: "run-highlighted-1",
    activeSession: makeSession({
      name: "session-0",
      sessionId: "session-id-0",
      updatedAt: "2026-03-05T10:00:00.000Z",
      pendingWaitFor: { kind: "user", eventType: "user.confirm" },
    }),
    sessions,
  };

  const actions = buildPaletteActions(state, 1_700_000_000_000);
  const switchActions = actions.filter((action) => action.id.startsWith("session.switch."));

  assert.equal(switchActions.length, 12);
  assert.equal(
    actions.some((action) => action.id === "journey.resume.recent" && action.command === "/resume recent"),
    true,
  );
  assert.equal(actions.some((action) => action.id === "chat.jump.latest"), true);
  assert.equal(actions.some((action) => action.id === "chat.jump.highlight"), true);
  assert.equal(actions.some((action) => action.command === "/mcp remove docker-gw"), true);
  assert.equal(actions.some((action) => action.draft === "/mcp add sse "), false);
});

test("buildPaletteActions keeps parser command roots discoverable via commands or drafts", () => {
  assert.doesNotThrow(() => {
    assertTuiCommandDescriptorCoverage();
  });

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

  const actions = buildPaletteActions(state, 1_700_000_000_000);
  const visibleRoots = buildVisibleSlashRoots();
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
    assert.equal(
      discoveredRoots.has(root),
      visibleRoots.has(root),
      `Expected palette discoverability for '/${root}'`,
    );
  }
});

test("buildTuiCommandHelp keeps parser command roots visible", () => {
  const help = buildTuiCommandHelp();
  const discoveredRoots = new Set<string>();

  for (const match of help.matchAll(/\/([a-z][a-z-]*)\b/gu)) {
    const root = match[1];
    if (root !== undefined) {
      discoveredRoots.add(root);
    }
  }

  const visibleRoots = buildVisibleSlashRoots();
  for (const root of TUI_SLASH_COMMANDS) {
    assert.equal(
      discoveredRoots.has(root),
      visibleRoots.has(root),
      `Expected help visibility for '/${root}'`,
    );
  }
});

function buildVisibleSlashRoots(): Set<string> {
  const roots = new Set<string>();
  for (const descriptor of TUI_COMMAND_DESCRIPTORS) {
    if (descriptor.hidden === true || descriptor.root === undefined) {
      continue;
    }
    roots.add(descriptor.root);
  }
  return roots;
}
