import assert from "node:assert/strict";

import {
  createToolProviderConfigurationResolver,
  createToolProviderRuntimeConfiguration,
} from "../../tools/providers/runtimeConfiguration.js";
import { resolveWeatherProviderSet } from "../../tools/free/weatherProviderResolver.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Weather provider resolution requires an explicitly scoped local fallback credential", () => {
  const unavailable = resolveWeatherProviderSet({});
  assert.equal(unavailable.primary.key, "open-meteo");
  assert.equal(unavailable.fallback, undefined);

  const configured = resolveWeatherProviderSet({
    providerConfigurations: createToolProviderConfigurationResolver([
      createToolProviderRuntimeConfiguration({
        providerKey: "visual-crossing",
        credential: "visual-secret",
      }),
    ]),
  });
  assert.equal(configured.fallback?.key, "visual-crossing");
  assert.equal(configured.fallback?.availability, "configured");
  assert.equal(JSON.stringify(configured).includes("visual-secret"), false);
});

contractTest("runtime.hermetic", "Weather provider resolution delegates hosted fallback credentials to Kestrel One", () => {
  const providers = resolveWeatherProviderSet({
    kestrelOne: {
      appUrl: "https://kestrel.example",
      executionTicket: "execution-ticket",
    },
  });
  assert.equal(providers.fallback?.availability, "hosted-broker");
  assert.equal(JSON.stringify(providers).includes("execution-ticket"), false);
});
