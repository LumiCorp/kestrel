import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKestrelOneCapabilityDescriptors,
  parseRunnerKnowledgeCapabilityRequest,
} from "@/lib/agent/kestrel-capabilities";

test("buildKestrelOneCapabilityDescriptors exposes knowledge search without secrets", () => {
  const [capability] = buildKestrelOneCapabilityDescriptors({
    request: new Request("https://app.example.test/api/chats/chat_123"),
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
