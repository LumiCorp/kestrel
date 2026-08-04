import {
  MEMORY_READ_BINDING_VERSION,
  createMemoryLifecyclePolicyV1,
  createMemoryTierPolicyV1,
  parseMemoryReadBindingV1,
  type MemoryDocumentAccessV1,
  type MemoryReadBindingV1,
  type MemoryReadContextV1,
  type MemoryScopeV1,
} from "@kestrel-agents/memory";

export const HOSTED_KNOWLEDGE_LIFECYCLE_POLICY =
  createMemoryLifecyclePolicyV1({
    policyId: "kestrel-one:semantic-knowledge:lifecycle",
    namespace: "semantic_knowledge",
    deletion: {
      mode: "tombstone_then_propagate",
      requiredTargets: [
        "object_store",
        "database_graph",
        "vector_index",
        "lexical_index",
        "cache",
      ],
    },
    expiryUsesDeletionLifecycle: true,
    supersessionMode: "append_and_supersede",
    legalHoldSupported: true,
  });

export const HOSTED_KNOWLEDGE_TIER_POLICY = createMemoryTierPolicyV1({
  tierPolicyId: "kestrel-one:semantic-knowledge",
  namespace: "semantic_knowledge",
  writerAuthorities: ["kestrel-one:knowledge-ingestion"],
  readerAuthorities: [
    "kestrel-one:hosted-session",
    "kestrel-one:runtime-capability",
  ],
  sourceOfTruth: "hosted_knowledge_store",
  retention: { mode: "indefinite" },
  lifecyclePolicyId: HOSTED_KNOWLEDGE_LIFECYCLE_POLICY.policyId,
});

export function createHostedKnowledgeReadAuthority(input: {
  tenantId: string;
  userId: string;
  agentId: string;
  taskId: string;
  scope: MemoryScopeV1;
  documentAccess: MemoryDocumentAccessV1;
  issuer: MemoryReadBindingV1["issuer"];
  now?: Date;
  expiresAt?: Date | undefined;
}): {
  binding: MemoryReadBindingV1;
  context: MemoryReadContextV1;
} {
  const now = input.now ?? new Date();
  const issuedAt = now.toISOString();
  const binding = parseMemoryReadBindingV1({
    version: MEMORY_READ_BINDING_VERSION,
    bindingId: crypto.randomUUID(),
    tenantId: input.tenantId,
    userId: input.userId,
    agentId: input.agentId,
    taskId: input.taskId,
    policyRevision: HOSTED_KNOWLEDGE_TIER_POLICY.revision,
    permittedNamespaces: ["semantic_knowledge"],
    permittedScopes: [input.scope],
    documentAccess: input.documentAccess,
    issuer: input.issuer,
    issuedAt,
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: input.expiresAt.toISOString() }),
  });
  return {
    binding,
    context: {
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      taskId: input.taskId,
      issuerKind: input.issuer.kind,
      issuerAuthorityId: input.issuer.authorityId,
      policyRevision: HOSTED_KNOWLEDGE_TIER_POLICY.revision,
      now: issuedAt,
    },
  };
}
