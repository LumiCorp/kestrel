import assert from "node:assert/strict";

import {
  buildPlan,
  parseArgs,
  patchStateForV3,
  type CandidateSession,
  type CliOptions,
} from "../../scripts/migrate-v2-to-v3.js";
import { contractTest } from "../helpers/contract-test.js";


function makeCandidate(overrides: Partial<CandidateSession>): CandidateSession {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    currentVersion: overrides.currentVersion ?? 1,
    currentStepAgent: overrides.currentStepAgent,
    schemaVersion: overrides.schemaVersion,
    legacyReadonly: overrides.legacyReadonly ?? false,
    hasActiveRun: overrides.hasActiveRun ?? false,
    hasPendingEffects: overrides.hasPendingEffects ?? false,
    hasPendingOutbox: overrides.hasPendingOutbox ?? false,
    hasStepAgent: overrides.hasStepAgent ?? false,
  };
}

contractTest("runtime.hermetic", "buildPlan defaults to active/resumable migration scope", () => {
  const sessions: CandidateSession[] = [
    makeCandidate({ sessionId: "active", hasActiveRun: true }),
    makeCandidate({ sessionId: "pending", hasPendingEffects: true }),
    makeCandidate({ sessionId: "cold" }),
    makeCandidate({ sessionId: "readonly", legacyReadonly: true, hasActiveRun: true }),
  ];
  const options: CliOptions = {
    dryRun: true,
    apply: false,
    scope: "active-resumable",
    sessionIds: [],
  };

  const plan = buildPlan(sessions, options);
  assert.deepEqual(
    plan.migratable.map((session) => session.sessionId),
    ["active", "pending"],
  );
  assert.deepEqual(
    plan.archiveOnly.map((session) => session.sessionId),
    ["cold", "readonly"],
  );
});

contractTest("runtime.hermetic", "buildPlan with ids scope reports unknown sessions as blocked", () => {
  const sessions: CandidateSession[] = [
    makeCandidate({ sessionId: "one", hasActiveRun: true }),
  ];
  const options: CliOptions = {
    dryRun: true,
    apply: false,
    scope: "ids",
    sessionIds: ["one", "missing"],
  };

  const plan = buildPlan(sessions, options);
  assert.deepEqual(plan.migratable.map((session) => session.sessionId), ["one"]);
  assert.deepEqual(plan.blocked, [{ sessionId: "missing", reason: "session_not_found" }]);
});

contractTest("runtime.hermetic", "patchStateForV3 backfills memory, budget, and stateNode defaults", () => {
  const patched = patchStateForV3({}, "session-abc");
  const memory = patched.memory as Record<string, unknown>;
  const budget = patched.budget as Record<string, unknown>;
  const stateNode = patched.stateNode as Record<string, unknown>;

  assert.deepEqual(memory.working, {});
  assert.equal(typeof memory.episodicRef, "string");
  assert.equal(memory.semanticRef, "semantic:default");

  assert.equal(budget.remainingMs, 30_000);
  assert.equal(budget.tokensUsed, 0);
  assert.equal(budget.toolCallsUsed, 0);

  assert.equal(stateNode.parent, "root");
  assert.equal(stateNode.child, "idle");
});

contractTest("runtime.hermetic", "parseArgs tolerates leading standalone -- forwarded by pnpm run", () => {
  const options = parseArgs(["--", "--dry-run", "--scope", "active-resumable"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.scope, "active-resumable");
});
