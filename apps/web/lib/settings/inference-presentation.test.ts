import assert from "node:assert/strict";
import test from "node:test";
import { getInferenceOverview } from "./inference-presentation";

test("Inference overview keeps loading distinct from an unconfigured connection", () => {
  assert.equal(
    getInferenceOverview({
      loaded: false,
      connection: null,
      profiles: [],
      fleet: [],
      quota: 1,
    }).connectionStatus,
    "Loading",
  );
  assert.equal(
    getInferenceOverview({
      loaded: true,
      connection: null,
      profiles: [],
      fleet: [],
      quota: 1,
    }).connectionStatus,
    "Not configured",
  );
});

test("Inference overview prioritizes the active profile, fleet attention, quota, and spend", () => {
  const overview = getInferenceOverview({
    loaded: true,
    connection: { status: "ready", hasApiKey: true },
    profiles: [
      { displayName: "Draft", status: "draft" },
      { displayName: "Production", status: "active" },
    ],
    fleet: [
      { deployment: { status: "ready" }, attributedSpendUsd: 8.5 },
      { deployment: { status: "failed" }, attributedSpendUsd: 1.25 },
    ],
    quota: 3,
  });

  assert.equal(overview.activeProfile, "Production");
  assert.equal(overview.fleetHealth, "1 need attention");
  assert.equal(overview.fleetTone, "warning");
  assert.equal(overview.quota, 3);
  assert.equal(overview.attributedSpendUsd, 9.75);
});
