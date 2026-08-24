import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentOptions } from "../../agents/reference-react/src/constants.js";
import { DEFAULT_OPENROUTER_MODEL } from "../../models/openrouter/constants.js";

test("reference agent uses the canonical OpenRouter model by default", () => {
  const options = resolveAgentOptions();

  assert.equal(options.agentModel, DEFAULT_OPENROUTER_MODEL);
  assert.equal(options.maintenanceModel, DEFAULT_OPENROUTER_MODEL);
  assert.equal(options.delegationModel, DEFAULT_OPENROUTER_MODEL);
});
