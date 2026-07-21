import assert from "node:assert/strict";
import test from "node:test";

import { toDriverAbortPatterns, toDriverActions } from "../ops/helpers/pty.js";

test("toDriverActions preserves ordered text and key actions", () => {
  const actions = toDriverActions([
    { typeText: "/mcp" },
    { key: "enter" },
    { key: "ctrl-p" },
    { key: "ctrl-2" },
    { key: "esc" },
  ]);
  assert.deepEqual(actions, [
    { typeText: "/mcp" },
    { key: "enter" },
    { key: "ctrl-p" },
    { key: "ctrl-2" },
    { key: "esc" },
  ]);
});

test("toDriverActions returns empty array for undefined", () => {
  assert.deepEqual(toDriverActions(undefined), []);
});

test("toDriverAbortPatterns preserves scoped regex and count options", () => {
  assert.deepEqual(
    toDriverAbortPatterns([
      {
        pattern: /\/checkpoint/u,
        reason: "manual palette should stay collapsed",
        fromCursor: true,
        maxMatches: 0,
      },
    ]),
    [
      {
        pattern: "\\/checkpoint",
        regex: true,
        reason: "manual palette should stay collapsed",
        fromCursor: true,
        maxMatches: 0,
      },
    ],
  );
});
