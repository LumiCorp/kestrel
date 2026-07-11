import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeRestoredActiveRegion,
  shouldSeedComposerFromChatInput,
  toPersistedActiveRegion,
} from "../../cli/ink/focusPolicy.js";

test("normalizeRestoredActiveRegion removes transient command bar focus", () => {
  assert.equal(normalizeRestoredActiveRegion("chat", "command_bar"), "composer");
  assert.equal(normalizeRestoredActiveRegion("logs", "logs"), "logs");
});

test("normalizeRestoredActiveRegion keeps chat details from trapping focus", () => {
  assert.equal(normalizeRestoredActiveRegion("chat", "details"), "composer");
  assert.equal(normalizeRestoredActiveRegion("logs", "details"), "details");
});

test("toPersistedActiveRegion stores the command bar return region instead of transient focus", () => {
  assert.equal(toPersistedActiveRegion({ activeRegion: "command_bar", commandBarReturnRegion: "chat_list" }), "chat_list");
  assert.equal(toPersistedActiveRegion({ activeRegion: "command_bar" }), "composer");
  assert.equal(toPersistedActiveRegion({ activeRegion: "logs" }), "logs");
});

test("shouldSeedComposerFromChatInput admits printable chat input and preserves controls", () => {
  assert.equal(shouldSeedComposerFromChatInput({ activeView: "chat", activeRegion: "chat_list" }, "h", {}), true);
  assert.equal(shouldSeedComposerFromChatInput({ activeView: "chat", activeRegion: "chat_list", chatTailLocked: false }, "h", {}), false);
  assert.equal(shouldSeedComposerFromChatInput({ activeView: "chat", activeRegion: "chat_list" }, "h", { ctrl: true }), false);
  assert.equal(shouldSeedComposerFromChatInput({ activeView: "chat", activeRegion: "chat_list" }, "/", {}), false);
  assert.equal(shouldSeedComposerFromChatInput({ activeView: "chat", activeRegion: "chat_list" }, "", {}), false);
  assert.equal(shouldSeedComposerFromChatInput({ activeView: "chat", activeRegion: "composer" }, "h", {}), false);
});
