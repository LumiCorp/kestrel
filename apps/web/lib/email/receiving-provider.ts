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

export type CreatedResendWebhook = {
  /** Persist this provider identity before any follow-up provider request. */
  id: string;
  /** One-time secret-bearing evidence. This must never enter a public projection. */
  signingSecret: string;
};

/**
 * Serializable provider intent that must be durably stored before create is
 * attempted. It deliberately excludes credentials and provider evidence.
 */
export type ResendWebhookCreateIntent = {
  endpoint: string;
  events: ["email.received"];
};

export function prepareResendWebhookCreateIntent(
  endpoint: string,
): ResendWebhookCreateIntent {
  return {
    endpoint: exactText(endpoint),
    events: ["email.received"],
  };
}

export type ResendWebhookUpdateEvidence = {
  id: string;
  applied: {
    endpoint?: string;
    status?: "enabled" | "disabled";
  };
};

export interface ResendReceivingProvider {
  listDomains(apiKey: string): Promise<ResendReceivingDomain[]>;
  getDomain(apiKey: string, domainId: string): Promise<ResendReceivingDomain>;
  /** Create only; the caller must persist this evidence before disabling it. */
  createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook>;
  /** Retrieve separately so creation and mutation evidence can be persisted first. */
  getWebhook(
    apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection>;
  /** Mutate only; retrieval and reconciliation remain explicit retry steps. */
  updateWebhook(input: {
    apiKey: string;
    webhookId: string;
    endpoint?: string;
    enabled?: boolean;
  }): Promise<ResendWebhookUpdateEvidence>;
  removeWebhook(apiKey: string, webhookId: string): Promise<void>;
}

/** Adopt this stronger contract only with durable webhook staging storage. */
export interface ResendWebhookCreateRecoveryProvider
  extends ResendReceivingProvider {
  /**
   * Recover an ambiguous create from its previously persisted intent. This
   * operation only lists and retrieves; it never creates another webhook.
   */
  reconcileWebhookCreate(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook>;
}

/** Provider lifecycle operations required before deleting their local owner. */
export interface ResendWebhookDecommissionProvider
  extends ResendWebhookCreateRecoveryProvider {
  /**
   * Retrieve a webhook while preserving an explicit provider 404 as absence
   * evidence. Other provider failures must still reject.
   */
  getWebhookIfPresent(
    apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection | null>;
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
      | "RESEND_RECEIVING_REQUEST_INVALID"
      | "RESEND_RECEIVING_PROVIDER_UNAVAILABLE"
      | "RESEND_RECEIVING_RESPONSE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ResendReceivingProviderError";
  }
}

export class ResendHttpReceivingProvider
  implements ResendWebhookDecommissionProvider
{
  readonly #fetch: ReceivingFetch;
  readonly #baseUrl: URL;

  constructor(input: { fetchImpl?: ReceivingFetch; baseUrl?: string } = {}) {
    this.#fetch = input.fetchImpl ?? fetch;
    this.#baseUrl = new URL(input.baseUrl ?? "https://api.resend.com");
  }

  async listDomains(apiKey: string): Promise<ResendReceivingDomain[]> {
    const rows = parseCompleteList(await this.#request(apiKey, "/domains"));
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
    const domain = parseDomain(
      await this.#request(apiKey, `/domains/${encodeURIComponent(domainId)}`),
    );
    if (domain.id !== domainId) throw invalidResponse();
    return domain;
  }

  async createWebhook(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook> {
    const intent = parseWebhookCreateIntent(input.intent);
    const body = record(
      await this.#request(input.apiKey, "/webhooks", {
        method: "POST",
        body: JSON.stringify({
          endpoint: intent.endpoint,
          events: intent.events,
        }),
      }),
    );
    const signingSecret = text(body.signing_secret);
    const id = text(body.id);
    return {
      id,
      signingSecret,
    };
  }

  async reconcileWebhookCreate(input: {
    apiKey: string;
    intent: ResendWebhookCreateIntent;
  }): Promise<CreatedResendWebhook> {
    const intent = parseWebhookCreateIntent(input.intent);
    const webhooks: ResendWebhookProjection[] = [];
    const cursors = new Set<string>();
    const webhookIds = new Set<string>();
    let after: string | undefined;
    while (true) {
      const page = parseWebhookListPage(
        await this.#request(
          input.apiKey,
          `/webhooks?limit=100${
            after === undefined ? "" : `&after=${encodeURIComponent(after)}`
          }`,
        ),
      );
      if (after && page.data.some((webhook) => webhook.id === after)) {
        throw invalidResponse();
      }
      for (const webhook of page.data) {
        if (webhookIds.has(webhook.id)) throw invalidResponse();
        webhookIds.add(webhook.id);
      }
      webhooks.push(...page.data);
      if (!page.hasMore) break;
      const nextCursor = page.data.at(-1)?.id;
      if (!nextCursor || nextCursor === after || cursors.has(nextCursor)) {
        throw invalidResponse();
      }
      cursors.add(nextCursor);
      after = nextCursor;
    }
    const matches = webhooks.filter((webhook) =>
      webhookMatchesCreateIntent(webhook, intent),
    );
    if (matches.length !== 1) throw invalidResponse();

    const match = matches[0];
    if (!match) throw invalidResponse();
    const retrieved = record(
      await this.#request(
        input.apiKey,
        `/webhooks/${encodeURIComponent(match.id)}`,
      ),
    );
    const projection = parseWebhook(retrieved);
    if (
      !webhookProjectionsAgree(match, projection) ||
      projection.status !== "enabled"
    ) {
      throw invalidResponse();
    }
    return {
      id: projection.id,
      signingSecret: text(retrieved.signing_secret),
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

  async getWebhookIfPresent(
    apiKey: string,
    webhookId: string,
  ): Promise<ResendWebhookProjection | null> {
    const response = await this.#request(
      apiKey,
      `/webhooks/${encodeURIComponent(webhookId)}`,
      {},
      [404],
    );
    return acceptedProviderStatus(response, 404)
      ? null
      : parseWebhook(response);
  }

  async updateWebhook(input: {
    apiKey: string;
    webhookId: string;
    endpoint?: string;
    enabled?: boolean;
  }): Promise<ResendWebhookUpdateEvidence> {
    const applied = {
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      ...(input.enabled === undefined
        ? {}
        : {
            status: input.enabled
              ? ("enabled" as const)
              : ("disabled" as const),
          }),
    };
    const response = record(
      await this.#request(
        input.apiKey,
        `/webhooks/${encodeURIComponent(input.webhookId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(applied),
        },
      ),
    );
    const id = text(response.id);
    if (id !== input.webhookId) throw invalidResponse();
    return { id, applied };
  }

  async removeWebhook(apiKey: string, webhookId: string): Promise<void> {
    await this.#request(
      apiKey,
      `/webhooks/${encodeURIComponent(webhookId)}`,
      {
        method: "DELETE",
      },
      [404],
    );
  }

  async #request(
    apiKey: string,
    path: string,
    init: RequestInit = {},
    acceptedStatuses: readonly number[] = [],
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
    if (acceptedStatuses.includes(response.status)) {
      return { acceptedProviderStatus: response.status };
    }
    if (response.status === 401 || response.status === 403) {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
        "Resend receiving requires a Full access API key.",
      );
    }
    if (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 429
    ) {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
        "Resend receiving is temporarily unavailable.",
      );
    }
    if (response.status === 404) {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_DOMAIN_INVALID",
        "The selected Resend resource is unavailable.",
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new ResendReceivingProviderError(
        "RESEND_RECEIVING_REQUEST_INVALID",
        "Resend rejected the receiving request.",
      );
    }
    if (!response.ok) throw invalidResponse();
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw invalidResponse();
    }
  }
}

function parseCompleteList(value: unknown): unknown[] {
  const envelope = record(value);
  if (
    envelope.object !== "list" ||
    envelope.has_more !== false ||
    !Array.isArray(envelope.data)
  ) {
    throw invalidResponse();
  }
  return envelope.data;
}

function parseWebhookListPage(value: unknown): {
  data: ResendWebhookProjection[];
  hasMore: boolean;
} {
  const envelope = record(value);
  if (
    envelope.object !== "list" ||
    typeof envelope.has_more !== "boolean" ||
    !Array.isArray(envelope.data)
  ) {
    throw invalidResponse();
  }
  const data = envelope.data.map(parseWebhook);
  if (envelope.has_more && data.length === 0) throw invalidResponse();
  return { data, hasMore: envelope.has_more };
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

function mapDomainStatus(value: unknown): ResendReceivingDomain["status"] {
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
    endpoint: exactText(webhook.endpoint),
    status: enumValue(webhook.status, ["enabled", "disabled"]),
    events: webhook.events.map(exactText),
  };
}

function parseWebhookCreateIntent(
  value: ResendWebhookCreateIntent,
): ResendWebhookCreateIntent {
  const intent = record(value);
  if (
    !Array.isArray(intent.events) ||
    intent.events.length !== 1 ||
    intent.events[0] !== "email.received"
  ) {
    throw invalidResponse();
  }
  return {
    endpoint: exactText(intent.endpoint),
    events: ["email.received"],
  };
}

function webhookMatchesCreateIntent(
  webhook: ResendWebhookProjection,
  intent: ResendWebhookCreateIntent,
): boolean {
  return (
    webhook.endpoint === intent.endpoint &&
    webhook.events.length === 1 &&
    webhook.events[0] === "email.received"
  );
}

function webhookProjectionsAgree(
  listed: ResendWebhookProjection,
  retrieved: ResendWebhookProjection,
): boolean {
  return (
    retrieved.id === listed.id &&
    retrieved.endpoint === listed.endpoint &&
    retrieved.status === listed.status &&
    retrieved.events.length === listed.events.length &&
    retrieved.events.every((event, index) => event === listed.events[index])
  );
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

function exactText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value !== value.trim()
  ) {
    throw invalidResponse();
  }
  return value;
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

function acceptedProviderStatus(value: unknown, status: number): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, "acceptedProviderStatus") === status
  );
}
