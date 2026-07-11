import assert from "node:assert/strict";
import { before, test } from "node:test";

import { prepareOpsFixtures } from "../helpers/database.js";
import { runTuiScenario } from "../helpers/pty.js";

let databaseUrl = "";

before(async () => {
  const prepared = await prepareOpsFixtures();
  databaseUrl = prepared.databaseUrl;
});

test("TUI shows waiting prompts and resume affordances for approval-blocked sessions", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-approval-child",
    databaseUrl,
    steps: [
      {
        waitFor: /ops-approval-child · CHAT/,
      },
      {
        waitFor: /WAITING:user\.approval/,
      },
    ],
  });

  assert.match(transcript, /ops-approval-child · CHAT/);
  assert.match(transcript, /WAITING:user\.approval/);
  assert.match(transcript, /Approve child thread before continuing\./);
  assert.match(transcript, /Waiting for 'user\.approval'/);
});

test("TUI palette navigation exposes task inbox entries for delegated child sessions", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 8,
    steps: [
      {
        waitFor: /ops-root · CHAT/i,
      },
      {
        waitFor: /WAITING:delegation/,
      },
    ],
  });

  assert.match(transcript, /ops-root · CHAT/);
  assert.match(transcript, /WAITING:delegation/);
  assert.match(transcript, /Child thread is waiting for approval\./);
});

test("TUI shortcut palettes separate manual actions from slash command catalog", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 10,
    steps: [
      {
        waitFor: /ops-root · CHAT/i,
        actions: [{ key: "tab", settleMs: 150 }, { key: "ctrl-p", settleMs: 250 }],
      },
      {
        waitFor: /Command Palette/i,
        fromCursor: true,
        actions: [{ typeText: "checkpoint", settleMs: 250 }],
        abortPatterns: [
          {
            pattern: /\/checkpoint/u,
            reason: "manual palette should not expose dormant slash checkpoint route",
            fromCursor: true,
            maxMatches: 0,
          },
        ],
      },
      {
        waitFor: /No commands found\./i,
        fromCursor: true,
        actions: [
          { key: "esc", settleMs: 250 },
          { typeText: "/", settleMs: 250 },
        ],
      },
      {
        waitFor: /Slash Commands/i,
        fromCursor: true,
        actions: [{ typeText: "checkpoint", settleMs: 250 }],
      },
      {
        waitFor: /▸\s*\/checkpoint/i,
        fromCursor: true,
      },
    ],
  });

  assert.match(transcript, /Command Palette/i);
  assert.match(transcript, /No commands found\./i);
  assert.match(transcript, /Slash Commands/i);
  assert.match(transcript, /▸\s*\/checkpoint/i);
});

test("TUI blocked-mode sessions preserve operator guidance in restored state", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-mode-blocked",
    databaseUrl,
    steps: [
      {
        waitFor: /ops-mode-blocked · CHAT/,
      },
      {
        waitFor: /WAITING:user\.mode_switch/,
      },
    ],
  });

  assert.match(transcript, /ops-mode-blocked · CHAT/);
  assert.match(transcript, /WAITING:user\.mode_switch/);
  assert.match(transcript, /Switch to Build to continue\./);
});

test("TUI workspace journey can be opened and exited back to chat deterministically", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 8,
    steps: [
      {
        waitFor: /ops-root · CHAT/i,
        actions: [{ typeText: "/workspace" }],
      },
      {
        waitFor: />\s*\/workspace/i,
        actions: [{ key: "enter", settleMs: 250 }],
      },
      {
        waitFor: /ops-root · WORKSPACE/i,
        actions: [{ key: "esc", settleMs: 100 }],
      },
      {
        waitFor: /ops-root · CHAT/i,
      },
    ],
  });

  assert.match(transcript, /ops-root · CHAT/i);
  assert.match(transcript, /ops-root · WORKSPACE/i);
  assert.match(transcript, /Back to Chat/i);
});

test("TUI MCP journey opens from slash command and returns to chat with Esc", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 8,
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/mcp" }] },
      { waitFor: />\s*\/mcp/i, actions: [{ key: "enter", settleMs: 250 }] },
      { waitFor: /ops-root · MCP/i, actions: [{ key: "esc", settleMs: 100 }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, /ops-root · MCP/i);
  assert.match(transcript, /Back to Chat/i);
});

test("TUI Code journey opens from slash command and returns to chat with Esc", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 8,
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/code" }] },
      { waitFor: />\s*\/code/i, actions: [{ key: "enter", settleMs: 250 }] },
      { waitFor: /ops-root · CODE/i, actions: [{ key: "esc", settleMs: 100 }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, /ops-root · CODE/i);
  assert.match(transcript, /Back to Chat/i);
});

test("TUI Delegation and Recovery journeys open from slash commands", async () => {
  const delegationTranscript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 8,
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/child" }] },
      { waitFor: />\s*\/child/i, actions: [{ key: "enter", settleMs: 250 }] },
      { waitFor: /ops-root · DELEGATION/i },
    ],
  });
  const recoveryTranscript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 8,
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/checkpoint" }] },
      { waitFor: />\s*\/checkpoint/i, actions: [{ key: "enter", settleMs: 250 }] },
      { waitFor: /ops-root · RECOVERY/i },
    ],
  });

  assert.match(delegationTranscript, /ops-root · DELEGATION/i);
  assert.match(recoveryTranscript, /ops-root · RECOVERY/i);
});

test("TUI scripted fresh-session startup lands in prompt-ready chat", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    freshSessionName: "ops-fresh-chat",
    databaseUrl,
    timeoutSeconds: 20,
    steps: [
      {
        waitFor: /ops-fresh-chat · CHAT/i,
      },
    ],
  });

  assert.match(transcript, /ops-fresh-chat · CHAT/i);
});

test("TUI scripted chat submits non-command messages with Enter", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    freshSessionName: "ops-submit-message",
    databaseUrl,
    timeoutSeconds: 20,
    steps: [
      {
        waitFor: /ops-submit-message · CHAT/i,
        actions: [{ typeText: "hello from scripted enter", settleMs: 250 }, { key: "enter", settleMs: 700 }],
      },
      {
        waitFor: />> hello from scripted enter|Run in progress|mode=act/i,
      },
    ],
  });

  assert.match(transcript, />> hello from scripted enter/i);
  assert.match(transcript, /RUNNING|Run in progress|Calling decision model/i);
});

test("TUI workspace journey supports deterministic arrow-key navigation", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    databaseUrl,
    timeoutSeconds: 10,
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/workspace" }] },
      { waitFor: />\s*\/workspace/i, actions: [{ key: "enter", settleMs: 250 }] },
      { waitFor: />\s*Start task in selected workspace/i, actions: [{ key: "down", settleMs: 100 }] },
      { waitFor: />\s*Switch to detached/i, actions: [{ key: "down", settleMs: 100 }] },
      { waitFor: />\s*Open History Home/i, actions: [{ key: "down", settleMs: 100 }] },
      { waitFor: />\s*Back to Chat/i, actions: [{ key: "enter", settleMs: 150 }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, />\s*Switch to detached/i);
  assert.match(transcript, />\s*Open History Home/i);
  assert.match(transcript, />\s*Back to Chat/i);
  assert.match(transcript, /ops-root · CHAT/i);
});
