---
id: plan-managed-entrypoint-operational-protocol-context-2026-05-12
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on: [../../PLANS.md]
---

# Managed Entrypoint Operational Protocol Context Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the task-specific operational protocol needed to drive managed Terminal-Bench entrypoints without restoring full iterative task-text bloat.

**Architecture:** Add a bounded, model-facing "Managed entrypoint protocol" context block derived from exact task-text snippets already ingested by Kestrel. Keep the runtime policy unchanged: this is context rendering, not a solver, parser, verifier, compile guard, retry rule, or benchmark-specific strategy. Reduce repeated child-artifact contract text so the protocol block fits near the top of deliberator and observer inputs.

**Tech Stack:** TypeScript, Node test runner, existing `ContextBuilder`, `modelInputBoundary`, and reference-react boundary tests.

---

## File Structure

- Modify `agents/reference-react/src/context/ContextBuilder.ts`
  - Add a bounded protocol-snippet extractor.
  - Render protocol snippets inside `describeManagedEntrypointContext(...)`, immediately after the canonical launch line.
  - Compact repeated `requiredChildren` rendering so `/app/output/1.txt` through `/app/output/10.txt` does not crowd out task mechanics.
- Modify `agents/reference-react/src/modelInputBoundary.ts`
  - Include a short operational-protocol summary in compact managed-entrypoint goals.
- Modify `tests/unit/context-builder-budget.test.ts`
  - Add regression coverage proving iterative context preserves `./maze_game.sh <maze_id>`, `1 through 10`, `move N/S/E/W`, and movement response tokens while staying compact.
- Modify `tests/unit/model-input-boundary.test.ts`
  - Update the existing managed-entrypoint compact-goal test so it expects protocol facts and still rejects full raw task repetition.
- Modify `tests/unit/react-boundary-journey.test.ts`
  - Add a journey-shaped regression proving maze-managed context steers away from "grid printed in stdout" assumptions and toward movement-response DFS/controller logic.

## Scope Rules

- Do not add persisted state, model schema fields, compile guards, retry caps, task solvers, hidden verifier access, or benchmark-specific success logic.
- Do not parse arbitrary command output for correctness.
- Do not infer maze correctness from protocol snippets.
- The extractor may use bounded task-text snippets around explicit managed-entrypoint mentions, command examples, response vocabulary, and artifact templates. These snippets are raw context facts, not policy decisions.
- Keep forbidden model-facing sections out: `Working memory:`, `Required artifact status:`, `Recent action pattern:`, proof-chain language, support IDs, and blocker-ID instructions.

---

### Task 1: Add Failing Context Tests For Managed Protocol Snippets

**Files:**
- Modify: `tests/unit/context-builder-budget.test.ts`

- [ ] **Step 1: Add a maze-shaped task constant near existing managed-entrypoint tests**

```ts
const mazeProtocolTask = [
  "To begin the challenge:",
  "1. Run the `./maze_game.sh <maze_id>` script to start the maze interface for a specific maze",
  "   - Valid maze IDs are 1 through 10, representing different maze sizes",
  "Commands you can use in the maze interface:",
  "- `move N` (move north/up)",
  "- `move S` (move south/down)",
  "- `move E` (move east/right)",
  "- `move W` (move west/left)",
  "After each movement command, you'll receive one of these responses:",
  "- \"hit wall\" (cannot move in that direction)",
  "- \"moved\" (successfully moved)",
  "- \"reached exit\" (found the exit 'E')",
  "Once you've fully explored a maze, create a file named `/app/output/<maze_id>.txt` that accurately represents that maze.",
].join("\n");
```

- [ ] **Step 2: Add a test that proves protocol facts render near managed entrypoints**

```ts
test("managed entrypoint context preserves operational protocol snippets", () => {
  const context = buildDecisionContext({
    reactState: {
      goal: mazeProtocolTask,
    },
    eventPayload: {
      message: mazeProtocolTask,
      metadata: {
        managedEntrypoints: [
          {
            path: "/app/maze_game.sh",
            command: "./maze_game.sh",
            cwd: "/app",
            securityMode: "protected_entrypoint",
            requiredTransport: "kestrel_devshell.start",
          },
        ],
      },
    },
    budget: {
      remainingMs: 120_000,
      tokensUsed: 0,
      toolCallsUsed: 0,
    },
    capabilityManifest: [],
  });

  const situation = context.currentSituation;
  assert.match(situation, /Managed entrypoints:/u);
  assert.match(situation, /Managed entrypoint protocol:/u);
  assert.match(situation, /\.\/maze_game\.sh <maze_id>/u);
  assert.match(situation, /Valid maze IDs are 1 through 10/u);
  assert.match(situation, /move N/u);
  assert.match(situation, /move S/u);
  assert.match(situation, /move E/u);
  assert.match(situation, /move W/u);
  assert.match(situation, /hit wall/u);
  assert.match(situation, /moved/u);
  assert.match(situation, /reached exit/u);
  assert.match(situation, /\/app\/output\/<maze_id>\.txt/u);
  assert.equal(situation.length <= 3_000, true);
  assert.doesNotMatch(situation, /Working memory:/u);
  assert.doesNotMatch(situation, /Required artifact status:/u);
  assert.doesNotMatch(situation, /Recent action pattern:/u);
});
```

- [ ] **Step 3: Add a test that child artifact repetition is summarized**

```ts
test("compact task contract summarizes large required child sets", () => {
  const context = buildDecisionContext({
    reactState: {
      goal: mazeProtocolTask,
    },
    eventPayload: {
      message: mazeProtocolTask,
      metadata: {
        managedEntrypoints: [
          {
            path: "/app/maze_game.sh",
            command: "./maze_game.sh",
            cwd: "/app",
            securityMode: "protected_entrypoint",
            requiredTransport: "kestrel_devshell.start",
          },
        ],
      },
    },
    budget: {
      remainingMs: 120_000,
      tokensUsed: 0,
      toolCallsUsed: 0,
    },
    capabilityManifest: [],
  });

  const contractText = JSON.stringify(context.compactTaskContract);
  assert.match(contractText, /"path":"\/app\/output"/u);
  assert.match(contractText, /requiredChildSummary/u);
  assert.doesNotMatch(contractText, /Create required child artifact \/app\/output\/10\.txt.*Create required child artifact \/app\/output\/9\.txt/u);
});
```

- [ ] **Step 4: Run the focused tests and confirm failure**

Run:

```bash
node --import tsx --test tests/unit/context-builder-budget.test.ts
```

Expected: the new tests fail because `Managed entrypoint protocol:` is not rendered and child artifact output is still repetitive.

---

### Task 2: Implement Bounded Operational Protocol Snippets

**Files:**
- Modify: `agents/reference-react/src/context/ContextBuilder.ts`

- [ ] **Step 1: Add protocol constants near the other context budgets**

```ts
const MANAGED_ENTRYPOINT_PROTOCOL_MAX_SNIPPETS = 8;
const MANAGED_ENTRYPOINT_PROTOCOL_SNIPPET_CHARS = 180;
const MANAGED_ENTRYPOINT_PROTOCOL_TOTAL_CHARS = 900;
```

- [ ] **Step 2: Add protocol snippets to the compact task contract**

In `buildCompactTaskContract(...)`, compute protocol snippets from `combined`:

```ts
const managedEntrypointProtocol = deriveManagedEntrypointProtocolSnippets(combined);
```

Then include the field only when snippets exist:

```ts
return {
  taskHash: createHash("sha256").update(combined).digest("hex").slice(0, 16),
  taskLength: Buffer.byteLength(combined, "utf8"),
  ...(artifacts.length > 0 ? { requiredArtifacts: artifacts } : {}),
  ...(visibleRequirements.length > 0 ? { visibleRequirements } : {}),
  ...(managedEntrypointProtocol.length > 0 ? { managedEntrypointProtocol } : {}),
  ...(input.omitExcerpt === true ? {} : { excerpt: clampTaskText(combined, TASK_CONTRACT_EXCERPT_CHARS) }),
};
```

- [ ] **Step 3: Add the extractor below `deriveCompactVisibleRequirements(...)`**

```ts
function deriveManagedEntrypointProtocolSnippets(combinedTaskText: string): string[] {
  const snippets = combinedTaskText
    .split(/\n+/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const snippet of snippets) {
    if (isManagedEntrypointProtocolSnippet(snippet) === false) {
      continue;
    }
    const clipped = clampRawText(snippet, MANAGED_ENTRYPOINT_PROTOCOL_SNIPPET_CHARS);
    const key = clipped.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(clipped);
    if (selected.length >= MANAGED_ENTRYPOINT_PROTOCOL_MAX_SNIPPETS) {
      break;
    }
  }
  return selected;
}

function isManagedEntrypointProtocolSnippet(snippet: string): boolean {
  const lower = snippet.toLowerCase();
  return (
    /`?\.\/[^`\s]+(?:\s+<[^>]+>)?`?/u.test(snippet) ||
    /\bvalid .{0,40}(ids?|arguments?|inputs?)\b/iu.test(snippet) ||
    /\bcommands? you can use\b/iu.test(snippet) ||
    /`?move\s+[NSEW]`?/u.test(snippet) ||
    /\b(hit wall|moved|reached exit)\b/iu.test(snippet) ||
    /\/app\/output\/<[^>]+>\.txt/u.test(snippet) ||
    /\bafter each .{0,40}command\b/iu.test(lower) ||
    /\bbatch .{0,40}commands?\b/iu.test(lower)
  );
}
```

This is a bounded snippet selector. It does not decide correctness, infer state, parse hidden outputs, or change policy.

- [ ] **Step 4: Render the snippets in `describeManagedEntrypointContext(...)`**

Change the function input type:

```ts
function describeManagedEntrypointContext(input: {
  managedEntrypoints: readonly ManagedEntrypointContext[];
  processes: Record<string, unknown>[];
  latest: LatestToolEvidence | undefined;
  completionAttemptPacket: CompletionAttemptPacketFact | undefined;
  compactTaskContract?: Record<string, unknown> | undefined;
}): string | undefined {
```

After the canonical launch lines, add:

```ts
const protocolLines = readManagedEntrypointProtocolLines(input.compactTaskContract);
if (protocolLines.length > 0) {
  lines.push("Managed entrypoint protocol:");
  lines.push(...protocolLines.map((line) => `- ${line}`));
}
```

Add helper:

```ts
function readManagedEntrypointProtocolLines(contract: Record<string, unknown> | undefined): string[] {
  const snippets = asArray(contract?.managedEntrypointProtocol)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0);
  if (snippets.length === 0) {
    return [];
  }
  const joined: string[] = [];
  let used = 0;
  for (const snippet of snippets) {
    const next = clampRawText(snippet, MANAGED_ENTRYPOINT_PROTOCOL_SNIPPET_CHARS);
    if (used + next.length > MANAGED_ENTRYPOINT_PROTOCOL_TOTAL_CHARS) {
      break;
    }
    joined.push(next);
    used += next.length;
  }
  return joined;
}
```

- [ ] **Step 5: Pass `compactTaskContract` into both callers**

In `buildCurrentSituation(...)` and `buildObserverSituation(...)`, update the calls:

```ts
add(describeManagedEntrypointContext({
  managedEntrypoints: input.managedEntrypoints,
  processes: input.devShellProcesses,
  latest: input.latestToolEvidence,
  completionAttemptPacket: input.completionAttemptPacket,
  compactTaskContract: input.compactTaskContract,
}), true);
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --import tsx --test tests/unit/context-builder-budget.test.ts
```

Expected: protocol rendering assertions pass, child summary test still fails until Task 3.

---

### Task 3: Compact Repeated Required Children

**Files:**
- Modify: `agents/reference-react/src/context/ContextBuilder.ts`

- [ ] **Step 1: Add child rendering helper below `mergeArtifactContractChildren(...)`**

```ts
function renderRequiredChildrenForCompactContract(
  children: readonly NonNullable<ExtractedArtifactContract["requiredChildren"]>[number][],
): Record<string, unknown> {
  const normalized = children
    .map((child) => ({
      path: child.path,
      requirement: child.requirement,
      ...(child.sourceText !== undefined
        ? { sourceText: clampRawText(child.sourceText, TASK_CONTRACT_SOURCE_SNIPPET_CHARS) }
        : {}),
    }))
    .filter((child) => child.path.trim().length > 0);
  if (normalized.length <= 5) {
    return { requiredChildren: normalized };
  }
  return {
    requiredChildSummary: {
      count: normalized.length,
      first: normalized.slice(0, 3),
      last: normalized.slice(-2),
    },
  };
}
```

- [ ] **Step 2: Replace inline `requiredChildren` mapping**

Replace this pattern in `buildCompactTaskContract(...)`:

```ts
...(contract.requiredChildren !== undefined
  ? {
      requiredChildren: contract.requiredChildren.map((child) => ({
        path: child.path,
        requirement: child.requirement,
        ...(child.sourceText !== undefined
          ? { sourceText: clampRawText(child.sourceText, TASK_CONTRACT_SOURCE_SNIPPET_CHARS) }
          : {}),
      })),
    }
  : {}),
```

with:

```ts
...(contract.requiredChildren !== undefined
  ? renderRequiredChildrenForCompactContract(contract.requiredChildren)
  : {}),
```

- [ ] **Step 3: Run focused context tests**

Run:

```bash
node --import tsx --test tests/unit/context-builder-budget.test.ts
```

Expected: both new context tests pass and existing context tests still pass.

---

### Task 4: Preserve Protocol Facts In Compact Managed Goals

**Files:**
- Modify: `agents/reference-react/src/modelInputBoundary.ts`
- Modify: `tests/unit/model-input-boundary.test.ts`

- [ ] **Step 1: Update the existing managed-entrypoint boundary test**

In the existing test named similar to `iterative model inputs prefer compact managed-entrypoint goal over raw task excerpt`, add assertions:

```ts
assert.match(String(deliberatorInput.goal), /Managed task entrypoint\(s\): \.\/maze_game\.sh in \/app/u);
assert.match(String(deliberatorInput.goal), /\.\/maze_game\.sh <maze_id>/u);
assert.match(String(deliberatorInput.goal), /Valid maze IDs are 1 through 10/u);
assert.match(String(deliberatorInput.goal), /move N/u);
assert.match(String(deliberatorInput.goal), /hit wall/u);
assert.doesNotMatch(String(deliberatorInput.goal), /^Complete this task\.\nRun \.\/maze_game\.sh/u);
```

Expected failure: compact goal currently omits these protocol snippets.

- [ ] **Step 2: Update `buildManagedEntrypointCompactGoal(...)`**

Read `managedEntrypointProtocol` from the compact contract:

```ts
const protocolSnippets = Array.isArray(contract?.managedEntrypointProtocol)
  ? contract.managedEntrypointProtocol
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .slice(0, 5)
  : [];
```

Add to `parts`:

```ts
protocolSnippets.length > 0
  ? `Operational protocol: ${protocolSnippets.join(" | ")}.`
  : undefined,
```

- [ ] **Step 3: Run model-input tests**

Run:

```bash
node --import tsx --test tests/unit/model-input-boundary.test.ts
```

Expected: existing boundary tests and new protocol assertions pass.

---

### Task 5: Add Journey Regression For Wrong Stdout-Grid Assumption

**Files:**
- Modify: `tests/unit/react-boundary-journey.test.ts`

- [ ] **Step 1: Add a journey test near the existing managed-entrypoint cases**

```ts
test("managed maze context preserves movement protocol after parser failure", () => {
  const task = [
    "Run the `./maze_game.sh <maze_id>` script to start the maze interface for a specific maze",
    "Valid maze IDs are 1 through 10.",
    "Commands you can use in the maze interface:",
    "- `move N`",
    "- `move S`",
    "- `move E`",
    "- `move W`",
    "After each movement command, you'll receive one of these responses:",
    "- \"hit wall\"",
    "- \"moved\"",
    "- \"reached exit\"",
    "create a file named `/app/output/<maze_id>.txt` that accurately represents that maze",
  ].join("\n");
  const context = buildDecisionContext({
    reactState: {
      goal: task,
      observerJudgment: {
        kind: "continue",
        handoffNote:
          "The controller started the managed entrypoint but failed with RuntimeError: maze grid not found in output. The repair target is maze_controller.py runtime logic.",
      },
      lastActionResult: {
        kind: "tool",
        name: "dev.shell.run",
        status: "FAILED",
        output: [
          "COMPLETION_ATTEMPT_PACKET_START",
          "{",
          "  \"required_output\": \"/app/output\",",
          "  \"producer_transport\": \"kestrel_devshell.start\",",
          "  \"entrypoint_started\": true,",
          "  \"producer_status\": \"failed\",",
          "  \"blockers\": [\"RuntimeError: maze grid not found in output\"],",
          "  \"repair_target\": \"maze_controller.py runtime logic\"",
          "}",
          "COMPLETION_ATTEMPT_PACKET_END",
        ].join("\n"),
      },
      workItem: {
        phase: "derive_artifact",
        objective: "Create /app/output.",
        target: "/app/output",
      },
    },
    eventPayload: {
      message: task,
      metadata: {
        managedEntrypoints: [
          {
            path: "/app/maze_game.sh",
            command: "./maze_game.sh",
            cwd: "/app",
            securityMode: "protected_entrypoint",
            requiredTransport: "kestrel_devshell.start",
          },
        ],
      },
    },
    budget: {
      remainingMs: 90_000,
      tokensUsed: 0,
      toolCallsUsed: 0,
    },
    capabilityManifest: [],
  });

  const situation = String(buildDeliberatorModelInput({
    goal: task,
    eventType: "react.deliberate",
    decisionContext: context,
    availableTools: [],
    capabilityManifest: [],
  }).currentSituation);

  assert.match(situation, /maze grid not found in output/u);
  assert.match(situation, /\.\/maze_game\.sh <maze_id>/u);
  assert.match(situation, /move N/u);
  assert.match(situation, /hit wall/u);
  assert.match(situation, /reached exit/u);
  assert.doesNotMatch(situation, /Working memory:/u);
  assert.doesNotMatch(situation, /Required artifact status:/u);
});
```

- [ ] **Step 2: Run journey tests**

Run:

```bash
node --import tsx --test tests/unit/react-boundary-journey.test.ts
```

Expected: the new journey test passes once Tasks 2-4 are complete.

---

### Task 6: Validation And Probe

**Files:**
- No new files.

- [ ] **Step 1: Run focused boundary tests**

Run:

```bash
node --import tsx --test tests/unit/context-builder-budget.test.ts tests/unit/model-input-boundary.test.ts tests/unit/react-boundary-journey.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run required project gates**

Run:

```bash
pnpm run typecheck
pnpm run prompt-suite
pnpm run evals:release-check
pnpm run governance:check
pnpm run test
```

Expected: all pass. If `pnpm run test` fails in unrelated dirty work, record the exact failing test and do not fold unrelated cleanup into this slice.

- [ ] **Step 3: Run one Terminal-Bench probe**

Run:

```bash
pnpm run bench:terminal -- cli --task-id blind-maze-explorer-algorithm
```

Acceptance for this slice:
- model-facing context includes managed entrypoint facts and the operational protocol;
- generated controller no longer assumes the maze prints a full grid on startup;
- if the run still fails, the next observed issue is in controller DFS logic or task solving, not context loss of invocation/movement semantics.

---

## Self-Review

- Spec coverage: This plan preserves the operational protocol near managed entrypoints, keeps context compact, avoids new runtime policy, and adds tests for context, model boundary, and journey behavior.
- Placeholder scan: No task contains `TBD`, `TODO`, or unspecified test instructions.
- Type consistency: The only new compact contract field is `managedEntrypointProtocol: string[]`; it is read as an optional record field and does not alter persisted ReAct state or model output schemas.
