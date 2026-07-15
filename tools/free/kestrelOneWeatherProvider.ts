import type { SharedToolContext } from "../contracts.js";
import {
  ensureFetchOk,
  parseJsonRecord,
} from "../helpers.js";
import {
  createVisualCrossingWeatherAdapterFromTransport,
  type VisualCrossingWeatherAdapter,
} from "./visualCrossingWeather.js";

const CAPABILITY_RUNTIME_NAMES = {
  getWeather: "free.weather.current",
  forecast: "free.weather.forecast",
} as const;

type WeatherCapabilityKey = keyof typeof CAPABILITY_RUNTIME_NAMES;

/**
 * Use Kestrel One's exact App broker as the Visual Crossing transport. The
 * execution ticket authorizes the Project/Environment boundary; provider
 * credentials remain server-side and never enter shared runtime context.
 */
export function createKestrelOneVisualCrossingWeatherAdapter(input: {
  appUrl: string;
  executionTicket: string;
  approvalModes?: Record<string, "auto" | "ask"> | undefined;
  fetchImpl?: typeof fetch | undefined;
}): VisualCrossingWeatherAdapter {
  const fetchImpl = input.fetchImpl ?? fetch;
  return createVisualCrossingWeatherAdapterFromTransport({
    async request(request) {
      const capability: WeatherCapabilityKey =
        request.include === "current" ? "getWeather" : "forecast";
      const runtimeName = CAPABILITY_RUNTIME_NAMES[capability];
      const approval =
        input.approvalModes?.[runtimeName] === "ask" ? "confirmed" : "auto";
      const url = new URL(
        `/api/runtime/apps/built_in.weather/${capability}/${approval}/timeline`,
        input.appUrl,
      );
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.executionTicket}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          latitude: request.latitude,
          longitude: request.longitude,
          include: request.include,
          timezone: request.timezone,
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      ensureFetchOk(request.toolName, "visual-crossing", response, {
        latitude: request.latitude,
        longitude: request.longitude,
        transport: "kestrel-one-app-broker",
      });
      return parseJsonRecord(
        request.toolName,
        "visual-crossing",
        await response.json(),
        { transport: "kestrel-one-app-broker" },
      );
    },
  });
}

export function hasKestrelOneWeatherContext(
  context: SharedToolContext,
): context is SharedToolContext & {
  kestrelOne: {
    appUrl: string;
    executionTicket: string;
    appApprovalModes?: Record<string, "auto" | "ask"> | undefined;
  };
} {
  return Boolean(
    context.kestrelOne?.appUrl?.trim() &&
      context.kestrelOne.executionTicket?.trim(),
  );
}
