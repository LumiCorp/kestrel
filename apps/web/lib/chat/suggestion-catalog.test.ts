import assert from "node:assert/strict";
import test from "node:test";
import { selectChatSuggestions } from "./suggestion-catalog";

test("selectChatSuggestions is deterministic for the same seed", () => {
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

test("selectChatSuggestions covers all primary lanes when media is enabled", () => {
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

test("selectChatSuggestions excludes media suggestions when media is unavailable", () => {
  const selected = selectChatSuggestions({
    seed: "chat-no-media",
    imageEnabled: false,
    knowledgeEnabled: true,
    videoEnabled: false,
  });

  assert.equal(selected.length, 4);
  assert.ok(selected.every((suggestion) => suggestion.kind === "prompt"));
});

test("selectChatSuggestions only includes enabled media kinds", () => {
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

test("selectChatSuggestions excludes knowledge suggestions when knowledge is unavailable", () => {
  const selected = selectChatSuggestions({
    seed: "chat-no-knowledge",
    imageEnabled: true,
    knowledgeEnabled: false,
    videoEnabled: true,
  });

  assert.ok(selected.every((suggestion) => suggestion.feature !== "knowledge"));
});
