import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "scenario", "fixtures");
const FILES = ["max-step-loop.jsonl", "no-action.jsonl", "invalid-finalize.jsonl"];

test("scenario regression fixtures are present and valid jsonl", async () => {
  for (const fileName of FILES) {
    const fullPath = path.join(FIXTURE_DIR, fileName);
    const raw = await readFile(fullPath, "utf8");
    const lines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    assert.equal(lines.length > 0, true, `${fileName} should have at least one line`);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `${fileName} has invalid JSON`);
    }
  }
});
