import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryLocalCoreCredentialStore,
  UnavailableLocalCoreCredentialStore,
} from "../../src/localCore/credentialStore.js";
import {
  KestrelOneReceivingAuthorizationError,
  LocalCoreKestrelOneAccountManager,
} from "../../src/localCore/kestrelOneAccount.js";

test("Kestrel One account status is signed out when credential storage is unavailable", async () => {
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore: new UnavailableLocalCoreCredentialStore(),
  });

  assert.deepEqual(await manager.account(), { status: "signed_out" });
});

test("Kestrel One account requests coalesce rotating credential refreshes", async (context) => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  await credentialStore.set(
    "kestrel_one.account",
    JSON.stringify({
      baseUrl: "https://kestrel.example/",
      accessToken: "expired-access",
      accessTokenExpiresAt: new Date(0).toISOString(),
      refreshToken: "rotating-refresh",
    }),
  );
  let refreshRequests = 0;
  const authorizedRequests: string[] = [];
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    now: () => now,
    fetchImpl: async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/desktop/v1/oauth/token") {
        refreshRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          token_type: "Bearer",
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 900,
        });
      }
      authorizedRequests.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      if (url.pathname === "/api/desktop/v1/account") {
        return Response.json({
          account: {
            id: "user-1",
            name: "Kestrel User",
            email: "user@example.test",
          },
          organizations: [],
          projects: [],
          threads: [],
        });
      }
      if (url.pathname === "/api/desktop/v1/threads/thread-1") {
        return Response.json({
          snapshotVersion: "desktop-v1",
          thread: {
            id: "thread-1",
            projectId: null,
            title: "Thread",
            interactionMode: "build",
            updatedAt: new Date(now).toISOString(),
          },
          messages: [],
          turns: [],
          queue: {
            state: "running",
            activeTurnId: null,
            queuedTurnIds: [],
          },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  context.after(() => manager.close());

  const [account, thread] = await Promise.all([
    manager.account(),
    manager.thread("thread-1"),
  ]);

  assert.equal(account.status, "signed_in");
  assert.equal(thread.thread.id, "thread-1");
  assert.equal(refreshRequests, 1);
  assert.deepEqual(authorizedRequests, [
    "Bearer fresh-access",
    "Bearer fresh-access",
  ]);
  assert.match(
    (await credentialStore.get("kestrel_one.account")) ?? "",
    /fresh-refresh/u,
  );
});

test("Kestrel One account 401 clears the rejected credential and returns signed out", async () => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  await credentialStore.set(
    "kestrel_one.account",
    JSON.stringify({
      baseUrl: "https://kestrel.example/",
      accessToken: "rejected-access",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: "rejected-refresh",
    }),
  );
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    fetchImpl: async () => new Response(null, { status: 401 }),
  });

  assert.deepEqual(await manager.account(), { status: "signed_out" });
  assert.equal(await credentialStore.get("kestrel_one.account"), undefined);
});

test("receiving management stays tenant-bound and does not persist the write-only key", async () => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const storedCredential = JSON.stringify({
    baseUrl: "https://kestrel.example/",
    accessToken: "account-access",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "account-refresh",
  });
  await credentialStore.set("kestrel_one.account", storedCredential);
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    fetchImpl: async (request, init) => {
      const url = new URL(String(request));
      requests.push({ url, ...(init ? { init } : {}) });
      return Response.json({
        connection: {
          provider: "resend",
          configured: true,
          receivingDomainKind: "resend_managed",
          credentialStatus: "full_access",
          credentialValidatedAt: "2026-08-26T12:00:00.000Z",
          receivingDomain: "raixaro.resend.app",
          receivingDomainStatus: "verified",
          mxStatus: "verified",
          domainCheckedAt: "2026-08-26T12:00:00.000Z",
          webhookStatus: "not_staged",
          inboundEnabled: false,
          lastHealthCheckedAt: "2026-08-26T12:00:00.000Z",
          lastTestedAt: null,
          lastErrorCode: null,
          readiness: "ready_inactive",
        },
      });
    },
  });

  const projection = await manager.saveReceivingConnection({
    organizationId: "organization-1",
    receivingDomain: "raixaro.resend.app",
    apiKey: "re_full_access_secret",
  });

  assert.equal(projection.receivingDomain, "raixaro.resend.app");
  assert.equal(
    requests[0]?.url.pathname,
    "/api/desktop/v1/organizations/organization-1/email/receiving",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    receivingDomain: "raixaro.resend.app",
    apiKey: "re_full_access_secret",
  });
  assert.equal(
    await credentialStore.get("kestrel_one.account"),
    storedCredential,
  );
  assert.doesNotMatch(
    storedCredential,
    /re_full_access_secret|raixaro\.resend\.app/u,
  );
});

for (const statusCode of [401, 403] as const) {
  test(`receiving reads preserve hosted ${statusCode} as a typed Organization authorization rejection`, async () => {
    const credentialStore = new MemoryLocalCoreCredentialStore();
    await credentialStore.set(
      "kestrel_one.account",
      JSON.stringify({
        baseUrl: "https://kestrel.example/",
        accessToken: "account-access",
        accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        refreshToken: "account-refresh",
      }),
    );
    const manager = new LocalCoreKestrelOneAccountManager({
      credentialStore,
      fetchImpl: async () =>
        Response.json(
          { error: "Organization receiving access was rejected." },
          { status: statusCode },
        ),
    });

    await assert.rejects(
      manager.receivingConnection("organization-revoked"),
      (error) =>
        error instanceof KestrelOneReceivingAuthorizationError &&
        error.statusCode === statusCode,
    );
  });
}
