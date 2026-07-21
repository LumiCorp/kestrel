import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const authSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "auth.ts"),
  "utf8"
);

contractTest("web.hermetic", "the Next.js cookie bridge is the final Better Auth plugin", () => {
  const pluginsStart = authSource.indexOf("plugins: [");
  const pluginsEnd = authSource.indexOf("\n  ],", pluginsStart);
  const plugins = authSource.slice(pluginsStart, pluginsEnd);

  assert.ok(pluginsStart >= 0);
  assert.ok(pluginsEnd > pluginsStart);
  assert.match(plugins, /lastLoginMethod\(\),\s+nextCookies\(\),\s*$/u);
});

contractTest("web.hermetic", "personal API keys use x-api-key and cannot consume Better Auth Bearer sessions", () => {
  const apiKeyStart = authSource.indexOf("apiKey({");
  const apiKeyEnd = authSource.indexOf("openAPI()", apiKeyStart);
  const apiKeyConfiguration = authSource.slice(apiKeyStart, apiKeyEnd);

  assert.match(apiKeyConfiguration, /headers\?\.get\("x-api-key"\)/u);
  assert.doesNotMatch(apiKeyConfiguration, /authorization|Bearer/u);
  assert.match(authSource, /openAPI\(\),\s+bearer\(\)/u);
});
