export type ReceivingConnection = {
  provider: "resend";
  configured: boolean;
  credentialStatus: "not_configured" | "full_access" | "insufficient" | "error";
  credentialValidatedAt: string | null;
  receivingDomain: string | null;
  receivingDomainStatus: "not_selected" | "pending" | "verified" | "failed";
  mxStatus: "unknown" | "pending" | "verified" | "failed";
  domainCheckedAt: string | null;
  webhookStatus: "not_staged" | "staged" | "active" | "disabled" | "error";
  inboundEnabled: boolean;
  lastHealthCheckedAt: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  readiness:
    | "not_configured"
    | "credential_insufficient"
    | "domain_unready"
    | "ready_inactive"
    | "staged"
    | "active"
    | "error";
};

export type ReceivingDomain = {
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  receiving: "enabled" | "disabled";
  mxStatus: "unknown" | "pending" | "verified" | "failed";
};

type ReceivingPresentation = {
  setApiKey(value: string): void;
  setBusy(value: boolean): void;
  setConnection(value: ReceivingConnection): void;
  setDomainId(value: string): void;
  setDomains(value: ReceivingDomain[]): void;
  setError(value: string | undefined): void;
  showInfo(message: string): void;
  showSuccess(message: string): void;
};

type Request = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type Operation = {
  epoch: number;
  isCurrent(): boolean;
  commit(update: () => void): boolean;
};

export class OrganizationReceivingController {
  readonly #present: ReceivingPresentation;
  readonly #request: Request;
  #active = true;
  #busy = false;
  #epoch = 0;

  constructor(present: ReceivingPresentation, request: Request = fetch) {
    this.#present = present;
    this.#request = request;
  }

  deactivate(): void {
    this.#active = false;
    this.#epoch += 1;
  }

  async load(): Promise<void> {
    await this.#run("Could not load inbound receiving.", async (operation) => {
      const connection = await this.#readReconciledConnection(operation);
      if (!connection) {
        return;
      }
      operation.commit(() => {
        this.#present.setConnection(connection);
        this.#present.setError(undefined);
      });
    });
  }

  async inspectDomains(apiKey: string): Promise<void> {
    await this.#run(
      "Could not inspect Resend receiving domains.",
      async (operation) => {
        const response = await this.#request(
          "/api/organization/email/receiving/domains",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiKey: apiKey || undefined }),
          },
        );
        const body = await readBody(response);
        if (!operation.isCurrent()) {
          return;
        }
        if (!response.ok) {
          const connection = await this.#readReconciledConnection(operation);
          if (!connection) {
            return;
          }
          operation.commit(() => {
            this.#present.setConnection(connection);
            this.#present.setError(
              readError(body) || "Could not inspect Resend receiving domains.",
            );
          });
          return;
        }

        const domains = readDomains(body);
        const connection = await this.#readReconciledConnection(operation);
        if (!connection) {
          return;
        }
        operation.commit(() => {
          this.#present.setConnection(connection);
          this.#present.setDomains(domains);
          this.#present.setError(undefined);
          if (domains.length === 0) {
            this.#present.showInfo(
              "No Resend receiving domains are available for this key.",
            );
          }
        });
      },
    );
  }

  async save(apiKey: string, domainId: string): Promise<void> {
    await this.#run("Could not save inbound receiving.", async (operation) => {
      const response = await this.#request(
        "/api/organization/email/receiving",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: apiKey || undefined,
            receivingDomainId: domainId,
          }),
        },
      );
      const body = await readBody(response);
      if (!operation.isCurrent()) {
        return;
      }
      if (!response.ok) {
        operation.commit(() => {
          this.#present.setError(
            readError(body) || "Could not save inbound receiving.",
          );
        });
        return;
      }

      readConnection(body);
      const connection = await this.#readReconciledConnection(operation);
      if (!connection) {
        return;
      }
      operation.commit(() => {
        this.#present.setConnection(connection);
        this.#present.setApiKey("");
        this.#present.setDomainId("");
        this.#present.setDomains([]);
        this.#present.setError(undefined);
        this.#present.showSuccess("Inbound receiving configuration saved.");
      });
    });
  }

  async #readReconciledConnection(
    operation: Operation,
  ): Promise<ReceivingConnection | undefined> {
    const response = await this.#request(
      "/api/organization/email/receiving",
      { cache: "no-store" },
    );
    const body = await readBody(response);
    if (!operation.isCurrent()) {
      return;
    }
    if (!response.ok) {
      throw new Error(readError(body) || "Could not load inbound receiving.");
    }
    return readConnection(body);
  }

  async #run(
    failureMessage: string,
    work: (operation: Operation) => Promise<void>,
  ): Promise<void> {
    if (!this.#active) {
      return;
    }
    const epoch = ++this.#epoch;
    if (!this.#busy) {
      this.#busy = true;
      this.#present.setBusy(true);
    }
    const operation: Operation = {
      epoch,
      isCurrent: () => this.#isCurrent(epoch),
      commit: (update) => {
        if (!this.#isCurrent(epoch)) {
          return false;
        }
        update();
        return true;
      },
    };

    try {
      await work(operation);
    } catch {
      operation.commit(() => {
        this.#present.setError(failureMessage);
      });
    } finally {
      if (this.#isCurrent(epoch)) {
        this.#busy = false;
        this.#present.setBusy(false);
      }
    }
  }

  #isCurrent(epoch: number): boolean {
    return this.#active && epoch === this.#epoch;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function readConnection(body: Record<string, unknown>): ReceivingConnection {
  assertExactKeys(body, ["connection"]);
  const connection = assertRecord(body.connection);
  assertExactKeys(connection, [
    "provider",
    "configured",
    "credentialStatus",
    "credentialValidatedAt",
    "receivingDomain",
    "receivingDomainStatus",
    "mxStatus",
    "domainCheckedAt",
    "webhookStatus",
    "inboundEnabled",
    "lastHealthCheckedAt",
    "lastTestedAt",
    "lastErrorCode",
    "readiness",
  ]);
  return {
    provider: assertEnum(connection.provider, ["resend"]),
    configured: assertBoolean(connection.configured),
    credentialStatus: assertEnum(connection.credentialStatus, [
      "not_configured",
      "full_access",
      "insufficient",
      "error",
    ]),
    credentialValidatedAt: assertNullableDate(connection.credentialValidatedAt),
    receivingDomain: assertNullableText(connection.receivingDomain),
    receivingDomainStatus: assertEnum(connection.receivingDomainStatus, [
      "not_selected",
      "pending",
      "verified",
      "failed",
    ]),
    mxStatus: assertEnum(connection.mxStatus, [
      "unknown",
      "pending",
      "verified",
      "failed",
    ]),
    domainCheckedAt: assertNullableDate(connection.domainCheckedAt),
    webhookStatus: assertEnum(connection.webhookStatus, [
      "not_staged",
      "staged",
      "active",
      "disabled",
      "error",
    ]),
    inboundEnabled: assertBoolean(connection.inboundEnabled),
    lastHealthCheckedAt: assertNullableDate(connection.lastHealthCheckedAt),
    lastTestedAt: assertNullableDate(connection.lastTestedAt),
    lastErrorCode: assertNullableText(connection.lastErrorCode),
    readiness: assertEnum(connection.readiness, [
      "not_configured",
      "credential_insufficient",
      "domain_unready",
      "ready_inactive",
      "staged",
      "active",
      "error",
    ]),
  };
}

function readDomains(body: Record<string, unknown>): ReceivingDomain[] {
  assertExactKeys(body, ["domains"]);
  if (!Array.isArray(body.domains)) {
    throw new Error("Invalid receiving domains response.");
  }
  return body.domains.map((value) => {
    const domain = assertRecord(value);
    assertExactKeys(domain, ["id", "name", "status", "receiving", "mxStatus"]);
    return {
      id: assertText(domain.id),
      name: assertText(domain.name),
      status: assertEnum(domain.status, ["pending", "verified", "failed"]),
      receiving: assertEnum(domain.receiving, ["enabled", "disabled"]),
      mxStatus: assertEnum(domain.mxStatus, [
        "unknown",
        "pending",
        "verified",
        "failed",
      ]),
    };
  });
}

function readError(body: Record<string, unknown>): string | undefined {
  return typeof body.error === "string" ? body.error : undefined;
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid receiving response.");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new Error("Invalid receiving response.");
  }
}

function assertText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid receiving response.");
  }
  return value;
}

function assertNullableText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return assertText(value);
}

function assertNullableDate(value: unknown): string | null {
  const text = assertNullableText(value);
  if (text !== null && Number.isNaN(Date.parse(text))) {
    throw new Error("Invalid receiving response.");
  }
  return text;
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid receiving response.");
  }
  return value;
}

function assertEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new Error("Invalid receiving response.");
  }
  return value as Value;
}
