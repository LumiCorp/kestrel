import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoMcpOauthRedirect,
  discoverMcpOauthConfiguration,
} from "./oauth-flow";

const noHeaders: Record<string, string> = {};

test("MCP OAuth follows protected-resource and authorization-server metadata", async () => {
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
          code_challenge_methods_supported: ["S256"],
        },
      };
    },
  });
  assert.deepEqual(discovered.scopes, ["tools:read", "prompts:read"]);
  assert.equal(
    discovered.authorizationEndpoint.toString(),
    "https://auth.example.com/authorize"
  );
  assert.equal(
    discovered.tokenEndpoint.toString(),
    "https://auth.example.com/token"
  );
  assert.equal(requested.length, 3);
});

test("MCP OAuth falls back through well-known and OIDC discovery and requires PKCE", async () => {
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

test("MCP OAuth cancels redirect bodies before rejecting them", async () => {
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
