import assert from "node:assert/strict";
import {
  assertNoMcpOauthRedirect,
  discoverMcpOauthConfiguration,
  registerMcpOauthClient,
  parseMcpOauthTokenResponse,
} from "./oauth-flow";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const noHeaders: Record<string, string> = {};

contractTest("web.hermetic", "MCP OAuth accepts only explicitly allowed provider token labels", () => {
  assert.equal(
    parseMcpOauthTokenResponse(
      { access_token: "xoxp-token", token_type: "user", scope: "chat:write" },
      ["bearer", "user"]
    ).access_token,
    "xoxp-token"
  );
  assert.throws(
    () =>
      parseMcpOauthTokenResponse(
        { access_token: "opaque", token_type: "mac" },
        ["bearer"]
      ),
    /unsupported token type/u
  );
});

contractTest("web.hermetic", "MCP OAuth follows protected-resource and authorization-server metadata", async () => {
  const requested: string[] = [];
  const discovered = await discoverMcpOauthConfiguration({
    resource: "https://mcp.example.com/mcp",
    request: async (url) => {
      requested.push(url.toString());
      if (url.toString() === "https://mcp.example.com/mcp") {
        return {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/oauth-resource", scope="tools:read prompts:read"',
          },
          body: null,
        };
      }
      if (url.toString() === "https://mcp.example.com/oauth-resource") {
        return {
          status: 200,
          headers: noHeaders,
          body: {
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://auth.example.com/tenant"],
            scopes_supported: ["fallback:scope"],
          },
        };
      }
      assert.equal(
        url.toString(),
        "https://auth.example.com/.well-known/oauth-authorization-server/tenant"
      );
      return {
        status: 200,
        headers: noHeaders,
        body: {
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
        },
      };
    },
  });
  assert.deepEqual(discovered.scopes, ["tools:read", "prompts:read"]);
  assert.deepEqual(discovered.supportedScopes, ["fallback:scope"]);
  assert.equal(
    discovered.authorizationEndpoint.toString(),
    "https://auth.example.com/authorize"
  );
  assert.equal(
    discovered.tokenEndpoint.toString(),
    "https://auth.example.com/token"
  );
  assert.equal(
    discovered.registrationEndpoint?.toString(),
    "https://auth.example.com/register"
  );
  assert.equal(requested.length, 3);
});

contractTest("web.hermetic", "MCP OAuth registers a bounded public client for one callback", async () => {
  let registrationBody: unknown;
  const registered = await registerMcpOauthClient({
    registrationEndpoint: new URL("https://auth.example.com/register"),
    redirectUri: "https://kestrel.example/api/apps/notion/oauth/callback",
    clientName: "Notion for Kestrel",
    scopes: ["tools:read", "tools:write"],
    request: async (url, init) => {
      assert.equal(url.toString(), "https://auth.example.com/register");
      assert.equal(init?.method, "POST");
      registrationBody = JSON.parse(String(init?.body));
      return {
        status: 201,
        headers: noHeaders,
        body: {
          client_id: "dynamic-client-id",
          token_endpoint_auth_method: "none",
        },
      };
    },
  });
  assert.deepEqual(registrationBody, {
    client_name: "Notion for Kestrel",
    redirect_uris: [
      "https://kestrel.example/api/apps/notion/oauth/callback",
    ],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "tools:read tools:write",
  });
  assert.deepEqual(registered, {
    clientId: "dynamic-client-id",
    clientSecret: undefined,
    tokenEndpointAuthMethod: "none",
  });
});

contractTest("web.hermetic", "MCP OAuth refuses implicit client registration support", async () => {
  await assert.rejects(
    registerMcpOauthClient({
      registrationEndpoint: null,
      redirectUri: "https://kestrel.example/callback",
      clientName: "Kestrel",
    }),
    /does not support client registration/u
  );
});

contractTest("web.hermetic", "MCP OAuth falls back through well-known and OIDC discovery and requires PKCE", async () => {
  const discovered = await discoverMcpOauthConfiguration({
    resource: "https://mcp.example.com/public/mcp",
    request: async (url) => {
      const value = url.toString();
      if (value === "https://mcp.example.com/public/mcp") {
        return { status: 405, headers: noHeaders, body: null };
      }
      if (
        value ===
        "https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp"
      ) {
        return { status: 404, headers: noHeaders, body: null };
      }
      if (
        value === "https://mcp.example.com/.well-known/oauth-protected-resource"
      ) {
        return {
          status: 200,
          headers: noHeaders,
          body: {
            resource: "https://mcp.example.com/public/mcp",
            authorization_servers: ["https://auth.example.com"],
            scopes_supported: ["mcp:basic"],
          },
        };
      }
      if (
        value ===
        "https://auth.example.com/.well-known/oauth-authorization-server"
      ) {
        return { status: 404, headers: noHeaders, body: null };
      }
      assert.equal(
        value,
        "https://auth.example.com/.well-known/openid-configuration"
      );
      return {
        status: 200,
        headers: noHeaders,
        body: {
          issuer: "https://auth.example.com/",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          code_challenge_methods_supported: ["S256"],
        },
      };
    },
  });
  assert.deepEqual(discovered.scopes, ["mcp:basic"]);

  await assert.rejects(
    discoverMcpOauthConfiguration({
      resource: "https://mcp.example.com/mcp",
      request: async (url) =>
        url.hostname === "mcp.example.com" && url.pathname === "/mcp"
          ? { status: 401, headers: noHeaders, body: null }
          : url.hostname === "mcp.example.com"
            ? {
                status: 200,
                headers: noHeaders,
                body: {
                  resource: "https://mcp.example.com/mcp",
                  authorization_servers: ["https://auth.example.com"],
                },
              }
            : {
                status: 200,
                headers: noHeaders,
                body: {
                  issuer: "https://auth.example.com/",
                  authorization_endpoint: "https://auth.example.com/authorize",
                  token_endpoint: "https://auth.example.com/token",
                  code_challenge_methods_supported: ["plain"],
                },
              },
    }),
    /PKCE S256/u
  );
});

contractTest("web.hermetic", "MCP OAuth cancels redirect bodies before rejecting them", async () => {
  const events: string[] = [];
  const response = new Response(
    new ReadableStream({
      cancel() {
        events.push("cancelled");
      },
    }),
    { status: 302, headers: { location: "https://other.example/mcp" } }
  );
  await assert.rejects(
    assertNoMcpOauthRedirect(response),
    /redirects are not allowed/u
  );
  assert.deepEqual(events, ["cancelled"]);
});
