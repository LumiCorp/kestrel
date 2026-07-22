import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  dictationShortcutLabel,
  isDictationShortcut,
  type DictationShortcutEvent,
} from "./dictation-shortcut";

function shortcutEvent(
  overrides: Partial<DictationShortcutEvent> = {}
): DictationShortcutEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: "m",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

contractTest("web.hermetic", "accepts the platform primary modifier for dictation", () => {
  assert.equal(
    isDictationShortcut(shortcutEvent({ metaKey: true, shiftKey: true })),
    true
  );
  assert.equal(
    isDictationShortcut(shortcutEvent({ ctrlKey: true, shiftKey: true })),
    true
  );
});

contractTest("web.hermetic", "rejects modified and ambiguous dictation shortcuts", () => {
  assert.equal(isDictationShortcut(shortcutEvent({ ctrlKey: true })), false);
  assert.equal(
    isDictationShortcut(
      shortcutEvent({ ctrlKey: true, metaKey: true, shiftKey: true })
    ),
    false
  );
  assert.equal(
    isDictationShortcut(
      shortcutEvent({ metaKey: true, shiftKey: true, key: "n" })
    ),
    false
  );
});

contractTest("web.hermetic", "labels the shortcut using the current platform convention", () => {
  assert.equal(dictationShortcutLabel("MacIntel"), "⌘⇧M");
  assert.equal(dictationShortcutLabel("iPhone"), "⌘⇧M");
  assert.equal(dictationShortcutLabel("Win32"), "Ctrl+Shift+M");
});
