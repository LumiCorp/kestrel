import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "Project skills persist canonically without a Workspace and adopt legacy installations",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    const [{ resetDbRuntimeForTests }, projectSkills] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./skills"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const ids = {
      user: `skills-user-${suffix}`,
      organization: `skills-org-${suffix}`,
      otherOrganization: `skills-other-org-${suffix}`,
      environment: `skills-env-${suffix}`,
      otherEnvironment: `skills-other-env-${suffix}`,
      member: `skills-member-${suffix}`,
      otherMember: `skills-other-member-${suffix}`,
      project: `skills-project-${suffix}`,
      legacyProject: `skills-legacy-project-${suffix}`,
      otherProject: `skills-other-project-${suffix}`,
      workspace: `skills-workspace-${suffix}`,
      legacyInstallation: `skills-legacy-installation-${suffix}`,
    };
    const now = new Date("2026-07-22T12:00:00.000Z");
    const originalFetch = globalThis.fetch;

    context.after(async () => {
      globalThis.fetch = originalFetch;
      await sql`DELETE FROM "organization" WHERE "id" IN (${ids.organization}, ${ids.otherOrganization})`;
      await sql`DELETE FROM "user" WHERE "id" = ${ids.user}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${ids.user}, 'Skills User', ${`${ids.user}@example.test`}, true,
          ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES
          (${ids.organization}, 'Skills Org', ${ids.organization}, ${now}),
          (${ids.otherOrganization}, 'Other Skills Org', ${ids.otherOrganization}, ${now})
      `;
      await transaction`
        INSERT INTO "member" (
          "id", "organizationId", "userId", "role", "createdAt"
        ) VALUES
          (${ids.member}, ${ids.organization}, ${ids.user}, 'owner', ${now}),
          (${ids.otherMember}, ${ids.otherOrganization}, ${ids.user}, 'owner', ${now})
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "fly_app_name", "router_url"
        ) VALUES
          (
            ${ids.environment}, ${ids.organization}, ${ids.user},
            'Skills Environment', 'skills', 'iad', 'ready',
            ${`skills-app-${suffix}`}, 'https://environment.example'
          ),
          (
            ${ids.otherEnvironment}, ${ids.otherOrganization}, ${ids.user},
            'Other Skills Environment', 'skills', 'iad', 'ready',
            ${`other-skills-app-${suffix}`}, 'https://other-environment.example'
          )
      `;
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "environment_id", "created_by_user_id", "name"
        ) VALUES
          (
            ${ids.project}, ${ids.organization}, ${ids.environment},
            ${ids.user}, 'Canonical Skills Project'
          ),
          (
            ${ids.legacyProject}, ${ids.organization}, ${ids.environment},
            ${ids.user}, 'Legacy Skills Project'
          ),
          (
            ${ids.otherProject}, ${ids.otherOrganization}, ${ids.otherEnvironment},
            ${ids.user}, 'Other Skills Project'
          )
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "project_id",
          "created_by_user_id", "name", "kind", "source_type", "status",
          "fly_machine_id"
        ) VALUES (
          ${ids.workspace}, ${ids.organization}, ${ids.environment},
          ${ids.legacyProject}, ${ids.user}, 'Legacy Skills Workspace',
          'project', 'blank', 'ready', ${`skills-machine-${suffix}`}
        )
      `;
      await transaction`
        INSERT INTO "project_members" (
          "project_id", "organization_member_id", "role"
        ) VALUES
          (${ids.project}, ${ids.member}, 'owner'),
          (${ids.legacyProject}, ${ids.member}, 'owner'),
          (${ids.otherProject}, ${ids.otherMember}, 'owner')
      `;
    });

    const created = await projectSkills.createProjectSkill({
      organizationId: ids.organization,
      projectId: ids.project,
      actorUserId: ids.user,
      source: {
        gitUrl: "https://git.example/acme/review.git",
        branch: "main",
      },
    });
    assert.equal(created.status, "pending");
    assert.equal(
      (await projectSkills.listProjectSkills({
        organizationId: ids.otherOrganization,
        projectId: ids.project,
      })).length,
      0
    );
    await assert.rejects(
      projectSkills.createProjectSkill({
        organizationId: ids.organization,
        projectId: ids.project,
        actorUserId: ids.user,
        source: created.source,
      }),
      /already installed/u
    );
    await assert.rejects(
      projectSkills.createProjectSkill({
        organizationId: ids.organization,
        projectId: ids.project,
        actorUserId: ids.user,
        source: {
          gitUrl: "https://user:secret@git.example/acme/private.git",
          branch: "main",
        },
      }),
      /without credentials/u
    );
    await assert.rejects(
      sql`
        INSERT INTO "project_skill_installations" (
          "id", "organization_id", "project_id", "created_by_user_id",
          "git_url", "branch"
        ) VALUES (
          ${`skills-cross-tenant-${suffix}`}, ${ids.otherOrganization},
          ${ids.project}, ${ids.user}, 'https://git.example/cross.git', 'main'
        )
      `,
      /foreign key/u
    );

    const retainedRevision = {
      installationId: created.installationId,
      name: "review",
      description: "Review changes.",
      commitSha: "a".repeat(40),
      contentDigest: `sha256:${"b".repeat(64)}`,
      relativeRoot: `.kestrel/skills/${created.installationId}/revisions/${"a".repeat(40)}`,
      skillFile: `.kestrel/skills/${created.installationId}/revisions/${"a".repeat(40)}/SKILL.md`,
      installedAt: now.toISOString(),
      fileCount: 1,
      totalBytes: 100,
    };
    await sql`
      UPDATE "project_skill_installations"
      SET "status" = 'ready', "revision" = ${sql.json(retainedRevision)}
      WHERE "id" = ${created.installationId}
    `;
    const updated = await projectSkills.updateProjectSkill({
      organizationId: ids.organization,
      projectId: ids.project,
      installationId: created.installationId,
      actorUserId: ids.user,
      source: {
        gitUrl: "https://git.example/acme/review.git",
        branch: "next",
      },
    });
    assert.equal(updated.status, "pending");
    assert.equal(updated.revision?.commitSha, retainedRevision.commitSha);
    const [auditCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "project_audit_events"
      WHERE "project_id" = ${ids.project}
    `;
    assert.equal(auditCount?.count, 2);

    const legacyRevision = {
      ...retainedRevision,
      installationId: ids.legacyInstallation,
      name: "legacy-review",
      relativeRoot: `.kestrel/skills/${ids.legacyInstallation}/revisions/${"a".repeat(40)}`,
      skillFile: `.kestrel/skills/${ids.legacyInstallation}/revisions/${"a".repeat(40)}/SKILL.md`,
    };
    const legacySkill = {
      installationId: ids.legacyInstallation,
      workspaceId: ids.workspace,
      source: {
        gitUrl: "https://git.example/acme/legacy.git",
        branch: "main",
      },
      status: "ready",
      revision: legacyRevision,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const requests: Array<{ method: string; body?: unknown }> = [];
    globalThis.fetch = (async (_url, init) => {
      const method = init?.method ?? "GET";
      requests.push({
        method,
        ...(typeof init?.body === "string"
          ? { body: JSON.parse(init.body) as unknown }
          : {}),
      });
      return Response.json({ skills: [legacySkill] });
    }) as typeof fetch;

    const synchronized = await projectSkills.synchronizeProjectSkills({
      organizationId: ids.organization,
      projectId: ids.legacyProject,
      actorUserId: "kestrel-one:github:bot",
    });
    assert.equal(synchronized.deferred, false);
    assert.equal(synchronized.skills[0]?.installationId, ids.legacyInstallation);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "PUT"]
    );
    assert.deepEqual(requests[1]?.body, {
      installations: [
        {
          installationId: ids.legacyInstallation,
          source: legacySkill.source,
        },
      ],
    });
    const [legacyProject] = await sql<
      Array<{ initializedAt: Date | null }>
    >`
      SELECT "skill_catalog_initialized_at" AS "initializedAt"
      FROM "projects"
      WHERE "id" = ${ids.legacyProject}
    `;
    assert.ok(legacyProject?.initializedAt);

    await projectSkills.removeProjectSkill({
      organizationId: ids.organization,
      projectId: ids.project,
      installationId: created.installationId,
      actorUserId: ids.user,
    });
    assert.deepEqual(
      await projectSkills.listProjectSkills({
        organizationId: ids.organization,
        projectId: ids.project,
      }),
      []
    );
  }
);
