import assert from "node:assert/strict";
import test from "node:test";
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
