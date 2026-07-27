import assert from "node:assert/strict";

import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { LocalCoreKestrelOneAccountManager } from "../../src/localCore/kestrelOneAccount.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "Kestrel One account requests coalesce rotating credential refreshes",
  async (context) => {
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
  },
);
