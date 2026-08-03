import test from "node:test";
import assert from "node:assert/strict";
import { parseRunnerCommandV2 } from "@kestrel-agents/protocol";

test("operator approval replies cannot select grant classes or capabilities", () => {
  for (const legacyAuthority of [
    { allowToolClasses: ["external_side_effect"] },
    { allowCapabilities: ["mcp.invoke"] },
  ]) {
    assert.throws(
      () =>
        parseRunnerCommandV2({
          id: "operator-approval-authority",
          type: "operator.control",
          payload: {
            action: "approve",
            threadId: "thread-1",
            ...legacyAuthority,
          },
        }),
      /is not supported/u,
    );
  }
});

test("operator recovery options are accepted only on reply commands", () => {
  const parsed = parseRunnerCommandV2({
    id: "operator-recovery-option",
    type: "operator.control",
    payload: {
      action: "reply",
      threadId: "thread-1",
      requestId: "request-1",
      recoveryOptionId: "retry.primary",
      message: "Selected recovery option: retry.primary",
    },
  });
  assert.equal(parsed.type, "operator.control");
  if (parsed.type === "operator.control") {
    assert.equal(parsed.payload.recoveryOptionId, "retry.primary");
  }

  assert.throws(
    () => parseRunnerCommandV2({
      id: "operator-recovery-option-blank",
      type: "operator.control",
      payload: {
        action: "reply",
        threadId: "thread-1",
        recoveryOptionId: "",
      },
    }),
    /recoveryOptionId must be a non-empty string/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "operator-recovery-option-unrelated",
      type: "operator.control",
      payload: {
        action: "retry",
        threadId: "thread-1",
        recoveryOptionId: "retry.primary",
      },
    }),
    /recoveryOptionId is supported only for reply/u,
  );
});
