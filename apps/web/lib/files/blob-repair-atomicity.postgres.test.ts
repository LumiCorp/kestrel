import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "blob repair rolls back availability when its audit event cannot be inserted",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, { verifyRestoredFileBlob }] =
      await Promise.all([import("@/lib/db/runtime"), import("./availability")]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `blob-repair-audit-org-${suffix}`;
    const blobId = `blob-repair-audit-blob-${suffix}`;
    const objectKey = `file-repair-audit/${suffix}`;
    const bytes = Buffer.from("restored blob bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Blob Repair Audit Org', ${`blob-repair-audit-${suffix}`}, now())
    `;
    await sql`
      INSERT INTO "file_blobs" (
        "id", "organization_id", "object_key", "size_bytes", "sha256",
        "availability_status", "scan_status"
      ) VALUES (
        ${blobId}, ${organizationId}, ${objectKey}, ${bytes.byteLength}, ${sha256},
        'missing', 'clean'
      )
    `;

    await assert.rejects(
      verifyRestoredFileBlob({
        blobId,
        organizationId,
        // Deliberately violate the audit actor foreign key after the
        // availability update to exercise the transaction rollback boundary.
        actorUserId: `missing-audit-actor-${suffix}`,
        storage: {
          exists: async () => true,
          readBuffer: async () => bytes,
        },
      }),
    );

    const [state] = await sql<Array<{
      availabilityStatus: string;
      auditCount: number;
    }>>`
      SELECT
        blob."availability_status" AS "availabilityStatus",
        (
          SELECT count(*)
          FROM "admin_event_logs" audit
          WHERE audit."target_type" = 'file_blob'
            AND audit."target_id" = ${blobId}
            AND audit."action" = 'restore_verified'
        )::int AS "auditCount"
      FROM "file_blobs" blob
      WHERE blob."id" = ${blobId}
    `;

    assert.deepEqual(state, {
      availabilityStatus: "missing",
      auditCount: 0,
    });
  },
);
