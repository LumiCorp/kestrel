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
    "Inspect the actual files, diffs, commands, tests, runtime state, and logs before drawing conclusions.",
    "Keep diffs small and preserve unrelated code, tests, and user work.",
    "Existing tests and assertions describe behavior that should stay the same unless the user asks to change it.",
    "Treat runtime context as the current control packet",
    "Your job is to change the workspace to satisfy the user's request and deliver working software.",
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
  assert.match(act, /investigate only enough to choose a reasonable first edit/u);
  assert.match(act, /make the smallest plausible candidate change/u);
  assert.match(act, /validate it immediately/u);
  assert.match(act, /Use implementation and validation as the main way to learn/u);
  assert.match(act, /1\. Orient just enough to act/u);
  assert.match(act, /Identify the exact behavior the user wants changed/u);
  assert.match(act, /treat that concrete file\/path\/artifact as the primary edit target/u);
  assert.match(act, /treat it as validation evidence unless the task explicitly asks you to edit that thing/u);
  assert.match(act, /only to the depth needed to identify the likely edit target, existing implementation pattern, and validation path/u);
  assert.match(act, /Create a compact visible todo/u);
  assert.match(act, /requested change/u);
  assert.match(act, /explicit constraints/u);
  assert.match(act, /primary edit target/u);
  assert.match(act, /first candidate change/u);
  assert.match(act, /planned validation/u);
  assert.match(act, /Do not let exhaustive file reading, test discovery, or planning delay a reasonable first implementation/u);
  assert.match(act, /2\. Make the first candidate change/u);
  assert.match(act, /Once the primary edit target, pattern, and validation path are known/u);
  assert.match(act, /source, config, artifact, UI, API, command, or documentation change/u);
  assert.match(act, /If the task names a required file, output artifact, user-facing artifact, or deliverable to create or modify/u);
  assert.match(act, /create or update that concrete target once you know a plausible first structure or change/u);
  assert.match(act, /Do not keep investigating while the primary edit target remains untouched/u);
  assert.match(act, /Further investigation should improve the candidate, not postpone creating it/u);
  assert.match(act, /When the task constrains structure, tokens, formatting, or allowed changes/u);
  assert.match(act, /targeted replacements or a bounded script instead of rewriting the whole file/u);
  assert.match(act, /When changing reused code or produced values/u);
  assert.match(act, /use repo\.trace when plain file reads or search results are too scattered/u);
  assert.match(act, /If an edit tool reports that no file changed, treat the intended edit as not done/u);
  assert.match(act, /Do not change existing test expectations just to make your patch pass/u);
  assert.match(act, /3\. Validate immediately and iterate/u);
  assert.doesNotMatch(act, /3\. Validate with tests/u);
  assert.match(act, /Run the planned validation from your visible todo note as soon as the candidate exists/u);
  assert.match(act, /Run the nearest relevant existing tests for the edited source file and any user-visible output or error text your edit might affect/u);
  assert.match(act, /Tests are preferred when they check the requested result/u);
  assert.match(act, /If the task names an output file, command, API\/function call, score, ranking, artifact, or format/u);
  assert.match(act, /inspect or run that exact final thing after the last change/u);
  assert.match(act, /Do not treat a proxy check as completion/u);
  assert.match(act, /Add or update the nearest relevant test only when coverage is missing/u);
  assert.match(act, /If the planned test command fails because the runner is unavailable/u);
  assert.match(act, /repo-local test commands and try the project's runner/u);
  assert.match(act, /before using a direct reproduction script/u);
  assert.match(act, /Use a direct reproduction script only when no relevant test exists/u);
  assert.match(act, /A reproduction script used for validation must assert the expected behavior and fail if the bug is still present/u);
  assert.match(act, /printing values is inspection, not validation/u);
  assert.match(act, /After making a fix, run a check that would have failed before the fix and now passes/u);
  assert.match(act, /Use the bug report's example, error message, input size, boundary value, or failure condition/u);
  assert.match(act, /Existing tests are useful, but they are not enough if they do not exercise the reported bug/u);
  assert.match(act, /For overflow, size-limit, timeout, parsing, formatting, or edge-case bugs/u);
  assert.match(act, /If an existing test fails after your edit, treat it as a likely regression first/u);
  assert.match(act, /Use compiler output, test failures, runtime behavior, and direct inspection of the changed deliverable to revise or replace the implementation/u);
  assert.match(act, /Do not keep rereading the same material when validation gives the next concrete edit/u);
  assert.match(act, /4\. Review the final diff/u);
  assert.match(act, /Inspect changed tests and user-visible output or error text/u);
  assert.match(act, /Keep those changes only when the request requires them/u);
  assert.match(act, /Finalize only after the requested result has been checked, or report the concrete blocker/u);
  assert.match(act, /Choose one coherent approach and carry it through/u);
  assert.match(act, /For stateful, interactive, or protocol-driven tasks, maintain a concise observed state model from tool outputs/u);
  assert.match(act, /Alternate actions with observations, updating the state after each response/u);
  assert.match(act, /Prefer continuing the live process or session when task state matters/u);
  assert.match(act, /Avoid repeated restarts, rereads, or no-progress probes when the last observation gives the next move/u);
  assert.match(act, /Use bounded action batches only when the protocol is understood and intermediate feedback is not needed/u);
  assert.match(act, /Reserve enough time to create, verify, and read back the requested final artifact/u);
  assert.match(act, /Treat named output artifacts or deliverables as primary build targets/u);
  assert.match(act, /do not spend the run investigating while the named target remains untouched/u);
  assert.match(act, /With exec_command, `command` starts one managed process and briefly observes it/u);
  assert.match(act, /reuse its `sessionId` to read, send stdin, or stop it/u);
  assert.match(act, /The next action after status `running` should normally use the returned `sessionId`/u);
  assert.match(act, /Do not use repeated fresh commands as a substitute for stdin/u);
  assert.match(act, /prefer a small controller or driver script/u);
  assert.match(act, /Keep the visible plan current/u);
  assert.match(act, /call exec_command again with that sessionId, no command, and assistantProgress/u);
  assert.match(act, /perform the planned current-state validation after the final mutation/u);
  assert.match(act, /use the normal package-manager generator or official scaffold command/u);
  assert.match(act, /Do not hand-write the initial framework boilerplate as a substitute/u);
  assert.match(act, /Verify the result with the best available check/u);
  assert.match(act, /For user-facing artifacts, verify the actual output or wiring/u);
  assert.doesNotMatch(act, /Find the relevant source file and existing tests for the source file, changed behavior, and any user-visible output or error text your edit might affect before editing/u);
  assert.doesNotMatch(act, /Before editing code or artifacts, create a visible todo note/u);
  assert.doesNotMatch(act, /If you cannot name the existing test\/assertion and planned validation yet, search tests or repo test commands before editing/u);
  assert.doesNotMatch(act, /Run or directly check/u);
  assert.doesNotMatch(act, /user-facing closeout clearly says validation is still failing or unverified/u);
  assert.doesNotMatch(act, /parser, serializer, validator, regex, or character-class/u);
  assert.doesNotMatch(act, /encode the expected behavior as assertions or explicit nonzero exits/u);
  assert.doesNotMatch(act, /nearby callers or tests to understand the behavior you might affect/u);
  assert.doesNotMatch(act, /nearby case that could catch an overbroad fix/u);
  assert.doesNotMatch(act, /compatibility evidence/u);
  assert.doesNotMatch(act, /behavior surface/u);
  assert.doesNotMatch(act, /Do not rewrite existing expected output to bless a regression/u);
  assert.doesNotMatch(act, /Validate the bug case and one nearby existing behavior that should remain unchanged/u);
  assert.doesNotMatch(act, /Do not change the expected value unless the request clearly requires that public behavior to change/u);
  assert.doesNotMatch(act, /Find existing tests for that source file or behavior/u);
  assert.doesNotMatch(act, /planned validation command or direct check for each/u);
  assert.doesNotMatch(act, /public output\/error text/u);
  assert.doesNotMatch(act, /fs\.verify_static_app/u);
  assert.doesNotMatch(act, /evidenceRefs/u);
  assert.doesNotMatch(act, /create-next-app/u);
  assert.doesNotMatch(act, /structural checker/u);
  assert.doesNotMatch(act, /do not chase unavailable browser tooling/u);
  assert.doesNotMatch(act, /checker stub/u);
});

test("shared deliberator prompt keeps validation completion guidance across modes", () => {
  const plan = buildDeliberatorSystemPrompt({ interactionMode: "plan" });
  const act = buildDeliberatorSystemPrompt({ interactionMode: "build" });
  const chat = buildDeliberatorSystemPrompt({ interactionMode: "chat" });
  const sharedFragments = [
    /completion means the changed behavior has been validated after the edit/u,
    /run it after editing before finalizing/u,
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
