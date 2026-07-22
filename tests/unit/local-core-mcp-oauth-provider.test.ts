import assert from "node:assert/strict";

import {
  LocalCoreMcpOAuthProvider,
  parseOAuthCredentialPrefix,
} from "../../src/localCore/mcpOAuthProvider.js";
import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { contractTest } from "../helpers/contract-test.js";

const clientMetadata = {
  client_name: "Kestrel Desktop",
  redirect_uris: ["http://127.0.0.1:43177/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

contractTest(
  "runtime.hermetic",
  "Local Core persists and rotates App OAuth state in scoped credential records",
  async () => {
    const credentialStore = new MemoryLocalCoreCredentialStore();
    const redirected: string[] = [];
    const provider = new LocalCoreMcpOAuthProvider({
      credentialStore,
      credentialPrefix: "mcp.standard.notion",
      redirectUrl: "http://127.0.0.1:43177/oauth/callback",
      clientMetadata,
      authorizationState: "state-1",
      onAuthorization: (url) => {
        redirected.push(url.toString());
      },
    });

    await provider.saveClientInformation({ client_id: "registered-client" });
    await provider.saveCodeVerifier("a".repeat(43));
    await provider.saveTokens({
      access_token: "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
      expires_in: 300,
    });
    await provider.saveTokens({
      access_token: "access-2",
      token_type: "Bearer",
      refresh_token: "refresh-2",
      expires_in: 300,
    });
    await provider.redirectToAuthorization(
      new URL("https://auth.example.test/authorize"),
    );

    assert.equal(provider.state(), "state-1");
    assert.equal(await provider.codeVerifier(), "a".repeat(43));
    assert.deepEqual(await provider.clientInformation(), {
      client_id: "registered-client",
    });
    assert.equal((await provider.tokens())?.access_token, "access-2");
    assert.deepEqual(redirected, ["https://auth.example.test/authorize"]);
    assert.equal(
      await credentialStore.has("mcp.standard.notion.oauth.tokens"),
      true,
    );
    assert.equal(
      await credentialStore.has("mcp.standard.notion.oauth.client"),
      true,
    );
  },
);

contractTest(
  "runtime.hermetic",
  "Local Core OAuth invalidation removes only the requested App credential scope",
  async () => {
    const credentialStore = new MemoryLocalCoreCredentialStore();
    const provider = new LocalCoreMcpOAuthProvider({
      credentialStore,
      credentialPrefix: "mcp.standard.notion",
      redirectUrl: "http://localhost:43177/oauth/callback",
      clientMetadata,
      onAuthorization() {},
    });
    await provider.saveClientInformation({ client_id: "registered-client" });
    await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
    await provider.saveCodeVerifier("b".repeat(43));

    await provider.invalidateCredentials("tokens");
    assert.equal(await provider.tokens(), undefined);
    assert.deepEqual(await provider.clientInformation(), {
      client_id: "registered-client",
    });
    assert.equal(await provider.codeVerifier(), "b".repeat(43));

    await provider.invalidateCredentials("all");
    assert.equal(await provider.clientInformation(), undefined);
    await assert.rejects(
      provider.codeVerifier(),
      /No valid App authorization verifier/u,
    );
  },
);

contractTest(
  "runtime.hermetic",
  "Local Core OAuth storage fails closed without reflecting corrupt credential content",
  async () => {
    const credentialStore = new MemoryLocalCoreCredentialStore();
    await credentialStore.set(
      "mcp.standard.notion.oauth.tokens",
      JSON.stringify({ access_token: "secret-value" }),
    );
    const provider = new LocalCoreMcpOAuthProvider({
      credentialStore,
      credentialPrefix: "mcp.standard.notion",
      redirectUrl: "http://127.0.0.1:43177/oauth/callback",
      clientMetadata,
      onAuthorization() {},
    });

    await assert.rejects(provider.tokens(), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(
        (error as Error).message,
        "Stored App authorization tokens is invalid.",
      );
      assert.doesNotMatch((error as Error).message, /secret-value/u);
      return true;
    });
  },
);

contractTest(
  "runtime.hermetic",
  "Local Core OAuth accepts only scoped credential prefixes and loopback callbacks",
  () => {
    assert.equal(
      parseOAuthCredentialPrefix("mcp.standard.slack"),
      "mcp.standard.slack",
    );
    assert.throws(
      () => parseOAuthCredentialPrefix("provider.openai.default"),
      /prefix is invalid/u,
    );
    assert.throws(
      () =>
        new LocalCoreMcpOAuthProvider({
          credentialStore: new MemoryLocalCoreCredentialStore(),
          credentialPrefix: "mcp.standard.slack",
          redirectUrl: "https://desktop.example.test/callback",
          clientMetadata,
          onAuthorization() {},
        }),
      /loopback HTTP URL/u,
    );
  },
);
