import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "concurrent availability probes honor the committed missing state",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, availability] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./availability"),
    ]);
    const sql = postgres(databaseUrl, { max: 4 });
    const suffix = crypto.randomUUID();
    const organizationId = `availability-race-org-${suffix}`;
    const blobId = `availability-race-blob-${suffix}`;
    const objectKey = `availability-race/${suffix}`;

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Availability Race Org', ${`availability-race-${suffix}`}, now())
    `;
    await sql`
      INSERT INTO "file_blobs" (
        "id", "organization_id", "object_key", "size_bytes", "sha256",
        "availability_status", "scan_status"
      ) VALUES (
        ${blobId}, ${organizationId}, ${objectKey}, 1,
        ${"a".repeat(64)}, 'unknown', 'clean'
      )
    `;

    let releaseAvailableProbe: (() => void) | undefined;
    let availableProbeStarted = false;
    const availableProbe = {
      exists: async () => {
        availableProbeStarted = true;
        return await new Promise<boolean>((resolve) => {
          releaseAvailableProbe = () => resolve(true);
        });
      },
    };
    const missingProbe = {
      exists: async () => false,
    };
    const input = {
      blobId,
      objectKey,
      availabilityStatus: "unknown" as const,
    };

    const availableResult = availability.ensureFileBlobAvailable({
      ...input,
      storage: availableProbe,
    });
    assert.equal(availableProbeStarted, true);
    const availableRejection = assert.rejects(
      availableResult,
      (error: unknown) =>
        error instanceof availability.FileAvailabilityError &&
        error.code === "ATTACHMENT_BLOB_MISSING",
    );

    const missingResult = availability.ensureFileBlobAvailable({
      ...input,
      storage: missingProbe,
    });
    const missingRejection = assert.rejects(
      missingResult,
      (error: unknown) =>
        error instanceof availability.FileAvailabilityError &&
        error.code === "ATTACHMENT_BLOB_MISSING",
    );

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [row] = await sql<Array<{ availabilityStatus: string }>>`
        SELECT "availability_status" AS "availabilityStatus"
        FROM "file_blobs"
        WHERE "id" = ${blobId}
      `;
      if (row?.availabilityStatus === "missing") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (attempt === 49) {
        throw new Error("The missing availability probe did not commit.");
      }
    }

    assert.ok(releaseAvailableProbe);
    releaseAvailableProbe();
    await Promise.all([availableRejection, missingRejection]);

    const [committed] = await sql<Array<{ availabilityStatus: string }>>`
      SELECT "availability_status" AS "availabilityStatus"
      FROM "file_blobs"
      WHERE "id" = ${blobId}
    `;
    assert.equal(committed?.availabilityStatus, "missing");
  },
);
