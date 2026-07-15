import type { AppCredentialPayload } from "./credential-crypto";
import type { CreateEnvironmentAppConnectionInput } from "./contracts";
import {
  assertTavilyProxyTarget,
  TAVILY_RUNTIME_CAPABILITIES,
} from "./tavily-contract";
import { validateTavilyConnection } from "./tavily-connection";
import { validateVisualCrossingConnection } from "./weather-connection";

export type AppProviderAuthMethod =
  | "none"
  | "api_key"
  | "oauth_personal"
  | "oauth_environment"
  | "deployment_managed";

export type AppConnectionHealth = {
  status: "connected";
  checkedAt: Date;
};

export type AppProviderRuntimeRequest = {
  url: URL;
  init: RequestInit;
  timeoutMs?: number | undefined;
};

export class AppProviderRuntimeContractError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400
  ) {
    super(code);
    this.name = "AppProviderRuntimeContractError";
  }
}

export type AppProviderAdapter = {
  appKey: string;
  authMethods: readonly AppProviderAuthMethod[];
  validateEnvironmentConnection?: (
    input: CreateEnvironmentAppConnectionInput
  ) => Promise<AppConnectionHealth>;
  createEnvironmentCredential?: (
    input: CreateEnvironmentAppConnectionInput
  ) => AppCredentialPayload;
  runtime?: {
    capabilityKeys: readonly string[];
    assertTarget: (input: {
      capability: string;
      method: string;
      path: string[];
    }) => void;
    createRequest: (input: {
      capability: string;
      method: string;
      path: string[];
      body?: ArrayBuffer | undefined;
      credential: AppCredentialPayload | null;
    }) => AppProviderRuntimeRequest;
    degradedStatusCodes: readonly number[];
    reconnectFailureCode: string;
  };
};

const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";

const tavilyAdapter: AppProviderAdapter = {
  appKey: "tavily",
  authMethods: ["api_key"],
  validateEnvironmentConnection: validateTavilyConnection,
  createEnvironmentCredential(input) {
    return {
      kind: "api_key",
      apiKey: input.apiKey,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    };
  },
  runtime: {
    capabilityKeys: TAVILY_RUNTIME_CAPABILITIES,
    assertTarget(input) {
      assertTavilyProxyTarget({
        capability: input.capability as (typeof TAVILY_RUNTIME_CAPABILITIES)[number],
        method: input.method,
        path: input.path,
      });
    },
    createRequest(input) {
      if (input.credential?.kind !== "api_key") {
        throw new Error("Tavily requires an API-key credential.");
      }
      const baseUrl = ensureTrailingSlash(
        input.credential.baseUrl ?? DEFAULT_TAVILY_BASE_URL
      );
      return {
        url: new URL(
          input.path.map(encodeURIComponent).join("/"),
          baseUrl
        ),
        init: {
          method: input.method,
          headers: {
            Authorization: `Bearer ${input.credential.apiKey}`,
            ...(input.method === "POST"
              ? { "content-type": "application/json" }
              : {}),
            "X-Client-Source": "kestrel-one",
            ...(input.credential.projectId
              ? { "X-Project-ID": input.credential.projectId }
              : {}),
          },
          ...(input.body ? { body: input.body } : {}),
          cache: "no-store",
        },
        timeoutMs: 120_000,
      };
    },
    degradedStatusCodes: [401, 403],
    reconnectFailureCode: "TAVILY_RECONNECT_REQUIRED",
  },
};

const weatherAdapter: AppProviderAdapter = {
  appKey: "built_in.weather",
  authMethods: ["api_key"],
  validateEnvironmentConnection: validateVisualCrossingConnection,
  createEnvironmentCredential(input) {
    return {
      kind: "api_key",
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    };
  },
  runtime: {
    capabilityKeys: ["getWeather", "forecast"],
    assertTarget(input) {
      if (
        input.method === "POST" &&
        input.path.length === 1 &&
        input.path[0] === "timeline" &&
        (input.capability === "getWeather" || input.capability === "forecast")
      ) {
        return;
      }
      throw new AppProviderRuntimeContractError(
        "WEATHER_PROXY_TARGET_DENIED",
        404
      );
    },
    createRequest(input) {
      if (input.credential?.kind !== "api_key") {
        throw new AppProviderRuntimeContractError(
          "WEATHER_FALLBACK_CONNECTION_REQUIRED",
          409
        );
      }
      const request = parseWeatherRuntimeBody(input.body);
      const expectedInclude =
        input.capability === "getWeather" ? "current" : "current,days,hours";
      if (request.include !== expectedInclude) {
        throw new AppProviderRuntimeContractError(
          "WEATHER_PROXY_PAYLOAD_DENIED"
        );
      }
      const baseUrl = ensureTrailingSlash(
        input.credential.baseUrl ?? DEFAULT_VISUAL_CROSSING_BASE_URL
      );
      const url = new URL(
        `${encodeURIComponent(request.latitude)},${encodeURIComponent(request.longitude)}`,
        baseUrl
      );
      url.searchParams.set("key", input.credential.apiKey);
      url.searchParams.set("unitGroup", "metric");
      url.searchParams.set("include", request.include);
      url.searchParams.set("contentType", "json");
      url.searchParams.set("timezone", request.timezone);
      return {
        url,
        init: { method: "GET", cache: "no-store" },
      };
    },
    degradedStatusCodes: [401, 403],
    reconnectFailureCode: "VISUAL_CROSSING_RECONNECT_REQUIRED",
  },
};

const PROVIDER_ADAPTERS = new Map(
  [weatherAdapter, tavilyAdapter].map((adapter) => [adapter.appKey, adapter])
);

export function getAppProviderAdapter(appKey: string) {
  return PROVIDER_ADAPTERS.get(appKey) ?? null;
}

export function listAppProviderAdapters() {
  return [...PROVIDER_ADAPTERS.values()];
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

const DEFAULT_VISUAL_CROSSING_BASE_URL =
  "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/";

function parseWeatherRuntimeBody(body: ArrayBuffer | undefined) {
  if (!body) {
    throw new AppProviderRuntimeContractError("WEATHER_PROXY_PAYLOAD_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new AppProviderRuntimeContractError("WEATHER_PROXY_PAYLOAD_INVALID");
  }
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new AppProviderRuntimeContractError("WEATHER_PROXY_PAYLOAD_INVALID");
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "latitude" &&
        key !== "longitude" &&
        key !== "include" &&
        key !== "timezone"
    ) ||
    typeof value.latitude !== "number" ||
    !Number.isFinite(value.latitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    typeof value.longitude !== "number" ||
    !Number.isFinite(value.longitude) ||
    value.longitude < -180 ||
    value.longitude > 180 ||
    (value.include !== "current" &&
      value.include !== "current,days,hours") ||
    typeof value.timezone !== "string" ||
    !value.timezone.trim() ||
    value.timezone.length > 128
  ) {
    throw new AppProviderRuntimeContractError("WEATHER_PROXY_PAYLOAD_INVALID");
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    include: value.include,
    timezone: value.timezone.trim(),
  };
}
