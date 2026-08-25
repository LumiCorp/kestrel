import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      { resetStorageAdapterForTests },
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
