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
import { LocalCoreBrowserAuthorityCriticalSection } from "../../src/localCore/api.js";

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

test("Kestrel One refresh cannot overwrite a concurrent account replacement", async (context) => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  await credentialStore.set(
    "kestrel_one.account",
    JSON.stringify({
      baseUrl: "https://kestrel.example/",
      accessToken: "expired-access",
      accessTokenExpiresAt: new Date(0).toISOString(),
      refreshToken: "expired-refresh",
    }),
  );
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshRelease = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const accountAuthorizations: string[] = [];
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    fetchImpl: async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/desktop/v1/oauth/token") {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "refresh_token") {
          refreshStarted();
          await refreshRelease;
          return Response.json({
            token_type: "Bearer",
            access_token: "stale-refreshed-access",
            refresh_token: "stale-refreshed-refresh",
            expires_in: 900,
          });
        }
        return Response.json({
          token_type: "Bearer",
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_in: 900,
        });
      }
      accountAuthorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
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
    },
  });
  context.after(() => manager.close());

  const account = manager.account();
  await started;
  const authorization = await manager.start({
    baseUrl: "https://kestrel.example/",
  });
  const authorizationUrl = new URL(authorization.authorizationUrl!);
  const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  callback.searchParams.set(
    "state",
    authorizationUrl.searchParams.get("state")!,
  );
  callback.searchParams.set("code", "replacement-code");
  assert.equal((await fetch(callback)).status, 200);
  releaseRefresh();

  assert.equal((await account).status, "signed_in");
  assert.deepEqual(accountAuthorizations, ["Bearer replacement-access"]);
  assert.match(
    (await credentialStore.get("kestrel_one.account")) ?? "",
    /replacement-refresh/u,
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
  const order: string[] = [];
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    fetchImpl: async () => {
      order.push("account-401");
      return new Response(null, { status: 401 });
    },
    beforeCredentialReplace: async () => {
      order.push("close-browser-authority");
      assert.notEqual(
        await credentialStore.get("kestrel_one.account"),
        undefined,
      );
    },
  });

  assert.deepEqual(await manager.account(), { status: "signed_out" });
  assert.deepEqual(order, ["account-401", "close-browser-authority"]);
  assert.equal(await credentialStore.get("kestrel_one.account"), undefined);
});

test("Kestrel One account 401 retains credential authority when Browser cleanup fails", async () => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const credential = JSON.stringify({
    baseUrl: "https://kestrel.example/",
    accessToken: "rejected-access",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "rejected-refresh",
  });
  await credentialStore.set("kestrel_one.account", credential);
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    fetchImpl: async () => new Response(null, { status: 401 }),
    beforeCredentialReplace: async () => {
      throw new Error("Browser cleanup failed");
    },
  });

  await assert.rejects(manager.account(), /Browser cleanup failed/u);
  assert.equal(await credentialStore.get("kestrel_one.account"), credential);
});

test("Kestrel One sign-out retains credential authority when Browser cleanup fails", async () => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const credential = JSON.stringify({
    baseUrl: "https://kestrel.example/",
    accessToken: "account-access",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "account-refresh",
  });
  await credentialStore.set("kestrel_one.account", credential);
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    fetchImpl: async () => new Response(null, { status: 204 }),
    beforeCredentialReplace: async () => {
      throw new Error("Browser cleanup failed");
    },
  });

  await assert.rejects(manager.signOut(), /Browser cleanup failed/u);
  assert.equal(await credentialStore.get("kestrel_one.account"), credential);
});

test("Kestrel One authorization closes prior account authority before replacing its credential", async (context) => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const priorCredential = JSON.stringify({
    baseUrl: "https://kestrel.example/",
    accessToken: "prior-access",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "prior-refresh",
  });
  await credentialStore.set("kestrel_one.account", priorCredential);
  const order: string[] = [];
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    beforeCredentialReplace: async () => {
      order.push("close-browser-authority");
      assert.equal(
        await credentialStore.get("kestrel_one.account"),
        priorCredential,
      );
    },
    fetchImpl: async (request) => {
      const url = new URL(String(request));
      assert.equal(url.pathname, "/api/desktop/v1/oauth/token");
      order.push("exchange-credential");
      return Response.json({
        token_type: "Bearer",
        access_token: "replacement-access",
        refresh_token: "replacement-refresh",
        expires_in: 900,
      });
    },
  });
  context.after(() => manager.close());
  const authorization = await manager.start({
    baseUrl: "https://kestrel.example/",
  });
  const authorizationUrl = new URL(authorization.authorizationUrl!);
  const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  callback.searchParams.set(
    "state",
    authorizationUrl.searchParams.get("state")!,
  );
  callback.searchParams.set("code", "replacement-code");

  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.deepEqual(order, ["exchange-credential", "close-browser-authority"]);
  assert.match(
    (await credentialStore.get("kestrel_one.account")) ?? "",
    /replacement-refresh/u,
  );
});

test("Kestrel One account replacement blocks Browser admission through credential commit", async (context) => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const priorCredential = JSON.stringify({
    baseUrl: "https://kestrel.example/",
    accessToken: "prior-access",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "prior-refresh",
  });
  await credentialStore.set("kestrel_one.account", priorCredential);
  const criticalSection = new LocalCoreBrowserAuthorityCriticalSection();
  let replacementCommitted!: () => void;
  const committed = new Promise<void>((resolve) => {
    replacementCommitted = resolve;
  });
  let releaseReplacement!: () => void;
  const replacementRelease = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  let authorityClosed = false;
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    beforeCredentialReplace: async () => {
      authorityClosed = true;
    },
    withCredentialReplacement: async (action) =>
      await criticalSection.run(async () => {
        const result = await action();
        replacementCommitted();
        await replacementRelease;
        return result;
      }),
    fetchImpl: async () =>
      Response.json({
        token_type: "Bearer",
        access_token: "replacement-access",
        refresh_token: "replacement-refresh",
        expires_in: 900,
      }),
  });
  context.after(() => manager.close());
  const authorization = await manager.start({
    baseUrl: "https://kestrel.example/",
  });
  const authorizationUrl = new URL(authorization.authorizationUrl!);
  const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  callback.searchParams.set(
    "state",
    authorizationUrl.searchParams.get("state")!,
  );
  callback.searchParams.set("code", "replacement-code");

  const replacement = fetch(callback);
  await committed;
  let admitted = false;
  const admission = criticalSection.run(async () => {
    admitted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorityClosed, true);
  assert.equal(admitted, false);
  assert.match(
    (await credentialStore.get("kestrel_one.account")) ?? "",
    /replacement-refresh/u,
  );

  releaseReplacement();
  assert.equal((await replacement).status, 200);
  await admission;
  assert.equal(admitted, true);
});

test("Kestrel One credential replacement fails closed when Browser cleanup fails", async (context) => {
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const priorCredential = JSON.stringify({
    baseUrl: "https://kestrel.example/",
    accessToken: "prior-access",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "prior-refresh",
  });
  await credentialStore.set("kestrel_one.account", priorCredential);
  const manager = new LocalCoreKestrelOneAccountManager({
    credentialStore,
    beforeCredentialReplace: async () => {
      throw new Error("Browser cleanup failed");
    },
    fetchImpl: async () =>
      Response.json({
        token_type: "Bearer",
        access_token: "replacement-access",
        refresh_token: "replacement-refresh",
        expires_in: 900,
      }),
  });
  context.after(() => manager.close());
  const authorization = await manager.start({
    baseUrl: "https://kestrel.example/",
  });
  const authorizationUrl = new URL(authorization.authorizationUrl!);
  const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
  callback.searchParams.set(
    "state",
    authorizationUrl.searchParams.get("state")!,
  );
  callback.searchParams.set("code", "replacement-code");

  const response = await fetch(callback);
  assert.equal(response.status, 500);
  assert.equal(
    await credentialStore.get("kestrel_one.account"),
    priorCredential,
  );
});

test("Kestrel One account parses the typed Desktop Browser policy projection", async (context) => {
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
      Response.json({
        account: { id: "user-1", name: "Person", email: "person@example.test" },
        organizations: [
          {
            organizationId: "organization-1",
            organizationName: "Organization",
            organizationSlug: "organization",
            organizationRole: "member",
          },
        ],
        projects: [
          {
            id: "project-1",
            organizationId: "organization-1",
            name: "Project",
            environmentId: "environment-1",
            environmentProvider: "desktop",
            desktopWorkspaceRef: "workspace-ref-1",
            role: "owner",
            browserAuthority: {
              environment: {
                version: "browser_environment_domain_authority_v1",
                environmentId: "environment-1",
                revision: "environment-revision-1",
                enabledModes: ["operator"],
                personalGrantsEnabled: true,
                configuredPublicDomains: [],
                blockedPublicDomains: [],
              },
              project: {
                version: "browser_project_domain_authority_v1",
                projectId: "project-1",
                revision: "project-revision-1",
                enabledModes: ["operator"],
                personalGrantsEnabled: true,
                blockedPublicDomains: [],
              },
            },
          },
        ],
        threads: [],
      }),
  });
  context.after(() => manager.close());

  const account = await manager.account();
  assert.equal(account.status, "signed_in");
  if (account.status !== "signed_in") return;
  assert.equal(
    account.projection.projects[0]?.browserAuthority?.project.projectId,
    "project-1",
  );
  assert.equal(
    account.projection.projects[0]?.browserAuthority?.environment.environmentId,
    "environment-1",
  );
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
