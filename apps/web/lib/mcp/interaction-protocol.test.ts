import assert from "node:assert/strict";
import {
  buildElicitationResponse,
  parseUrlElicitation,
} from "./interaction-protocol";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "accepts URL elicitation without form content", () => {
  const requestEnvelope = {
    mode: "url",
    message: "Authorize access",
    elicitationId: "elicit-1",
    url: "https://accounts.example.test/authorize",
  };
  assert.equal(parseUrlElicitation(requestEnvelope)?.elicitationId, "elicit-1");
  assert.deepEqual(
    buildElicitationResponse({ requestEnvelope, decision: "approve" }),
    { action: "accept" }
  );
});

contractTest("web.hermetic", "rejects non-HTTPS URL elicitation", () => {
  assert.throws(
    () =>
      parseUrlElicitation({
        mode: "url",
        message: "Open this",
        elicitationId: "elicit-2",
        url: "javascript:alert(1)",
      }),
    /HTTPS/
  );
});

contractTest("web.hermetic", "validates form elicitation primitives", () => {
  assert.deepEqual(
    buildElicitationResponse({
      requestEnvelope: { message: "Choose", requestedSchema: {} },
      decision: "approve",
      content: { choice: "yes", tags: ["safe"] },
    }),
    {
      action: "accept",
      content: { choice: "yes", tags: ["safe"] },
    }
  );
});
