import { createHash } from "node:crypto";
import type postgres from "postgres";

export const LUMI_RESET_ORGANIZATION_NAME = "Lumi";

const ACTIVE_KNOWLEDGE_JOB_STATES = ["active", "created", "retry"] as const;
const KNOWLEDGE_QUEUES = [
  "knowledge.document.ingest",
  "knowledge.document.ingest.v2",
] as const;

type Queryable = postgres.Sql | postgres.TransactionSql;

type ResetTarget = {
  organizationId: string;
  organizationName: string;
  operator: string;
  restorePoint: string;
};

export type OrganizationFileResetManifest = ResetTarget & {
  version: 1;
  capturedAt: string;
  fingerprint: string;
  counts: {
    tasks: number;
    messages: number;
    files: number;
    blobs: number;
    grants: number;
    attachmentLinks: number;
    knowledgeDocuments: number;
    ingestionRuns: number;
    knowledgeChunks: number;
    knowledgeContextReferences: number;
    preservedTasks: number;
  };
  taskIds: string[];
  fileRecords: Array<{ id: string; blobId: string; sha256: string | null }>;
  blobs: Array<{ id: string; sha256: string | null }>;
  grants: Array<{
    id: string;
    fileId: string;
    scopeType: string;
    threadId: string | null;
    projectId: string | null;
  }>;
  attachmentLinks: Array<{
    messageId: string;
    threadId: string;
    fileId: string;
  }>;
  knowledgeDocuments: Array<{
    id: string;
    fileId: string;
    projectId: string | null;
    checksumSha256: string;
  }>;
  ingestionRuns: Array<{ id: string; documentId: string; status: string }>;
  knowledgeChunkIds: Array<{ id: string; documentId: string }>;
  knowledgeContextReferences: Array<{
    contextRevisionId: string;
    documentId: string;
  }>;
};

type SnapshotRows = Omit<
  OrganizationFileResetManifest,
  keyof ResetTarget | "version" | "capturedAt" | "fingerprint"
>;

export async function inspectOrganizationFileReset(
  sql: Queryable,
  target: ResetTarget,
): Promise<OrganizationFileResetManifest> {
  assertLumiTarget(target);
  const organizations = await sql<Array<{ id: string; name: string }>>`
    SELECT id, name
    FROM "organization"
    WHERE id = ${target.organizationId}
  `;
  const organization = organizations[0];
  if (!organization || organization.name !== target.organizationName) {
    throw new Error("The exact Lumi organization ID and name did not match.");
  }

  const [
    files,
    blobs,
    grants,
    attachmentLinks,
    taskRows,
    taskCounts,
    totalTaskCounts,
    documents,
    runs,
    chunks,
    contextReferences,
  ] = await Promise.all([
    sql<Array<{ id: string; blobId: string; sha256: string | null }>>`
      SELECT id, blob_id AS "blobId", sha256
      FROM kestrel_files
      WHERE organization_id = ${target.organizationId}
      ORDER BY id
    `,
    sql<Array<{ id: string; sha256: string | null }>>`
      SELECT id, sha256
      FROM file_blobs
      WHERE organization_id = ${target.organizationId}
      ORDER BY id
    `,
    sql<Array<{
      id: string;
      fileId: string;
      scopeType: string;
      threadId: string | null;
      projectId: string | null;
    }>>`
      SELECT id, file_id AS "fileId", scope_type AS "scopeType",
        thread_id AS "threadId", project_id AS "projectId"
      FROM file_scope_grants
      WHERE organization_id = ${target.organizationId}
      ORDER BY id
    `,
    sql<Array<{ messageId: string; threadId: string; fileId: string }>>`
      SELECT link.message_id AS "messageId", message.thread_id AS "threadId",
        link.file_id AS "fileId"
      FROM thread_message_files link
      INNER JOIN thread_messages message ON message.id = link.message_id
      INNER JOIN threads thread ON thread.id = message.thread_id
      WHERE thread.organization_id = ${target.organizationId}
      ORDER BY link.message_id, link.file_id
    `,
    sql<Array<{ id: string }>>`
      WITH attachment_tasks AS (
        SELECT message.thread_id AS id
        FROM thread_message_files link
        INNER JOIN thread_messages message ON message.id = link.message_id
        INNER JOIN threads thread ON thread.id = message.thread_id
        WHERE thread.organization_id = ${target.organizationId}
        UNION
        SELECT grant_row.thread_id AS id
        FROM file_scope_grants grant_row
        WHERE grant_row.organization_id = ${target.organizationId}
          AND grant_row.thread_id IS NOT NULL
      )
      SELECT id FROM attachment_tasks ORDER BY id
    `,
    sql<Array<{ messages: number }>>`
      WITH attachment_tasks AS (
        SELECT message.thread_id AS id
        FROM thread_message_files link
        INNER JOIN thread_messages message ON message.id = link.message_id
        INNER JOIN threads thread ON thread.id = message.thread_id
        WHERE thread.organization_id = ${target.organizationId}
        UNION
        SELECT grant_row.thread_id AS id
        FROM file_scope_grants grant_row
        WHERE grant_row.organization_id = ${target.organizationId}
          AND grant_row.thread_id IS NOT NULL
      )
      SELECT count(*)::int AS messages
      FROM thread_messages message
      WHERE message.thread_id IN (SELECT id FROM attachment_tasks)
    `,
    sql<Array<{ tasks: number }>>`
      SELECT count(*)::int AS tasks
      FROM threads
      WHERE organization_id = ${target.organizationId}
    `,
    sql<Array<{
      id: string;
      fileId: string;
      projectId: string | null;
      checksumSha256: string;
    }>>`
      SELECT id, file_id AS "fileId", project_id AS "projectId",
        checksum_sha256 AS "checksumSha256"
      FROM knowledge_documents
      WHERE organization_id = ${target.organizationId}
      ORDER BY id
    `,
    sql<Array<{ id: string; documentId: string; status: string }>>`
      SELECT id, document_id AS "documentId", status
      FROM knowledge_ingestion_runs
      WHERE organization_id = ${target.organizationId}
      ORDER BY id
    `,
    sql<Array<{ id: string; documentId: string }>>`
      SELECT id, document_id AS "documentId"
      FROM knowledge_document_chunks
      WHERE organization_id = ${target.organizationId}
      ORDER BY id
    `,
    sql<Array<{ contextRevisionId: string; documentId: string }>>`
      SELECT reference.context_revision_id AS "contextRevisionId",
        reference.document_id AS "documentId"
      FROM project_context_documents reference
      INNER JOIN knowledge_documents document ON document.id = reference.document_id
      WHERE document.organization_id = ${target.organizationId}
      ORDER BY reference.context_revision_id, reference.document_id
    `,
  ]);

  const taskIds = taskRows.map(({ id }) => id);
  const rows: SnapshotRows = {
    counts: {
      tasks: taskIds.length,
      messages: taskCounts[0]?.messages ?? 0,
      files: files.length,
      blobs: blobs.length,
      grants: grants.length,
      attachmentLinks: attachmentLinks.length,
      knowledgeDocuments: documents.length,
      ingestionRuns: runs.length,
      knowledgeChunks: chunks.length,
      knowledgeContextReferences: contextReferences.length,
      preservedTasks: (totalTaskCounts[0]?.tasks ?? 0) - taskIds.length,
    },
    taskIds,
    fileRecords: [...files],
    blobs: [...blobs],
    grants: [...grants],
    attachmentLinks: [...attachmentLinks],
    knowledgeDocuments: [...documents],
    ingestionRuns: [...runs],
    knowledgeChunkIds: [...chunks],
    knowledgeContextReferences: [...contextReferences],
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return {
    version: 1,
    ...target,
    capturedAt: new Date().toISOString(),
    fingerprint,
    ...rows,
  };
}

export async function assertNoActiveLumiKnowledgeWork(
  sql: Queryable,
  organizationId: string,
) {
  const activeRuns = await sql<Array<{ id: string }>>`
    SELECT id
    FROM knowledge_ingestion_runs
    WHERE organization_id = ${organizationId}
      AND status IN ('queued', 'running')
    LIMIT 1
  `;
  const jobs = await sql<Array<{ id: string }>>`
    SELECT job.id::text AS id
    FROM pgboss.job job
    WHERE job.name IN ${sql(KNOWLEDGE_QUEUES)}
      AND job.state IN ${sql(ACTIVE_KNOWLEDGE_JOB_STATES)}
      AND (
        job.data->>'documentId' IN (
          SELECT id FROM knowledge_documents WHERE organization_id = ${organizationId}
        )
        OR job.data->>'runId' IN (
          SELECT id FROM knowledge_ingestion_runs WHERE organization_id = ${organizationId}
        )
      )
    LIMIT 1
  `;
  if (activeRuns.length > 0 || jobs.length > 0) {
    throw new Error("Lumi has active, queued, or retrying Knowledge ingestion work.");
  }
}

export function exactResetConfirmation(manifest: OrganizationFileResetManifest) {
  return `RESET ${manifest.organizationName} ${manifest.organizationId} tasks=${manifest.counts.tasks} files=${manifest.counts.files}`;
}

export function exactActionConfirmation(manifest: OrganizationFileResetManifest) {
  return `DELETE ${manifest.organizationName} tasks=${manifest.counts.tasks} files=${manifest.counts.files} restore=${manifest.restorePoint}`;
}

export async function applyOrganizationFileReset(input: {
  sql: postgres.Sql;
  expected: OrganizationFileResetManifest;
  beforeCommit?: ((transaction: postgres.TransactionSql) => Promise<void>) | undefined;
}) {
  assertLumiTarget(input.expected);
  return await input.sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
    await transaction`
      SELECT id FROM "organization"
      WHERE id = ${input.expected.organizationId}
      FOR UPDATE
    `;
    await transaction`
      SELECT id FROM kestrel_files
      WHERE organization_id = ${input.expected.organizationId}
      ORDER BY id FOR UPDATE
    `;
    await transaction`
      SELECT id FROM threads
      WHERE organization_id = ${input.expected.organizationId}
      ORDER BY id FOR UPDATE
    `;
    await transaction`
      SELECT id FROM knowledge_documents
      WHERE organization_id = ${input.expected.organizationId}
      ORDER BY id FOR UPDATE
    `;
    await assertNoActiveLumiKnowledgeWork(transaction, input.expected.organizationId);
    const current = await inspectOrganizationFileReset(transaction, input.expected);
    if (current.fingerprint !== input.expected.fingerprint) {
      throw new Error("Lumi file state changed after confirmation; run a new dry-run.");
    }

    if (input.expected.taskIds.length > 0) {
      await transaction`
        UPDATE threads child
        SET parent_thread_id = NULL, branch_anchor_message_id = NULL,
          updated_at = now()
        WHERE child.organization_id = ${input.expected.organizationId}
          AND child.id NOT IN ${transaction(input.expected.taskIds)}
          AND (
            child.parent_thread_id IN ${transaction(input.expected.taskIds)}
            OR child.branch_anchor_message_id IN (
              SELECT id FROM thread_messages
              WHERE thread_id IN ${transaction(input.expected.taskIds)}
            )
          )
      `;
    }
    await transaction`
      DELETE FROM project_context_documents reference
      USING knowledge_documents document
      WHERE reference.document_id = document.id
        AND document.organization_id = ${input.expected.organizationId}
    `;
    await transaction`DELETE FROM knowledge_ingestion_runs WHERE organization_id = ${input.expected.organizationId}`;
    await transaction`DELETE FROM knowledge_document_chunks WHERE organization_id = ${input.expected.organizationId}`;
    await transaction`DELETE FROM knowledge_documents WHERE organization_id = ${input.expected.organizationId}`;
    if (input.expected.taskIds.length > 0) {
      await transaction`DELETE FROM threads WHERE id IN ${transaction(input.expected.taskIds)}`;
    }
    await transaction`DELETE FROM file_scope_grants WHERE organization_id = ${input.expected.organizationId}`;
    await transaction`
      DELETE FROM thread_message_files link
      USING kestrel_files file
      WHERE link.file_id = file.id
        AND file.organization_id = ${input.expected.organizationId}
    `;
    await transaction`
      UPDATE file_backfill_results result
      SET file_id = NULL
      FROM kestrel_files file
      WHERE result.file_id = file.id
        AND file.organization_id = ${input.expected.organizationId}
    `;
    await transaction`DELETE FROM kestrel_files WHERE organization_id = ${input.expected.organizationId}`;
    await transaction`
      UPDATE file_blobs blob
      SET deleted_at = coalesce(blob.deleted_at, now())
      WHERE blob.organization_id = ${input.expected.organizationId}
        AND NOT EXISTS (
          SELECT 1 FROM kestrel_files file WHERE file.blob_id = blob.id
        )
    `;
    await transaction`
      INSERT INTO admin_event_logs (
        id, organization_id, actor_user_id, level, category, action,
        target_type, target_id, message, metadata, created_at
      ) VALUES (
        ${crypto.randomUUID()}, ${input.expected.organizationId}, NULL, 'warn',
        'organization_files', 'lumi_reset', 'organization',
        ${input.expected.organizationId}, 'Reset Lumi attachment and Knowledge state.',
        ${transaction.json({
          operator: input.expected.operator,
          restorePoint: input.expected.restorePoint,
          fingerprint: input.expected.fingerprint,
          counts: input.expected.counts,
        })}, now()
      )
    `;

    const verification = await inspectOrganizationFileReset(transaction, input.expected);
    if (
      verification.counts.files !== 0
      || verification.counts.knowledgeDocuments !== 0
      || verification.counts.attachmentLinks !== 0
      || verification.counts.tasks !== 0
      || verification.counts.preservedTasks !== input.expected.counts.preservedTasks
    ) {
      throw new Error("Lumi file reset verification failed; the transaction will roll back.");
    }
    const untombstoned = await transaction<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM file_blobs blob
      WHERE blob.organization_id = ${input.expected.organizationId}
        AND blob.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM kestrel_files file WHERE file.blob_id = blob.id)
    `;
    if ((untombstoned[0]?.count ?? 0) !== 0) {
      throw new Error("Lumi blob tombstone verification failed; the transaction will roll back.");
    }
    await input.beforeCommit?.(transaction);
    return {
      fingerprint: input.expected.fingerprint,
      counts: input.expected.counts,
      verified: true as const,
    };
  });
}

function assertLumiTarget(target: ResetTarget) {
  if (!target.organizationId.trim()) throw new Error("The exact Lumi organization ID is required.");
  if (target.organizationName !== LUMI_RESET_ORGANIZATION_NAME) {
    throw new Error(`The organization name must be exactly '${LUMI_RESET_ORGANIZATION_NAME}'.`);
  }
  if (!target.operator.trim()) throw new Error("The operator identity is required.");
  if (!target.restorePoint.trim()) throw new Error("A current provider restore point is required.");
}
