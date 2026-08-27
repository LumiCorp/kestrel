export type ResendReceivingDomain = {
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  receiving: "enabled" | "disabled";
  mxStatus: "unknown" | "pending" | "verified" | "failed";
};

export type ResendWebhookProjection = {
  id: string;
  endpoint: string;
  status: "enabled" | "disabled";
  events: string[];
};

export type CreatedResendWebhook = ResendWebhookProjection & {
  signingSecret: string;
};

export interface ResendReceivingProvider {
  listDomains(apiKey: string): Promise<ResendReceivingDomain[]>;
  getDomain(apiKey: string, domainId: string): Promise<ResendReceivingDomain>;
  createWebhook(input: {
    apiKey: string;
    endpoint: string;
    events: ["email.received"];
    enabled: boolean;
  }): Promise<CreatedResendWebhook>;
  getWebhook(apiKey: string, webhookId: string): Promise<ResendWebhookProjection>;
  updateWebhook(input: {
    apiKey: string;
    webhookId: string;
    endpoint?: string;
    enabled?: boolean;
  }): Promise<ResendWebhookProjection>;
  removeWebhook(apiKey: string, webhookId: string): Promise<void>;
}

type ReceivingFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ResendReceivingProviderError extends Error {
  constructor(
    readonly code:
      | "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT"
      | "RESEND_RECEIVING_DOMAIN_INVALID"
      | "RESEND_RECEIVING_PROVIDER_UNAVAILABLE"
      | "RESEND_RECEIVING_RESPONSE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ResendReceivingProviderError";
  }
}

export class ResendHttpReceivingProvider implements ResendReceivingProvider {
  readonly #fetch: ReceivingFetch;
  readonly #baseUrl: URL;

  constructor(input: { fetchImpl?: ReceivingFetch; baseUrl?: string } = {}) {
    this.#fetch = input.fetchImpl ?? fetch;
    this.#baseUrl = new URL(input.baseUrl ?? "https://api.resend.com");
  }

  async listDomains(apiKey: string): Promise<ResendReceivingDomain[]> {
    const payload = await this.#request(apiKey, "/domains");
    const rows = record(payload).data;
    if (!Array.isArray(rows)) throw invalidResponse();
    const summaries = rows.map(parseDomain);
    return await Promise.all(
      summaries.map((domain) =>
        domain.receiving === "enabled"
          ? this.getDomain(apiKey, domain.id)
          : domain,
      ),
    );
  }

  async getDomain(
    apiKey: string,
    domainId: string,
  ): Promise<ResendReceivingDomain> {
    return parseDomain(
      await this.#request(apiKey, `/domains/${encodeURIComponent(domainId)}`),
    );
  }

  async createWebhook(input: {
    apiKey: string;
    endpoint: string;
    events: ["email.received"];
    enabled: boolean;
  }): Promise<CreatedResendWebhook> {
    const body = record(
      await this.#request(input.apiKey, "/webhooks", {
        method: "POST",
        body: JSON.stringify({
          endpoint: input.endpoint,
          events: input.events,
        }),
      }),
    );
    const signingSecret = text(body.signing_secret);
    const id = text(body.id);
    if (!input.enabled) {
      await this.#request(input.apiKey, `/webhooks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "disabled" }),
      });
    }
    return {
      ...(await this.getWebhook(input.apiKey, id)),
      signingSecret,
    };
  }

  async getWebhook(
    apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection> {
    return parseWebhook(
      await this.#request(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`),
    );
  }

  async updateWebhook(input: {
    apiKey: string;
    webhookId: string;
    endpoint?: string;
    enabled?: boolean;
  }): Promise<ResendWebhookProjection> {
    await this.#request(
      input.apiKey,
      `/webhooks/${encodeURIComponent(input.webhookId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.endpoint ? { endpoint: input.endpoint } : {}),
          ...(input.enabled === undefined
            ? {}
            : { status: input.enabled ? "enabled" : "disabled" }),
        }),
      },
    );
    return await this.getWebhook(input.apiKey, input.webhookId);
  }

  async removeWebhook(apiKey: string, webhookId: string): Promise<void> {
    await this.#request(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, {
      method: "DELETE",
    });
  }

  async #request(
    apiKey: string,
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "user-agent": "Kestrel-One/1.0",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    } catch {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
        "Resend receiving is temporarily unavailable.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
        "Resend receiving requires a Full access API key.",
      );
    }
    if (!response.ok) {
      throw new ResendReceivingProviderError(
        response.status === 404
          ? "RESEND_RECEIVING_DOMAIN_INVALID"
          : "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
        response.status === 404
          ? "The selected Resend resource is unavailable."
          : "Resend receiving is temporarily unavailable.",
      );
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw invalidResponse();
    }
  }
}

function parseDomain(value: unknown): ResendReceivingDomain {
  const domain = record(value);
  const capabilities = record(domain.capabilities);
  const providerStatus = mapDomainStatus(domain.status);
  const receiving = enumValue(capabilities.receiving, ["enabled", "disabled"]);
  const records = Array.isArray(domain.records) ? domain.records : [];
  const mxRecord = records
    .map(record)
    .find((entry) => entry.record === "Receiving MX" && entry.type === "MX");
  const mxStatus = mxRecord ? mapDomainStatus(mxRecord.status) : "unknown";
  const status =
    receiving === "enabled" && mxStatus === "verified"
      ? "verified"
      : providerStatus;
  return {
    id: text(domain.id),
    name: text(domain.name).toLowerCase(),
    status,
    receiving,
    mxStatus,
  };
}

function mapDomainStatus(
  value: unknown,
): ResendReceivingDomain["status"] {
  switch (text(value)) {
    case "verified":
      return "verified";
    case "not_started":
    case "pending":
    case "partially_verified":
      return "pending";
    case "failed":
    case "partially_failed":
    case "temporary_failure":
    case "temporarily_failed":
      return "failed";
    default:
      throw invalidResponse();
  }
}

function parseWebhook(value: unknown): ResendWebhookProjection {
  const webhook = record(value);
  if (!Array.isArray(webhook.events)) throw invalidResponse();
  return {
    id: text(webhook.id),
    endpoint: text(webhook.endpoint),
    status: enumValue(webhook.status, ["enabled", "disabled"]),
    events: webhook.events.map(text),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse();
  return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  const parsed = text(value) as T;
  if (!allowed.includes(parsed)) throw invalidResponse();
  return parsed;
}

function invalidResponse() {
  return new ResendReceivingProviderError(
    "RESEND_RECEIVING_RESPONSE_INVALID",
    "Resend returned an invalid receiving response.",
  );
}
