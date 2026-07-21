import assert from "node:assert/strict";

import { checkInvariantViolations } from "../../src/governance/invariants.js";
import { contractTest } from "../helpers/contract-test.js";


function routeContractViolations(file: string, content: string): string[] {
  return checkInvariantViolations({ file, content })
    .filter((violation) => violation.rule_id === "route-triage-contract")
    .map((violation) => violation.message);
}

function commandProcessorMutationViolations(file: string, content: string): string[] {
  return checkInvariantViolations({ file, content })
    .filter((violation) => violation.rule_id === "reference-react-command-processor-mutation-authority")
    .map((violation) => violation.message);
}

contractTest("runtime.hermetic", "route-triage-contract passes when OperatorTriageSummary contains canonical fields", () => {
  const messages = routeContractViolations(
    "/repo/src/governance/contracts.ts",
    `
export interface OperatorTriageSummary {
  interactionMode: string;
  executionLane: string;
  extractorCandidateTools: string[];
  plannerAction: string;
  topFailure: unknown;
  internetSignals: unknown[];
  replayVerdict: "passed" | "failed";
  uiEvidenceInventory: unknown[];
}
`,
  );

  assert.equal(messages.length, 0);
});

contractTest("runtime.hermetic", "route-triage-contract fails when OperatorTriageSummary is missing canonical fields", () => {
  const messages = routeContractViolations(
    "/repo/src/governance/contracts.ts",
    `
export interface OperatorTriageSummary {
  interactionMode: string;
  executionLane: string;
}
`,
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /missing canonical fields/i);
});

contractTest("runtime.hermetic", "reference-react command processor invariant rejects direct execution state patches", () => {
  const messages = commandProcessorMutationViolations(
    "/repo/agents/reference-react/src/steps/acter.ts",
    `
export function createStep() {
  return {
    status: "RUNNING",
    statePatch: { react: {} },
  };
}
`,
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /must not assemble Transition\.statePatch directly/i);
});

contractTest("runtime.hermetic", "reference-react command processor invariant permits checkpoint helper calls", () => {
  const messages = commandProcessorMutationViolations(
    "/repo/agents/reference-react/src/steps/execStates.ts",
    `
export function createStep() {
  return createReferenceReactExecutionCheckpoint({ snapshot, nextStepAgent, substate: "dispatch" });
}
`,
  );

  assert.equal(messages.length, 0);
});
