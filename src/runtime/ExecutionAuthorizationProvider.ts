import { createRuntimeFailure, RuntimeFailure } from "./RuntimeFailure.js";
import type { HostedMcpAuthorization } from "../mcp/hosted-contracts.js";

type RenewalResponse = {
  version: "execution-authorization-renewal-v1";
  executionTicket: string;
  expiresAt: string;
  renewAfter: string;
};

export class ExecutionAuthorizationProvider {
  private ticket: string;
  private expiresAt: number;
  private renewAfter: number;
  private renewalInFlight: Promise<string> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private terminalFailure: RuntimeFailure | undefined;

  constructor(private readonly input: {
    authorization: HostedMcpAuthorization;
    fetchImpl?: typeof fetch | undefined;
    onRenew?(ticket: string): Promise<void> | void;
  }) {
    this.ticket = input.authorization.executionTicket;
    this.expiresAt = readTicketExpiry(this.ticket);
    this.renewAfter = Math.max(Date.now(), this.expiresAt - 60_000);
    this.schedule();
  }

  get currentTicket() {
    return this.ticket;
  }

  async getTicket(options: { forceRenew?: boolean } = {}) {
    if (this.terminalFailure !== undefined) throw this.terminalFailure;
    if (this.closed) {
      throw createRuntimeFailure(
        "EXECUTION_AUTH_RENEWAL_DENIED",
        "Execution authorization is no longer active.",
        { recoverable: false },
      );
    }
    if (
      options.forceRenew === true ||
      (this.input.authorization.renewal !== undefined && Date.now() >= this.renewAfter)
    ) {
      return this.renew();
    }
    if (Date.now() >= this.expiresAt) {
      throw createRuntimeFailure(
        "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
        "Execution authorization expired before it could be renewed.",
        { recoverable: false },
      );
    }
    return this.ticket;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private renew(): Promise<string> {
    if (this.renewalInFlight) return this.renewalInFlight;
    const renewal = this.input.authorization.renewal;
    if (!renewal) {
      return Promise.reject(createRuntimeFailure(
        "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
        "This execution does not carry renewable authorization.",
        { recoverable: false },
      ));
    }
    this.renewalInFlight = (async () => {
      let response: Response;
      try {
        response = await (this.input.fetchImpl ?? fetch)(renewal.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${renewal.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ executionTicket: this.ticket }),
        });
      } catch {
        throw createRuntimeFailure(
          "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
          "The execution authorization service is unavailable.",
          { recoverable: Date.now() < this.expiresAt },
        );
      }
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const error = asRecord(body?.error);
        const code = error?.code === "EXECUTION_AUTH_RENEWAL_DENIED"
          ? "EXECUTION_AUTH_RENEWAL_DENIED"
          : "EXECUTION_AUTH_RENEWAL_UNAVAILABLE";
        throw createRuntimeFailure(
          code,
          code === "EXECUTION_AUTH_RENEWAL_DENIED"
            ? "Execution authorization renewal was denied."
            : "The execution authorization service is unavailable.",
          { recoverable: code !== "EXECUTION_AUTH_RENEWAL_DENIED" && Date.now() < this.expiresAt },
        );
      }
      const parsed = parseRenewalResponse(body);
      if (this.closed) {
        throw createRuntimeFailure(
          "EXECUTION_AUTH_RENEWAL_DENIED",
          "Execution authorization is no longer active.",
          { recoverable: false },
        );
      }
      this.ticket = parsed.executionTicket;
      this.expiresAt = Date.parse(parsed.expiresAt);
      this.renewAfter = Date.parse(parsed.renewAfter);
      await this.input.onRenew?.(this.ticket);
      this.schedule();
      return this.ticket;
    })().catch((error: unknown) => {
      if (
        error instanceof RuntimeFailure &&
        (error.code === "EXECUTION_AUTH_RENEWAL_DENIED" ||
          Date.now() >= this.expiresAt)
      ) {
        this.terminalFailure = error;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
      }
      throw error;
    }).finally(() => {
      this.renewalInFlight = undefined;
    });
    return this.renewalInFlight;
  }

  private schedule() {
    if (this.closed || this.input.authorization.renewal === undefined) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.renew().catch(() => {
        if (!this.closed && Date.now() < this.expiresAt) {
          this.timer = setTimeout(() => void this.renew().catch(() => {}), 15_000);
          this.timer.unref();
        }
      });
    }, Math.max(1, this.renewAfter - Date.now()));
    this.timer.unref();
  }
}

function parseRenewalResponse(value: unknown): RenewalResponse {
  const record = asRecord(value);
  if (
    record?.version !== "execution-authorization-renewal-v1" ||
    typeof record.executionTicket !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.renewAfter !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    !Number.isFinite(Date.parse(record.renewAfter))
  ) {
    throw createRuntimeFailure(
      "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
      "The execution authorization service returned an invalid response.",
      { recoverable: false },
    );
  }
  return record as RenewalResponse;
}

function readTicketExpiry(ticket: string) {
  try {
    const payload = ticket.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof decoded.expiresAt === "number" && Number.isFinite(decoded.expiresAt)) {
      return decoded.expiresAt * 1000;
    }
  } catch {}
  return Date.now() + 300_000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
