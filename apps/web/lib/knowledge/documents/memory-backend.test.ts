import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_QUERY_VERSION,
  MEMORY_READ_BINDING_VERSION,
  MEMORY_RECORD_PROVENANCE_VERSION,
  InMemoryMemoryBackend,
  MemoryGateway,
  parseMemoryReadBindingV1,
  type MemoryBackendAdapterV1,
} from "@kestrel-agents/kestrel";
import { HostedKnowledgeMemoryBackend } from "./retrieval";

const POLICY_REVISION = `sha256:${"a".repeat(64)}`;
const SCOPE = {
  kind: "project" as const,
  tenantId: "org-1",
  projectId: "project-1",
};

const binding = parseMemoryReadBindingV1({
  version: MEMORY_READ_BINDING_VERSION,
  bindingId: "binding-1",
  tenantId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  taskId: "task-1",
  policyRevision: POLICY_REVISION,
  permittedNamespaces: ["semantic_knowledge"],
  permittedScopes: [SCOPE],
  documentAccess: { mode: "exact", documentIds: ["document-1"] },
  issuer: { kind: "trusted_runtime", authorityId: "runtime-1" },
  issuedAt: "2026-08-04T11:00:00.000Z",
  expiresAt: "2026-08-04T13:00:00.000Z",
});

const context = {
  tenantId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  taskId: "task-1",
  issuerKind: "trusted_runtime" as const,
  issuerAuthorityId: "runtime-1",
  policyRevision: POLICY_REVISION,
  now: "2026-08-04T12:00:00.000Z",
};

const query = {
  version: MEMORY_QUERY_VERSION,
  queryId: "query-1",
  namespace: "semantic_knowledge" as const,
  scope: SCOPE,
  text: "release checklist",
  limit: 6,
  documentIds: ["document-1"],
};

const semanticRuntime = {
  provider: "openrouter",
  apiKey: "openrouter-key",
  baseURL: "https://openrouter.ai/api/v1",
  model: "openai/text-embedding-3-small",
  headers: {},
  mode: "live" as const,
  surface: "embedding" as const,
  usesPlaceholderKey: false,
  retrievalStrategy: "semantic-first" as const,
  provenance: {
    mode: "semantic" as const,
    provider: "openrouter",
    model: "openai/text-embedding-3-small",
    dimensions: 1536 as const,
  },
};

function createInMemoryBackend(): MemoryBackendAdapterV1 {
  return new InMemoryMemoryBackend({
    backendId: "memory-conformance",
    policyRevision: POLICY_REVISION,
    records: [
      {
        provenance: {
          version: MEMORY_RECORD_PROVENANCE_VERSION,
          recordId: "document-1",
          namespace: "semantic_knowledge",
          source: {
            kind: "document",
            referenceId: "document-1",
            revision: "checksum-1",
          },
          creator: { kind: "user", id: "user-1" },
          createdAt: "2026-08-03T12:00:00.000Z",
          scope: SCOPE,
          confidence: {
            kind: "asserted_source",
            sourceReferenceId: "document-1",
          },
        },
        filename: "release.md",
        mediaType: "text/markdown",
        segments: [
          {
            segmentId: "document-1:0",
            text: "The release checklist requires a signed manifest.",
            label: "Release checklist",
            url: "/api/knowledge/documents/document-1/download",
          },
        ],
      },
    ],
  });
}

function createHostedBackend(): MemoryBackendAdapterV1 {
  return new HostedKnowledgeMemoryBackend({
    policyRevision: POLICY_REVISION,
    dependencies: {
      embeddingRuntime: semanticRuntime,
      embedQuery: async () => [1, 0],
      searchVector: async () => [
        {
          documentId: "document-1",
          filename: "release.md",
          title: "Release checklist",
          mediaType: "text/markdown",
          chunkText: "The release checklist requires a signed manifest.",
          chunkIndex: 0,
          pageNumber: null,
          sectionTitle: "Manifest",
          score: 0.95,
          projectId: "project-1",
          uploaderUserId: "user-1",
          createdAt: "2026-08-03T12:00:00.000Z",
          checksumSha256: "checksum-1",
        },
      ],
      searchLexical: async () => {
        throw new Error("semantic result should not fall back");
      },
    },
  });
}

for (const [name, createBackend] of [
  ["hosted Drizzle/pgvector", createHostedBackend],
  ["in-memory", createInMemoryBackend],
] as const) {
  test(`${name} memory backend passes the query/result conformance contract`, async () => {
    const result = await new MemoryGateway().query({
      context,
      binding,
      query,
      backend: createBackend(),
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.recordId, "document-1");
    assert.equal(result.items[0]?.provenance.scope.kind, "project");
    assert.equal(result.items[0]?.provenance.confidence.kind, "asserted_source");
    assert.match(result.items[0]?.segments[0]?.text ?? "", /signed manifest/u);
  });
}
