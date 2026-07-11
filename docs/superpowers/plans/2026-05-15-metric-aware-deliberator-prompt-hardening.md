---
id: plan-metric-aware-deliberator-prompt-hardening-2026-05-15
domain: agents
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on: [../../PLANS.md]
---

# Metric-Aware Deliberator Prompt Hardening Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen prompt engineering so the agent reasons from measurable success criteria and runtime budget before launching broad training/search/generation work.

**Architecture:** This is prompt and eval work, not a deterministic strategy-selection loop. We will change the deliberator and dev-shell prompt guidance, then add focused prompt/context tests that verify the prompts steer toward metric-aware reasoning without Terminal-Bench-specific behavior.

**Tech Stack:** TypeScript, Node test runner, existing reference-react prompt assembly, existing `prompt-suite` runner.

---

## File Map

- Modify: `agents/reference-react/src/steps/deliberator.ts`
  - Add prompt rules in `avoidWastedCalls`, `doneWhen`, and `extraRules`.
  - Keep these rules general: measurable outcomes, budgets, expensive loops, and metric misses.
- Modify: `agents/reference-react/prompts/includes/dev-shell.md`
  - Clarify training/search/optimization controller behavior.
  - Prevent full final verification inside hot loops.
- Modify: `tests/unit/prompt-builder.test.ts`
  - Assert the deliberator system prompt contains the new metric/budget and expensive-loop guidance.
- Modify or create: `tests/unit/context-builder-budget.test.ts`
  - Add a context-rendering test for failed measurable criteria if existing helpers support it.
  - If helpers are too cumbersome, keep this as a prompt-builder test only in this slice.
- Modify: `tests/scenario/promptSuiteHarness.ts`
  - Add one generalized scenario for measurable artifact work under a short budget.
- Test commands:
  - `node --import tsx --test tests/unit/prompt-builder.test.ts`
  - `node --import tsx --test tests/scenario/prompt-suite-pass-rate.test.ts`
  - `pnpm run prompt-suite`

## Non-Goals

- Do not add deterministic classifiers, heuristic strategy gates, lexical keyword routing, or score thresholds.
- Do not add Terminal-Bench-specific task names, CartPole-specific rules, or benchmark branching.
- Do not block valid conventional implementations when they are justified by task evidence and budget.
- Do not change runtime deadline policy in this slice.

## Task 1: Add Metric-Aware Deliberator Prompt Rules

**Files:**
- Modify: `agents/reference-react/src/steps/deliberator.ts`
- Test: `tests/unit/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing prompt-builder test**

Add assertions to the existing `buildRoleSystemPrompt("deliberator", ...)` test in `tests/unit/prompt-builder.test.ts`.

```ts
test("deliberator prompt includes metric-aware expensive work guidance", () => {
  const prompt = buildRoleSystemPrompt("deliberator", {
    filesystem: "Use fs tools.",
    devShell: "Use dev.shell.run.",
    workspace: "Workspace guidance.",
  });

  assert.match(prompt, /explicit measurable success criterion/u);
  assert.match(prompt, /target metric/u);
  assert.match(prompt, /remaining budget/u);
  assert.match(prompt, /Library availability is not an instruction/u);
  assert.match(prompt, /A completed run with a failed metric is not a done progress item/u);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --import tsx --test tests/unit/prompt-builder.test.ts
```

Expected: FAIL because the new strings are not present yet.

- [ ] **Step 3: Add deliberator prompt rules**

In `agents/reference-react/src/steps/deliberator.ts`, add these strings to `avoidWastedCalls` near the existing broad controller guidance:

```ts
"When the original task has an explicit measurable success criterion, optimize for satisfying that criterion, not for implementing the most literal genre of solution.",
"Before a broad training, search, build, simulation, or generation run, choose an action whose reason names the target metric, the remaining budget, and why this action is likely to move the metric enough.",
"Library availability is not an instruction to use that library. Prefer the simplest task-valid method that can satisfy the observable success criterion within the remaining budget.",
"If a task asks for a trained, searched, generated, optimized, or synthesized artifact, first consider whether a cheap baseline, direct construction, fixture-derived solution, or small search can satisfy the metric before starting an expensive conventional pipeline.",
"If the latest verification is far from the required metric, treat that as evidence against the current approach unless the next action names a specific defect and why repairing it should close the gap.",
```

Add this string to `doneWhen`:

```ts
"For measurable tasks, your reason names the required metric and why the chosen action is budget-fit before starting broad expensive work.",
```

Add this string to `extraRules`:

```ts
"Progress items for measurable tasks should track required outcomes, not just activity phases. A completed run with a failed metric is not a done progress item.",
```

- [ ] **Step 4: Run the prompt-builder test**

Run:

```bash
node --import tsx --test tests/unit/prompt-builder.test.ts
```

Expected: PASS.

## Task 2: Clarify Dev-Shell Guidance for Optimization Controllers

**Files:**
- Modify: `agents/reference-react/prompts/includes/dev-shell.md`
- Test: `tests/unit/prompt-builder.test.ts`

- [ ] **Step 1: Extend the failing test**

Add these assertions to the same prompt-builder test:

```ts
assert.match(prompt, /For training, optimization, simulation, or search controllers/u);
assert.match(prompt, /Do not run full final verification inside the inner/u);
assert.match(prompt, /Promote candidates to final required artifact paths only after/u);
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --import tsx --test tests/unit/prompt-builder.test.ts
```

Expected: FAIL because the dev-shell include does not contain this guidance yet.

- [ ] **Step 3: Add the dev-shell prompt section**

In `agents/reference-react/prompts/includes/dev-shell.md`, after the paragraph beginning `Long bounded controllers must finish`, add:

```md
For training, optimization, simulation, or search controllers:
- Do not run full final verification inside the inner training/search/simulation loop.
- Use cheap progress checks inside the loop and run full required verification only at command end or after a candidate appears likely to pass.
- Write candidates to staging first. Promote candidates to final required artifact paths only after the visible metric check passes.
- If the metric is far below target, report that mismatch plainly and change approach or name the exact defect before spending another broad run.
```

- [ ] **Step 4: Run the prompt-builder test**

Run:

```bash
node --import tsx --test tests/unit/prompt-builder.test.ts
```

Expected: PASS.

## Task 3: Add a Prompt-Suite Scenario for Budget-Fit Metric Reasoning

**Files:**
- Modify: `tests/scenario/promptSuiteHarness.ts`
- Test: `tests/scenario/prompt-suite-pass-rate.test.ts`

- [ ] **Step 1: Add the scenario case**

Append this case to the `CASES` array in `tests/scenario/promptSuiteHarness.ts`:

```ts
{
  name: "measurable_artifact_budget_fit",
  message:
    "In this workspace, produce an artifact that must pass an explicit numeric score above 300 within about five minutes. A conventional slow training pipeline is possible, but a simpler task-valid candidate or small search may also satisfy the score. Choose the next action. Do not assume that using the available ML library is required unless it is the cheapest likely path.",
  expectsTool: true,
  tags: ["tools", "metric", "budget", "prompt-engineering"],
  failureClass: "recovery",
  risk: "high",
}
```

- [ ] **Step 2: Run the scenario smoke test**

Run:

```bash
node --import tsx --test tests/scenario/prompt-suite-pass-rate.test.ts
```

Expected: PASS. If it fails because the scenario expects real filesystem tools that are unavailable in the harness configuration, keep the scenario in the suite only if the failure is a real prompt regression; otherwise move this assertion to a unit-level prompt assembly test in Task 4.

## Task 4: Add a Deterministic Unit Test for the Prompt Text Contract

**Files:**
- Modify: `tests/unit/prompt-builder.test.ts`

- [ ] **Step 1: Add a single targeted prompt contract test**

If Task 3 is noisy, keep the behavioral coverage deterministic by adding this test:

```ts
test("deliberator prompt discourages broad expensive work before budget-fit metric reasoning", () => {
  const prompt = buildRoleSystemPrompt("deliberator", {
    filesystem: "Use fs tools.",
    devShell: "Use dev.shell.run.",
    workspace: "Workspace guidance.",
  });

  const requiredFragments = [
    "explicit measurable success criterion",
    "target metric",
    "remaining budget",
    "broad training, search, build, simulation, or generation run",
    "Library availability is not an instruction",
    "cheap baseline",
    "failed metric is not a done progress item",
  ];

  for (const fragment of requiredFragments) {
    assert.equal(
      prompt.includes(fragment),
      true,
      `Expected deliberator prompt to include: ${fragment}`,
    );
  }
});
```

- [ ] **Step 2: Run the unit test**

Run:

```bash
node --import tsx --test tests/unit/prompt-builder.test.ts
```

Expected: PASS.

## Task 5: Focused Verification

**Files:**
- No additional edits.

- [ ] **Step 1: Run prompt tests**

Run:

```bash
node --import tsx --test tests/unit/prompt-builder.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run prompt suite**

Run:

```bash
pnpm run prompt-suite
```

Expected: PASS. If it fails, inspect whether the failure is the new metric-budget scenario or an unrelated flaky/provider issue.

- [ ] **Step 3: Run governance check**

Run:

```bash
pnpm run governance:check
```

Expected: PASS.

- [ ] **Step 4: Decide whether broader gates are warranted**

Because this is prompt-only plus prompt tests, run these only if the touched files or generated resource checks indicate broader impact:

```bash
pnpm run test
pnpm run evals:release-check
```

Expected: PASS or documented unrelated failures.

## Review Checklist

- The wording is general and does not mention CartPole, Terminal Bench, or task IDs.
- The change is prompt guidance, not deterministic strategy routing.
- The prompt still allows broad training/search when the model can justify it as budget-fit.
- Full final verification is discouraged only inside hot loops, not at command end.
- A failed metric cannot be represented as completed progress.
