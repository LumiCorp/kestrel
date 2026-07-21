import assert from "node:assert/strict";

import type { createTavilyClient } from "../../../tools/internet/client.js";
import {
  DesktopToolProviderVerificationError,
  verifyDesktopToolProvider,
} from "../src/toolProviderVerification.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "Tavily capability verification performs a bounded live request", async () => {
  let query = "";
  let options: unknown;
  const factory = (() => ({
    search: async (nextQuery: string, nextOptions: unknown) => {
      query = nextQuery;
      options = nextOptions;
      return { results: [] };
    },
  })) as unknown as typeof createTavilyClient;

  await verifyDesktopToolProvider({
    capabilityId: "tools.internet.tavily",
    credential: "secret",
    settings: createDefaultDesktopSettings(),
    tavilyClientFactory: factory,
  });

  assert.equal(query, "Kestrel capability verification");
  assert.deepEqual(options, { maxResults: 1, searchDepth: "basic", timeout: 5 });
});

contractTest("desktop.hermetic", "tool verification errors never include credential values", async () => {
  const secret = "credential-that-must-not-leak";
  await assert.rejects(
    verifyDesktopToolProvider({
      capabilityId: "tools.weather",
      credential: secret,
      settings: createDefaultDesktopSettings(),
      visualCrossingVerifier: async () => { throw new Error(secret); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopToolProviderVerificationError);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
