import test from "node:test";
import assert from "node:assert/strict";

import { createUiDerivedSelectors } from "../../cli/ink/store/selectors.js";
import type { AgentRunLogLine, TuiSessionMeta } from "../../cli/contracts.js";

function makeLog(eventName: string, runId?: string): AgentRunLogLine {
  return {
    timestamp: new Date().toISOString(),
    level: "INFO",
    eventName,
    runId,
  };
}

function makeSession(name: string): TuiSessionMeta {
  const now = new Date().toISOString();
  return {
    name,
    sessionId: `${name}-id`,
    profileId: "reference",
    createdAt: now,
    updatedAt: now,
    started: true,
  };
}

test("selectors memoize filtered logs and invalidate on filter change", () => {
  const selectors = createUiDerivedSelectors();
  const logs = [makeLog("run_started", "r1"), makeLog("step_committed", "r2")];

  const filtersA = {
    level: "ALL",
    eventQuery: "run",
    runIdQuery: "",
    paused: false,
    grouped: true,
  } as const;

  const first = selectors.filterLogs(logs, filtersA);
  const second = selectors.filterLogs(logs, filtersA);
  assert.equal(first, second);

  const third = selectors.filterLogs(logs, {
    ...filtersA,
    eventQuery: "step",
  });
  assert.notEqual(first, third);
  assert.equal(third.length, 1);
});

test("selectors memoize sessions and invalidate on query change", () => {
  const selectors = createUiDerivedSelectors();
  const sessions = [makeSession("alpha"), makeSession("beta")];

  const first = selectors.filterSessions(sessions, "a");
  const second = selectors.filterSessions(sessions, "a");
  assert.equal(first, second);

  const third = selectors.filterSessions(sessions, "beta");
  assert.notEqual(first, third);
  assert.equal(third.length, 1);
  assert.equal(third[0]?.name, "beta");
});

test("palette filtering is clamped and case-insensitive", () => {
  const selectors = createUiDerivedSelectors();
  const actions = [
    { id: "1", label: "Go to Chat", detail: "switch view", command: "/switch chat" },
    { id: "2", label: "Go to Logs", detail: "switch view", command: "/switch logs" },
    { id: "3", label: "Status", detail: "show status", command: "/status" },
  ];

  const filtered = selectors.filterPaletteActions(actions, "go", 1);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, "1");

  const same = selectors.filterPaletteActions(actions, "go", 1);
  assert.equal(filtered, same);

  const expanded = selectors.filterPaletteActions(actions, "go", 3);
  assert.equal(expanded.length, 2);
});

test("palette filtering matches slash command text", () => {
  const selectors = createUiDerivedSelectors();
  const actions = [
    { id: "1", label: "Show runtime status", detail: "inspect status", command: "/status" },
    { id: "2", label: "Create session", detail: "new session", command: "/new" },
  ];

  const filtered = selectors.filterPaletteActions(actions, "status", 5);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.command, "/status");
});
