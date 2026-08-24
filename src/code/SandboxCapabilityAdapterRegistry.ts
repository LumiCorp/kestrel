export type SandboxCapabilityEffectClass = "read_only" | "external_effect";

export class SandboxCapabilityAdapterFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SandboxCapabilityAdapterFailure";
  }
}

export interface SandboxCapabilityAdapterInvocationContext {
  fetchImpl: typeof fetch;
  credential: string;
  timeoutMs: number;
  expiryMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
}

export interface SandboxCapabilityAdapterModelContract {
  /** Secret-free model guidance. It is compiled into code.execute. */
  readonly description: string;
  readonly usage: string;
  readonly optional: true;
  readonly selectionInputSchema: Record<string, unknown>;
  readonly examples: readonly Record<string, unknown>[];
}

export interface SandboxCapabilityAdapter<Profile = unknown, Selection = unknown, Input = unknown, Output = unknown> {
  readonly capabilityId: string;
  readonly operation: string;
  readonly resource: string;
  readonly credentialId: string;
  readonly effectClass: SandboxCapabilityEffectClass;
  readonly modelContract: SandboxCapabilityAdapterModelContract;
  parseProfile(value: unknown): Profile;
  parseSelection(value: unknown): Selection;
  canonicalInput(profile: Profile, selection: Selection): Input;
  destination(profile: Profile): string;
  invoke(input: Input, context: SandboxCapabilityAdapterInvocationContext): Promise<Output>;
}

export class SandboxCapabilityAdapterRegistry {
  private readonly adapters = new Map<string, SandboxCapabilityAdapter>();

  constructor(adapters: readonly SandboxCapabilityAdapter[]) {
    for (const adapter of adapters) {
      assertExactAdapterDeclaration(adapter);
      if (this.adapters.has(adapter.capabilityId)) {
        throw new Error(`Duplicate sandbox capability adapter '${adapter.capabilityId}'`);
      }
      this.adapters.set(adapter.capabilityId, adapter);
    }
  }

  list(): readonly SandboxCapabilityAdapter[] {
    return [...this.adapters.values()];
  }

  requireExact(input: { capabilityId: string; operation?: string; resource?: string }): SandboxCapabilityAdapter {
    const adapter = this.adapters.get(input.capabilityId);
    if (adapter === undefined) throw new Error(`Unknown sandbox capability adapter '${input.capabilityId}'`);
    if (input.operation !== undefined && adapter.operation !== input.operation) {
      throw new Error(`Sandbox capability operation '${input.operation}' is not registered for '${input.capabilityId}'`);
    }
    if (input.resource !== undefined && adapter.resource !== input.resource) {
      throw new Error(`Sandbox capability resource '${input.resource}' is not registered for '${input.capabilityId}'`);
    }
    return adapter;
  }
}

function assertExactAdapterDeclaration(adapter: SandboxCapabilityAdapter): void {
  for (const [label, value] of Object.entries({
    capabilityId: adapter.capabilityId,
    operation: adapter.operation,
    resource: adapter.resource,
    credentialId: adapter.credentialId,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Sandbox capability adapter ${label} is missing`);
    }
  }
  const resource = new URL(adapter.resource);
  if (resource.protocol !== "https:" || resource.username !== "" || resource.password !== "") {
    throw new Error("Sandbox capability adapter resource must be an exact credential-free HTTPS URL");
  }
  if (adapter.effectClass !== "read_only" && adapter.effectClass !== "external_effect") {
    throw new Error("Sandbox capability adapter effect class is invalid");
  }
  const modelContract = adapter.modelContract;
  if (
    typeof modelContract !== "object" || modelContract === null ||
    typeof modelContract.description !== "string" || modelContract.description.trim() === "" ||
    typeof modelContract.usage !== "string" || modelContract.usage.trim() === "" ||
    modelContract.optional !== true ||
    typeof modelContract.selectionInputSchema !== "object" || modelContract.selectionInputSchema === null ||
    !Array.isArray(modelContract.examples)
  ) {
    throw new Error("Sandbox capability adapter model contract is invalid");
  }
  const serialized = JSON.stringify(modelContract).toLowerCase();
  if (/(authorization|bearer|api[_-]?key|credential|secret|token)/u.test(serialized)) {
    throw new Error("Sandbox capability adapter model contract must be secret-free");
  }
}
