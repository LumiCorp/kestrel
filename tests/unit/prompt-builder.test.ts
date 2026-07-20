import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { renderPromptTemplate } from "../../agents/reference-react/src/prompt/promptBuilder.js";
import { readPromptTemplate } from "../../agents/reference-react/src/prompt/templateLoader.js";
import {
  buildDeliberatorSystemPrompt,
  resolveDeliberatorPromptVariant,
} from "../../agents/reference-react/src/prompt/deliberatorPrompt.js";

test("prompt builder rejects missing required slots", () => {
  assert.throws(
    () => renderPromptTemplate("Hello {{role}}", {}, { requiredSlots: ["role"] }),
    /Missing required prompt slot: role/u,
  );
});

test("prompt builder allows optional missing slots", () => {
  assert.equal(
    renderPromptTemplate("Hello {{role}}\n{{extra_guidance}}", { role: "ROUTER" }),
    "Hello ROUTER",
  );
});

test("prompt builder rejects unknown placeholders", () => {
  assert.throws(
    () => renderPromptTemplate("Hello {{not_a_real_slot}}", {}),
    /Unknown prompt template slot: not_a_real_slot/u,
  );
});

test("prompt builder preserves critical slots when clipping", () => {
  const rendered = renderPromptTemplate(
    "{{current_blocking_fact}}\n{{latest_result}}",
    {
      current_blocking_fact: "Current blocking fact: repair changed 0 occurrences.",
      latest_result: "x".repeat(500),
    },
    {
      maxChars: 120,
      criticalSlots: ["current_blocking_fact"],
    },
  );

  assert.match(rendered, /Current blocking fact: repair changed 0 occurrences/u);
  assert.match(rendered, /\[prompt clipped\]/u);
});

test("template loader supports explicit prompt root override", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reference-react-prompts-"));
  const previous = process.env.KESTREL_REFERENCE_REACT_PROMPT_ROOT;
  try {
    writeFileSync(path.join(root, "custom.md"), "Hello from override\n");
    process.env.KESTREL_REFERENCE_REACT_PROMPT_ROOT = root;
    assert.equal(readPromptTemplate("custom"), "Hello from override\n");
  } finally {
    if (previous === undefined) {
      delete process.env.KESTREL_REFERENCE_REACT_PROMPT_ROOT;
    } else {
      process.env.KESTREL_REFERENCE_REACT_PROMPT_ROOT = previous;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("deliberator prompt keeps durable role rules out of context rendering", () => {
  const prompt = buildDeliberatorSystemPrompt({ interactionMode: "build" });
  const requiredFragments = [
    "You are Kestrel, a pragmatic software engineer.",
    "Respect higher-priority instructions, repo-local instructions, the active mode, and the active tool policy.",
    "Runtime context is the authoritative control packet",
    "Preserve unrelated code, tests, and user work.",
    "Change the workspace to satisfy the request and deliver working software.",
    "Execution-state contract:",
  ];

  for (const fragment of requiredFragments) {
    assert.equal(
      prompt.includes(fragment),
      true,
      `Expected deliberator prompt to include: ${fragment}`,
    );
  }

  const removedAlwaysOnGuidance = [
    "Choose between five moves",
    "Dev-shell process contract",
    "raw turn-by-turn dev.process tools may be hidden by design",
    "Generated controller workflow",
    "Filesystem guidance",
    "project.card.create proactively",
  ];
  for (const fragment of removedAlwaysOnGuidance) {
    assert.equal(
      prompt.includes(fragment),
      false,
      `Expected deliberator prompt to omit always-on guidance: ${fragment}`,
    );
  }
});

test("deliberator prompt preserves application instructions at system priority", () => {
  const prompt = buildDeliberatorSystemPrompt({
    interactionMode: "chat",
    systemInstructions: [
      "Answer only from the supplied document.",
      "Return a JSON object matching the requested schema.",
    ],
  });

  assert.match(prompt, /Application system instructions:/u);
  assert.match(prompt, /1\. Answer only from the supplied document\./u);
  assert.match(prompt, /2\. Return a JSON object matching the requested schema\./u);
});

test("deliberator prompt exposes typed host actions only for Desktop Chat and Build", () => {
  const desktopChat = buildDeliberatorSystemPrompt({
    interactionMode: "chat",
    environmentShellKind: "desktop",
  });
  const desktopBuild = buildDeliberatorSystemPrompt({
    interactionMode: "build",
    environmentShellKind: "desktop",
  });
  const desktopPlan = buildDeliberatorSystemPrompt({
    interactionMode: "plan",
    environmentShellKind: "desktop",
  });
  const cliBuild = buildDeliberatorSystemPrompt({ interactionMode: "build", environmentShellKind: "cli" });
  const webChat = buildDeliberatorSystemPrompt({ interactionMode: "chat", environmentShellKind: "web" });

  assert.match(desktopChat, /use desktop\.host\.open/u);
  assert.match(desktopBuild, /use desktop\.host\.open/u);
  assert.doesNotMatch(desktopPlan, /desktop\.host\.open/u);
  assert.doesNotMatch(cliBuild, /desktop\.host\.open/u);
  assert.doesNotMatch(webChat, /desktop\.host\.open/u);
});

test("deliberator prompt resolver selects real mode prompts", () => {
  assert.equal(resolveDeliberatorPromptVariant({ interactionMode: "plan" }), "reference-react:plan");
  assert.equal(resolveDeliberatorPromptVariant({ interactionMode: "build" }), "reference-react:build");
  assert.equal(resolveDeliberatorPromptVariant({ interactionMode: "chat" }), "reference-react:chat");
  assert.equal(
    resolveDeliberatorPromptVariant({
      interactionMode: "build",
      promptVariant: "reference-react:plan",
    }),
    "reference-react:build",
  );

  const plan = buildDeliberatorSystemPrompt({ interactionMode: "plan" });
  const act = buildDeliberatorSystemPrompt({ interactionMode: "build" });
  const chat = buildDeliberatorSystemPrompt({ interactionMode: "chat" });

  assert.match(plan, /You are in planning mode/u);
  assert.match(plan, /session plan document/u);
  assert.match(plan, /Do not start implementation/u);
  assert.match(plan, /Do not choose implementation file mutation tools for product code/u);
  assert.match(act, /You are in build mode/u);
  assert.match(act, /deliver working software/u);
  assert.match(chat, /You are in chat mode/u);
  assert.match(chat, /answer conversationally/u);
  assert.notEqual(plan, act);
  assert.notEqual(plan, chat);
});

test("build-mode deliberator prompt stays compact and generic", () => {
  const act = buildDeliberatorSystemPrompt({ interactionMode: "build" });

  assert.match(act, /deliver working software/u);
  assert.match(act, /implementation-first/u);
  assert.match(act, /1\. Orient just enough to act/u);
  assert.match(act, /primary edit target/u);
  assert.match(act, /compact visible todo/u);
  assert.match(act, /2\. Make the smallest plausible candidate change early/u);
  assert.match(act, /smaller literal copied exactly from current content/u);
  assert.match(act, /do not substitute a whole-file overwrite unless the task permits it/u);
  assert.match(act, /never change test expectations merely to bless a regression/u);
  assert.match(act, /3\. Validate the exact requested behavior after the latest mutation/u);
  assert.match(act, /repo-native command/u);
  assert.match(act, /make it assert the result/u);
  assert.match(act, /4\. Review the final diff/u);
  assert.match(act, /usable workspace, active sessions, observed changed files, and validation freshness/u);
  assert.match(act, /continue that exact sessionId without command/u);
  assert.match(act, /Do not start a duplicate command/u);
  assert.match(act, /A mutation makes earlier validation stale/u);
  assert.match(act, /settle every live process before finalizing/u);
  assert.match(act, /visible plan agent-owned/u);
  assert.match(act, /Never create a todo whose work is closing todos, finalizing, or reporting itself/u);
  assert.match(act, /do not finalize by itself while an item remains open/u);
  assert.ok(act.length < 6000, `Expected compact build prompt, received ${act.length} characters.`);
});

test("shared deliberator prompt keeps authoritative evidence and structured response guidance across modes", () => {
  const plan = buildDeliberatorSystemPrompt({ interactionMode: "plan" });
  const act = buildDeliberatorSystemPrompt({ interactionMode: "build" });
  const chat = buildDeliberatorSystemPrompt({ interactionMode: "chat" });
  const sharedFragments = [
    /Runtime context is the authoritative control packet/u,
    /Treat transcript and tool results as observed evidence/u,
    /Every decision response must contain a valid structured tool call/u,
  ];

  for (const prompt of [plan, act, chat]) {
    for (const fragment of sharedFragments) {
      assert.match(prompt, fragment);
    }
  }
});

test("plan-mode deliberator prompt requires session plan before handoff for execution-ready software build requests", () => {
  const plan = buildDeliberatorSystemPrompt({ interactionMode: "plan" });

  assert.match(
    plan,
    /For software build requests, once stack, scope, and defaults are clear enough for the next implementation pass, write the session plan document before choosing `handoff_to_build`\./u,
  );
  assert.match(
    plan,
    /Reserve finalize status goal_satisfied for true conversational or current task status answers, not execution-ready build requests\./u,
  );
  assert.match(
    plan,
    /Treat follow-ups such as "let's start the build", "lets start the build", "go ahead", or similar implementation prompts as a request to proceed with the already-agreed build pass/u,
  );
  assert.match(
    plan,
    /Do not finalize with status goal_satisfied once a software build request is clear enough for the next implementation pass\./u,
  );
  assert.match(
    plan,
    /Do not reopen framework, stack, database, or scaffold discovery after those choices are already settled\./u,
  );
});
