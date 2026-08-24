import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) => fs.readFileSync(path.join(webRoot, relativePath), "utf8");

test("two-phase attachment routes stream opaque bytes behind Thread authorization", () => {
  const store = read("lib/attachments/store.ts");
  const service = read("lib/files/service.ts");
  const initialize = read("app/api/threads/[id]/attachments/route.ts");
  const upload = read("app/api/threads/[id]/attachments/[attachmentId]/route.ts");
  const download = read("app/api/threads/[id]/attachments/[attachmentId]/content/route.ts");
  assert.match(initialize, /initializeThreadAttachment/u);
  assert.match(upload, /request\.body/u);
  assert.match(service, /Readable\.fromWeb/u);
  assert.match(service, /FileVerificationTransform/u);
  assert.match(service, /getThreadForUser/u);
  assert.match(download, /getThreadAttachmentForUser/u);
  assert.match(download, /Content-Disposition/u);
  assert.match(download, /X-Content-Type-Options/u);
  assert.doesNotMatch(initialize, /accept=/u);
});

test("project-task and standalone attachment uploads share representation contracts", () => {
  const projectUpload = read("app/api/files/[fileId]/route.ts");
  const standaloneUpload = read("app/api/threads/[id]/attachments/[attachmentId]/route.ts");
  assert.match(projectUpload, /uploadThreadFile/u);
  assert.match(projectUpload, /fileApiRepresentationContract\(file\)/u);
  assert.match(standaloneUpload, /uploadThreadAttachment/u);
  assert.match(standaloneUpload, /modelVisibleMetadataOnlyReason/u);
  assert.match(standaloneUpload, /isKnowledgeDocumentMediaTypeSupported/u);
  for (const source of [projectUpload, standaloneUpload]) {
    assert.match(source, /representation/u);
    assert.match(source, /downloadUrl/u);
  }
});

test("submission and execution fail closed for missing, duplicate, oversized, or quarantined files", () => {
  const store = read("lib/attachments/store.ts");
  const service = read("lib/files/service.ts");
  const turns = read("lib/turns/store.ts");
  for (const source of [service, turns]) {
    assert.match(source, /CONVERSATION_ATTACHMENT_MAX_COUNT/u);
    assert.match(source, /CONVERSATION_ATTACHMENT_MAX_TURN_BYTES/u);
    assert.match(source, /unavailable, incomplete, or quarantined/u);
  }
  assert.match(service, /File IDs must be unique/u);
  assert.match(turns, /threadMessageFiles/u);
  assert.doesNotMatch(turns, /lifecycleState: "submitted"/u);
  assert.match(store, /resolveThreadFilesForExecution/u);
});

test("legacy uploads remain visible through an idempotent canonical backfill", () => {
  const backfill = read("lib/attachments/backfill.ts");
  assert.match(backfill, /part\?\.type !== "file"/u);
  assert.match(backfill, /file-legacy-/u);
  assert.match(backfill, /onConflictDoNothing/u);
  assert.match(backfill, /The referenced legacy object is unavailable/u);
  assert.match(backfill, /type: "data-kestrel-file"/u);
  assert.match(backfill, /ordinal: fileOrdinal/u);
  assert.match(backfill, /part\?\.type === "data-kestrel-file"/u);
});

test("the composer supports picker, paste, drop, cancel, retry, and file-only submission", () => {
  const composer = read("components/chatbot/multimodal-input.tsx");
  assert.match(composer, /type="file"/u);
  assert.match(composer, /handlePaste/u);
  assert.match(composer, /onDrop/u);
  assert.match(composer, /AbortController/u);
  assert.match(composer, /onRetry/u);
  assert.match(composer, /attachments\.length === 0/u);
  assert.match(composer, /type: "data-kestrel-file"/u);
  assert.match(composer, /composerPresentation\.action\.disabled/u);
  assert.doesNotMatch(composer, /accept="/u);
});

test("unified file search preserves migrated Knowledge chunk retrieval", () => {
  const service = read("lib/files/service.ts");
  assert.match(service, /knowledgeDocumentChunks/u);
  assert.match(service, /document\.file_id/u);
  assert.match(service, /chunk\.content ilike/u);
});

test("file publication uses organization membership authority", () => {
  const service = read("lib/files/service.ts");
  assert.doesNotMatch(service, /@\/lib\/knowledge\/auth/u);
  assert.match(service, /@\/lib\/knowledge\/organization-access/u);
  assert.match(service, /canManageOrganization/u);
  assert.match(service, /Organization administrator access is required to publish organization files/u);
  assert.match(service, /Organization administrator access is required to revoke organization files/u);
});

test("orphaned blobs are marked and removed only after the deletion grace period", () => {
  const service = read("lib/files/service.ts");
  const threads = read("lib/threads/store.ts");
  assert.match(service, /FILE_BLOB_DELETION_GRACE_MS/u);
  assert.match(service, /cleanupPendingBlobDeletions/u);
  assert.match(service, /await storage\.delete\(candidate\.objectKey\)/u);
  assert.match(threads, /set\(\{ deletedAt: new Date\(\) \}\)/u);
  assert.doesNotMatch(threads, /deleteObject\(objectKey\)/u);
});

test("blob availability distinguishes missing objects from temporary storage failures", () => {
  const availability = read("lib/files/availability.ts");
  const schema = read("drizzle/schema.ts");
  const migration = read("lib/db/migrations/0080_file_blob_availability.sql");
  assert.match(schema, /availabilityStatus: text\("availability_status"/u);
  assert.match(schema, /\["unknown", "available", "missing"\]/u);
  assert.match(migration, /DEFAULT 'unknown' NOT NULL/u);
  assert.match(migration, /'unknown', 'available', 'missing'/u);
  assert.match(availability, /ATTACHMENT_BLOB_MISSING/u);
  assert.match(availability, /ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE/u);
  assert.match(availability, /availabilityStatus: exists \? "available" : "missing"/u);
  assert.match(availability, /availabilityStatus, "unknown"/u);
  assert.match(availability, /createHash\("sha256"\)/u);
  assert.match(availability, /restore_verified/u);
});
