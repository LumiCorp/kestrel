import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const migrations = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

contractTest("web.hermetic", "committed migration names, timestamps, and contents are immutable", () => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")
  ) as { entries: Array<{ idx: number; tag: string; when: number }> };
  const lock = JSON.parse(
    fs.readFileSync(path.join(migrations, "meta/history-lock.json"), "utf8")
  ) as Record<string, string>;

  assert.equal(journal.entries.length, Object.keys(lock).length);
  let previousTimestamp = 0;
  for (const entry of journal.entries) {
    assert.ok(entry.when > previousTimestamp);
    previousTimestamp = entry.when;
    const sql = fs.readFileSync(
      path.join(migrations, `${entry.tag}.sql`),
      "utf8"
    );
    const hash = createHash("sha256").update(sql).digest("hex");
    assert.equal(lock[entry.tag], `${entry.when}:${hash}`);
  }
});
