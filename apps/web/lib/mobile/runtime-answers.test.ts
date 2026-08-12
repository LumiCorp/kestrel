import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMobileRuntimeAnswers } from "./runtime-answers";

test("normalizes every mobile Runtime question without collapsing identifiers", () => {
  assert.deepEqual(
    normalizeMobileRuntimeAnswers({
      workspace: "Workspace A",
      permissions: ["read", "write"],
      retries: 2,
      confirmed: true,
    }),
    {
      workspace: ["Workspace A"],
      permissions: ["read", "write"],
      retries: ["2"],
      confirmed: ["true"],
    },
  );
});

test("does not manufacture answers for an empty mobile response", () => {
  assert.equal(normalizeMobileRuntimeAnswers(undefined), undefined);
  assert.equal(normalizeMobileRuntimeAnswers({}), undefined);
});
