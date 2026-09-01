import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0089_project_email_triggers.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(path.join(directory, "migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<Record<string, unknown>> };
const historyLock = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;

test("Project Email Triggers are additive, private, revisioned capabilities", () => {
  assert.match(migration, /CREATE TABLE "project_email_triggers"/u);
  assert.match(migration, /"access_mode" text DEFAULT 'private' NOT NULL/u);
  assert.match(migration, /CHECK \("access_mode" = 'private'\)/u);
  assert.match(migration, /"revision" integer DEFAULT 1 NOT NULL/u);
  assert.match(migration, /UNIQUE INDEX "project_email_triggers_address_idx"/u);
  assert.match(migration, /"execution_owner_user_id" text/u);
  assert.match(migration, /"deleted_at" timestamp with time zone/u);
  assert.doesNotMatch(migration, /project_prompt_schedules/u);
  assert.deepEqual(
    journal.entries.find((entry) => entry.tag === "0089_project_email_triggers"),
    {
      idx: 89,
      version: "7",
      when: 1_787_914_800_000,
      tag: "0089_project_email_triggers",
      breakpoints: true,
    },
  );
  assert.equal(
    historyLock["0089_project_email_triggers"],
    "1787914800000:65312bab559de3b99cc9ffd7034d3705333cabb52240e741a9ebbc11c1d1604e",
  );
});
