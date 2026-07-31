import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


test("runtime context uses portable workspace installations instead of built-in selections", async () => {
  const source = await readFile(new URL("../../src/runtime/agent-context/runtimeContext.ts", import.meta.url), "utf8");
  assert.match(source, /Installed workspace skills:/u);
  assert.doesNotMatch(source, /Activate one with \/skill/u);
});
