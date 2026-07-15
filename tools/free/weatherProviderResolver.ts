import type { SharedToolContext } from "../contracts.js";
import { createKestrelOneVisualCrossingWeatherAdapter } from "./kestrelOneWeatherProvider.js";
import { createOpenMeteoWeatherAdapter } from "./openMeteoWeather.js";
import { createVisualCrossingWeatherAdapter } from "./visualCrossingWeather.js";
import type { WeatherProviderAdapter } from "./weatherProvider.js";

export interface WeatherProviderSet {
  primary: {
    key: "open-meteo";
    adapter: WeatherProviderAdapter;
  };
  fallback:
    | {
        key: "visual-crossing";
        availability: "configured" | "hosted-broker";
        adapter: WeatherProviderAdapter;
      }
    | undefined;
}

/**
 * Resolve provider transports only. This function intentionally does not
 * decide timeouts, failure eligibility, retries, or whether fallback runs.
 */
export function resolveWeatherProviderSet(
  context: SharedToolContext,
): WeatherProviderSet {
  const primary = {
    key: "open-meteo" as const,
    adapter: createOpenMeteoWeatherAdapter({ fetchImpl: context.fetchImpl }),
  };
  const hosted = context.kestrelOne;
  if (hosted?.appUrl?.trim() && hosted.executionTicket?.trim()) {
    return {
      primary,
      fallback: {
        key: "visual-crossing",
        availability: "hosted-broker",
        adapter: createKestrelOneVisualCrossingWeatherAdapter({
          appUrl: hosted.appUrl,
          executionTicket: hosted.executionTicket,
          approvalModes: hosted.appApprovalModes,
          fetchImpl: context.fetchImpl,
        }),
      },
    };
  }
  const configuration =
    context.providerConfigurations?.resolve("visual-crossing");
  const credential = configuration?.readCredential();
  return {
    primary,
    fallback:
      credential === undefined
        ? undefined
        : {
            key: "visual-crossing",
            availability: "configured",
            adapter: createVisualCrossingWeatherAdapter({
              apiKey: credential,
              baseUrl: configuration?.baseUrl,
              fetchImpl: context.fetchImpl,
            }),
          },
  };
}
