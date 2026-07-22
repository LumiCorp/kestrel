import assert from "node:assert/strict";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { LocalCoreMcpOAuthSessionManager } from "../../src/localCore/mcpOAuthSessions.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "Local Core completes an App OAuth session through a verified loopback callback",
  async () => {
    const credentialStore = new MemoryLocalCoreCredentialStore();
    const manager = new LocalCoreMcpOAuthSessionManager({
      credentialStore,
      authorize: async (provider, options) => {
        if (options.authorizationCode === undefined) {
          await provider.saveCodeVerifier("v".repeat(43));
          const url = new URL("https://auth.example.test/authorize");
          url.searchParams.set("state", String(await provider.state?.()));
          url.searchParams.set("redirect_uri", String(provider.redirectUrl));
          await provider.redirectToAuthorization(url);
          return "REDIRECT";
        }
        assert.equal(options.authorizationCode, "approved-code");
        await provider.saveTokens({
          access_token: "rotated-access-token",
          token_type: "Bearer",
          refresh_token: "rotated-refresh-token",
        });
        return "AUTHORIZED";
      },
    });

    const started = await manager.start({
      credentialPrefix: "mcp.standard.notion",
      serverUrl: "https://mcp.notion.com/mcp",
      appName: "Notion",
    });
    assert.equal(started.state, "awaiting_user");
    const authorizationUrl = new URL(started.authorizationUrl!);
    const callbackUrl = new URL(
      authorizationUrl.searchParams.get("redirect_uri")!,
    );
    callbackUrl.searchParams.set("code", "approved-code");
    callbackUrl.searchParams.set(
      "state",
      authorizationUrl.searchParams.get("state")!,
    );
    const response = await fetch(callbackUrl);

    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      "App connected. You can return to Kestrel.",
    );
    assert.equal(manager.status(started.sessionId)?.state, "complete");
    assert.equal(
      JSON.parse(
        (await credentialStore.get("mcp.standard.notion.oauth.tokens"))!,
      ).access_token,
      "rotated-access-token",
    );
    assert.equal(
      await credentialStore.has("mcp.standard.notion.oauth.verifier"),
      false,
    );
    await manager.close();
  },
);

contractTest(
  "runtime.hermetic",
  "Local Core allows only one active authorization window per App connection",
  async () => {
    const manager = new LocalCoreMcpOAuthSessionManager({
      credentialStore: new MemoryLocalCoreCredentialStore(),
      authorize: async (provider) => {
        await provider.saveCodeVerifier("v".repeat(43));
        await provider.redirectToAuthorization(
          new URL("https://auth.example.test/authorize"),
        );
        return "REDIRECT";
      },
    });
    const input = {
      credentialPrefix: "mcp.standard.notion" as const,
      serverUrl: "https://mcp.notion.com/mcp",
      appName: "Notion",
    };

    await manager.start(input);
    await assert.rejects(
      async () => await manager.start(input),
      /already has a connection window open/u,
    );
    await manager.close();
  },
);

contractTest(
  "runtime.hermetic",
  "Local Core seeds a trusted PKCE public client without storing a client secret",
  async () => {
    const credentialStore = new MemoryLocalCoreCredentialStore();
    const manager = new LocalCoreMcpOAuthSessionManager({
      credentialStore,
      authorize: async (provider, options) => {
        assert.deepEqual(await provider.clientInformation(), {
          client_id: "kestrel-slack-public-client",
          token_endpoint_auth_method: "none",
        });
        assert.equal(options.scope, "search:read.public");
        await provider.redirectToAuthorization(
          new URL("https://slack.com/oauth/v2_user/authorize"),
        );
        return "REDIRECT";
      },
    });

    await manager.start({
      credentialPrefix: "mcp.standard.slack",
      serverUrl: "https://mcp.slack.com/mcp",
      appName: "Slack",
      clientId: "kestrel-slack-public-client",
      scopes: ["search:read.public"],
    });

    const stored = JSON.parse(
      (await credentialStore.get("mcp.standard.slack.oauth.client"))!,
    ) as Record<string, unknown>;
    assert.equal(stored.client_id, "kestrel-slack-public-client");
    assert.equal("client_secret" in stored, false);
    await manager.close();
  },
);

contractTest(
  "runtime.hermetic",
  "Local Core rejects forged App OAuth callback state without exchanging a code",
  async () => {
    let exchanges = 0;
    let capturedProvider: OAuthClientProvider | undefined;
    const manager = new LocalCoreMcpOAuthSessionManager({
      credentialStore: new MemoryLocalCoreCredentialStore(),
      authorize: async (provider, options) => {
        capturedProvider = provider;
        if (options.authorizationCode !== undefined) exchanges += 1;
        const url = new URL("https://auth.example.test/authorize");
        url.searchParams.set("state", String(await provider.state?.()));
        await provider.redirectToAuthorization(url);
        return "REDIRECT";
      },
    });
    const started = await manager.start({
      credentialPrefix: "mcp.standard.notion",
      serverUrl: "https://mcp.notion.com/mcp",
      appName: "Notion",
    });
    const callbackUrl = new URL(String(capturedProvider!.redirectUrl));
    callbackUrl.searchParams.set("code", "forged-code");
    callbackUrl.searchParams.set("state", "forged-state");

    const response = await fetch(callbackUrl);
    assert.equal(response.status, 400);
    assert.equal(exchanges, 0);
    assert.equal(manager.status(started.sessionId)?.state, "awaiting_user");
    await manager.close();
  },
);
