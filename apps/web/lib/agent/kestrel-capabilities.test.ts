import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import {
  buildKestrelOneCapabilityDescriptors,
  parseRunnerKnowledgeCapabilityRequest,
} from "@/lib/agent/kestrel-capabilities";

test("buildKestrelOneCapabilityDescriptors exposes knowledge search without secrets", () => {
  const [capability] = buildKestrelOneCapabilityDescriptors({
    request: new Request("https://app.example.test/api/threads/threads_123"),
  });

  assert.equal(capability?.name, "kestrel_one.search_knowledge_documents");
  assert.equal(
    capability?.endpoint.url,
    "https://app.example.test/api/kestrel/tools/search-knowledge-documents"
  );
  assert.deepEqual(capability?.endpoint.auth, {
    type: "bearer",
    tokenEnv: "KESTREL_ONE_TOOL_TOKEN",
  });
  assert.equal(JSON.stringify(capability).includes("secret-token"), false);
});

test("parseRunnerKnowledgeCapabilityRequest accepts runner bearer auth and tenant", () => {
  const result = parseRunnerKnowledgeCapabilityRequest({
    expectedToken: "secret-token",
    request: new Request("https://app.example.test/api/kestrel/tools/search", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "x-kestrel-tenant-id": "org_123",
      },
    }),
  });

  assert.deepEqual(result, {
    organizationId: "org_123",
  });
});

test("parseRunnerKnowledgeCapabilityRequest accepts only UUID context grants", () => {
  const contextGrantId = "3f33e85c-a682-4d54-a628-b970d4983f1d";
  const result = parseRunnerKnowledgeCapabilityRequest({
    expectedToken: "secret-token",
    request: new Request("https://app.example.test/api/kestrel/tools/search", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "x-kestrel-tenant-id": "org_123",
        "x-kestrel-project-context-grant": contextGrantId,
      },
    }),
  });

  assert.deepEqual(result, {
    organizationId: "org_123",
    contextGrantId,
  });

  assert.throws(() =>
    parseRunnerKnowledgeCapabilityRequest({
      expectedToken: "secret-token",
      request: new Request(
        "https://app.example.test/api/kestrel/tools/search",
        {
          method: "POST",
          headers: {
            authorization: "Bearer secret-token",
            "x-kestrel-tenant-id": "org_123",
            "x-kestrel-project-context-grant": "forged-grant",
          },
        }
      ),
    })
  );
});

test("parseRunnerKnowledgeCapabilityRequest accepts a tenant-bound Environment ticket", () => {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const now = Math.floor(Date.now() / 1000);
  const token = signEnvironmentExecutionTicket({
    privateKey,
    ticket: {
      version: 1,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: "org_123",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      agentId: "kestrel-one",
      flyAppName: "app-1",
      flyMachineId: "machine-1",
      capabilities: ["knowledge.search"],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: "nonce-1",
    },
  });
  const request = new Request(
    "https://app.example.test/api/kestrel/tools/search",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-kestrel-tenant-id": "org_123",
      },
    }
  );
  assert.deepEqual(
    parseRunnerKnowledgeCapabilityRequest({
      expectedToken: undefined,
      environmentTicketPublicKey: publicKey,
      request,
    }),
    { organizationId: "org_123" }
  );
  assert.throws(() =>
    parseRunnerKnowledgeCapabilityRequest({
      expectedToken: undefined,
      environmentTicketPublicKey: publicKey,
      request: new Request(request, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-kestrel-tenant-id": "org_other",
        },
      }),
    })
  );
});

test("parseRunnerKnowledgeCapabilityRequest rejects missing or invalid token", () => {
  assert.throws(
    () =>
      parseRunnerKnowledgeCapabilityRequest({
        expectedToken: undefined,
        request: new Request(
          "https://app.example.test/api/kestrel/tools/search",
          {
            method: "POST",
            headers: {
              authorization: "Bearer secret-token",
              "x-kestrel-tenant-id": "org_123",
            },
          }
        ),
      }),
    /Unauthorized/
  );

  assert.throws(
    () =>
      parseRunnerKnowledgeCapabilityRequest({
        expectedToken: "secret-token",
        request: new Request(
          "https://app.example.test/api/kestrel/tools/search",
          {
            method: "POST",
            headers: {
              authorization: "Bearer wrong-token",
              "x-kestrel-tenant-id": "org_123",
            },
          }
        ),
      }),
    /Unauthorized/
  );
});
