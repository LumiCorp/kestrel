import assert from "node:assert/strict";
import test from "node:test";
import {
  getKestrelStandardAppManifest,
  KESTREL_APP_IDS,
  KESTREL_STANDARD_APP_MANIFESTS,
  type KestrelAppId,
} from "../src/apps.js";

test("standard App manifests contain only product-facing concepts", () => {
  assert.equal(
    new Set(KESTREL_STANDARD_APP_MANIFESTS.map((app) => app.id)).size,
    KESTREL_STANDARD_APP_MANIFESTS.length,
  );
  assert.equal(
    JSON.stringify(KESTREL_STANDARD_APP_MANIFESTS).match(
      /mcp|stdio|webhook|transport|remote server/giu,
    ),
    null,
  );
});

test("Microsoft 365 is one App with selectable service capability packs", () => {
  const microsoft365 = getKestrelStandardAppManifest(
    KESTREL_APP_IDS.MICROSOFT_365,
  );
  assert.ok(microsoft365);
  assert.deepEqual(
    microsoft365.capabilityPacks.map((pack) => pack.key),
    ["outlook", "teams", "sharepoint"],
  );
  assert.equal(
    KESTREL_STANDARD_APP_MANIFESTS.some((app) => String(app.id) === "outlook"),
    false,
  );
});

test("built-in capabilities are published through the same App catalog", () => {
  const builtIns = KESTREL_STANDARD_APP_MANIFESTS.filter(
    (app) => app.category === "built_in",
  );
  assert.deepEqual(
    builtIns.map((app) => app.id),
    [
      KESTREL_APP_IDS.WEATHER,
      KESTREL_APP_IDS.TIME,
      KESTREL_APP_IDS.GEOCODING,
      KESTREL_APP_IDS.EXCHANGE_RATES,
      KESTREL_APP_IDS.KNOWLEDGE_SEARCH,
      KESTREL_APP_IDS.SANDBOX,
      KESTREL_APP_IDS.ARTIFACTS,
    ],
  );
  assert.ok(builtIns.every((app) => app.capabilityPacks.length > 0));
});

test("workflow Apps declare their missing-dependency roles in App terms", () => {
  const workflows = KESTREL_STANDARD_APP_MANIFESTS.filter(
    (app) => app.category === "workflow",
  );
  assert.deepEqual(
    workflows.map((app) => app.id),
    [
      KESTREL_APP_IDS.SOFTWARE_DELIVERY,
      KESTREL_APP_IDS.MEETING_FOLLOW_THROUGH,
      KESTREL_APP_IDS.INCIDENT_RESPONSE,
      KESTREL_APP_IDS.CUSTOMER_ESCALATION,
    ],
  );
  assert.ok(
    workflows.every(
      (app) =>
        app.dependencies?.length &&
        app.dependencies.every(
          (dependency) =>
            dependency.role.length > 0 &&
            dependency.minimum > 0 &&
            dependency.appIds.length >= dependency.minimum,
        ),
    ),
  );
  const manifestsById = new Map(
    KESTREL_STANDARD_APP_MANIFESTS.map((app) => [app.id, app]),
  );
  for (const workflow of workflows) {
    for (const dependency of workflow.dependencies ?? []) {
      for (const [appId, requiredPacks] of Object.entries(
        dependency.requiredCapabilityPacks ?? {},
      )) {
        assert.ok(dependency.appIds.includes(appId as KestrelAppId));
        const publishedPacks = new Set(
          manifestsById
            .get(appId as KestrelAppId)
            ?.capabilityPacks.map((pack) => pack.key),
        );
        assert.ok(requiredPacks?.length);
        assert.ok(requiredPacks?.every((pack) => publishedPacks.has(pack)));
      }
    }
  }
  assert.ok(
    workflows.every(
      (app) =>
        typeof app.workflowInstructions === "string" &&
        app.workflowInstructions.length > 0,
    ),
  );
});
