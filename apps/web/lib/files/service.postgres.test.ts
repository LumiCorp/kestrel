import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "thread file inventory joins shared blobs and preserves evidence when a blob is missing",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, files, availability] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./service"),
      import("./availability"),
    ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const userId = `file-inventory-user-${suffix}`;
    const organizationId = `file-inventory-org-${suffix}`;
    const threadId = `file-inventory-thread-${suffix}`;
    const blobId = `file-inventory-blob-${suffix}`;
    const fileId = `file-inventory-file-${suffix}`;
    const grantId = `file-inventory-grant-${suffix}`;

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'File Inventory User', ${`${userId}@example.test`},
          true, now(), now()
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'File Inventory Org',
          ${`file-inventory-org-${suffix}`}, now()
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES (
          ${threadId}, 'File Inventory Thread', ${userId}, ${organizationId}, 'web'
        )
      `;
      await transaction`
        INSERT INTO "file_blobs" (
          "id", "organization_id", "object_key", "size_bytes", "sha256",
          "availability_status", "scan_status"
        ) VALUES (
          ${blobId}, ${organizationId}, ${`file-inventory/${suffix}`}, 12,
          ${"a".repeat(64)}, 'missing', 'clean'
        )
      `;
      await transaction`
        INSERT INTO "kestrel_files" (
          "id", "organization_id", "uploader_user_id", "blob_id", "filename",
          "declared_media_type", "detected_media_type", "size_bytes", "sha256",
          "lifecycle_state"
        ) VALUES (
          ${fileId}, ${organizationId}, ${userId}, ${blobId}, 'missing.pdf',
          'application/pdf', 'application/pdf', 12, ${"a".repeat(64)}, 'ready'
        )
      `;
      await transaction`
        INSERT INTO "file_scope_grants" (
          "id", "file_id", "organization_id", "scope_type", "thread_id",
          "created_by_user_id"
        ) VALUES (
          ${grantId}, ${fileId}, ${organizationId}, 'thread', ${threadId}, ${userId}
        )
      `;
    });

    await assert.rejects(
      files.listThreadFileInventory({
        threadId,
        organizationId,
        userId,
      }),
      (error: unknown) =>
        error instanceof availability.FileAvailabilityError &&
        error.code === "ATTACHMENT_BLOB_MISSING" &&
        error.fileId === fileId &&
        error.blobId === blobId,
    );

    const [evidence] = await sql<
      Array<{ fileId: string; grantId: string; availabilityStatus: string }>
    >`
      SELECT
        file.id AS "fileId",
        scope_grant.id AS "grantId",
        blob.availability_status AS "availabilityStatus"
      FROM "kestrel_files" file
      INNER JOIN "file_scope_grants" scope_grant ON scope_grant.file_id = file.id
      INNER JOIN "file_blobs" blob ON blob.id = file.blob_id
      WHERE file.id = ${fileId}
        AND scope_grant.id = ${grantId}
    `;
    assert.deepEqual(evidence, {
      fileId,
      grantId,
      availabilityStatus: "missing",
    });

    const hostedWorkerInventory = await files.listThreadFileInventory({
      threadId,
      organizationId,
      userId,
      checkAvailability: false,
    });
    assert.deepEqual(hostedWorkerInventory, []);

    await sql`
      UPDATE "file_blobs"
      SET "availability_status" = 'available'
      WHERE "id" = ${blobId}
    `;
    const inventory = await files.listThreadFileInventory({
      threadId,
      organizationId,
      userId,
    });
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0]?.fileId, fileId);
    assert.equal(inventory[0]?.blobId, blobId);
    assert.equal(inventory[0]?.availabilityStatus, "available");
  },
);

test(
  "hosted Browser download promotion reconciles response loss and compensates a proven uncommitted object",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const previousStorageProvider = process.env.STORAGE_PROVIDER;
    const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-download-"));
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_LOCAL_ROOT = storageRoot;

    const [
      { resetDbRuntimeForTests },
      files,
      { getStorageAdapter, resetStorageAdapterForTests },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./service"),
      import("@/lib/storage"),
    ]);
    resetStorageAdapterForTests();
    const sql = postgres(databaseUrl, { max: 4 });
    const suffix = crypto.randomUUID();
    const userId = `browser-download-user-${suffix}`;
    const organizationId = `browser-download-org-${suffix}`;
    const threadId = `browser-download-thread-${suffix}`;
    const deniedThreadId = `browser-download-denied-thread-${suffix}`;
    const bytes = Buffer.from("exact hosted Browser download bytes", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const identity = {
      operationId: `browser-download-operation-${suffix}`,
      organizationId,
      threadId,
      userId,
      sessionId: `browser-session-${suffix}`,
      generation: 1,
      pendingDownloadId: `pending-download-${suffix}`,
      filename: "report.txt",
      declaredMediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256,
    };

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      resetStorageAdapterForTests();
      if (previousStorageProvider === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = previousStorageProvider;
      if (previousStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
      else process.env.STORAGE_LOCAL_ROOT = previousStorageRoot;
      await rm(storageRoot, { recursive: true, force: true });
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
        VALUES (${userId}, 'Browser Download User', ${`${userId}@example.test`}, true, now(), now())
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Browser Download Org', ${organizationId}, now())
      `;
      await transaction`
        INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
        VALUES (${`browser-download-member-${suffix}`}, ${organizationId}, ${userId}, 'owner', now())
      `;
      for (const id of [threadId, deniedThreadId]) {
        await transaction`
          INSERT INTO "threads" ("id", "title", "created_by_user_id", "organization_id", "origin")
          VALUES (${id}, 'Browser Download Thread', ${userId}, ${organizationId}, 'web')
        `;
      }
    });

    await files.stageHostedBrowserDownload({ ...identity, body: Readable.from(bytes) });
    const [first, replay] = await Promise.all([
      files.commitHostedBrowserDownload(identity),
      files.commitHostedBrowserDownload(identity),
    ]);
    assert.equal(replay.id, first.id);
    const afterResponseLoss = await files.commitHostedBrowserDownload(identity);
    assert.equal(afterResponseLoss.id, first.id);
    const [counts] = await sql<Array<{ promotions: number; files: number; grants: number }>>`
      SELECT
        (SELECT count(*)::int FROM "browser_download_promotions" WHERE "organization_id" = ${organizationId}) AS promotions,
        (SELECT count(*)::int FROM "kestrel_files" WHERE "organization_id" = ${organizationId}) AS files,
        (SELECT count(*)::int FROM "file_scope_grants" WHERE "organization_id" = ${organizationId}) AS grants
    `;
    assert.deepEqual(counts, { promotions: 1, files: 1, grants: 1 });

    const uncommitted = {
      ...identity,
      operationId: `browser-download-uncommitted-${suffix}`,
      threadId: deniedThreadId,
      pendingDownloadId: `pending-uncommitted-${suffix}`,
    };
    await files.stageHostedBrowserDownload({ ...uncommitted, body: Readable.from(bytes) });
    const uncommittedBlobId = `blob-browser-${createHash("sha256").update(JSON.stringify({
      organizationId,
      sessionId: uncommitted.sessionId,
      generation: uncommitted.generation,
      pendingDownloadId: uncommitted.pendingDownloadId,
      sha256,
    })).digest("hex")}`;
    const uncommittedKey = getStorageAdapter().buildObjectKey(
      "files", organizationId, uncommittedBlobId, "original",
    );
    assert.equal(await getStorageAdapter().objectExists(uncommittedKey), true);
    await sql`DELETE FROM "threads" WHERE "id" = ${deniedThreadId}`;
    await assert.rejects(files.commitHostedBrowserDownload(uncommitted), /Thread not found/u);
    assert.equal(await getStorageAdapter().objectExists(uncommittedKey), false);
  },
);

test(
  "extractable metadata-only blobs are reprocessed independently across organizations",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const previousStorageProvider = process.env.STORAGE_PROVIDER;
    const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-file-representation-"));
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_LOCAL_ROOT = storageRoot;

    const [
      { resetDbRuntimeForTests },
      files,
      { getStorageAdapter, resetStorageAdapterForTests },
      knowledge,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./service"),
      import("@/lib/storage"),
      import("@/lib/knowledge/documents/runtime"),
    ]);
    resetStorageAdapterForTests();
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizations = ["personal", "lumi"].map((label) => ({
      organizationId: `representation-${label}-org-${suffix}`,
      userId: `representation-${label}-user-${suffix}`,
      memberId: `representation-${label}-member-${suffix}`,
      label,
    }));

    context.after(async () => {
      for (const organization of organizations) {
        await sql`DELETE FROM "organization" WHERE "id" = ${organization.organizationId}`;
        await sql`DELETE FROM "user" WHERE "id" = ${organization.userId}`;
      }
      await resetDbRuntimeForTests();
      resetStorageAdapterForTests();
      if (previousStorageProvider === undefined) {
        delete process.env.STORAGE_PROVIDER;
      } else {
        process.env.STORAGE_PROVIDER = previousStorageProvider;
      }
      if (previousStorageRoot === undefined) {
        delete process.env.STORAGE_LOCAL_ROOT;
      } else {
        process.env.STORAGE_LOCAL_ROOT = previousStorageRoot;
      }
      await rm(storageRoot, { recursive: true, force: true });
      await sql.end({ timeout: 0 });
    });

    for (const organization of organizations) {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO "user" (
            "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
          ) VALUES (
            ${organization.userId}, ${`${organization.label} File User`},
            ${`${organization.userId}@example.test`}, true, now(), now()
          )
        `;
        await transaction`
          INSERT INTO "organization" ("id", "name", "slug", "createdAt")
          VALUES (
            ${organization.organizationId}, ${`${organization.label} File Org`},
            ${organization.organizationId}, now()
          )
        `;
        await transaction`
          INSERT INTO "member" (
            "id", "organizationId", "userId", "role", "createdAt"
          ) VALUES (
            ${organization.memberId}, ${organization.organizationId},
            ${organization.userId}, 'owner', now()
          )
        `;
      });
    }

    const buffer = Buffer.from("# Shared incident sentinel\nQuartz is readable in every organization.\n", "utf8");
    const blobIds: string[] = [];
    for (const organization of organizations) {
      const first = await files.createPublishedFileFromBuffer({
        organizationId: organization.organizationId,
        uploaderUserId: organization.userId,
        filename: "incident.md",
        declaredMediaType: "text/markdown",
        buffer,
      });
      assert.equal(first.representationStatus, "extracted_text");
      await getStorageAdapter().deleteObject(first.objectKey);
      await sql`
        UPDATE "file_blobs"
        SET "availability_status" = 'unknown', "availability_checked_at" = NULL
        WHERE "id" = ${first.blobId}
      `;

      const restored = await files.createPublishedFileFromBuffer({
        organizationId: organization.organizationId,
        uploaderUserId: organization.userId,
        filename: "incident.md",
        declaredMediaType: "text/markdown",
        buffer,
      });
      assert.equal(restored.blobId, first.blobId);
      assert.equal(restored.availabilityStatus, "available");
      assert.equal(await getStorageAdapter().objectExists(first.objectKey), true);

      await sql`
        UPDATE "file_representations"
        SET "kind" = 'metadata_only', "status" = 'ready',
            "text_content" = NULL, "error" = 'historical extraction failure',
            "updated_at" = now()
        WHERE "blob_id" = ${first.blobId}
      `;

      const reuploaded = await files.createPublishedFileFromBuffer({
        organizationId: organization.organizationId,
        uploaderUserId: organization.userId,
        filename: "incident.md",
        declaredMediaType: "text/markdown",
        buffer,
      });
      assert.equal(reuploaded.blobId, first.blobId);
      assert.equal(reuploaded.representationStatus, "extracted_text");
      assert.match(reuploaded.representationText ?? "", /Quartz is readable/u);
      blobIds.push(reuploaded.blobId);
    }
    assert.notEqual(blobIds[0], blobIds[1]);

    const matrix = await import("../../../../packages/attachments/scripts/extraction-matrix.mjs") as {
      createBlankPdf(): Buffer;
    };
    const blankPdf = await files.createPublishedFileFromBuffer({
      organizationId: organizations[0]!.organizationId,
      uploaderUserId: organizations[0]!.userId,
      filename: "blank.pdf",
      declaredMediaType: "application/pdf",
      buffer: matrix.createBlankPdf(),
    });
    assert.equal(blankPdf.representationStatus, "metadata_only");
    assert.equal(blankPdf.metadataOnlyReason, "Attachment extractor returned no text.");
    const [blankRepresentation] = await sql<Array<{ status: string; error: string | null }>>`
      SELECT "status", "error"
      FROM "file_representations"
      WHERE "blob_id" = ${blankPdf.blobId}
    `;
    assert.deepEqual(blankRepresentation, {
      status: "failed",
      error: "Attachment extractor returned no text.",
    });

    const opaque = await files.createPublishedFileFromBuffer({
      organizationId: organizations[0]!.organizationId,
      uploaderUserId: organizations[0]!.userId,
      filename: "opaque.bin",
      declaredMediaType: "application/octet-stream",
      buffer: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(opaque.representationStatus, "metadata_only");
    await assert.rejects(
      knowledge.publishFileToKnowledge({
        organizationId: organizations[0]!.organizationId,
        uploaderUserId: organizations[0]!.userId,
        fileId: opaque.id,
      }),
      /file type is not supported for Knowledge/u,
    );
  },
);

test(
  "hosted Browser upload rejects declared PNG bytes without PNG magic and consumes the reserved draft",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const previousStorageProvider = process.env.STORAGE_PROVIDER;
    const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-artifact-"));
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_LOCAL_ROOT = storageRoot;

    const [
      { resetDbRuntimeForTests },
      files,
      { resetStorageAdapterForTests },
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./service"),
      import("@/lib/storage"),
    ]);
    resetStorageAdapterForTests();
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const userId = `browser-artifact-user-${suffix}`;
    const organizationId = `browser-artifact-org-${suffix}`;
    const threadId = `browser-artifact-thread-${suffix}`;
    const fileId = `file-browser-${createHash("sha256").update(suffix).digest("hex")}`;
    const invalidPng = Buffer.from("not-png!", "utf8");
    const expectedSha256 = createHash("sha256").update(invalidPng).digest("hex");

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      resetStorageAdapterForTests();
      if (previousStorageProvider === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = previousStorageProvider;
      if (previousStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
      else process.env.STORAGE_LOCAL_ROOT = previousStorageRoot;
      await rm(storageRoot, { recursive: true, force: true });
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Browser Artifact User', ${`${userId}@example.test`},
          true, now(), now()
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Browser Artifact Org', ${organizationId}, now()
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES (
          ${threadId}, 'Browser Artifact Thread', ${userId}, ${organizationId}, 'web'
        )
      `;
    });

    await files.initializeThreadFile({
      threadId,
      organizationId,
      userId,
      filename: "browser-screenshot.png",
      sizeBytes: invalidPng.byteLength,
      declaredMediaType: "image/png",
      trustedFileId: fileId,
    });
    await assert.rejects(
      files.uploadThreadFile({
        fileId,
        threadId,
        organizationId,
        userId,
        body: webStream(invalidPng),
        contentLength: invalidPng.byteLength,
        expectedSha256,
        expectedMediaType: "image/png",
        singleUseDraft: true,
      }),
      (error: unknown) =>
        error instanceof files.FileUploadVerificationError &&
        error.code === "FILE_MEDIA_TYPE_MISMATCH",
    );
    const failed = await files.getThreadFileForUser({
      fileId,
      threadId,
      organizationId,
      userId,
    });
    assert.equal(failed.lifecycleState, "failed");
    await assert.rejects(
      files.uploadThreadFile({
        fileId,
        threadId,
        organizationId,
        userId,
        body: webStream(invalidPng),
        contentLength: invalidPng.byteLength,
        expectedSha256,
        expectedMediaType: "image/png",
        singleUseDraft: true,
      }),
      (error: unknown) =>
        error instanceof files.FileUploadVerificationError &&
        error.code === "FILE_UPLOAD_ALREADY_USED",
    );
    await assert.rejects(
      files.uploadThreadFile({
        fileId,
        threadId,
        organizationId,
        userId,
        body: webStream(invalidPng),
        contentLength: invalidPng.byteLength,
      }),
      (error: unknown) =>
        error instanceof files.FileUploadVerificationError &&
        error.code === "FILE_UPLOAD_ALREADY_USED",
    );
  },
);

test(
  "concurrent project promotion converges on one grant, document, and active run",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const previousStorageProvider = process.env.STORAGE_PROVIDER;
    const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-file-promotion-"));
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_LOCAL_ROOT = storageRoot;

    const [
      { resetDbRuntimeForTests },
      files,
      { resetStorageAdapterForTests },
      knowledge,
      knowledgeQueue,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./service"),
      import("@/lib/storage"),
      import("@/lib/knowledge/documents/runtime"),
      import("@/lib/knowledge/queue"),
    ]);
    resetStorageAdapterForTests();
    const sql = postgres(databaseUrl, { max: 8 });
    const suffix = crypto.randomUUID();
    const userId = `promotion-user-${suffix}`;
    const organizationId = `promotion-org-${suffix}`;
    const memberId = `promotion-member-${suffix}`;
    const environmentId = `promotion-environment-${suffix}`;
    const projectId = `promotion-project-${suffix}`;

    context.after(async () => {
      await knowledgeQueue.stopControlWorkers();
      await sql`
        DELETE FROM pgboss.job
        WHERE data->>'runId' IN (
          SELECT id FROM knowledge_ingestion_runs
          WHERE organization_id = ${organizationId}
        )
      `;
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      resetStorageAdapterForTests();
      if (previousStorageProvider === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = previousStorageProvider;
      if (previousStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
      else process.env.STORAGE_LOCAL_ROOT = previousStorageRoot;
      await rm(storageRoot, { recursive: true, force: true });
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Promotion User', ${`${userId}@example.test`}, true, now(), now()
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Promotion Org', ${organizationId}, now())
      `;
      await transaction`
        INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
        VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now())
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "provider", "region", "status", "is_default"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId}, 'Promotion Environment',
          'promotion-environment', 'desktop', 'local', 'ready', true
        )
      `;
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "environment_id", "created_by_user_id", "name"
        ) VALUES (
          ${projectId}, ${organizationId}, ${environmentId}, ${userId}, 'Promotion Project'
        )
      `;
      await transaction`
        INSERT INTO "project_members" (
          "project_id", "organization_member_id", "role"
        ) VALUES (${projectId}, ${memberId}, 'owner')
      `;
    });

    const legacyBuffer = Buffer.from("# Concurrent legacy upload sentinel\n", "utf8");
    const legacyResults = await Promise.all([
      knowledge.createKnowledgeDocumentFromUpload({
        organizationId,
        uploaderUserId: userId,
        projectId,
        file: new File([legacyBuffer], "legacy-promotion.md", {
          type: "text/markdown",
        }),
      }),
      knowledge.createKnowledgeDocumentFromUpload({
        organizationId,
        uploaderUserId: userId,
        projectId,
        file: new File([legacyBuffer], "legacy-promotion.md", {
          type: "text/markdown",
        }),
      }),
    ]);
    assert.equal(legacyResults[0].document.id, legacyResults[1].document.id);
    const [legacyCounts] = await sql<Array<{
      documents: number;
      activeRuns: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM knowledge_documents
          WHERE id = ${legacyResults[0].document.id}) AS documents,
        (SELECT count(*)::int FROM knowledge_ingestion_runs
          WHERE document_id = ${legacyResults[0].document.id}
            AND status IN ('queued', 'running')) AS "activeRuns"
    `;
    assert.deepEqual(legacyCounts, { documents: 1, activeRuns: 1 });

    const promotionBuffer = Buffer.from("# Concurrent promotion sentinel\n", "utf8");
    const file = await files.createPublishedFileFromBuffer({
      organizationId,
      uploaderUserId: userId,
      filename: "promotion.md",
      declaredMediaType: "text/markdown",
      buffer: promotionBuffer,
    });
    const results = await Promise.all([
      knowledge.publishFileToKnowledge({
        organizationId,
        uploaderUserId: userId,
        fileId: file.id,
        projectId,
      }),
      knowledge.publishFileToKnowledge({
        organizationId,
        uploaderUserId: userId,
        fileId: file.id,
        projectId,
      }),
    ]);
    assert.equal(results[0].document.id, results[1].document.id);

    const [counts] = await sql<Array<{
      grants: number;
      documents: number;
      activeRuns: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM file_scope_grants
          WHERE file_id = ${file.id} AND scope_type = 'project'
            AND project_id = ${projectId} AND revoked_at IS NULL) AS grants,
        (SELECT count(*)::int FROM knowledge_documents
          WHERE file_id = ${file.id} AND scope = 'project'
            AND project_id = ${projectId}) AS documents,
        (SELECT count(*)::int FROM knowledge_ingestion_runs
          WHERE document_id = ${results[0].document.id}
            AND status IN ('queued', 'running')) AS "activeRuns"
    `;
    assert.deepEqual(counts, { grants: 1, documents: 1, activeRuns: 1 });

    const duplicateUpload = await files.createPublishedFileFromBuffer({
      organizationId,
      uploaderUserId: userId,
      filename: "promotion-copy.md",
      declaredMediaType: "text/markdown",
      buffer: promotionBuffer,
    });
    assert.notEqual(duplicateUpload.id, file.id);
    assert.equal(duplicateUpload.blobId, file.blobId);

    const duplicatePromotion = await knowledge.publishFileToKnowledge({
      organizationId,
      uploaderUserId: userId,
      fileId: duplicateUpload.id,
      projectId,
    });
    assert.notEqual(duplicatePromotion.document.id, results[0].document.id);
    assert.equal(duplicatePromotion.document.fileId, duplicateUpload.id);
    assert.equal(duplicatePromotion.document.storageKey, results[0].document.storageKey);
    assert.equal(duplicatePromotion.deduped, false);

    const [duplicateCounts] = await sql<Array<{
      grants: number;
      documents: number;
      activeRuns: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM file_scope_grants
          WHERE file_id IN (${file.id}, ${duplicateUpload.id})
            AND scope_type = 'project' AND project_id = ${projectId}
            AND revoked_at IS NULL) AS grants,
        (SELECT count(*)::int FROM knowledge_documents
          WHERE project_id = ${projectId}
            AND checksum_sha256 = ${file.sha256}) AS documents,
        (SELECT count(*)::int FROM knowledge_ingestion_runs
          WHERE document_id IN (${results[0].document.id}, ${duplicatePromotion.document.id})
            AND status IN ('queued', 'running')) AS "activeRuns"
    `;
    assert.deepEqual(duplicateCounts, {
      grants: 2,
      documents: 2,
      activeRuns: 2,
    });
  },
);

function webStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
