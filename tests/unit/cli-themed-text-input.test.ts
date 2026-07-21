import assert from "node:assert/strict";

import {
  resolveThemedTextInputEdit,
  shouldThemedTextInputIgnoreKey,
} from "../../cli/ink/components/ThemedTextInput.js";
import { buildVisibleEditableTextInputRows } from "../../cli/ink/components/textInputLayout.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "resolveThemedTextInputEdit advances cursor against the inserted value", () => {
  const first = resolveThemedTextInputEdit({
    value: "",
    cursorOffset: 0,
    rawInput: "a",
    key: {},
    showCursor: true,
  });
  assert.deepEqual(first, {
    value: "a",
    cursorOffset: 1,
    cursorWidth: 0,
  });

  const second = resolveThemedTextInputEdit({
    value: first.value,
    cursorOffset: first.cursorOffset,
    rawInput: "b",
    key: {},
    showCursor: true,
  });
  assert.deepEqual(second, {
    value: "ab",
    cursorOffset: 2,
    cursorWidth: 0,
  });
});

contractTest("runtime.hermetic", "resolveThemedTextInputEdit clamps movement to the edited value bounds", () => {
  assert.deepEqual(
    resolveThemedTextInputEdit({
      value: "a",
      cursorOffset: 0,
      rawInput: "",
      key: { leftArrow: true },
      showCursor: true,
    }),
    {
      value: "a",
      cursorOffset: 0,
      cursorWidth: 0,
    },
  );

  assert.deepEqual(
    resolveThemedTextInputEdit({
      value: "a",
      cursorOffset: 1,
      rawInput: "",
      key: { rightArrow: true },
      showCursor: true,
    }),
    {
      value: "a",
      cursorOffset: 1,
      cursorWidth: 0,
    },
  );
});

contractTest("runtime.hermetic", "text input ignores app-level controls so global chords do not pollute drafts", () => {
  assert.equal(shouldThemedTextInputIgnoreKey({ ctrl: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ meta: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ escape: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ tab: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ upArrow: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ downArrow: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ pageUp: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ pageDown: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({ f1: true }), true);
  assert.equal(shouldThemedTextInputIgnoreKey({}), false);
  assert.equal(shouldThemedTextInputIgnoreKey({ leftArrow: true }), false);
  assert.equal(shouldThemedTextInputIgnoreKey({ rightArrow: true }), false);
  assert.equal(shouldThemedTextInputIgnoreKey({ backspace: true }), false);
  assert.equal(shouldThemedTextInputIgnoreKey({ delete: true }), false);
});

contractTest("runtime.hermetic", "wrapped text input viewport follows the next row at hard-wrap cursor boundaries", () => {
  assert.deepEqual(
    buildVisibleEditableTextInputRows({
      text: "abcdefghij",
      width: 5,
      maxRows: 1,
      cursorOffset: 5,
    }),
    [
      {
        text: "fghij",
        startOffset: 5,
        endOffset: 10,
      },
    ],
  );
});
