import assert from "node:assert/strict";
import test from "node:test";
import { productionImageReadiness } from "./route";

test("production image readiness requires the shared bearer token and migration", async () => {
  const previous = process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN;
  process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN = "exact-token";
  try {
    const ready = await productionImageReadiness(
      new Request(
        "https://kestrel.example/api/internal/production-images?kind=platform&requiredMigration=0073_application_owned_production_delivery",
        { headers: { authorization: "Bearer exact-token" } },
      ),
      readiness(true),
    );
    const unauthorized = await productionImageReadiness(
      new Request("https://kestrel.example/api/internal/production-images", {
        headers: { authorization: "Bearer wrong-token" },
      }),
      readiness(true),
    );
    assert.equal(ready.status, 200);
    assert.equal(unauthorized.status, 401);
  } finally {
    if (previous === undefined) {
      delete process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN;
    } else {
      process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN = previous;
    }
  }
});

test("runtime readiness waits for its tag-capable lifecycle consumer", async () => {
  const previous = process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN;
  process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN = "exact-token";
  try {
    const response = await productionImageReadiness(
      new Request(
        "https://kestrel.example/api/internal/production-images?kind=environment-runtime&requiredMigration=0073_application_owned_production_delivery",
        { headers: { authorization: "Bearer exact-token" } },
      ),
      readiness(false),
    );
    assert.equal(response.status, 503);
  } finally {
    if (previous === undefined) delete process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN;
    else process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN = previous;
  }
});

function readiness(runtimeConsumerReady: boolean) {
  return {
    migrationApplied: async () => true,
    runtimeConsumerReady: async () => runtimeConsumerReady,
  };
}
