import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { authorizeMcpRequest, isAllowedOrigin } from "../src/authorization.js";
import type { AuthorizedMcpGrant, McpGrantStore } from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const now = new Date("2026-07-13T12:00:00.000Z");
const grant: AuthorizedMcpGrant = {
  id: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
  runExecutionId: "run-1",
  workspaceId: "workspace-1",
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
  policyDigest: "sha256:policy",
  expiresAt: new Date(now.getTime() + 300_000),
  capabilities: [],
  servers: [],
};

contractTest("services.hermetic", "MCP request authorization binds the grant to the signed run identity", async () => {
  const seen: Parameters<McpGrantStore["activateGrant"]>[0][] = [];
  const grantStore: McpGrantStore = {
    async activateGrant(input) {
      seen.push(input);
      return grant;
    },
  };
  const decision = await authorizeMcpRequest({
    headers: {
      authorization: `Bearer ${ticket()}`,
      "x-kestrel-mcp-grant-id": grant.id,
    },
    publicKey: publicKeyPem,
    grantStore,
    now,
  });
  assert.equal(decision.ok, true);
  assert.deepEqual(seen[0], {
    grantId: grant.id,
    runExecutionId: "run-1",
    organizationId: "org-1",
    environmentId: "env-1",
    threadId: "thread-1",
    now,
  });
});

contractTest("services.hermetic", "MCP request authorization rejects missing, invalid, and unknown grants", async () => {
  const grantStore: McpGrantStore = {
    async activateGrant() {
      return null;
    },
  };
  assert.deepEqual(
    await authorizeMcpRequest({
      headers: {},
      publicKey: publicKeyPem,
      grantStore,
      now,
    }),
    { ok: false, status: 401, code: "MCP_AUTH_REQUIRED" }
  );
  assert.deepEqual(
    await authorizeMcpRequest({
      headers: {
        authorization: `Bearer ${ticket()}`,
        "x-kestrel-mcp-grant-id": grant.id,
      },
      publicKey: publicKeyPem,
      grantStore,
      now,
    }),
    { ok: false, status: 403, code: "MCP_GRANT_INVALID" }
  );
});

contractTest("services.hermetic", "Origin validation is default-deny when browsers send an Origin", () => {
  assert.equal(
    isAllowedOrigin({ origin: undefined, allowedOrigins: new Set() }),
    true
  );
  assert.equal(
    isAllowedOrigin({
      origin: "https://kestrel.example",
      allowedOrigins: new Set(),
    }),
    false
  );
  assert.equal(
    isAllowedOrigin({
      origin: "https://kestrel.example/path",
      allowedOrigins: new Set(["https://kestrel.example"]),
    }),
    true
  );
});

function ticket(): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return signEnvironmentExecutionTicket({
    privateKey: privateKeyPem,
    ticket: {
      version: 1,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: "org-1",
      environmentId: "env-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      agentId: "agent-1",
      flyAppName: "app-1",
      flyMachineId: "machine-1",
      capabilities: ["run.stream"],
      issuedAt,
      expiresAt: issuedAt + 300,
      nonce: "nonce-1",
    },
  });
}
