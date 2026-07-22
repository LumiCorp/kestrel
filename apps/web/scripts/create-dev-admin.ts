/**
 * Creates a default developer admin account + organization for local testing.
 * Run with: `pnpm create-dev-admin`.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";

config({
  path: ".env.local",
});

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL or POSTGRES_URL is required to create the dev admin.");
  process.exit(1);
}

const client = postgres(databaseUrl, { prepare: false, max: 1 });

const email = process.env.DEV_ADMIN_EMAIL || "admin@dev.local";
const password = process.env.DEV_ADMIN_PASSWORD || "devpass123";
const name = process.env.DEV_ADMIN_NAME || "Dev Admin";
const orgName = process.env.DEV_ORG_NAME || "Dev-org";
const orgSlug = orgName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "") || "dev-org";

async function run() {
  const now = new Date();
  const { auth } = await import("@/lib/auth");
  const { ensurePersonalOrganization } = await import("@/lib/personal-workspace");
  let [existingUser] = await client`
    SELECT id FROM "user"
    WHERE email = ${email}
  `;

  const canSignIn = await auth.api
    .signInEmail({
      body: {
        email,
        password,
        rememberMe: true,
      },
      headers: new Headers(),
    })
    .then(() => true)
    .catch(() => false);

  if (!canSignIn) {
    if (existingUser) {
      await client`
        DELETE FROM "user"
        WHERE id = ${existingUser.id}
      `;
    }

    await auth.api.signUpEmail({
      body: {
        name,
        email,
        password,
      },
      headers: new Headers(),
    });

    [existingUser] = await client`
      SELECT id FROM "user"
      WHERE email = ${email}
    `;
  }

  if (!existingUser?.id) {
    throw new Error(`Failed to create or load dev admin user for ${email}`);
  }

  const userId = existingUser.id;

  const personalOrganization = await ensurePersonalOrganization({
    id: userId,
    name,
    email,
  });

  await client.begin(async (tx) => {
    await tx`
      UPDATE "user"
      SET name = ${name}, role = 'admin', "emailVerified" = true, "updatedAt" = ${now}
      WHERE id = ${userId}
    `;

    const [existingOrg] = await tx`
      SELECT id FROM "organization"
      WHERE slug = ${orgSlug}
      LIMIT 1
    `;

    const organizationId = existingOrg?.id ?? randomUUID();

    if (!existingOrg) {
      await tx`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${organizationId}, ${orgName}, ${orgSlug}, ${now})
      `;
    } else {
      await tx`
        UPDATE "organization"
        SET name = ${orgName}
        WHERE id = ${organizationId}
      `;
    }

    const [existingMembership] = await tx`
      SELECT id FROM "member"
      WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
      LIMIT 1
    `;

    if (!existingMembership) {
      await tx`
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
        VALUES (${randomUUID()}, ${organizationId}, ${userId}, 'admin', ${now})
      `;
    } else {
      await tx`
        UPDATE "member"
        SET role = 'admin'
        WHERE id = ${existingMembership.id}
      `;
    }
  });

  console.log(
    `✅ Dev admin ready: ${email} with personal workspace + organization ${orgName} (${orgSlug})`
  );
  console.log(`Personal organization ID: ${personalOrganization.id}`);

  await client.end();
  process.exit(0);
}

run().catch((error) => {
  console.error("Failed to create dev admin:", error);
  process.exit(1);
});
