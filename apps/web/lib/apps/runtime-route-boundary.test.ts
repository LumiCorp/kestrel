import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

contractTest("web.hermetic", "generic App runtime broker owns credential and policy authorization", () => {
  const broker = read("lib/apps/runtime-route.ts");
  assert.match(broker, /verifyEnvironmentExecutionTicket/u);
  assert.match(broker, /authorizeAppRuntime/u);
  assert.match(broker, /getAppProviderAdapter/u);
  assert.match(broker, /runtime\.assertTarget/u);
  assert.match(broker, /markAppConnectionDegraded/u);
  assert.match(broker, /markAppConnectionHealthy/u);
  assert.doesNotMatch(broker, /TAVILY_API_KEY|EXA_API_KEY/u);
});

contractTest("web.hermetic", "generic and legacy Tavily routes delegate to the same broker", () => {
  const genericRoute = read(
    "app/api/runtime/apps/[appKey]/[capability]/[approval]/[...path]/route.ts"
  );
  const legacyRoute = read(
    "app/api/runtime/apps/tavily/[capability]/[approval]/[...path]/route.ts"
  );
  assert.match(genericRoute, /handleAppRuntimeRequest/u);
  assert.match(genericRoute, /appKey: params\.appKey/u);
  assert.match(legacyRoute, /handleAppRuntimeRequest/u);
  assert.match(legacyRoute, /appKey: "tavily"/u);
});
