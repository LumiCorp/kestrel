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
  readiness: string;
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
      await this.#reconcile(operation);
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
          await this.#reconcile(operation);
          operation.commit(() => {
            this.#present.setError(
              readError(body) || "Could not inspect Resend receiving domains.",
            );
          });
          return;
        }

        const domains = readDomains(body);
        operation.commit(() => {
          this.#present.setDomains(domains);
          this.#present.setError(undefined);
        });
        await this.#reconcile(operation);
        operation.commit(() => {
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

      const connection = readConnection(body);
      operation.commit(() => {
        this.#present.setConnection(connection);
        this.#present.setApiKey("");
        this.#present.setDomainId("");
        this.#present.setDomains([]);
        this.#present.setError(undefined);
        this.#present.showSuccess("Inbound receiving configuration saved.");
      });
      await this.#reconcile(operation);
    });
  }

  async #reconcile(operation: Operation): Promise<void> {
    const response = await this.#request(
      "/api/organization/email/receiving",
      { cache: "no-store" },
    );
    const body = await readBody(response);
    if (!response.ok) {
      operation.commit(() => {
        this.#present.setError(
          readError(body) || "Could not load inbound receiving.",
        );
      });
      return;
    }
    operation.commit(() => {
      this.#present.setConnection(readConnection(body));
      this.#present.setError(undefined);
    });
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
  return body.connection as ReceivingConnection;
}

function readDomains(body: Record<string, unknown>): ReceivingDomain[] {
  return Array.isArray(body.domains) ? (body.domains as ReceivingDomain[]) : [];
}

function readError(body: Record<string, unknown>): string | undefined {
  return typeof body.error === "string" ? body.error : undefined;
}
