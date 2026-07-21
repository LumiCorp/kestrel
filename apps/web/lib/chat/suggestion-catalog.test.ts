import assert from "node:assert/strict";
import { selectChatSuggestions } from "./suggestion-catalog";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "selectChatSuggestions is deterministic for the same seed", () => {
  const first = selectChatSuggestions({
    seed: "chat-123",
    imageEnabled: true,
    videoEnabled: true,
  }).map((suggestion) => suggestion.id);
  const second = selectChatSuggestions({
    seed: "chat-123",
    imageEnabled: true,
    videoEnabled: true,
  }).map((suggestion) => suggestion.id);

  assert.deepEqual(second, first);
});

contractTest("web.hermetic", "selectChatSuggestions covers all primary lanes when media is enabled", () => {
  const selected = selectChatSuggestions({
    seed: "chat-coverage",
    imageEnabled: true,
    videoEnabled: true,
  });

  assert.equal(selected.length, 4);
  assert.deepEqual(
    selected.map((suggestion) => suggestion.lane),
    ["thinking", "making", "grounding", "media"]
  );
});

contractTest("web.hermetic", "selectChatSuggestions excludes media suggestions when media is unavailable", () => {
  const selected = selectChatSuggestions({
    seed: "chat-no-media",
    imageEnabled: false,
    knowledgeEnabled: true,
    videoEnabled: false,
  });

  assert.equal(selected.length, 4);
  assert.ok(selected.every((suggestion) => suggestion.kind === "prompt"));
});

contractTest("web.hermetic", "selectChatSuggestions only includes enabled media kinds", () => {
  const selected = selectChatSuggestions({
    seed: "chat-image-only",
    imageEnabled: true,
    knowledgeEnabled: true,
    videoEnabled: false,
  });

  const mediaSuggestion = selected.find(
    (suggestion) => suggestion.kind === "media"
  );

  assert.ok(mediaSuggestion);
  assert.equal(mediaSuggestion?.mediaKind, "image");
});

contractTest("web.hermetic", "selectChatSuggestions excludes knowledge suggestions when knowledge is unavailable", () => {
  const selected = selectChatSuggestions({
    seed: "chat-no-knowledge",
    imageEnabled: true,
    knowledgeEnabled: false,
    videoEnabled: true,
  });

  assert.ok(selected.every((suggestion) => suggestion.feature !== "knowledge"));
});
