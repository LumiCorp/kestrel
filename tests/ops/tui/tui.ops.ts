import assert from "node:assert/strict";
import { describe } from "node:test";

import { runTuiScenario } from "../helpers/pty.js";
import { contractTest } from "../../helpers/contract-test.js";

describe("TUI PTY journeys", () => {

contractTest("runtime.process", "TUI workspace journey can be opened and exited back to chat deterministically", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      {
        waitFor: /ops-root · CHAT/i,
        actions: [{ typeText: "/workspace" }],
      },
      {
        waitFor: />\s*\/workspace/i,
        actions: [{ key: "enter" }],
      },
      {
        waitFor: /ops-root · WORKSPACE/i,
        actions: [{ key: "esc" }],
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

contractTest("runtime.process", "TUI MCP journey opens from slash command and returns to chat with Esc", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/mcp" }] },
      { waitFor: />\s*\/mcp/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · MCP/i, actions: [{ key: "esc" }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, /ops-root · MCP/i);
  assert.match(transcript, /Back to Chat/i);
});

contractTest("runtime.process", "TUI Code journey opens from slash command and returns to chat with Esc", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/code" }] },
      { waitFor: />\s*\/code/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · CODE/i, actions: [{ key: "esc" }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, /ops-root · CODE/i);
  assert.match(transcript, /Back to Chat/i);
});

contractTest("runtime.process", "TUI Delegation and Recovery journeys open from slash commands", async () => {
  const delegationTranscript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/child" }] },
      { waitFor: />\s*\/child/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · DELEGATION/i },
    ],
  });
  const recoveryTranscript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/checkpoint" }] },
      { waitFor: />\s*\/checkpoint/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · RECOVERY/i },
    ],
  });

  assert.match(delegationTranscript, /ops-root · DELEGATION/i);
  assert.match(recoveryTranscript, /ops-root · RECOVERY/i);
});

contractTest("runtime.process", "TUI scripted fresh-session startup lands in prompt-ready chat", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    freshSessionName: "ops-fresh-chat",
    steps: [
      {
        waitFor: /ops-fresh-chat · CHAT/i,
      },
    ],
  });

  assert.match(transcript, /ops-fresh-chat · CHAT/i);
});

contractTest("runtime.process", "TUI scripted chat submits non-command messages with Enter", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    freshSessionName: "ops-submit-message",
    steps: [
      {
        waitFor: /ops-submit-message · CHAT/i,
        actions: [{ typeText: "hello from scripted enter" }],
      },
      {
        waitFor: />\s*hello from scripted enter/i,
        actions: [{ key: "enter" }],
      },
      {
        waitFor: /RUNNING|Run in progress|Calling decision model/i,
      },
    ],
  });

  assert.match(transcript, />> hello from scripted enter/i);
  assert.match(transcript, /RUNNING|Run in progress|Calling decision model/i);
});

contractTest("runtime.process", "TUI workspace journey supports deterministic arrow-key navigation", async () => {
  const transcript = await runTuiScenario({
    sessionName: "ops-root",
    steps: [
      { waitFor: /ops-root · CHAT/i, actions: [{ typeText: "/workspace" }] },
      { waitFor: />\s*\/workspace/i, actions: [{ key: "enter" }] },
      { waitFor: />\s*Start task in selected workspace/i, actions: [{ key: "down" }] },
      { waitFor: />\s*Switch to detached/i, actions: [{ key: "down" }] },
      { waitFor: />\s*Open History Home/i, actions: [{ key: "down" }] },
      { waitFor: />\s*Back to Chat/i, actions: [{ key: "enter" }] },
      { waitFor: /ops-root · CHAT/i },
    ],
  });

  assert.match(transcript, />\s*Switch to detached/i);
  assert.match(transcript, />\s*Open History Home/i);
  assert.match(transcript, />\s*Back to Chat/i);
  assert.match(transcript, /ops-root · CHAT/i);
});
});
