import {
  memoryScopesEqualV1,
  parseMemoryBackendV1,
  parseMemoryQueryResultV1,
  parseMemoryQueryV1,
  parseMemoryReadBindingV1,
  type MemoryBackendV1,
  type MemoryQueryResultV1,
  type MemoryQueryV1,
  type MemoryReadBindingV1,
} from "../kestrel/contracts/memory.js";

export interface MemoryReadContextV1 {
  tenantId: string;
  userId: string;
  agentId: string;
  taskId: string;
  issuerKind: MemoryReadBindingV1["issuer"]["kind"];
  issuerAuthorityId: string;
  policyRevision: string;
  now: string;
}

export interface MemoryBackendAdapterV1 {
  readonly descriptor: MemoryBackendV1;
  query(input: {
    binding: MemoryReadBindingV1;
    query: MemoryQueryV1;
  }): Promise<MemoryQueryResultV1>;
}

export class MemoryAuthorizationError extends Error {
  readonly code:
    | "MEMORY_BINDING_INVALID"
    | "MEMORY_BINDING_STALE"
    | "MEMORY_BINDING_EXPIRED"
    | "MEMORY_BINDING_AUTHORITY_MISMATCH"
    | "MEMORY_SCOPE_DENIED"
    | "MEMORY_DOCUMENT_DENIED"
    | "MEMORY_BACKEND_INVALID";

  constructor(
    code: MemoryAuthorizationError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryAuthorizationError";
    this.code = code;
  }
}

export class MemoryGateway {
  async query(input: {
    context: MemoryReadContextV1;
    binding: unknown;
    query: unknown;
    backend: MemoryBackendAdapterV1;
  }): Promise<MemoryQueryResultV1> {
    const context = parseReadContext(input.context);
    let binding: MemoryReadBindingV1;
    let query: MemoryQueryV1;
    let backend: MemoryBackendV1;
    try {
      binding = parseMemoryReadBindingV1(input.binding);
      query = parseMemoryQueryV1(input.query);
      backend = parseMemoryBackendV1(input.backend.descriptor);
    } catch (error) {
      throw new MemoryAuthorizationError(
        "MEMORY_BINDING_INVALID",
        "Memory retrieval requires valid canonical contracts.",
        { cause: error },
      );
    }

    assertBindingAuthority(binding, context);
    assertBindingTime(binding, context);
    assertQueryAuthority({ binding, query, backend });

    const result = parseMemoryQueryResultV1(
      await input.backend.query({
        binding: structuredClone(binding),
        query: structuredClone(query),
      }),
    );
    assertResultAuthority({ binding, query, backend, result });
    return result;
  }
}

function parseReadContext(value: MemoryReadContextV1): MemoryReadContextV1 {
  const keys = Object.keys(value).sort();
  const expected = [
    "agentId",
    "issuerAuthorityId",
    "issuerKind",
    "now",
    "policyRevision",
    "taskId",
    "tenantId",
    "userId",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    !Number.isFinite(Date.parse(value.now)) ||
    new Date(value.now).toISOString() !== value.now
  ) {
    throw new MemoryAuthorizationError(
      "MEMORY_BINDING_INVALID",
      "Memory read context is malformed.",
    );
  }
  for (const field of [
    "tenantId",
    "userId",
    "agentId",
    "taskId",
    "issuerAuthorityId",
    "policyRevision",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new MemoryAuthorizationError(
        "MEMORY_BINDING_INVALID",
        `Memory read context ${field} is required.`,
      );
    }
  }
  if (value.issuerKind !== "trusted_runtime" && value.issuerKind !== "trusted_hosted") {
    throw new MemoryAuthorizationError(
      "MEMORY_BINDING_INVALID",
      "Memory read context issuerKind is invalid.",
    );
  }
  return { ...value };
}

function assertBindingAuthority(
  binding: MemoryReadBindingV1,
  context: MemoryReadContextV1,
): void {
  for (const field of ["tenantId", "userId", "agentId", "taskId"] as const) {
    if (binding[field] !== context[field]) {
      throw new MemoryAuthorizationError(
        "MEMORY_BINDING_AUTHORITY_MISMATCH",
        `Memory read binding ${field} does not match trusted context.`,
      );
    }
  }
  if (binding.policyRevision !== context.policyRevision) {
    throw new MemoryAuthorizationError(
      "MEMORY_BINDING_STALE",
      "Memory read binding policy revision is stale.",
    );
  }
  if (
    binding.issuer.kind !== context.issuerKind ||
    binding.issuer.authorityId !== context.issuerAuthorityId
  ) {
    throw new MemoryAuthorizationError(
      "MEMORY_BINDING_AUTHORITY_MISMATCH",
      "Memory read binding issuer does not match trusted context.",
    );
  }
}

function assertBindingTime(
  binding: MemoryReadBindingV1,
  context: MemoryReadContextV1,
): void {
  const now = Date.parse(context.now);
  if (Date.parse(binding.issuedAt) > now) {
    throw new MemoryAuthorizationError(
      "MEMORY_BINDING_INVALID",
      "Memory read binding has not been issued yet.",
    );
  }
  if (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= now) {
    throw new MemoryAuthorizationError(
      "MEMORY_BINDING_EXPIRED",
      "Memory read binding has expired.",
    );
  }
}

function assertQueryAuthority(input: {
  binding: MemoryReadBindingV1;
  query: MemoryQueryV1;
  backend: MemoryBackendV1;
}): void {
  const { binding, query, backend } = input;
  if (
    backend.policyRevision !== binding.policyRevision ||
    backend.namespace !== query.namespace
  ) {
    throw new MemoryAuthorizationError(
      "MEMORY_BACKEND_INVALID",
      "Memory backend does not match the authorized policy and namespace.",
    );
  }
  if (!binding.permittedNamespaces.includes(query.namespace)) {
    throw new MemoryAuthorizationError(
      "MEMORY_SCOPE_DENIED",
      "Memory query namespace is not authorized.",
    );
  }
  if (
    query.scope.tenantId !== binding.tenantId ||
    !binding.permittedScopes.some((scope) => memoryScopesEqualV1(scope, query.scope))
  ) {
    throw new MemoryAuthorizationError(
      "MEMORY_SCOPE_DENIED",
      "Memory query scope would widen the read binding.",
    );
  }
  if (binding.documentAccess.mode === "exact") {
    if (query.documentIds === undefined) {
      throw new MemoryAuthorizationError(
        "MEMORY_DOCUMENT_DENIED",
        "An exact memory document binding requires an exact query document set.",
      );
    }
    const allowed = new Set(binding.documentAccess.documentIds);
    if (query.documentIds.some((documentId) => !allowed.has(documentId))) {
      throw new MemoryAuthorizationError(
        "MEMORY_DOCUMENT_DENIED",
        "Memory query document set would widen the read binding.",
      );
    }
  }
}

function assertResultAuthority(input: {
  binding: MemoryReadBindingV1;
  query: MemoryQueryV1;
  backend: MemoryBackendV1;
  result: MemoryQueryResultV1;
}): void {
  const { binding, query, backend, result } = input;
  if (
    result.queryId !== query.queryId ||
    result.bindingId !== binding.bindingId ||
    result.backendId !== backend.backendId ||
    result.policyRevision !== binding.policyRevision
  ) {
    throw new MemoryAuthorizationError(
      "MEMORY_BACKEND_INVALID",
      "Memory backend result does not match the authorized query.",
    );
  }
  const exactDocuments =
    binding.documentAccess.mode === "exact"
      ? new Set(binding.documentAccess.documentIds)
      : undefined;
  const requestedDocuments = query.documentIds === undefined
    ? undefined
    : new Set(query.documentIds);
  if (result.items.length > query.limit) {
    throw new MemoryAuthorizationError(
      "MEMORY_BACKEND_INVALID",
      "Memory backend returned more records than the bounded query allowed.",
    );
  }
  for (const item of result.items) {
    if (
      item.provenance.namespace !== query.namespace ||
      !memoryScopesEqualV1(item.provenance.scope, query.scope) ||
      (exactDocuments !== undefined && !exactDocuments.has(item.recordId)) ||
      (requestedDocuments !== undefined && !requestedDocuments.has(item.recordId)) ||
      (query.minimumMatchScore !== undefined &&
        item.segments.some((segment) =>
          segment.matchEvidence.score < query.minimumMatchScore!))
    ) {
      throw new MemoryAuthorizationError(
        "MEMORY_BACKEND_INVALID",
        "Memory backend returned a record outside the authorized scope or bounded query.",
      );
    }
  }
}
