import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import postgres from "postgres";
import { generateDesktopCredentialEncryptionKeyPair } from "@lumi/kestrel-environment-auth";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "Desktop enrollment isolates credentials, rejects nonce replay, and retains missing catalog identities",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    const originalPreviewHostSuffix = process.env.KESTREL_PREVIEW_HOST_SUFFIX;
    const originalPreviewEdgeOrigin =
      process.env.KESTREL_PREVIEW_EDGE_PUBLIC_ORIGIN;
    process.env.KESTREL_PREVIEW_HOST_SUFFIX = "preview.example.test";
    process.env.KESTREL_PREVIEW_EDGE_PUBLIC_ORIGIN = "ws://127.0.0.1:49153";
    const [
      { resetDbRuntimeForTests },
      desktop,
      desktopAccount,
      desktopPreview,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./desktop"),
      import("@/lib/desktop-account"),
      import("./desktop-preview"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    context.after(async () => {
      restoreEnvironmentVariable(
        "KESTREL_PREVIEW_HOST_SUFFIX",
        originalPreviewHostSuffix,
      );
      restoreEnvironmentVariable(
        "KESTREL_PREVIEW_EDGE_PUBLIC_ORIGIN",
        originalPreviewEdgeOrigin,
      );
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    const suffix = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const now = new Date();
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Desktop Admin', ${`desktop-${suffix}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Desktop Organization',
          ${`desktop-${suffix}`}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "member" (
          "id", "organizationId", "userId", "role", "createdAt"
        ) VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', ${now})
      `;
      await transaction`
        INSERT INTO "organization_feature_flags" (
          "organization_id", "key", "enabled", "updated_by_user_id"
        ) VALUES (
          ${organizationId}, 'desktop_environments', true, ${userId}
        )
      `;
    });

    const signingKeys = generateKeyPairSync("ed25519");
    const encryptionKeys = generateDesktopCredentialEncryptionKeyPair();
    const privateKey = signingKeys.privateKey
      .export({
        format: "pem",
        type: "pkcs8",
      })
      .toString();
    const enrollment = await desktop.createDesktopEnrollmentRequest({
      desktopName: "Greg's Mac",
      publicKey: signingKeys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
      encryptionPublicKey: encryptionKeys.publicKey,
    });
    const approved = await desktop.approveDesktopEnrollment({
      requestId: enrollment.requestId,
      organizationId,
      actorUserId: userId,
      approval: {},
    });
    assert.equal(approved.environment.provider, "desktop");
    assert.equal(approved.environment.status, "ready");

    const consumed = await desktop.consumeDesktopEnrollment({
      requestId: enrollment.requestId,
      requestSecret: enrollment.requestSecret,
    });
    assert.equal(consumed.status, "active");
    if (consumed.status !== "active") return;

    const authorization = await authorize({
      desktop,
      connectionId: consumed.connectionId,
      credential: consumed.connectorCredential,
      privateKey,
      nonce: randomBytes(24).toString("base64url"),
      bodyText: "{}",
    });
    const firstCatalog = await desktop.syncDesktopWorkspaceCatalog(
      authorization,
      {
        workspaces: [
          {
            workspaceRef: "enrollment-scoped-workspace",
            label: "Kestrel",
            available: true,
          },
          {
            workspaceRef: "unbound-workspace",
            label: "Unbound local project",
            available: true,
          },
        ],
      },
    );
    const boundCatalog = firstCatalog.find(
      (entry) => entry.workspaceRef === "enrollment-scoped-workspace",
    );
    assert.equal(boundCatalog?.availability, "available");
    assert.ok(boundCatalog);
    const stableCatalogId = boundCatalog.id;
    const ownerCatalog =
      await desktop.listVisibleProjectDesktopWorkspaceCatalog({
        organizationId,
        role: "owner",
        desktopCatalogId: stableCatalogId,
      });
    assert.equal(ownerCatalog.length, 2);

    const projectId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "projects" (
          "id", "organization_id", "environment_id", "created_by_user_id",
          "name", "created_at", "updated_at"
        ) VALUES (
          ${projectId}, ${organizationId}, ${approved.environment.id}, ${userId},
          'Desktop Preview Project', ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "project_members" (
          "project_id", "organization_member_id", "role", "created_at", "updated_at"
        ) VALUES (${projectId}, ${memberId}, 'owner', ${now}, ${now})
      `;
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "project_id",
          "created_by_user_id", "name", "kind", "source_type",
          "desktop_catalog_id", "status", "created_at", "updated_at"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${approved.environment.id}, ${projectId},
          ${userId}, 'Desktop Preview Workspace', 'project', 'desktop',
          ${stableCatalogId}, 'ready', ${now}, ${now}
        )
      `;
    });
    const verifier = "desktop-preview-verifier-value-000000000000000000";
    const redirectUri =
      "http://127.0.0.1:49152/oauth/callback/abcdefghijklmnopqrstuvwx";
    const authorizationCode =
      await desktopAccount.createDesktopAuthorizationCode({
        userId,
        redirectUri,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
    const userCredential = await desktopAccount.exchangeDesktopUserCredential({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const previewRequest = new Request("https://kestrel.example/", {
      headers: {
        authorization: `Bearer ${userCredential.access_token}`,
      },
    });
    const publications = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        desktopPreview.publishDesktopPreview(previewRequest, {
          projectId,
          connectionId: consumed.connectionId,
          localRunRef: `local-run-${index}`,
          port: 5100 + index,
        }),
      ),
    );
    const publicationFailures = publications.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? `${result.reason.name}: ${result.reason.message}`
              : String(result.reason),
          ]
        : [],
    );
    assert.equal(
      publications.filter((result) => result.status === "fulfilled").length,
      5,
      publicationFailures.join("\n"),
    );
    const rejected = publications.find(
      (result) => result.status === "rejected",
    );
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof desktopPreview.DesktopPreviewError);
    assert.equal(rejected.reason.code, "PREVIEW_LIMIT_REACHED");
    const [activePreviews] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "workspace_preview_leases"
      WHERE "workspace_id" = ${workspaceId}
        AND "status" IN ('provisioning', 'active')
    `;
    assert.equal(activePreviews?.count, 5);

    await desktop.syncDesktopWorkspaceCatalog(authorization, {
      workspaces: [],
    });
    const missingCatalog = await desktop.listDesktopWorkspaceCatalog({
      organizationId,
      environmentId: approved.environment.id,
    });
    assert.equal(missingCatalog[0]?.id, stableCatalogId);
    assert.equal(missingCatalog[0]?.availability, "missing");
    const memberCatalog =
      await desktop.listVisibleProjectDesktopWorkspaceCatalog({
        organizationId,
        role: "member",
        desktopCatalogId: stableCatalogId,
      });
    assert.deepEqual(
      memberCatalog.map((entry) => ({
        id: entry.id,
        availability: entry.availability,
      })),
      [{ id: stableCatalogId, availability: "missing" }],
    );

    const replayNonce = randomBytes(24).toString("base64url");
    await authorize({
      desktop,
      connectionId: consumed.connectionId,
      credential: consumed.connectorCredential,
      privateKey,
      nonce: replayNonce,
      bodyText: "{}",
    });
    await assert.rejects(
      authorize({
        desktop,
        connectionId: consumed.connectionId,
        credential: consumed.connectorCredential,
        privateKey,
        nonce: replayNonce,
        bodyText: "{}",
      }),
      (error: unknown) =>
        error instanceof desktop.DesktopConnectorAuthError &&
        error.code === "DESKTOP_CONNECTOR_REPLAY_REJECTED",
    );

    const [connection] = await sql<
      Array<{
        publicKey: string;
        credentialHash: string;
        encryptionPublicKey: string;
      }>
    >`
      SELECT
        "public_key" AS "publicKey",
        "credential_hash" AS "credentialHash",
        "encryption_public_key" AS "encryptionPublicKey"
      FROM "desktop_environment_connections"
      WHERE "id" = ${consumed.connectionId}
    `;
    assert.notEqual(connection?.credentialHash, consumed.connectorCredential);
    assert.equal(connection?.encryptionPublicKey, encryptionKeys.publicKey);
    assert.match(connection?.publicKey ?? "", /BEGIN PUBLIC KEY/u);
  },
);

async function authorize(input: {
  desktop: typeof import("./desktop");
  connectionId: string;
  credential: string;
  privateKey: string;
  nonce: string;
  bodyText: string;
}) {
  const pathname = `/api/runtime/desktop-environments/${input.connectionId}/presence`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHash("sha256").update(input.bodyText).digest("hex");
  const signature = sign(
    null,
    Buffer.from(["POST", pathname, timestamp, input.nonce, digest].join("\n")),
    input.privateKey,
  ).toString("base64url");
  return input.desktop.authorizeDesktopConnector({
    connectionId: input.connectionId,
    bodyText: input.bodyText,
    request: new Request(`https://kestrel.example${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.credential}`,
        "x-kestrel-timestamp": timestamp,
        "x-kestrel-nonce": input.nonce,
        "x-kestrel-signature": signature,
      },
    }),
  });
}

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}
