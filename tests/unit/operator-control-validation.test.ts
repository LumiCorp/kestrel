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
