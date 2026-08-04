import { hashCanonical } from "./tool-contract.js";

export const MEMORY_TIER_POLICY_VERSION = "memory_tier_policy_v1" as const;
export const MEMORY_LIFECYCLE_POLICY_VERSION =
  "memory_lifecycle_policy_v1" as const;
export const MEMORY_READ_BINDING_VERSION = "memory_read_binding_v1" as const;
export const MEMORY_QUERY_VERSION = "memory_query_v1" as const;
export const MEMORY_RECORD_PROVENANCE_VERSION =
  "memory_record_provenance_v1" as const;
export const MEMORY_QUERY_RESULT_VERSION = "memory_query_result_v1" as const;
export const MEMORY_BACKEND_VERSION = "memory_backend_v1" as const;
export const MEMORY_LIFECYCLE_EVENT_VERSION =
  "memory_lifecycle_event_v1" as const;

export const MEMORY_NAMESPACES_V1 = [
  "thread_history",
  "working_memory",
  "semantic_knowledge",
  "artifact",
] as const;

export type MemoryNamespaceV1 = (typeof MEMORY_NAMESPACES_V1)[number];
export type MemoryRetrievalStrategyV1 = "vector" | "lexical";

export type MemoryScopeV1 =
  | { kind: "tenant"; tenantId: string }
  | { kind: "project"; tenantId: string; projectId: string }
  | { kind: "thread"; tenantId: string; threadId: string }
  | { kind: "task"; tenantId: string; taskId: string };

export type MemoryRetentionV1 =
  | { mode: "session" }
  | { mode: "ttl"; ttlMs: number }
  | { mode: "indefinite" };

export interface MemoryTierPolicyV1 {
  version: typeof MEMORY_TIER_POLICY_VERSION;
  tierPolicyId: string;
  revision: string;
  namespace: MemoryNamespaceV1;
  writerAuthorities: string[];
  readerAuthorities: string[];
  sourceOfTruth:
    | "runtime_event_store"
    | "runtime_checkpoint"
    | "hosted_knowledge_store"
    | "artifact_store";
  retention: MemoryRetentionV1;
  lifecyclePolicyId: string;
}

export interface MemoryLifecyclePolicyV1 {
  version: typeof MEMORY_LIFECYCLE_POLICY_VERSION;
  policyId: string;
  revision: string;
  namespace: MemoryNamespaceV1;
  deletion: {
    mode: "tombstone_then_propagate";
    requiredTargets: Array<"object_store" | "database_graph" | "vector_index" | "lexical_index" | "cache">;
  };
  expiryUsesDeletionLifecycle: boolean;
  supersessionMode: "append_and_supersede";
  legalHoldSupported: boolean;
}

export type MemoryDocumentAccessV1 =
  | { mode: "scope" }
  | { mode: "exact"; documentIds: string[] };

export interface MemoryReadBindingV1 {
  version: typeof MEMORY_READ_BINDING_VERSION;
  bindingId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  taskId: string;
  policyRevision: string;
  permittedNamespaces: MemoryNamespaceV1[];
  permittedScopes: MemoryScopeV1[];
  documentAccess: MemoryDocumentAccessV1;
  issuer: {
    kind: "trusted_runtime" | "trusted_hosted";
    authorityId: string;
  };
  issuedAt: string;
  expiresAt?: string | undefined;
}

export interface MemoryQueryV1 {
  version: typeof MEMORY_QUERY_VERSION;
  queryId: string;
  namespace: MemoryNamespaceV1;
  scope: MemoryScopeV1;
  text: string;
  limit: number;
  documentIds?: string[] | undefined;
  minimumMatchScore?: number | undefined;
}

export type MemoryConfidenceProvenanceV1 =
  | {
      kind: "asserted_source";
      sourceReferenceId: string;
    }
  | {
      kind: "evaluated";
      evaluatorId: string;
      evaluatorRevision: string;
      calibrationReference: string;
    };

export interface MemoryRecordProvenanceV1 {
  version: typeof MEMORY_RECORD_PROVENANCE_VERSION;
  recordId: string;
  namespace: MemoryNamespaceV1;
  source: {
    kind: "document" | "runtime_event" | "artifact" | "operator";
    referenceId: string;
    revision: string;
  };
  creator: {
    kind: "user" | "agent" | "system" | "import";
    id: string;
  };
  createdAt: string;
  scope: MemoryScopeV1;
  confidence: MemoryConfidenceProvenanceV1;
  supersedesRecordId?: string | undefined;
}

export interface MemoryResultSegmentV1 {
  segmentId: string;
  text: string;
  location: {
    label: string;
    url: string;
    pageNumber?: number | undefined;
    sectionTitle?: string | undefined;
  };
  matchEvidence: {
    strategy: MemoryRetrievalStrategyV1;
    score: number;
  };
}

export interface MemoryQueryResultItemV1 {
  recordId: string;
  provenance: MemoryRecordProvenanceV1;
  segments: MemoryResultSegmentV1[];
  sourceMetadata: {
    filename: string;
    title?: string | undefined;
    mediaType: string;
    excerptCount: number;
  };
}

export interface MemoryQueryResultV1 {
  version: typeof MEMORY_QUERY_RESULT_VERSION;
  queryId: string;
  bindingId: string;
  backendId: string;
  policyRevision: string;
  items: MemoryQueryResultItemV1[];
}

export interface MemoryBackendV1 {
  version: typeof MEMORY_BACKEND_VERSION;
  backendId: string;
  policyRevision: string;
  namespace: MemoryNamespaceV1;
  sourceOfTruth:
    | "runtime_event_store"
    | "runtime_checkpoint"
    | "hosted_knowledge_store"
    | "artifact_store";
  strategies: MemoryRetrievalStrategyV1[];
}

export interface MemoryLifecycleEventV1 {
  version: typeof MEMORY_LIFECYCLE_EVENT_VERSION;
  eventId: string;
  operationId: string;
  tenantId: string;
  recordId: string;
  namespace: MemoryNamespaceV1;
  type:
    | "tombstoned"
    | "propagation_acknowledged"
    | "deletion_completed"
    | "expired"
    | "superseded"
    | "legal_hold_applied"
    | "legal_hold_released"
    | "legal_hold_overridden";
  policyRevision: string;
  actor: {
    kind: "user" | "agent" | "system";
    id: string;
  };
  reasonCode: string;
  target?: "object_store" | "database_graph" | "vector_index" | "lexical_index" | "cache" | undefined;
  occurredAt: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const URI_PATH_PATTERN = /^(?:https?:\/\/|\/)[^\s]+$/u;
export function parseMemoryTierPolicyV1(value: unknown): MemoryTierPolicyV1 {
  const record = parseObject(value, "Memory tier policy", [
    "version", "tierPolicyId", "revision", "namespace", "writerAuthorities",
    "readerAuthorities", "sourceOfTruth", "retention", "lifecyclePolicyId",
  ]);
  requireVersion(record.version, MEMORY_TIER_POLICY_VERSION, "Memory tier policy");
  const parsed: MemoryTierPolicyV1 = {
    version: MEMORY_TIER_POLICY_VERSION,
    tierPolicyId: parseId(record.tierPolicyId, "tierPolicyId"),
    revision: parseHash(record.revision, "Memory tier policy revision"),
    namespace: parseNamespace(record.namespace),
    writerAuthorities: parseUniqueIds(record.writerAuthorities, "writerAuthorities"),
    readerAuthorities: parseUniqueIds(record.readerAuthorities, "readerAuthorities"),
    sourceOfTruth: parseEnum(record.sourceOfTruth, [
      "runtime_event_store", "runtime_checkpoint", "hosted_knowledge_store", "artifact_store",
    ], "Memory tier policy sourceOfTruth"),
    retention: parseRetention(record.retention),
    lifecyclePolicyId: parseId(record.lifecyclePolicyId, "lifecyclePolicyId"),
  };
  requireMatchingRevision(parsed, "revision", "Memory tier policy");
  return parsed;
}

export function createMemoryTierPolicyV1(
  input: Omit<MemoryTierPolicyV1, "version" | "revision">,
): MemoryTierPolicyV1 {
  const draft = {
    version: MEMORY_TIER_POLICY_VERSION,
    ...structuredClone(input),
    revision: "sha256:" + "0".repeat(64),
  } satisfies MemoryTierPolicyV1;
  draft.revision = fingerprintWithoutRevision(draft);
  return parseMemoryTierPolicyV1(draft);
}

export function parseMemoryLifecyclePolicyV1(value: unknown): MemoryLifecyclePolicyV1 {
  const record = parseObject(value, "Memory lifecycle policy", [
    "version", "policyId", "revision", "namespace", "deletion",
    "expiryUsesDeletionLifecycle", "supersessionMode", "legalHoldSupported",
  ]);
  requireVersion(record.version, MEMORY_LIFECYCLE_POLICY_VERSION, "Memory lifecycle policy");
  const deletion = parseObject(record.deletion, "Memory lifecycle policy deletion", ["mode", "requiredTargets"]);
  const parsed: MemoryLifecyclePolicyV1 = {
    version: MEMORY_LIFECYCLE_POLICY_VERSION,
    policyId: parseId(record.policyId, "policyId"),
    revision: parseHash(record.revision, "Memory lifecycle policy revision"),
    namespace: parseNamespace(record.namespace),
    deletion: {
      mode: parseLiteral(deletion.mode, "tombstone_then_propagate", "Memory lifecycle deletion mode"),
      requiredTargets: parseUniqueEnums(deletion.requiredTargets, [
        "object_store", "database_graph", "vector_index", "lexical_index", "cache",
      ], "Memory lifecycle deletion targets"),
    },
    expiryUsesDeletionLifecycle: parseBoolean(record.expiryUsesDeletionLifecycle, "expiryUsesDeletionLifecycle"),
    supersessionMode: parseLiteral(record.supersessionMode, "append_and_supersede", "Memory supersession mode"),
    legalHoldSupported: parseBoolean(record.legalHoldSupported, "legalHoldSupported"),
  };
  requireMatchingRevision(parsed, "revision", "Memory lifecycle policy");
  return parsed;
}

export function createMemoryLifecyclePolicyV1(
  input: Omit<MemoryLifecyclePolicyV1, "version" | "revision">,
): MemoryLifecyclePolicyV1 {
  const draft = {
    version: MEMORY_LIFECYCLE_POLICY_VERSION,
    ...structuredClone(input),
    revision: "sha256:" + "0".repeat(64),
  } satisfies MemoryLifecyclePolicyV1;
  draft.revision = fingerprintWithoutRevision(draft);
  return parseMemoryLifecyclePolicyV1(draft);
}

export function parseMemoryReadBindingV1(value: unknown): MemoryReadBindingV1 {
  const record = parseObject(value, "Memory read binding", [
    "version", "bindingId", "tenantId", "userId", "agentId", "taskId",
    "policyRevision", "permittedNamespaces", "permittedScopes", "documentAccess",
    "issuer", "issuedAt", "expiresAt",
  ]);
  requireVersion(record.version, MEMORY_READ_BINDING_VERSION, "Memory read binding");
  const issuer = parseObject(record.issuer, "Memory read binding issuer", ["kind", "authorityId"]);
  const documentAccess = parseDocumentAccess(record.documentAccess);
  const scopes = parseArray(record.permittedScopes, "Memory read binding permittedScopes", 1, 32)
    .map((scope) => parseMemoryScopeV1(scope));
  requireUniqueCanonical(scopes, "Memory read binding permittedScopes");
  const issuedAt = parseTimestamp(record.issuedAt, "Memory read binding issuedAt");
  const expiresAt = record.expiresAt === undefined
    ? undefined
    : parseTimestamp(record.expiresAt, "Memory read binding expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("Memory read binding expiresAt must be after issuedAt.");
  }
  return {
    version: MEMORY_READ_BINDING_VERSION,
    bindingId: parseId(record.bindingId, "bindingId"),
    tenantId: parseId(record.tenantId, "tenantId"),
    userId: parseId(record.userId, "userId"),
    agentId: parseId(record.agentId, "agentId"),
    taskId: parseId(record.taskId, "taskId"),
    policyRevision: parseHash(record.policyRevision, "Memory read binding policyRevision"),
    permittedNamespaces: parseUniqueEnums(record.permittedNamespaces, MEMORY_NAMESPACES_V1, "Memory read binding permittedNamespaces"),
    permittedScopes: scopes,
    documentAccess,
    issuer: {
      kind: parseEnum(issuer.kind, ["trusted_runtime", "trusted_hosted"], "Memory read binding issuer kind"),
      authorityId: parseId(issuer.authorityId, "authorityId"),
    },
    issuedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function parseMemoryQueryV1(value: unknown): MemoryQueryV1 {
  const record = parseObject(value, "Memory query", [
    "version", "queryId", "namespace", "scope", "text", "limit",
    "documentIds", "minimumMatchScore",
  ]);
  requireVersion(record.version, MEMORY_QUERY_VERSION, "Memory query");
  const text = parseString(record.text, "Memory query text", 3, 1_000).trim();
  if (text.length < 3) throw new Error("Memory query text must contain at least 3 non-whitespace characters.");
  const documentIds = record.documentIds === undefined
    ? undefined
    : parseUniqueIds(record.documentIds, "documentIds", 0, 1_000);
  const minimumMatchScore = record.minimumMatchScore === undefined
    ? undefined
    : parseBoundedNumber(record.minimumMatchScore, "minimumMatchScore", 0, 1);
  return {
    version: MEMORY_QUERY_VERSION,
    queryId: parseId(record.queryId, "queryId"),
    namespace: parseNamespace(record.namespace),
    scope: parseMemoryScopeV1(record.scope),
    text,
    limit: parseSafeInteger(record.limit, "Memory query limit", 1, 100),
    ...(documentIds === undefined ? {} : { documentIds }),
    ...(minimumMatchScore === undefined ? {} : { minimumMatchScore }),
  };
}

export function parseMemoryRecordProvenanceV1(value: unknown): MemoryRecordProvenanceV1 {
  const record = parseObject(value, "Memory record provenance", [
    "version", "recordId", "namespace", "source", "creator", "createdAt",
    "scope", "confidence", "supersedesRecordId",
  ]);
  requireVersion(record.version, MEMORY_RECORD_PROVENANCE_VERSION, "Memory record provenance");
  const source = parseObject(record.source, "Memory provenance source", ["kind", "referenceId", "revision"]);
  const creator = parseObject(record.creator, "Memory provenance creator", ["kind", "id"]);
  const confidence = parseConfidence(record.confidence);
  const supersedesRecordId = record.supersedesRecordId === undefined
    ? undefined
    : parseId(record.supersedesRecordId, "supersedesRecordId");
  const recordId = parseId(record.recordId, "recordId");
  if (supersedesRecordId === recordId) {
    throw new Error("Memory provenance cannot supersede itself.");
  }
  return {
    version: MEMORY_RECORD_PROVENANCE_VERSION,
    recordId,
    namespace: parseNamespace(record.namespace),
    source: {
      kind: parseEnum(source.kind, ["document", "runtime_event", "artifact", "operator"], "Memory provenance source kind"),
      referenceId: parseId(source.referenceId, "referenceId"),
      revision: parseId(source.revision, "revision"),
    },
    creator: {
      kind: parseEnum(creator.kind, ["user", "agent", "system", "import"], "Memory provenance creator kind"),
      id: parseId(creator.id, "id"),
    },
    createdAt: parseTimestamp(record.createdAt, "Memory provenance createdAt"),
    scope: parseMemoryScopeV1(record.scope),
    confidence,
    ...(supersedesRecordId === undefined ? {} : { supersedesRecordId }),
  };
}

export function parseMemoryQueryResultV1(value: unknown): MemoryQueryResultV1 {
  const record = parseObject(value, "Memory query result", [
    "version", "queryId", "bindingId", "backendId", "policyRevision", "items",
  ]);
  requireVersion(record.version, MEMORY_QUERY_RESULT_VERSION, "Memory query result");
  const items = parseArray(record.items, "Memory query result items", 0, 100)
    .map((item, index) => parseResultItem(item, index));
  requireUniqueCanonical(items.map((item) => item.recordId), "Memory query result record IDs");
  return {
    version: MEMORY_QUERY_RESULT_VERSION,
    queryId: parseId(record.queryId, "queryId"),
    bindingId: parseId(record.bindingId, "bindingId"),
    backendId: parseId(record.backendId, "backendId"),
    policyRevision: parseHash(record.policyRevision, "Memory query result policyRevision"),
    items,
  };
}

export function parseMemoryBackendV1(value: unknown): MemoryBackendV1 {
  const record = parseObject(value, "Memory backend", [
    "version", "backendId", "policyRevision", "namespace", "sourceOfTruth", "strategies",
  ]);
  requireVersion(record.version, MEMORY_BACKEND_VERSION, "Memory backend");
  return {
    version: MEMORY_BACKEND_VERSION,
    backendId: parseId(record.backendId, "backendId"),
    policyRevision: parseHash(record.policyRevision, "Memory backend policyRevision"),
    namespace: parseNamespace(record.namespace),
    sourceOfTruth: parseEnum(record.sourceOfTruth, [
      "runtime_event_store", "runtime_checkpoint", "hosted_knowledge_store", "artifact_store",
    ], "Memory backend sourceOfTruth"),
    strategies: parseUniqueEnums(record.strategies, ["vector", "lexical"], "Memory backend strategies"),
  };
}

export function parseMemoryLifecycleEventV1(value: unknown): MemoryLifecycleEventV1 {
  const record = parseObject(value, "Memory lifecycle event", [
    "version", "eventId", "operationId", "tenantId", "recordId", "namespace",
    "type", "policyRevision", "actor", "reasonCode", "target", "occurredAt",
  ]);
  requireVersion(record.version, MEMORY_LIFECYCLE_EVENT_VERSION, "Memory lifecycle event");
  const actor = parseObject(record.actor, "Memory lifecycle event actor", ["kind", "id"]);
  const type = parseEnum(record.type, [
    "tombstoned", "propagation_acknowledged", "deletion_completed", "expired",
    "superseded", "legal_hold_applied", "legal_hold_released", "legal_hold_overridden",
  ], "Memory lifecycle event type");
  const target = record.target === undefined ? undefined : parseEnum(record.target, [
    "object_store", "database_graph", "vector_index", "lexical_index", "cache",
  ], "Memory lifecycle event target");
  if ((type === "propagation_acknowledged") !== (target !== undefined)) {
    throw new Error("Memory lifecycle propagation acknowledgements require exactly one target.");
  }
  return {
    version: MEMORY_LIFECYCLE_EVENT_VERSION,
    eventId: parseId(record.eventId, "eventId"),
    operationId: parseId(record.operationId, "operationId"),
    tenantId: parseId(record.tenantId, "tenantId"),
    recordId: parseId(record.recordId, "recordId"),
    namespace: parseNamespace(record.namespace),
    type,
    policyRevision: parseHash(record.policyRevision, "Memory lifecycle event policyRevision"),
    actor: {
      kind: parseEnum(actor.kind, ["user", "agent", "system"], "Memory lifecycle event actor kind"),
      id: parseId(actor.id, "id"),
    },
    reasonCode: parseId(record.reasonCode, "reasonCode"),
    ...(target === undefined ? {} : { target }),
    occurredAt: parseTimestamp(record.occurredAt, "Memory lifecycle event occurredAt"),
  };
}

export function fingerprintMemoryContractV1(value: unknown): string {
  return hashCanonical(value);
}

export function memoryScopesEqualV1(left: MemoryScopeV1, right: MemoryScopeV1): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function parseMemoryScopeV1(value: unknown): MemoryScopeV1 {
  const record = parseObject(value, "Memory scope", ["kind", "tenantId", "projectId", "threadId", "taskId"]);
  const kind = parseEnum(record.kind, ["tenant", "project", "thread", "task"], "Memory scope kind");
  const allowedByKind: Record<typeof kind, string[]> = {
    tenant: ["kind", "tenantId"],
    project: ["kind", "tenantId", "projectId"],
    thread: ["kind", "tenantId", "threadId"],
    task: ["kind", "tenantId", "taskId"],
  };
  rejectUnknown(record, new Set(allowedByKind[kind]), "Memory scope");
  const tenantId = parseId(record.tenantId, "tenantId");
  if (kind === "tenant") return { kind, tenantId };
  if (kind === "project") return { kind, tenantId, projectId: parseId(record.projectId, "projectId") };
  if (kind === "thread") return { kind, tenantId, threadId: parseId(record.threadId, "threadId") };
  return { kind, tenantId, taskId: parseId(record.taskId, "taskId") };
}

function parseResultItem(value: unknown, index: number): MemoryQueryResultItemV1 {
  const path = `Memory query result items[${index}]`;
  const record = parseObject(value, path, ["recordId", "provenance", "segments", "sourceMetadata"]);
  const recordId = parseId(record.recordId, "recordId");
  const provenance = parseMemoryRecordProvenanceV1(record.provenance);
  if (provenance.recordId !== recordId) throw new Error(`${path} provenance recordId must match recordId.`);
  const sourceMetadata = parseObject(record.sourceMetadata, `${path} sourceMetadata`, ["filename", "title", "mediaType", "excerptCount"]);
  const title = sourceMetadata.title === undefined ? undefined : parseString(sourceMetadata.title, `${path} title`, 1, 1_000);
  const segments = parseArray(record.segments, `${path} segments`, 1, 100).map((segment, segmentIndex) => {
    const segmentPath = `${path} segments[${segmentIndex}]`;
    const item = parseObject(segment, segmentPath, ["segmentId", "text", "location", "matchEvidence"]);
    const location = parseObject(item.location, `${segmentPath} location`, ["label", "url", "pageNumber", "sectionTitle"]);
    const evidence = parseObject(item.matchEvidence, `${segmentPath} matchEvidence`, ["strategy", "score"]);
    const pageNumber = location.pageNumber === undefined ? undefined : parseSafeInteger(location.pageNumber, `${segmentPath} pageNumber`, 1, Number.MAX_SAFE_INTEGER);
    const sectionTitle = location.sectionTitle === undefined ? undefined : parseString(location.sectionTitle, `${segmentPath} sectionTitle`, 1, 1_000);
    const url = parseString(location.url, `${segmentPath} url`, 1, 4_096);
    if (!URI_PATH_PATTERN.test(url)) throw new Error(`${segmentPath} url must be an HTTP URL or absolute path.`);
    return {
      segmentId: parseId(item.segmentId, "segmentId"),
      text: parseString(item.text, `${segmentPath} text`, 1, 100_000),
      location: {
        label: parseString(location.label, `${segmentPath} label`, 1, 2_000),
        url,
        ...(pageNumber === undefined ? {} : { pageNumber }),
        ...(sectionTitle === undefined ? {} : { sectionTitle }),
      },
      matchEvidence: {
        strategy: parseEnum(evidence.strategy, ["vector", "lexical"], `${segmentPath} strategy`),
        score: parseBoundedNumber(evidence.score, `${segmentPath} score`, 0, 1),
      },
    } satisfies MemoryResultSegmentV1;
  });
  requireUniqueCanonical(segments.map((segment) => segment.segmentId), `${path} segment IDs`);
  return {
    recordId,
    provenance,
    segments,
    sourceMetadata: {
      filename: parseString(sourceMetadata.filename, `${path} filename`, 1, 1_000),
      ...(title === undefined ? {} : { title }),
      mediaType: parseString(sourceMetadata.mediaType, `${path} mediaType`, 1, 255),
      excerptCount: parseSafeInteger(sourceMetadata.excerptCount, `${path} excerptCount`, 1, Number.MAX_SAFE_INTEGER),
    },
  };
}

function parseConfidence(value: unknown): MemoryConfidenceProvenanceV1 {
  const record = parseObject(value, "Memory provenance confidence", [
    "kind", "sourceReferenceId", "evaluatorId", "evaluatorRevision", "calibrationReference",
  ]);
  const kind = parseEnum(record.kind, ["asserted_source", "evaluated"], "Memory confidence kind");
  if (kind === "asserted_source") {
    rejectUnknown(record, new Set(["kind", "sourceReferenceId"]), "Memory provenance confidence");
    return { kind, sourceReferenceId: parseId(record.sourceReferenceId, "sourceReferenceId") };
  }
  rejectUnknown(record, new Set(["kind", "evaluatorId", "evaluatorRevision", "calibrationReference"]), "Memory provenance confidence");
  return {
    kind,
    evaluatorId: parseId(record.evaluatorId, "evaluatorId"),
    evaluatorRevision: parseHash(record.evaluatorRevision, "Memory confidence evaluatorRevision"),
    calibrationReference: parseId(record.calibrationReference, "calibrationReference"),
  };
}

function parseDocumentAccess(value: unknown): MemoryDocumentAccessV1 {
  const record = parseObject(value, "Memory read binding documentAccess", ["mode", "documentIds"]);
  const mode = parseEnum(record.mode, ["scope", "exact"], "Memory document access mode");
  if (mode === "scope") {
    rejectUnknown(record, new Set(["mode"]), "Memory read binding documentAccess");
    return { mode };
  }
  return { mode, documentIds: parseUniqueIds(record.documentIds, "documentIds", 0, 10_000) };
}

function parseRetention(value: unknown): MemoryRetentionV1 {
  const record = parseObject(value, "Memory retention", ["mode", "ttlMs"]);
  const mode = parseEnum(record.mode, ["session", "ttl", "indefinite"], "Memory retention mode");
  if (mode === "ttl") return { mode, ttlMs: parseSafeInteger(record.ttlMs, "Memory retention ttlMs", 1, Number.MAX_SAFE_INTEGER) };
  rejectUnknown(record, new Set(["mode"]), "Memory retention");
  return { mode };
}

function fingerprintWithoutRevision(value: object): string {
  const { revision: _revision, ...payload } = value as Record<string, unknown>;
  return hashCanonical(payload);
}

function requireMatchingRevision(value: object, field: string, path: string): void {
  if ((value as Record<string, unknown>)[field] !== fingerprintWithoutRevision(value)) {
    throw new Error(`${path} revision does not match its canonical payload.`);
  }
}

function parseObject(value: unknown, path: string, fields: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const record = value as Record<string, unknown>;
  rejectUnknown(record, new Set(fields), path);
  return record;
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key)).sort()[0];
  if (unknown !== undefined) throw new Error(`${path} contains unknown field '${unknown}'.`);
}

function parseArray(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${path} must contain between ${min} and ${max} items.`);
  return value;
}

function parseId(value: unknown, field: string): string {
  const parsed = parseString(value, field, 1, 256);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${field} must be a bounded identifier.`);
  return parsed;
}

function parseHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`${path} must be a sha256 digest.`);
  return value;
}

function parseString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new Error(`${path} must be a string between ${min} and ${max} characters.`);
  return value;
}

function parseTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${path} must be a canonical ISO timestamp.`);
  return value;
}

function parseNamespace(value: unknown): MemoryNamespaceV1 {
  return parseEnum(value, MEMORY_NAMESPACES_V1, "Memory namespace");
}

function parseEnum<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${path} must be one of ${values.join(", ")}.`);
  return value as T[number];
}

function parseLiteral<const T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} must be '${expected}'.`);
  return expected;
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function parseSafeInteger(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${path} must be a safe integer between ${min} and ${max}.`);
  return value as number;
}

function parseBoundedNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${path} must be a finite number between ${min} and ${max}.`);
  return value;
}

function parseUniqueIds(value: unknown, path: string, min = 1, max = 256): string[] {
  const parsed = parseArray(value, path, min, max).map((item) => parseId(item, path));
  requireUniqueCanonical(parsed, path);
  return parsed;
}

function parseUniqueEnums<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number][] {
  const parsed = parseArray(value, path, 1, values.length).map((item) => parseEnum(item, values, path));
  requireUniqueCanonical(parsed, path);
  return parsed;
}

function requireUniqueCanonical(values: unknown[], path: string): void {
  const canonical = values.map((value) => hashCanonical(value));
  if (new Set(canonical).size !== canonical.length) throw new Error(`${path} must contain unique values.`);
}

function requireVersion(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw new Error(`${path} version must be '${expected}'.`);
}
