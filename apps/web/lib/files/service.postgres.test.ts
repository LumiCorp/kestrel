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
});

test("hosted Browser download reconciles a deterministic ready draft into one promotion result", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const previousStorageProvider = process.env.STORAGE_PROVIDER;
  const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
  const storageRoot = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-draft-"),
  );
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
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const userId = `browser-draft-user-${suffix}`;
  const organizationId = `browser-draft-org-${suffix}`;
  const threadId = `browser-draft-thread-${suffix}`;
  const bytes = Buffer.from("deterministic browser download", "utf8");
  const identity = {
    operationId: `browser-draft-operation-${suffix}`,
    organizationId,
    threadId,
    userId,
    sessionId: `browser-session-${suffix}`,
    generation: 1,
    pendingDownloadId: `pending-download-${suffix}`,
    filename: "download.bin",
    declaredMediaType: "",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const fileId = `file-browser-${createHash("sha256")
    .update(
      JSON.stringify({
        operationId: identity.operationId,
        organizationId,
        threadId,
        sessionId: identity.sessionId,
        generation: identity.generation,
        pendingDownloadId: identity.pendingDownloadId,
        sha256: identity.sha256,
      }),
    )
    .digest("hex")}`;

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
    await resetDbRuntimeForTests();
    resetStorageAdapterForTests();
    if (previousStorageProvider === undefined)
      delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = previousStorageProvider;
    if (previousStorageRoot === undefined)
      delete process.env.STORAGE_LOCAL_ROOT;
    else process.env.STORAGE_LOCAL_ROOT = previousStorageRoot;
    await rm(storageRoot, { recursive: true, force: true });
    await sql.end({ timeout: 0 });
  });
  await sql.begin(async (transaction) => {
    await transaction`
        INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
        VALUES (${userId}, 'Browser Draft User', ${`${userId}@example.test`}, true, now(), now())
      `;
    await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Browser Draft Org', ${organizationId}, now())
      `;
    await transaction`
        INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
        VALUES (${`browser-draft-member-${suffix}`}, ${organizationId}, ${userId}, 'owner', now())
      `;
    await transaction`
        INSERT INTO "threads" ("id", "title", "created_by_user_id", "organization_id", "origin")
        VALUES (${threadId}, 'Browser Draft Thread', ${userId}, ${organizationId}, 'web')
      `;
  });

  await files.initializeThreadFile({
    threadId,
    organizationId,
    userId,
    filename: identity.filename,
    sizeBytes: identity.sizeBytes,
    declaredMediaType: "application/octet-stream",
    trustedFileId: fileId,
  });
  await files.uploadThreadFile({
    fileId,
    threadId,
    organizationId,
    userId,
    body: webStream(bytes),
    contentLength: bytes.byteLength,
    expectedSha256: identity.sha256,
    singleUseDraft: true,
  });
  assert.equal(await files.prepareHostedBrowserDownload(identity), "ready");
  const completed = await files.completeHostedBrowserDownload(identity);
  assert.equal(completed.id, fileId);
  assert.equal(completed.lifecycleState, "ready");
  assert.equal(completed.declaredMediaType, "application/octet-stream");
  assert.equal(await files.prepareHostedBrowserDownload(identity), "ready");
  const [counts] = await sql<
    Array<{ files: number; promotions: number; grants: number }>
  >`
      SELECT
        (SELECT count(*)::int FROM "kestrel_files" WHERE "id" = ${fileId}) AS files,
        (SELECT count(*)::int FROM "browser_download_promotions" WHERE "operation_id" = ${identity.operationId}) AS promotions,
        (SELECT count(*)::int FROM "file_scope_grants" WHERE "file_id" = ${fileId}) AS grants
    `;
  assert.deepEqual(counts, { files: 1, promotions: 1, grants: 1 });
  const freshIdentity = {
    ...identity,
    operationId: `browser-fresh-operation-${suffix}`,
    pendingDownloadId: `pending-fresh-download-${suffix}`,
  };
  assert.equal(await files.prepareHostedBrowserDownload(freshIdentity), "upload_required");
  await files.uploadHostedBrowserDownload({ ...freshIdentity, body: Readable.from([bytes]) });
  const fresh = await files.completeHostedBrowserDownload(freshIdentity);
  assert.equal(fresh.lifecycleState, "ready");
  assert.equal(fresh.sha256, identity.sha256);
  assert.equal(await files.prepareHostedBrowserDownload(freshIdentity), "ready");
  await sql`UPDATE "kestrel_files" SET "created_at" = now() - interval '8 days' WHERE "id" = ${fileId}`;
  await files.cleanupExpiredFiles(new Date());
  assert.equal(
    (await files.completeHostedBrowserDownload(identity)).id,
    fileId,
  );

  const lateBytes = Buffer.from(
    "browser download finishing after expiry",
    "utf8",
  );
  const lateFileId = `file-browser-${createHash("sha256").update(`late:${suffix}`).digest("hex")}`;
  await files.initializeThreadFile({
    threadId,
    organizationId,
    userId,
    filename: "late.bin",
    sizeBytes: lateBytes.byteLength,
    declaredMediaType: "application/octet-stream",
    trustedFileId: lateFileId,
  });
  let emitted = false;
  const delayedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (emitted) return;
      emitted = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.enqueue(lateBytes);
      controller.close();
    },
  });
  await assert.rejects(
    files.uploadThreadFile({
      fileId: lateFileId,
      threadId,
      organizationId,
      userId,
      body: delayedBody,
      contentLength: lateBytes.byteLength,
      expectedSha256: createHash("sha256").update(lateBytes).digest("hex"),
      singleUseDraft: true,
      readyBefore: new Date(Date.now() + 100),
    }),
    /BROWSER_DOWNLOAD_UNAVAILABLE/u,
  );
  const [lateState] = await sql<
    Array<{
      lifecycleState: string;
      objectKey: string;
      promotions: number;
    }>
  >`
      SELECT file.lifecycle_state AS "lifecycleState", blob.object_key AS "objectKey",
        (SELECT count(*)::int FROM browser_download_promotions promotion
          WHERE promotion.file_id = file.id) AS promotions
      FROM kestrel_files file
      INNER JOIN file_blobs blob ON blob.id = file.blob_id
      WHERE file.id = ${lateFileId}
    `;
  assert.deepEqual(
    {
      lifecycleState: lateState?.lifecycleState,
      promotions: lateState?.promotions,
    },
    { lifecycleState: "failed", promotions: 0 },
  );
  assert.equal(
    await getStorageAdapter().objectExists(lateState?.objectKey ?? "missing"),
    false,
  );

  const racingFileId = `file-browser-${createHash("sha256").update(`race:${suffix}`).digest("hex")}`;
  await files.initializeThreadFile({
    threadId,
    organizationId,
    userId,
    filename: "racing.bin",
    sizeBytes: 1,
    declaredMediaType: "application/octet-stream",
    trustedFileId: racingFileId,
  });
  await sql`UPDATE kestrel_files SET created_at = now() - interval '8 days' WHERE id = ${racingFileId}`;
  let inserted!: () => void;
  const insertionStarted = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  let release!: () => void;
  const holdInsertion = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promotionInsert = sql.begin(async (transaction) => {
    await transaction`
        INSERT INTO browser_download_promotions (
          operation_id, organization_id, thread_id, session_id, generation,
          pending_download_id, sha256, effect_revision, file_id
        ) VALUES (
          ${`cleanup-race-operation-${suffix}`}, ${organizationId}, ${threadId},
          ${`cleanup-race-session-${suffix}`}, 1, ${`cleanup-race-pending-${suffix}`},
          ${"b".repeat(64)}, ${"c".repeat(64)}, ${racingFileId}
        )
      `;
    inserted();
    await holdInsertion;
  });
  await insertionStarted;
  const cleanup = files.cleanupExpiredFiles(new Date());
  let cleanupSettled = false;
  void cleanup.then(
    () => {
      cleanupSettled = true;
    },
    () => {
      cleanupSettled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cleanupSettled, false);
  release();
  await promotionInsert;
  await cleanup;
  const [racingCounts] = await sql<
    Array<{ files: number; promotions: number }>
  >`
      SELECT
        (SELECT count(*)::int FROM kestrel_files WHERE id = ${racingFileId}) AS files,
        (SELECT count(*)::int FROM browser_download_promotions WHERE file_id = ${racingFileId}) AS promotions
    `;
  assert.deepEqual(racingCounts, { files: 1, promotions: 1 });
});

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

  const buffer = Buffer.from(
    "# Shared incident sentinel\nQuartz is readable in every organization.\n",
    "utf8",
  );
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

  const matrix =
    (await import("../../../../packages/attachments/scripts/extraction-matrix.mjs")) as {
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
  assert.equal(
    blankPdf.metadataOnlyReason,
    "Attachment extractor returned no text.",
  );
  const [blankRepresentation] = await sql<
    Array<{ status: string; error: string | null }>
  >`
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
});

test(
  "hosted Browser upload rejects declared PNG bytes without PNG magic and consumes the reserved draft",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const previousStorageProvider = process.env.STORAGE_PROVIDER;
    const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-artifact-"),
  );
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_LOCAL_ROOT = storageRoot;

    const [
      { resetDbRuntimeForTests },
      files,
      { resetStorageAdapterForTests }] = await Promise.all([
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
    if (previousStorageProvider === undefined)
      delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = previousStorageProvider;
    if (previousStorageRoot === undefined)
      delete process.env.STORAGE_LOCAL_ROOT;
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
});

test(
  "concurrent project promotion converges on one grant, document, and active run",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    const previousStorageProvider = process.env.STORAGE_PROVIDER;
    const previousStorageRoot = process.env.STORAGE_LOCAL_ROOT;
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-file-promotion-"),
  );
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
    if (previousStorageProvider === undefined)
      delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = previousStorageProvider;
    if (previousStorageRoot === undefined)
      delete process.env.STORAGE_LOCAL_ROOT;
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

  const legacyBuffer = Buffer.from(
    "# Concurrent legacy upload sentinel\n",
    "utf8",
  );
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
  const [legacyCounts] = await sql<
    Array<{
      documents: number;
      activeRuns: number;
    }>
  >`
      SELECT
        (SELECT count(*)::int FROM knowledge_documents
          WHERE id = ${legacyResults[0].document.id}) AS documents,
        (SELECT count(*)::int FROM knowledge_ingestion_runs
          WHERE document_id = ${legacyResults[0].document.id}
            AND status IN ('queued', 'running')) AS "activeRuns"
    `;
    assert.deepEqual(legacyCounts, { documents: 1, activeRuns: 1 });

  const promotionBuffer = Buffer.from(
    "# Concurrent promotion sentinel\n",
    "utf8",
  );
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

  const [counts] = await sql<
    Array<{
      grants: number;
      documents: number;
      activeRuns: number;
    }>
  >`
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
  assert.equal(
    duplicatePromotion.document.storageKey,
    results[0].document.storageKey,
  );
    assert.equal(duplicatePromotion.deduped, false);

  const [duplicateCounts] = await sql<
    Array<{
      grants: number;
      documents: number;
      activeRuns: number;
    }>
  >`
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
});

function webStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
