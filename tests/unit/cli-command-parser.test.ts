import assert from "node:assert/strict";

import { isInteractiveOperatorCommandDraft, parseInput } from "../../cli/app/CommandParser.js";
import { buildTuiCommandHelp } from "../../cli/app/TuiCommandInventory.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseInput parses normal chat messages", () => {
  const parsed = parseInput("hello world");
  assert.deepEqual(parsed, {
    kind: "message",
    message: "hello world",
  });
});

contractTest("runtime.hermetic", "parseInput parses supported command with args", () => {
  const parsed = parseInput("/new research-thread");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "new",
    args: ["research-thread"],
  });
});

contractTest("runtime.hermetic", "parseInput parses guided start command", () => {
  const parsed = parseInput("/start");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "start",
    args: [],
  });
});

contractTest("runtime.hermetic", "parseInput parses mcp command with subcommand args", () => {
  const parsed = parseInput("/mcp status");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "mcp",
    args: ["status"],
  });
});

contractTest("runtime.hermetic", "parseInput parses mcp docker shortcut with optional profile", () => {
  const parsed = parseInput("/mcp docker default");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "mcp",
    args: ["docker", "default"],
  });
});

contractTest("runtime.hermetic", "parseInput parses code command with subcommand args", () => {
  const parsed = parseInput("/code status");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "code",
    args: ["status"],
  });
});

contractTest("runtime.hermetic", "parseInput parses workspace command with subcommand args", () => {
  const parsed = parseInput("/workspace status");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "workspace",
    args: ["status"],
  });
});

contractTest("runtime.hermetic", "parseInput parses workspace use command with workspace id", () => {
  const parsed = parseInput("/workspace use workspace-123");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "workspace",
    args: ["use", "workspace-123"],
  });
});

contractTest("runtime.hermetic", "parseInput parses compact command", () => {
  const parsed = parseInput("/compact");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "compact",
    args: [],
  });
});

contractTest("runtime.hermetic", "parseInput parses snapshot and restore commands", () => {
  assert.deepEqual(parseInput("/snapshot before refactor"), {
    kind: "command",
    command: "snapshot",
    args: ["before", "refactor"],
  });

  assert.deepEqual(parseInput("/restore"), {
    kind: "command",
    command: "restore",
    args: [],
  });

  assert.deepEqual(parseInput("/restore ws-1"), {
    kind: "command",
    command: "restore",
    args: ["ws-1"],
  });
});

contractTest("runtime.hermetic", "parseInput parses tasks command with launch args", () => {
  const parsed = parseInput("/tasks launch reference-openai investigate this failure");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "tasks",
    args: ["launch", "reference-openai", "investigate", "this", "failure"],
  });
});

contractTest("runtime.hermetic", "parseInput parses mode command with canonical args", () => {
  const parsed = parseInput("/mode build");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "mode",
    args: ["build"],
  });
});

contractTest("runtime.hermetic", "parseInput parses theme command with args", () => {
  const parsed = parseInput("/theme dark");
  assert.deepEqual(parsed, {
    kind: "command",
    command: "theme",
    args: ["dark"],
  });
});

contractTest("runtime.hermetic", "parseInput routes unknown command to help handler marker", () => {
  const parsed = parseInput("/wat");
  assert.equal(parsed.kind, "command");
  if (parsed.kind !== "command") {
    throw new Error("Expected command parse");
  }

  assert.equal(parsed.command, "help");
  assert.deepEqual(parsed.args, ["__unknown_command__", "wat"]);
});

contractTest("runtime.hermetic", "parseInput parses operator approval and steering commands", () => {
  const approve = parseInput("/approve req-123 yes");
  assert.deepEqual(approve, {
    kind: "command",
    command: "approve",
    args: ["req-123", "yes"],
  });

  const deny = parseInput("/deny req-123 no");
  assert.deepEqual(deny, {
    kind: "command",
    command: "deny",
    args: ["req-123", "no"],
  });

  const steer = parseInput("/steer focus on child blocker");
  assert.deepEqual(steer, {
    kind: "command",
    command: "steer",
    args: ["focus", "on", "child", "blocker"],
  });

  const queue = parseInput("/queue follow this after the run");
  assert.deepEqual(queue, {
    kind: "command",
    command: "queue",
    args: ["follow", "this", "after", "the", "run"],
  });

  const stop = parseInput("/stop pause all tool work");
  assert.deepEqual(stop, {
    kind: "command",
    command: "stop",
    args: ["pause", "all", "tool", "work"],
  });
});

contractTest("runtime.hermetic", "parseInput parses operator retry and checkpoint commands", () => {
  const retry = parseInput("/retry stalled run");
  assert.deepEqual(retry, {
    kind: "command",
    command: "retry",
    args: ["stalled", "run"],
  });

  const checkpoint = parseInput("/checkpoint cp-7 handoff");
  assert.deepEqual(checkpoint, {
    kind: "command",
    command: "checkpoint",
    args: ["cp-7", "handoff"],
  });
});

contractTest("runtime.hermetic", "parseInput parses focus thread command", () => {
  const focus = parseInput("/focus thread-child-1");
  assert.deepEqual(focus, {
    kind: "command",
    command: "focus",
    args: ["thread-child-1"],
  });
});

contractTest("runtime.hermetic", "parseInput parses reply, assembly, child, and fanin commands", () => {
  assert.deepEqual(parseInput("/reply need more evidence"), {
    kind: "command",
    command: "reply",
    args: ["need", "more", "evidence"],
  });
  assert.deepEqual(parseInput("/assembly approve proposal-7"), {
    kind: "command",
    command: "assembly",
    args: ["approve", "proposal-7"],
  });
  assert.deepEqual(parseInput("/child spawn investigate blocker"), {
    kind: "command",
    command: "child",
    args: ["spawn", "investigate", "blocker"],
  });
  assert.deepEqual(parseInput("/fanin accept cp-7"), {
    kind: "command",
    command: "fanin",
    args: ["accept", "cp-7"],
  });
});

contractTest("runtime.hermetic", "interactive operator draft helper only unlocks operator slash commands", () => {
  assert.equal(isInteractiveOperatorCommandDraft("/steer hold here"), true);
  assert.equal(isInteractiveOperatorCommandDraft("/deny"), true);
  assert.equal(isInteractiveOperatorCommandDraft("/stop"), true);
  assert.equal(isInteractiveOperatorCommandDraft("/snapshot before changes"), false);
  assert.equal(isInteractiveOperatorCommandDraft("/status"), false);
  assert.equal(isInteractiveOperatorCommandDraft("hello"), false);
});

contractTest("runtime.hermetic", "command help presents simplified recovery commands", () => {
  const help = buildTuiCommandHelp();
  assert.match(help, /\/compact/u);
  assert.match(help, /\/snapshot/u);
  assert.match(help, /\/restore/u);
  assert.match(help, /\/approve/u);
  assert.match(help, /\/deny/u);
  assert.doesNotMatch(help, /\/checkpoint/u);
  assert.doesNotMatch(help, /\/reject/u);
});
