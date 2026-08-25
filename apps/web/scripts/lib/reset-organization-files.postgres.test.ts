import assert from "node:assert/strict";
import test from "node:test";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import {
  applyOrganizationFileReset,
  assertNoActiveLumiKnowledgeWork,
  inspectOrganizationFileReset,
} from "./reset-organization-files";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();
let boss: PgBoss;

test.before(async () => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  boss = new PgBoss({ connectionString: databaseUrl });
  await boss.start();
  await boss.createQueue("knowledge.document.ingest.v2");
});

test.after(async () => {
  await boss.stop({ graceful: true, timeout: 5_000 });
});

type Fixture = {
  organizationId: string;
  userId: string;
  attachedTaskId: string;
  preservedTaskId: string;
  fileIds: string[];
  blobIds: string[];
  documentId?: string;
  runId?: string;
};

async function createFixture(sql: postgres.Sql, options: { activeKnowledgeRun?: boolean } = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const organizationId = `lumi-reset-org-${suffix}`;
  const userId = `lumi-reset-user-${suffix}`;
  const attachedTaskId = `lumi-reset-attached-${suffix}`;
  const preservedTaskId = `lumi-reset-preserved-${suffix}`;
  const messageId = `lumi-reset-message-${suffix}`;
  const blobIds = [`lumi-reset-blob-a-${suffix}`, `lumi-reset-blob-b-${suffix}`];
  const fileIds = [`lumi-reset-file-a-${suffix}`, `lumi-reset-file-b-${suffix}`];
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  let documentId: string | undefined;
  let runId: string | undefined;
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'Lumi Reset User', ${`${userId}@example.test`}, true, now(), now())
    `;
    await transaction`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${organizationId}, 'Lumi', ${`lumi-reset-${suffix}`}, now())
    `;
    await transaction`
      INSERT INTO threads (id, title, created_by_user_id, organization_id, origin)
      VALUES
        (${attachedTaskId}, 'MUST-NOT-ENTER-MANIFEST', ${userId}, ${organizationId}, 'web'),
        (${preservedTaskId}, 'Preserved', ${userId}, ${organizationId}, 'web')
    `;
    await transaction`
      INSERT INTO thread_messages (id, thread_id, role, author_user_id, parts, search_text)
      VALUES (${messageId}, ${attachedTaskId}, 'user', ${userId},
        ${transaction.json([{ type: "text", text: "MUST-NOT-ENTER-MANIFEST" }])},
        'MUST-NOT-ENTER-MANIFEST')
    `;
    await transaction`
      INSERT INTO file_blobs (
        id, organization_id, object_key, size_bytes, sha256,
        availability_status, scan_status
      ) VALUES
        (${blobIds[0] as string}, ${organizationId}, ${`files/${suffix}/a`}, 10, ${digestA}, 'available', 'clean'),
        (${blobIds[1] as string}, ${organizationId}, ${`files/${suffix}/b`}, 11, ${digestB}, 'available', 'clean')
    `;
    await transaction`
      INSERT INTO kestrel_files (
        id, organization_id, uploader_user_id, blob_id, filename,
        declared_media_type, detected_media_type, size_bytes, sha256, lifecycle_state
      ) VALUES
        (${fileIds[0] as string}, ${organizationId}, ${userId}, ${blobIds[0] as string},
          'MUST-NOT-ENTER-MANIFEST.md', 'text/markdown', 'text/markdown', 10, ${digestA}, 'ready'),
        (${fileIds[1] as string}, ${organizationId}, ${userId}, ${blobIds[1] as string},
          'MUST-NOT-ENTER-MANIFEST.bin', 'application/octet-stream', 'application/octet-stream', 11, ${digestB}, 'ready')
    `;
    await transaction`
      INSERT INTO file_representations (
        id, blob_id, kind, status, media_type, text_content, truncated
      ) VALUES
        (${`representation-a-${suffix}`}, ${blobIds[0] as string}, 'extracted_text', 'ready',
          'text/markdown', 'MUST-NOT-ENTER-MANIFEST', false),
        (${`representation-b-${suffix}`}, ${blobIds[1] as string}, 'metadata_only', 'ready',
          'application/octet-stream', NULL, false)
    `;
    await transaction`
      INSERT INTO file_scope_grants (
        id, file_id, organization_id, scope_type, thread_id, created_by_user_id
      ) VALUES (${`grant-${suffix}`}, ${fileIds[0] as string}, ${organizationId},
        'thread', ${attachedTaskId}, ${userId})
    `;
    await transaction`
      INSERT INTO thread_message_files (message_id, file_id, ordinal)
      VALUES (${messageId}, ${fileIds[0] as string}, 0)
    `;
    if (options.activeKnowledgeRun) {
      documentId = `document-${suffix}`;
      runId = `run-${suffix}`;
      await transaction`
        INSERT INTO knowledge_documents (
          id, file_id, organization_id, scope, uploader_user_id, filename,
          original_filename, media_type, size_bytes, checksum_sha256,
          storage_key, status
        ) VALUES (
          ${documentId}, ${fileIds[1] as string}, ${organizationId}, 'organization',
          ${userId}, 'MUST-NOT-ENTER-MANIFEST.pdf', 'MUST-NOT-ENTER-MANIFEST.pdf',
          'application/pdf', 11, ${digestB}, ${`knowledge/${suffix}`}, 'processing'
        )
      `;
      await transaction`
        INSERT INTO knowledge_ingestion_runs (
          id, organization_id, document_id, requested_by_user_id,
          stage, status, attempt_count
        ) VALUES (${runId}, ${organizationId}, ${documentId}, ${userId},
          'extract', 'queued', 0)
      `;
    }
  });
  return {
    organizationId,
    userId,
    attachedTaskId,
    preservedTaskId,
    fileIds,
    blobIds,
    ...(documentId ? { documentId } : {}),
    ...(runId ? { runId } : {}),
  };
}

function target(fixture: Fixture) {
  return {
    organizationId: fixture.organizationId,
    organizationName: "Lumi",
    operator: "operator@example.test",
    restorePoint: `restore-${fixture.organizationId}`,
  };
}

test("dry-run is content-free and apply preserves non-attachment tasks plus blob grace state", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 2 });
  const fixture = await createFixture(sql);
  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE id = ${fixture.organizationId}`;
    await sql`DELETE FROM "user" WHERE id = ${fixture.userId}`;
    await sql.end({ timeout: 0 });
  });

  const manifest = await inspectOrganizationFileReset(sql, target(fixture));
  assert.deepEqual(manifest.counts, {
    tasks: 1,
    messages: 1,
    files: 2,
    blobs: 2,
    grants: 1,
    attachmentLinks: 1,
    knowledgeDocuments: 0,
    ingestionRuns: 0,
    knowledgeChunks: 0,
    knowledgeContextReferences: 0,
    preservedTasks: 1,
  });
  assert.doesNotMatch(JSON.stringify(manifest), /MUST-NOT-ENTER-MANIFEST/u);
  const result = await applyOrganizationFileReset({ sql, expected: manifest });
  assert.equal(result.verified, true);

  const [state] = await sql<Array<{
    attachedTasks: number;
    preservedTasks: number;
    files: number;
    tombstonedBlobs: number;
    representations: number;
    auditEvents: number;
  }>>`
    SELECT
      (SELECT count(*)::int FROM threads WHERE id = ${fixture.attachedTaskId}) AS "attachedTasks",
      (SELECT count(*)::int FROM threads WHERE id = ${fixture.preservedTaskId}) AS "preservedTasks",
      (SELECT count(*)::int FROM kestrel_files WHERE organization_id = ${fixture.organizationId}) AS files,
      (SELECT count(*)::int FROM file_blobs WHERE organization_id = ${fixture.organizationId} AND deleted_at IS NOT NULL) AS "tombstonedBlobs",
      (SELECT count(*)::int FROM file_representations representation INNER JOIN file_blobs blob ON blob.id = representation.blob_id WHERE blob.organization_id = ${fixture.organizationId}) AS representations,
      (SELECT count(*)::int FROM admin_event_logs WHERE organization_id = ${fixture.organizationId} AND action = 'lumi_reset') AS "auditEvents"
  `;
  assert.deepEqual(state, {
    attachedTasks: 0,
    preservedTasks: 1,
    files: 0,
    tombstonedBlobs: 2,
    representations: 2,
    auditEvents: 1,
  });
});

test("apply rolls back every mutation when verification cannot commit", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 2 });
  const fixture = await createFixture(sql);
  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE id = ${fixture.organizationId}`;
    await sql`DELETE FROM "user" WHERE id = ${fixture.userId}`;
    await sql.end({ timeout: 0 });
  });
  const manifest = await inspectOrganizationFileReset(sql, target(fixture));
  await assert.rejects(
    applyOrganizationFileReset({
      sql,
      expected: manifest,
      beforeCommit: async () => { throw new Error("rollback sentinel"); },
    }),
    /rollback sentinel/u,
  );
  const [state] = await sql<Array<{ tasks: number; files: number; tombstones: number; audits: number }>>`
    SELECT
      (SELECT count(*)::int FROM threads WHERE id = ${fixture.attachedTaskId}) AS tasks,
      (SELECT count(*)::int FROM kestrel_files WHERE organization_id = ${fixture.organizationId}) AS files,
      (SELECT count(*)::int FROM file_blobs WHERE organization_id = ${fixture.organizationId} AND deleted_at IS NOT NULL) AS tombstones,
      (SELECT count(*)::int FROM admin_event_logs WHERE organization_id = ${fixture.organizationId} AND action = 'lumi_reset') AS audits
  `;
  assert.deepEqual(state, { tasks: 1, files: 2, tombstones: 0, audits: 0 });
});

test("apply refuses stale snapshots and active Knowledge work", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const sql = postgres(databaseUrl, { max: 2 });
  const fixture = await createFixture(sql);
  const activeFixture = await createFixture(sql, { activeKnowledgeRun: true });
  context.after(async () => {
    await sql`
      DELETE FROM pgboss.job
      WHERE data->>'runId' = ${activeFixture.runId ?? ""}
    `;
    await sql`
      DELETE FROM knowledge_ingestion_runs
      WHERE organization_id = ${activeFixture.organizationId}
    `;
    await sql`
      DELETE FROM knowledge_documents
      WHERE organization_id = ${activeFixture.organizationId}
    `;
    await sql`DELETE FROM "organization" WHERE id IN (${fixture.organizationId}, ${activeFixture.organizationId})`;
    await sql`DELETE FROM "user" WHERE id IN (${fixture.userId}, ${activeFixture.userId})`;
    await sql.end({ timeout: 0 });
  });
  const manifest = await inspectOrganizationFileReset(sql, target(fixture));
  await sql`
    INSERT INTO file_blobs (
      id, organization_id, object_key, size_bytes, sha256,
      availability_status, scan_status
    ) VALUES (${`late-${fixture.organizationId}`}, ${fixture.organizationId},
      ${`late/${fixture.organizationId}`}, 0, ${"c".repeat(64)}, 'available', 'clean')
  `;
  await assert.rejects(
    applyOrganizationFileReset({ sql, expected: manifest }),
    /state changed after confirmation/u,
  );
  await assert.rejects(
    assertNoActiveLumiKnowledgeWork(sql, activeFixture.organizationId),
    /active, queued, or retrying/u,
  );
  assert.ok(activeFixture.documentId && activeFixture.runId);
  await sql`
    UPDATE knowledge_ingestion_runs
    SET status = 'failed', finished_at = now(), updated_at = now()
    WHERE id = ${activeFixture.runId}
  `;
  const jobId = await boss.send("knowledge.document.ingest.v2", {
    runId: activeFixture.runId,
    documentId: activeFixture.documentId,
  });
  assert.ok(jobId);
  await assert.rejects(
    assertNoActiveLumiKnowledgeWork(sql, activeFixture.organizationId),
    /active, queued, or retrying/u,
  );
  await boss.deleteJob("knowledge.document.ingest.v2", jobId);
});
