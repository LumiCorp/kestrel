import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_LIFECYCLE_EVENT_VERSION,
  MEMORY_QUERY_VERSION,
  MEMORY_READ_BINDING_VERSION,
  MEMORY_RECORD_PROVENANCE_VERSION,
  InMemoryMemoryBackend,
  MemoryGateway,
  createMemoryLifecyclePolicyV1,
  createMemoryTierPolicyV1,
  parseMemoryLifecycleEventV1,
  parseMemoryQueryV1,
  parseMemoryReadBindingV1,
  parseMemoryRecordProvenanceV1,
  parseMemoryTierPolicyV1,
  type MemoryBackendAdapterV1,
  type MemoryReadBindingV1,
  type MemoryReadContextV1,
} from "../../src/index.js";

const NOW = "2026-08-04T12:00:00.000Z";
const POLICY_REVISION = `sha256:${"a".repeat(64)}`;

function createBinding(
  overrides: Partial<MemoryReadBindingV1> = {},
): MemoryReadBindingV1 {
  return parseMemoryReadBindingV1({
    version: MEMORY_READ_BINDING_VERSION,
    bindingId: "binding-1",
    tenantId: "tenant-1",
    userId: "user-1",
    agentId: "agent-1",
    taskId: "task-1",
    policyRevision: POLICY_REVISION,
    permittedNamespaces: ["semantic_knowledge"],
    permittedScopes: [{ kind: "project", tenantId: "tenant-1", projectId: "project-1" }],
    documentAccess: { mode: "exact", documentIds: ["document-1"] },
    issuer: { kind: "trusted_runtime", authorityId: "runtime-1" },
    issuedAt: "2026-08-04T11:00:00.000Z",
    expiresAt: "2026-08-04T13:00:00.000Z",
    ...overrides,
  });
}

function createContext(
  overrides: Partial<MemoryReadContextV1> = {},
): MemoryReadContextV1 {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    agentId: "agent-1",
    taskId: "task-1",
    policyRevision: POLICY_REVISION,
    now: NOW,
    ...overrides,
  };
}

function createQuery(overrides: Record<string, unknown> = {}) {
  return parseMemoryQueryV1({
    version: MEMORY_QUERY_VERSION,
    queryId: "query-1",
    namespace: "semantic_knowledge",
    scope: { kind: "project", tenantId: "tenant-1", projectId: "project-1" },
    text: "release checklist",
    limit: 6,
    documentIds: ["document-1"],
    ...overrides,
  });
}

function createBackend() {
  return new InMemoryMemoryBackend({
    backendId: "memory-test",
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
          scope: { kind: "project", tenantId: "tenant-1", projectId: "project-1" },
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

test("memory tier and lifecycle policies are canonical and keep namespaces distinct", () => {
  const lifecycle = createMemoryLifecyclePolicyV1({
    policyId: "semantic-lifecycle",
    namespace: "semantic_knowledge",
    deletion: {
      mode: "tombstone_then_propagate",
      requiredTargets: ["database_graph", "vector_index", "lexical_index"],
    },
    expiryUsesDeletionLifecycle: true,
    supersessionMode: "append_and_supersede",
    legalHoldSupported: true,
  });
  const policies = [
    ["thread_history", "runtime_event_store"],
    ["working_memory", "runtime_checkpoint"],
    ["semantic_knowledge", "hosted_knowledge_store"],
    ["artifact", "artifact_store"],
  ] as const;
  const tiers = policies.map(([namespace, sourceOfTruth]) =>
    createMemoryTierPolicyV1({
      tierPolicyId: `tier:${namespace}`,
      namespace,
      writerAuthorities: [`writer:${namespace}`],
      readerAuthorities: [`reader:${namespace}`],
      sourceOfTruth,
      retention: { mode: "indefinite" },
      lifecyclePolicyId: lifecycle.policyId,
    }),
  );
  assert.deepEqual(new Set(tiers.map((tier) => tier.namespace)).size, 4);
  assert.deepEqual(parseMemoryTierPolicyV1(tiers[2]), tiers[2]);
  const mutated = { ...tiers[2], readerAuthorities: ["reader:other"] };
  assert.throws(() => parseMemoryTierPolicyV1(mutated), /revision does not match/u);
  assert.throws(
    () => parseMemoryTierPolicyV1({ ...tiers[2], ranking: "dynamic" }),
    /unknown field 'ranking'/u,
  );
});

test("memory provenance requires an exact source or evaluator reference", () => {
  const provenance = parseMemoryRecordProvenanceV1({
    version: MEMORY_RECORD_PROVENANCE_VERSION,
    recordId: "document-1",
    namespace: "semantic_knowledge",
    source: { kind: "document", referenceId: "document-1", revision: "checksum-1" },
    creator: { kind: "user", id: "user-1" },
    createdAt: NOW,
    scope: { kind: "tenant", tenantId: "tenant-1" },
    confidence: {
      kind: "evaluated",
      evaluatorId: "memory-evaluator",
      evaluatorRevision: `sha256:${"b".repeat(64)}`,
      calibrationReference: "calibration-1",
    },
  });
  assert.equal(provenance.confidence.kind, "evaluated");
  assert.throws(
    () => parseMemoryRecordProvenanceV1({ ...provenance, confidence: { kind: "evaluated", score: 0.9 } }),
    /unknown field 'score'/u,
  );
});

test("memory lifecycle events are strict and target propagation acknowledgements", () => {
  const event = parseMemoryLifecycleEventV1({
    version: MEMORY_LIFECYCLE_EVENT_VERSION,
    eventId: "event-1",
    operationId: "operation-1",
    tenantId: "tenant-1",
    recordId: "document-1",
    namespace: "semantic_knowledge",
    type: "propagation_acknowledged",
    policyRevision: POLICY_REVISION,
    actor: { kind: "system", id: "memory-lifecycle" },
    reasonCode: "TARGET_ACKNOWLEDGED",
    target: "vector_index",
    occurredAt: NOW,
  });
  assert.equal(event.target, "vector_index");
  assert.throws(
    () => parseMemoryLifecycleEventV1({ ...event, target: undefined }),
    /require exactly one target/u,
  );
});

test("memory gateway authorizes an exact binding before backend retrieval", async () => {
  const result = await new MemoryGateway().query({
    context: createContext(),
    binding: createBinding(),
    query: createQuery(),
    backend: createBackend(),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.recordId, "document-1");
  assert.equal(result.items[0]?.provenance.confidence.kind, "asserted_source");
});

test("missing, stale, expired, and identity-mismatched bindings fail before backend calls", async () => {
  const gateway = new MemoryGateway();
  const cases: Array<[string, unknown, MemoryReadContextV1]> = [
    ["missing", undefined, createContext()],
    ["stale", createBinding(), createContext({ policyRevision: `sha256:${"c".repeat(64)}` })],
    ["expired", createBinding({ expiresAt: "2026-08-04T11:30:00.000Z" }), createContext()],
    ["tenant", createBinding(), createContext({ tenantId: "tenant-2" })],
    ["user", createBinding(), createContext({ userId: "user-2" })],
    ["agent", createBinding(), createContext({ agentId: "agent-2" })],
    ["task", createBinding(), createContext({ taskId: "task-2" })],
  ];
  for (const [name, binding, context] of cases) {
    let calls = 0;
    const backend = createBackend();
    const guarded: MemoryBackendAdapterV1 = {
      descriptor: backend.descriptor,
      query: async (input) => {
        calls += 1;
        return backend.query(input);
      },
    };
    await assert.rejects(
      gateway.query({ context, binding, query: createQuery(), backend: guarded }),
    );
    assert.equal(calls, 0, name);
  }
});

test("scope and document widening fail before backend calls", async () => {
  const gateway = new MemoryGateway();
  for (const query of [
    createQuery({ scope: { kind: "project", tenantId: "tenant-1", projectId: "project-2" } }),
    createQuery({ documentIds: ["document-2"] }),
    createQuery({ documentIds: undefined }),
  ]) {
    let calls = 0;
    const backend = createBackend();
    await assert.rejects(
      gateway.query({
        context: createContext(),
        binding: createBinding(),
        query,
        backend: {
          descriptor: backend.descriptor,
          query: async (input) => {
            calls += 1;
            return backend.query(input);
          },
        },
      }),
      /widen|exact query document set/u,
    );
    assert.equal(calls, 0);
  }
});
