import assert from "node:assert/strict";

import { createKestrelOneVisualCrossingWeatherAdapter } from "../../tools/free/kestrelOneWeatherProvider.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Kestrel One Visual Crossing transport keeps provider credentials behind the App broker", async () => {
  let requestUrl = "";
  let authorization = "";
  let requestBody: unknown;
  const adapter = createKestrelOneVisualCrossingWeatherAdapter({
    appUrl: "https://kestrel.example",
    executionTicket: "execution-ticket",
    fetchImpl: (async (url, init) => {
      requestUrl = String(url);
      authorization = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      );
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          latitude: 42.36,
          longitude: -71.06,
          currentConditions: {
            temp: 22.4,
            datetimeEpoch: 1_789_564_500,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  const output = await adapter.current({
    toolName: "free.weather.current",
    latitude: 42.36,
    longitude: -71.06,
  });

  assert.equal(
    requestUrl,
    "https://kestrel.example/api/runtime/apps/built_in.weather/getWeather/auto/timeline",
  );
  assert.equal(authorization, "Bearer execution-ticket");
  assert.deepEqual(requestBody, {
    latitude: 42.36,
    longitude: -71.06,
    include: "current",
    timezone: "UTC",
  });
  assert.equal(output.source, "visual-crossing");
  assert.equal(JSON.stringify(output).includes("execution-ticket"), false);
});
