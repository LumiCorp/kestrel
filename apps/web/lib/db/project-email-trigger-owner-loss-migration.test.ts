import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(directory, "migrations/0090_project_email_trigger_owner_loss.sql"),
  "utf8",
);
const journal = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/_journal.json"),
    "utf8",
  ),
) as { entries: Array<Record<string, unknown>> };
const historyLock = JSON.parse(
  fs.readFileSync(
    path.join(directory, "migrations/meta/history-lock.json"),
    "utf8",
  ),
) as Record<string, string>;

test("Organization member deletion disables owned Email Triggers atomically", () => {
  assert.match(
    migration,
    /CREATE TRIGGER "member_delete_disable_project_email_triggers"[\s\S]*BEFORE DELETE ON "member"/u,
  );
  assert.match(
    migration,
    /"organization_id" = OLD\."organizationId"[\s\S]*"execution_owner_user_id" = OLD\."userId"/u,
  );
  assert.match(migration, /"enabled" = true[\s\S]*"deleted_at" IS NULL/u);
  assert.match(
    migration,
    /"disabled_reason" = 'execution_owner_access_lost'[\s\S]*"revision" = "revision" \+ 1/u,
  );
  assert.match(
    migration,
    /'project\.email_trigger\.disabled'[\s\S]*'project_email_trigger'[\s\S]*'reason', 'execution_owner_access_lost'[\s\S]*'revision', "revision"/u,
  );
  assert.doesNotMatch(
    migration,
    /address_local_part|address_domain/u,
    "owner-loss audit evidence must not contain receiving addresses",
  );
  assert.deepEqual(
    journal.entries.find(
      (entry) => entry.tag === "0090_project_email_trigger_owner_loss",
    ),
    {
      idx: 90,
      version: "7",
      when: 1_787_918_400_000,
      tag: "0090_project_email_trigger_owner_loss",
      breakpoints: true,
    },
  );
  assert.match(
    historyLock["0090_project_email_trigger_owner_loss"] ?? "",
    /^1787918400000:[a-f0-9]{64}$/u,
  );
});
