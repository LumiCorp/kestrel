import assert from "node:assert/strict";

import {
  parseDemoArgs,
  resolveDemoProcessSpecs,
  type DemoAppId,
} from "../../scripts/demo-apps.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseDemoArgs defaults to every Kestrel demo app with runner and root db", () => {
  assert.deepEqual(parseDemoArgs([]), {
    apps: ["web", "docs", "desktop"],
    open: false,
    skipRootDb: false,
    skipRunner: false,
    waitTimeoutMs: 120_000,
  });
});

contractTest("runtime.hermetic", "parseDemoArgs supports browser-only prospect mode", () => {
  assert.deepEqual(parseDemoArgs(["--", "--no-desktop", "--open", "--wait-ms", "30000"]), {
    apps: ["web", "docs"],
    open: true,
    skipRootDb: false,
    skipRunner: false,
    waitTimeoutMs: 30_000,
  });
});

contractTest("runtime.hermetic", "parseDemoArgs supports explicit app subsets and skips", () => {
  assert.deepEqual(parseDemoArgs(["--only=web,docs", "--skip", "docs"]).apps, ["web"] satisfies DemoAppId[]);
});

contractTest("runtime.hermetic", "resolveDemoProcessSpecs wires unique demo ports and shared runner env", () => {
  const specs = resolveDemoProcessSpecs(parseDemoArgs(["--no-desktop"]));
  const byId = new Map(specs.map((spec) => [spec.id, spec]));

  assert.equal(byId.get("runner")?.readyUrl, "http://127.0.0.1:4010/health");
  assert.equal(byId.get("web")?.url, "http://127.0.0.1:43103");
  assert.equal(byId.get("docs")?.url, "http://127.0.0.1:43102");
  assert.equal(byId.get("web")?.env?.KESTREL_RUNNER_SERVICE_TOKEN, "dev-secret");
});

contractTest("runtime.hermetic", "resolveDemoProcessSpecs can omit the shared runner when one is already running", () => {
  const specs = resolveDemoProcessSpecs(parseDemoArgs(["--only", "web", "--no-runner"]));
  assert.deepEqual(specs.map((spec) => spec.id), ["web"]);
});
