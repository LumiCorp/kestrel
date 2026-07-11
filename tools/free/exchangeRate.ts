import type { SharedToolModule } from "../contracts.js";
import {
  ensureFetchOk,
  fetchImplOrDefault,
  parseJsonRecord,
  parseObjectInput,
  readString,
} from "../helpers.js";

export const exchangeRateTool: SharedToolModule = {
  definition: {
    name: "free.exchange.rate",
    description: "Fetch FX rates from a base currency using open.er-api.com.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base currency code, e.g. USD" },
        quote: { type: "string", description: "Optional quote currency code, e.g. EUR" },
      },
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["finance.fx_rate"],
      suitability: {
        supportsAttribution: true,
        typicalFailureModes: ["unsupported_currency", "provider_unavailable"],
      },
    },
    presentation: {
      displayName: "Exchange Rate",
      aliases: ["exchange rate", "fx rate", "currency exchange"],
      keywords: ["exchange", "currency", "fx", "rate"],
      provider: "open-er-api",
      toolFamily: "finance",
    },
  },
  createHandler(context) {
    const fetchImpl = fetchImplOrDefault(context.fetchImpl);

    return async (input: unknown) => {
      const body = parseObjectInput("free.exchange.rate", input);
      const base = (readString(body, "base") ?? "USD").toUpperCase();
      const quote = readString(body, "quote")?.toUpperCase();

      const response = await fetchImpl(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
      ensureFetchOk("free.exchange.rate", "open-er-api", response, { base, quote });

      const payload = parseJsonRecord("free.exchange.rate", "open-er-api", await response.json(), { base, quote });
      const rates = parseJsonRecord("free.exchange.rate", "open-er-api", payload.rates ?? {}, {
        base,
        quote,
        field: "rates",
      });

      const quoteRate =
        quote !== undefined && typeof rates[quote] === "number"
          ? (rates[quote] as number)
          : undefined;

      return {
        source: "open.er-api.com",
        base,
        quote,
        rate: quoteRate,
        rates,
        updatedAt: readString(payload, "time_last_update_utc"),
      };
    };
  },
};
