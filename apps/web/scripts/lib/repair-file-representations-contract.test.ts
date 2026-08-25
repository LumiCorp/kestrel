import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseRepairFileRepresentationArgs,
  repairFileRepresentationCandidates,
} from "./repair-file-representations-contract";

test("representation repair defaults to a bounded dry run", () => {
  assert.deepEqual(parseRepairFileRepresentationArgs([]), {
    apply: false,
    limit: 100,
  });
});

test("representation repair limits only extractable failed rows", async () => {
  const source = await readFile(
    new URL("../repair-file-representations.ts", import.meta.url),
    "utf8",
  );
  const selection = source.match(
    /const rows = await knowledgeDb[\s\S]*?\.limit\(options\.limit\)/u,
  )?.[0];
  assert.ok(selection);
  assert.match(selection, /like\(schema\.fileRepresentations\.mediaType, "text\/%"\)/u);
  assert.match(selection, /ATTACHMENT_TEXT_EXTRACTABLE_MEDIA_TYPES/u);
  assert.doesNotMatch(source, /rows\s*\.filter/u);
});

test("representation repair requires explicit apply and validates its bounds", () => {
  assert.deepEqual(
    parseRepairFileRepresentationArgs([
      "--",
      "--apply",
      "--limit",
      "25",
      "--organization-id",
      "org-1",
    ]),
    { apply: true, limit: 25, organizationId: "org-1" },
  );
  assert.throws(
    () => parseRepairFileRepresentationArgs(["--limit", "0"]),
    /integer from 1 to 1000/u,
  );
  assert.throws(
    () => parseRepairFileRepresentationArgs(["--unknown"]),
    /Unknown argument/u,
  );
});

test("representation repair continues after missing and failed candidates", async () => {
  const statuses = new Map<string, "ready" | "failed" | "missing">([
    ["ready", "ready"],
    ["missing", "missing"],
    ["corrupt", "failed"],
  ] as const);
  const attempted: string[] = [];
  const result = await repairFileRepresentationCandidates({
    candidates: ["missing", "corrupt", "ready"],
    initialSkipped: 2,
    repair: async (candidate) => {
      attempted.push(candidate);
      if (candidate !== "ready") throw new Error("fixture failure");
    },
    inspect: async (candidate) => statuses.get(candidate) ?? "failed",
  });
  assert.deepEqual(attempted, ["missing", "corrupt", "ready"]);
  assert.deepEqual(result, {
    scanned: 3,
    repaired: 1,
    stillFailed: 1,
    skipped: 3,
  });
});

test("representation repair fails closed when durable inspection is unavailable", async () => {
  await assert.rejects(
    repairFileRepresentationCandidates({
      candidates: ["candidate"],
      initialSkipped: 0,
      repair: async () => {
        throw new Error("database write failed");
      },
      inspect: async () => {
        throw new Error("database inspection failed");
      },
    }),
    /database inspection failed/u,
  );
});
