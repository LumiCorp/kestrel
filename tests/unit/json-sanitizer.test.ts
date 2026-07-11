import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeJsonValue,
  sanitizeUtf16String,
  stringifySanitizedJson,
} from "../../src/runtime/jsonSanitizer.js";

test("sanitizeUtf16String replaces lone high surrogates", () => {
  assert.equal(sanitizeUtf16String("a\ud800b"), "a\uFFFDb");
});

test("sanitizeUtf16String replaces lone low surrogates", () => {
  assert.equal(sanitizeUtf16String("a\udc00b"), "a\uFFFDb");
});

test("sanitizeUtf16String preserves valid surrogate pairs", () => {
  assert.equal(sanitizeUtf16String("smile \ud83d\ude00"), "smile \ud83d\ude00");
});

test("sanitizeUtf16String replaces NUL code points", () => {
  assert.equal(sanitizeUtf16String("a\u0000b"), "a\uFFFDb");
});

test("sanitizeJsonValue sanitizes nested arrays and objects", () => {
  const sanitized = sanitizeJsonValue({
    title: "\ud800draft",
    items: ["ok", "\udc00bad", "nul\u0000byte"],
    nested: {
      note: "pair \ud83d\ude00 kept",
      raw: "\u0000",
    },
  });

  assert.deepEqual(sanitized, {
    title: "\uFFFDdraft",
    items: ["ok", "\uFFFDbad", "nul\uFFFDbyte"],
    nested: {
      note: "pair \ud83d\ude00 kept",
      raw: "\uFFFD",
    },
  });
  assert.equal(stringifySanitizedJson(sanitized).includes("\ud800"), false);
  assert.equal(stringifySanitizedJson(sanitized).includes("\udc00"), false);
  assert.equal(stringifySanitizedJson(sanitized).includes("\\u0000"), false);
});

test("stringifySanitizedJson breaks self-referential array cycles deterministically", () => {
  const value: unknown[] = [];
  value.push(value);

  assert.equal(stringifySanitizedJson(value), "[\"[Circular]\"]");
});

test("stringifySanitizedJson duplicates repeated object references", () => {
  const shared = {
    action: "read",
    input: {
      path: "README.md",
    },
  };
  const value = {
    nextAction: shared,
    lastAction: shared,
  };

  assert.equal(
    stringifySanitizedJson(value),
    "{\"nextAction\":{\"action\":\"read\",\"input\":{\"path\":\"README.md\"}},\"lastAction\":{\"action\":\"read\",\"input\":{\"path\":\"README.md\"}}}",
  );
});

test("stringifySanitizedJson breaks recursive object cycles deterministically", () => {
  const value: Record<string, unknown> = {
    label: "root",
  };
  value.self = value;

  assert.equal(stringifySanitizedJson(value), "{\"label\":\"root\",\"self\":\"[Circular]\"}");
});
