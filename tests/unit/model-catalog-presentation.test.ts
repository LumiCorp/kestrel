import assert from "node:assert/strict";

import { buildPresentedProviderModelCatalog } from "../../src/profile/modelCatalogPresentation.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "buildPresentedProviderModelCatalog falls back to discovered models when curated recommendations are absent", () => {
  const summary = buildPresentedProviderModelCatalog({
    provider: "openrouter",
    catalog: {
      provider: "openrouter",
      source: "live",
      models: [
        "google/gemini-2.5-flash",
        "meta-llama/llama-3.3-70b-instruct",
      ],
    },
  });

  assert.deepEqual(summary.recommendedModels, [
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
  ]);
  assert.equal(summary.additionalAvailableCount, 0);
  assert.equal(summary.totalAvailableCount, 2);
});
