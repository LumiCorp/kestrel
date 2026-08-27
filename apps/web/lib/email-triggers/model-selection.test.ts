import assert from "node:assert/strict";
import test from "node:test";
import {
  emailTriggerModelIsUnavailable,
  reconcileEmailTriggerModelSelection,
} from "./model-selection";

const models = [
  { id: "openrouter/default", isDefault: true },
  { id: "openrouter/other", isDefault: false },
];

test("editing preserves a configured model that is no longer available", () => {
  assert.equal(
    reconcileEmailTriggerModelSelection({
      currentModelId: "openrouter/retired",
      models,
      mode: "edit",
    }),
    "openrouter/retired",
  );
  assert.equal(
    emailTriggerModelIsUnavailable({
      configuredModelId: "openrouter/retired",
      models,
    }),
    true,
  );
});

test("editing retains a still-available configured model", () => {
  assert.equal(
    reconcileEmailTriggerModelSelection({
      currentModelId: "openrouter/other",
      models,
      mode: "edit",
    }),
    "openrouter/other",
  );
  assert.equal(
    emailTriggerModelIsUnavailable({
      configuredModelId: "openrouter/other",
      models,
    }),
    false,
  );
});

test("creation selects the available Project Environment default", () => {
  assert.equal(
    reconcileEmailTriggerModelSelection({
      currentModelId: "",
      models,
      mode: "create",
    }),
    "openrouter/default",
  );
});
