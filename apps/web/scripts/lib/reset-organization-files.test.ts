import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  exactActionConfirmation,
  exactResetConfirmation,
  type OrganizationFileResetManifest,
} from "./reset-organization-files";
import { parseResetLumiFilesArgs } from "../reset-lumi-files";

function manifest(): OrganizationFileResetManifest {
  return {
    version: 1,
    organizationId: "lumi-org-id",
    organizationName: "Lumi",
    operator: "operator@example.test",
    restorePoint: "restore-2026-08-24",
    capturedAt: "2026-08-24T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    counts: {
      tasks: 7,
      messages: 62,
      files: 23,
      blobs: 18,
      grants: 22,
      attachmentLinks: 21,
      knowledgeDocuments: 12,
      ingestionRuns: 12,
      knowledgeChunks: 40,
      knowledgeContextReferences: 3,
      preservedTasks: 9,
    },
    taskIds: [],
    fileRecords: [],
    blobs: [],
    grants: [],
    attachmentLinks: [],
    knowledgeDocuments: [],
    ingestionRuns: [],
    knowledgeChunkIds: [],
    knowledgeContextReferences: [],
  };
}

test("Lumi reset defaults to dry-run and binds every destructive authority", () => {
  assert.deepEqual(parseResetLumiFilesArgs([
    "--organization-id", "lumi-org-id",
    "--organization-name", "Lumi",
    "--operator", "operator@example.test",
    "--restore-point", "restore-2026-08-24",
    "--manifest", "/tmp/lumi-reset.json",
  ]), {
    organizationId: "lumi-org-id",
    organizationName: "Lumi",
    operator: "operator@example.test",
    restorePoint: "restore-2026-08-24",
    manifestPath: "/tmp/lumi-reset.json",
    apply: false,
  });
  assert.equal(
    exactResetConfirmation(manifest()),
    "RESET Lumi lumi-org-id tasks=7 files=23",
  );
  assert.equal(
    exactActionConfirmation(manifest()),
    "DELETE Lumi tasks=7 files=23 restore=restore-2026-08-24",
  );
});

test("Lumi reset rejects broadened or incomplete targets", () => {
  const base = [
    "--organization-id", "lumi-org-id",
    "--organization-name", "Lumi",
    "--operator", "operator@example.test",
    "--restore-point", "restore-2026-08-24",
    "--manifest", "/tmp/lumi-reset.json",
  ];
  assert.throws(
    () => parseResetLumiFilesArgs(base.with(3, "Friends")),
    /exactly 'Lumi'/u,
  );
  assert.throws(
    () => parseResetLumiFilesArgs(base.slice(0, -2)),
    /--manifest is required/u,
  );
  assert.throws(
    () => parseResetLumiFilesArgs([...base, "--force"]),
    /--force is required|Unknown argument/u,
  );
});

test("reset manifest contract excludes filenames and content fields", async () => {
  const source = await readFile(new URL("./reset-organization-files.ts", import.meta.url), "utf8");
  const manifestType = source.slice(
    source.indexOf("type ResetTarget"),
    source.indexOf("type SnapshotRows"),
  );
  assert.doesNotMatch(manifestType, /filename|textContent|messageContent|objectKey/u);
  assert.match(manifestType, /checksumSha256/u);
  assert.match(manifestType, /restorePoint/u);
});
