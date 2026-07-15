export const LOCAL_CORE_CREDENTIAL_IDS = Object.freeze([
  "provider.openrouter.default",
  "provider.openai.default",
  "provider.anthropic.default",
  "tool.tavily.default",
  "tool.visual-crossing.default",
] as const);

export type LocalCoreCredentialId = (typeof LOCAL_CORE_CREDENTIAL_IDS)[number];

export type LocalCoreCredentialStoreBackend =
  | "memory"
  | "macos_keychain"
  | "unavailable";

export interface LocalCoreCredentialStatus {
  id: LocalCoreCredentialId;
  configured: boolean;
}

/**
 * This is the only credential-store shape intended for serialization.
 * Credential values never appear in status, diagnostics, or backend errors.
 */
export interface LocalCoreCredentialStoreStatus {
  backend: LocalCoreCredentialStoreBackend;
  available: boolean;
  credentials: LocalCoreCredentialStatus[];
}

/** Internal Core interface. Raw values must not cross a client/API boundary. */
export interface LocalCoreCredentialStore {
  readonly backend: LocalCoreCredentialStoreBackend;
  readonly available: boolean;
  get(id: LocalCoreCredentialId): Promise<string | undefined>;
  set(id: LocalCoreCredentialId, secret: string): Promise<void>;
  delete(id: LocalCoreCredentialId): Promise<boolean>;
  has(id: LocalCoreCredentialId): Promise<boolean>;
}

export class LocalCoreCredentialValidationError extends Error {
  readonly code = "LOCAL_CORE_CREDENTIAL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "LocalCoreCredentialValidationError";
  }
}

export class LocalCoreCredentialStoreUnavailableError extends Error {
  readonly code = "LOCAL_CORE_CREDENTIAL_STORE_UNAVAILABLE";

  constructor() {
    super("The Local Core credential store is unavailable.");
    this.name = "LocalCoreCredentialStoreUnavailableError";
  }
}

export function parseLocalCoreCredentialId(value: unknown): LocalCoreCredentialId {
  if (
    typeof value !== "string"
    || LOCAL_CORE_CREDENTIAL_IDS.includes(value as LocalCoreCredentialId) === false
  ) {
    throw new LocalCoreCredentialValidationError(
      "Local Core credential id is not supported.",
    );
  }
  return value as LocalCoreCredentialId;
}

export function parseLocalCoreCredentialSecret(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new LocalCoreCredentialValidationError(
      "Local Core credential value must be a non-empty string without surrounding whitespace or control characters.",
    );
  }
  return value;
}

export function parseLocalCoreCredentialStoreStatus(
  value: unknown,
): LocalCoreCredentialStoreStatus {
  const record = requireRecord(value, "Credential store status");
  rejectUnknownFields(
    record,
    new Set(["backend", "available", "credentials"]),
    "Credential store status",
  );
  if (
    record.backend !== "memory"
    && record.backend !== "macos_keychain"
    && record.backend !== "unavailable"
  ) {
    throw new LocalCoreCredentialValidationError(
      "Local Core credential store status backend is invalid.",
    );
  }
  if (typeof record.available !== "boolean") {
    throw new LocalCoreCredentialValidationError(
      "Local Core credential store status available must be a boolean.",
    );
  }
  if (Array.isArray(record.credentials) === false) {
    throw new LocalCoreCredentialValidationError(
      "Local Core credential store status credentials must be an array.",
    );
  }
  if (record.credentials.length !== LOCAL_CORE_CREDENTIAL_IDS.length) {
    throw new LocalCoreCredentialValidationError(
      "Local Core credential store status must include every supported credential exactly once.",
    );
  }

  const seen = new Set<LocalCoreCredentialId>();
  const credentials = record.credentials.map((entry) => {
    const credential = requireRecord(entry, "Credential status");
    rejectUnknownFields(
      credential,
      new Set(["id", "configured"]),
      "Credential status",
    );
    const id = parseLocalCoreCredentialId(credential.id);
    if (seen.has(id)) {
      throw new LocalCoreCredentialValidationError(
        "Local Core credential store status includes a duplicate credential id.",
      );
    }
    if (typeof credential.configured !== "boolean") {
      throw new LocalCoreCredentialValidationError(
        "Local Core credential status configured must be a boolean.",
      );
    }
    seen.add(id);
    return { id, configured: credential.configured };
  });

  for (const id of LOCAL_CORE_CREDENTIAL_IDS) {
    if (seen.has(id) === false) {
      throw new LocalCoreCredentialValidationError(
        "Local Core credential store status is missing a supported credential id.",
      );
    }
  }
  if (record.available === false && credentials.some((entry) => entry.configured)) {
    throw new LocalCoreCredentialValidationError(
      "An unavailable Local Core credential store cannot report configured credentials.",
    );
  }
  if (record.backend === "unavailable" && record.available !== false) {
    throw new LocalCoreCredentialValidationError(
      "The unavailable Local Core credential backend cannot report itself as available.",
    );
  }

  const configuredById = new Map(
    credentials.map((entry) => [entry.id, entry.configured] as const),
  );
  return {
    backend: record.backend,
    available: record.available,
    credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
      id,
      configured: configuredById.get(id) ?? false,
    })),
  };
}

export async function readLocalCoreCredentialStoreStatus(
  store: LocalCoreCredentialStore,
): Promise<LocalCoreCredentialStoreStatus> {
  const credentials: LocalCoreCredentialStatus[] = [];
  for (const id of LOCAL_CORE_CREDENTIAL_IDS) {
    credentials.push({
      id,
      configured: store.available ? await store.has(id) : false,
    });
  }
  return parseLocalCoreCredentialStoreStatus({
    backend: store.backend,
    available: store.available,
    credentials,
  });
}

export class MemoryLocalCoreCredentialStore implements LocalCoreCredentialStore {
  readonly backend = "memory" as const;
  readonly available = true;
  readonly #values = new Map<LocalCoreCredentialId, string>();

  async get(id: LocalCoreCredentialId): Promise<string | undefined> {
    return this.#values.get(parseLocalCoreCredentialId(id));
  }

  async set(id: LocalCoreCredentialId, secret: string): Promise<void> {
    this.#values.set(
      parseLocalCoreCredentialId(id),
      parseLocalCoreCredentialSecret(secret),
    );
  }

  async delete(id: LocalCoreCredentialId): Promise<boolean> {
    return this.#values.delete(parseLocalCoreCredentialId(id));
  }

  async has(id: LocalCoreCredentialId): Promise<boolean> {
    return this.#values.has(parseLocalCoreCredentialId(id));
  }
}

export class UnavailableLocalCoreCredentialStore implements LocalCoreCredentialStore {
  readonly backend = "unavailable" as const;
  readonly available = false;

  async get(id: LocalCoreCredentialId): Promise<string | undefined> {
    parseLocalCoreCredentialId(id);
    throw new LocalCoreCredentialStoreUnavailableError();
  }

  async set(id: LocalCoreCredentialId, secret: string): Promise<void> {
    parseLocalCoreCredentialId(id);
    parseLocalCoreCredentialSecret(secret);
    throw new LocalCoreCredentialStoreUnavailableError();
  }

  async delete(id: LocalCoreCredentialId): Promise<boolean> {
    parseLocalCoreCredentialId(id);
    throw new LocalCoreCredentialStoreUnavailableError();
  }

  async has(id: LocalCoreCredentialId): Promise<boolean> {
    parseLocalCoreCredentialId(id);
    throw new LocalCoreCredentialStoreUnavailableError();
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalCoreCredentialValidationError(
      `Local Core ${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find((key) => allowed.has(key) === false);
  if (unknown !== undefined) {
    throw new LocalCoreCredentialValidationError(
      `Local Core ${label} includes unsupported field '${unknown}'.`,
    );
  }
}
