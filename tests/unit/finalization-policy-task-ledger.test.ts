import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateFinalizationDecision } from "../../agents/reference-react/src/finalizationPolicy.js";
import { DecisionCompileError } from "../../agents/reference-react/src/decision/DecisionCompileError.js";
import type { ReactAction } from "../../agents/reference-react/src/types.js";
import { contractTest } from "../helpers/contract-test.js";


const FINALIZE_ACTION: ReactAction = {
  kind: "finalize",
  finalizeReason: "goal_satisfied",
  input: {
    message: "Done.",
    data: {},
  },
};

contractTest("runtime.hermetic", "goal-satisfied finalization does not inspect hidden ledger or evidence gates", () => {
  assert.doesNotThrow(() =>
    validateFinalizationDecision({
      action: {
        kind: "finalize",
        finalizeReason: "goal_satisfied",
        input: {
          message: "Done.",
          data: {
            completionState: "blocked",
            artifactVerification: {
              status: "failed",
              target: "index.html",
              failures: ["Rendered title is missing."],
            },
          },
        },
      },
    }),
  );
});

contractTest("runtime.hermetic", "finalization policy stays benchmark agnostic", () => {
  const source = readFileSync("agents/reference-react/src/finalizationPolicy.ts", "utf8");

  assert.doesNotMatch(source, /benchmark\.name/u);
  assert.doesNotMatch(source, /swe-verified/u);
  assert.doesNotMatch(source, /sweValidation/u);
});

contractTest("runtime.hermetic", "goal-satisfied finalization rejects implemented_and_verified with inconclusive artifact verification", () => {
  assert.throws(
    () =>
      validateFinalizationDecision({
        action: {
          kind: "finalize",
          finalizeReason: "goal_satisfied",
          input: {
            message: "Done.",
            data: {
              completionState: "implemented_and_verified",
              artifactVerification: {
                status: "inconclusive",
                target: "index.html",
                failures: ["Browser interaction was not exercised."],
              },
            },
          },
        },
      }),
    (error) =>
      error instanceof DecisionCompileError &&
      error.code === "DECISION_SCHEMA_FAILED" &&
      error.diagnostics?.reason === "implemented_and_verified_with_unpassed_artifact_verification",
  );
});

contractTest("runtime.hermetic", "finalization still requires a non-empty user-facing message", () => {
  assert.throws(
    () =>
      validateFinalizationDecision({
        action: {
          kind: "finalize",
          finalizeReason: "goal_satisfied",
          input: {
            message: "",
            data: {},
          },
        },
      }),
    (error) =>
      error instanceof DecisionCompileError &&
      error.code === "DECISION_SCHEMA_FAILED" &&
      error.diagnostics?.reason === "finalize_message_required",
  );
});

contractTest("runtime.hermetic", "goal-satisfied finalization rejects legacy closeout evidence fields", () => {
  assert.throws(
    () =>
      validateFinalizationDecision({
        action: {
          ...FINALIZE_ACTION,
          input: {
            message: "Done.",
            data: {
              changedFiles: ["index.html"],
            },
          },
        },
      }),
    (error) => {
      assert.equal(error instanceof DecisionCompileError, true);
      if (!(error instanceof DecisionCompileError)) {
        return false;
      }
      assert.equal(error.code, "DECISION_SCHEMA_FAILED");
      assert.equal(error.diagnostics?.reason, "legacy_finalize_evidence_fields_removed");
      assert.equal(error.diagnostics?.path, "nextAction.data");
      assert.match(String(error.diagnostics?.requiredCorrection), /omit changedFiles, checksRun, and checksFailed/u);
      assert.match(String(error.diagnostics?.requiredCorrection), /runtime derives changed files and validation evidence/u);
      return true;
    },
  );
});

contractTest("runtime.hermetic", "goal-satisfied finalization accepts unique non-empty keep-running session ids", () => {
  assert.doesNotThrow(() =>
    validateFinalizationDecision({
      action: {
        ...FINALIZE_ACTION,
        input: {
          message: "The app remains running at http://localhost:3000.",
          data: {
            keepRunningSessionIds: ["proc-app", "proc-worker"],
          },
        },
      },
    }),
  );
});

function assertKeepRunningSessionIdsRejected(value: unknown, reason: string): void {
  assert.throws(
    () =>
      validateFinalizationDecision({
        action: {
          ...FINALIZE_ACTION,
          input: {
            message: "Done.",
            data: { keepRunningSessionIds: value },
          },
        },
      }),
    (error) =>
      error instanceof DecisionCompileError &&
      error.code === "DECISION_SCHEMA_FAILED" &&
      error.diagnostics?.reason === reason,
  );
}

contractTest("runtime.hermetic", "finalization rejects non-array keep-running session ids", () => {
  assertKeepRunningSessionIdsRejected("proc-app", "keep_running_sessions_must_be_array");
});

contractTest("runtime.hermetic", "finalization rejects empty keep-running session ids", () => {
  assertKeepRunningSessionIdsRejected([""], "keep_running_session_id_invalid");
});

contractTest("runtime.hermetic", "finalization rejects whitespace-padded keep-running session ids", () => {
  assertKeepRunningSessionIdsRejected([" proc-app "], "keep_running_session_id_invalid");
});

contractTest("runtime.hermetic", "finalization rejects non-string keep-running session ids", () => {
  assertKeepRunningSessionIdsRejected([123], "keep_running_session_id_invalid");
});

contractTest("runtime.hermetic", "finalization rejects duplicate keep-running session ids", () => {
  assertKeepRunningSessionIdsRejected(["proc-app", "proc-app"], "keep_running_session_ids_duplicate");
});

contractTest("runtime.hermetic", "out-of-scope finalization cannot retain a running session", () => {
  assert.throws(
    () =>
      validateFinalizationDecision({
        action: {
          kind: "finalize",
          finalizeReason: "out_of_scope",
          input: {
            message: "That request is outside the current scope.",
            data: { keepRunningSessionIds: ["proc-app"] },
          },
        },
      }),
    (error) =>
      error instanceof DecisionCompileError &&
      error.code === "DECISION_SCHEMA_FAILED" &&
      error.diagnostics?.reason === "keep_running_sessions_require_goal_satisfied",
  );
});
