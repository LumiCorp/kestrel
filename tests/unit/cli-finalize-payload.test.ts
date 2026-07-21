import assert from "node:assert/strict";

import { buildFinalizePlainText, parseFinalizePayload } from "../../cli/output/FinalizePayload.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseFinalizePayload accepts {message,data?}", () => {
  const result = parseFinalizePayload({
    message: "Done",
    data: {
      id: 123,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload?.message, "Done");
  assert.deepEqual(result.payload?.data, { id: 123 });
});

contractTest("runtime.hermetic", "parseFinalizePayload rejects missing message", () => {
  const result = parseFinalizePayload({
    text: "nope",
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /message/);
});

contractTest("runtime.hermetic", "parseFinalizePayload accepts coding finalize payload data envelope", () => {
  const result = parseFinalizePayload({
    message: "Implemented and verified.",
    data: {
      summary: "Updated agent loop finalize behavior.",
      blockers: [],
      residualRisks: [],
      completionState: "implemented_and_verified",
      reportingGrounding: {
        summary: "model_authored",
        blockers: "model_authored",
        residualRisks: "model_authored",
        completionState: "model_authored",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload?.message, "Implemented and verified.");
  assert.equal((result.payload?.data ?? {}).completionState, "implemented_and_verified");
  assert.equal(
    (result.payload?.data as Record<string, unknown> | undefined)?.reportingGrounding !== undefined,
    true,
  );
});

contractTest("runtime.hermetic", "buildFinalizePlainText renders plan-shaped ui blocks into readable text", () => {
  const plainText = buildFinalizePlainText({
    ui: {
      blocks: [
        {
          kind: "steps",
          title: "Plan",
          items: [
            { title: "Inspect the workspace", status: "done" },
            { title: "Build the page", detail: "Create the landing route", status: "pending" },
          ],
        },
      ],
    },
  });

  assert.equal(
    plainText,
    [
      "Plan",
      "- [done] Inspect the workspace",
      "- [pending] Build the page: Create the landing route",
    ].join("\n"),
  );
});
