import { createRuntimeFailure, RuntimeFailure } from "./RuntimeFailure.js";
import type { HostedMcpAuthorization } from "../mcp/hosted-contracts.js";

type RenewalResponse = {
  version: "execution-authorization-renewal-v1";
  executionTicket: string;
  expiresAt: string;
  renewAfter: string;
};

export type ExecutionAuthorizationRenewalDiagnostic = {
  type: "execution.authorization.renewal";
  attempt: number;
  remainingMs: number;
  outcome:
    | "renewed"
    | "transport_failure"
    | "http_failure"
    | "denied"
    | "invalid_response"
    | "expired";
  runId?: string | undefined;
  httpStatus?: number | undefined;
};

const RENEWAL_RETRY_DELAY_MS = 15_000;

export class ExecutionAuthorizationProvider {
  private ticket: string;
  private expiresAt: number;
  private renewAfter: number;
  private renewalInFlight: Promise<string> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private terminalFailure: RuntimeFailure | undefined;
  private attempt = 0;

  constructor(private readonly input: {
    authorization: HostedMcpAuthorization;
    fetchImpl?: typeof fetch | undefined;
    runId?: string | undefined;
    onRenew?(ticket: string): Promise<void> | void;
    onDiagnostic?(event: ExecutionAuthorizationRenewalDiagnostic): void;
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
    if (this.renewalInFlight) return this.renewalInFlight;
    if (Date.now() >= this.expiresAt) {
      throw this.expire();
    }
    if (
      options.forceRenew === true ||
      (this.input.authorization.renewal !== undefined && Date.now() >= this.renewAfter)
    ) {
      return this.renew();
    }
    return this.ticket;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private renew(): Promise<string> {
    if (this.terminalFailure !== undefined) {
      return Promise.reject(this.terminalFailure);
    }
    if (this.renewalInFlight) return this.renewalInFlight;
    if (Date.now() >= this.expiresAt) {
      return Promise.reject(this.expire());
    }
    const renewal = this.input.authorization.renewal;
    if (!renewal) {
      return Promise.reject(createRuntimeFailure(
        "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
        "This execution does not carry renewable authorization.",
        { recoverable: false },
      ));
    }
    const attempt = this.attempt + 1;
    this.attempt = attempt;
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
        this.emitDiagnostic({ attempt, outcome: "transport_failure" });
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
        this.emitDiagnostic({
          attempt,
          outcome: code === "EXECUTION_AUTH_RENEWAL_DENIED"
            ? "denied"
            : "http_failure",
          httpStatus: response.status,
        });
        throw createRuntimeFailure(
          code,
          code === "EXECUTION_AUTH_RENEWAL_DENIED"
            ? "Execution authorization renewal was denied."
            : "The execution authorization service is unavailable.",
          { recoverable: code !== "EXECUTION_AUTH_RENEWAL_DENIED" && Date.now() < this.expiresAt },
        );
      }
      let parsed: RenewalResponse;
      try {
        parsed = parseRenewalResponse(body);
      } catch (error) {
        this.emitDiagnostic({ attempt, outcome: "invalid_response" });
        throw error;
      }
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
      this.emitDiagnostic({ attempt, outcome: "renewed" });
      this.attempt = 0;
      this.schedule();
      return this.ticket;
    })().catch((error: unknown) => {
      if (error instanceof RuntimeFailure) {
        const recoverable = error.details?.recoverable === true &&
          Date.now() < this.expiresAt;
        if (recoverable) {
          this.scheduleRetry();
        } else {
          this.terminalFailure = error;
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
        }
      } else {
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
    this.scheduleAfter(Math.max(1, this.renewAfter - Date.now()));
  }

  private scheduleRetry() {
    if (this.closed || Date.now() >= this.expiresAt) return;
    this.scheduleAfter(Math.min(
      RENEWAL_RETRY_DELAY_MS,
      Math.max(1, this.expiresAt - Date.now()),
    ));
  }

  private scheduleAfter(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.renew().catch(() => {});
    }, delayMs);
    this.timer.unref();
  }

  private expire() {
    if (this.terminalFailure !== undefined) return this.terminalFailure;
    const failure = createRuntimeFailure(
      "EXECUTION_AUTH_RENEWAL_UNAVAILABLE",
      "Execution authorization expired before it could be renewed.",
      { recoverable: false },
    );
    this.terminalFailure = failure;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.emitDiagnostic({
      attempt: this.attempt,
      outcome: "expired",
    });
    return failure;
  }

  private emitDiagnostic(
    event: Pick<
      ExecutionAuthorizationRenewalDiagnostic,
      "attempt" | "outcome" | "httpStatus"
    >,
  ) {
    const diagnostic: ExecutionAuthorizationRenewalDiagnostic = {
      type: "execution.authorization.renewal",
      attempt: event.attempt,
      remainingMs: Math.max(0, this.expiresAt - Date.now()),
      outcome: event.outcome,
      ...(this.input.runId !== undefined ? { runId: this.input.runId } : {}),
      ...(event.httpStatus !== undefined
        ? { httpStatus: event.httpStatus }
        : {}),
    };
    try {
      if (this.input.onDiagnostic) {
        this.input.onDiagnostic(diagnostic);
      } else {
        process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
      }
    } catch {
      // Diagnostics must never affect authorization behavior.
    }
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
