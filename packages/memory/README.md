# `@kestrel-agents/memory`

Governed memory contracts and retrieval helpers for Kestrel agents.

The package provides versioned memory policies, read bindings, queries, result
provenance, authorization-aware retrieval, and an in-memory backend for local
development and tests. Applications can use the contracts directly or place a
`MemoryGateway` in front of a trusted backend adapter.

## Install

```bash
pnpm add @kestrel-agents/memory@0.8.5
npm install @kestrel-agents/memory@0.8.5
```

## Query Authorized Memory

```ts
import {
  InMemoryMemoryBackend,
  MemoryGateway,
  createMemoryTierPolicyV1,
  parseMemoryQueryV1,
} from "@kestrel-agents/memory";

const policy = createMemoryTierPolicyV1({
  tierPolicyId: "semantic-knowledge",
  namespace: "semantic_knowledge",
  writerAuthorities: ["knowledge-ingest"],
  readerAuthorities: ["agent-runtime"],
  sourceOfTruth: "hosted_knowledge_store",
  retention: { mode: "indefinite" },
  lifecyclePolicyId: "semantic-knowledge-lifecycle",
});

const query = parseMemoryQueryV1({
  version: "memory_query_v1",
  queryId: "query-1",
  namespace: "semantic_knowledge",
  scope: { kind: "tenant", tenantId: "acme" },
  text: "deployment policy",
  limit: 10,
});

const backend = new InMemoryMemoryBackend({
  backendId: "local-memory",
  policyRevision: policy.revision,
});

const result = await new MemoryGateway().query({
  context: {
    tenantId: "acme",
    userId: "user-1",
    agentId: "agent-1",
    taskId: "task-1",
    issuerKind: "trusted_runtime",
    issuerAuthorityId: "agent-runtime",
    policyRevision: policy.revision,
    now: "2026-08-04T00:00:00.000Z",
  },
  binding: {
    version: "memory_read_binding_v1",
    bindingId: "binding-1",
    tenantId: "acme",
    userId: "user-1",
    agentId: "agent-1",
    taskId: "task-1",
    policyRevision: policy.revision,
    permittedNamespaces: ["semantic_knowledge"],
    permittedScopes: [{ kind: "tenant", tenantId: "acme" }],
    documentAccess: { mode: "scope" },
    issuer: { kind: "trusted_runtime", authorityId: "agent-runtime" },
    issuedAt: "2026-08-04T00:00:00.000Z",
  },
  query,
  backend,
});
```

`MemoryGateway` validates the binding, query, backend descriptor, and result
before returning data. Do not cast untrusted persisted or network data directly
to a memory contract; parse it at the boundary.

## Development

```bash
pnpm --filter @kestrel-agents/memory build
pnpm --filter @kestrel-agents/memory release:check
```

The package targets Node.js 20 or newer and publishes ESM with TypeScript
declarations.
