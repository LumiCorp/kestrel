import assert from "node:assert/strict";
import test from "node:test";
import {
  flyImagePublicationStateSchema,
  flyMigrationChanged,
  impactedFlyImages,
  matchesCatalogInput,
  selectFlyImageDiffBase,
  type FlyImageCatalog,
} from "../../scripts/fly-image-release-contract.js";

const catalog = {
  version: 1,
  images: [
    image("workspace-runtime", [
      "apps/workspace-runtime/**",
      "packages/sdk/**",
    ]),
    image("environment-router", ["apps/environment-router/**"]),
    image("preview-edge", ["apps/preview-edge/**"]),
    image("turn-worker", ["apps/web/**"]),
    image("runpod-worker", ["apps/web/**"]),
  ],
} satisfies FlyImageCatalog;

test("catalog input matching is path anchored", () => {
  assert.equal(matchesCatalogInput("apps/web/lib/a.ts", "apps/web/**"), true);
  assert.equal(
    matchesCatalogInput("other/apps/web/lib/a.ts", "apps/web/**"),
    false,
  );
  assert.equal(matchesCatalogInput("package.json", "package.json"), true);
});

test("impact detection selects every image whose declared inputs changed", () => {
  assert.deepEqual(
    impactedFlyImages({
      catalog,
      changedPaths: ["apps/web/lib/releases/store.ts"],
      forceAll: false,
    }).map((entry) => entry.role),
    ["turn-worker", "runpod-worker"],
  );
  assert.equal(
    impactedFlyImages({ catalog, changedPaths: [], forceAll: true }).length,
    5,
  );
});

test("migration detection covers authoritative web schema inputs", () => {
  assert.equal(flyMigrationChanged(["apps/web/drizzle/schema.ts"]), true);
  assert.equal(
    flyMigrationChanged(["apps/web/lib/db/migrations/0058_example.sql"]),
    true,
  );
  assert.equal(flyMigrationChanged(["apps/web/lib/releases/store.ts"]), false);
});

test("catalog changes rebuild every managed image", () => {
  const impacted = impactedFlyImages({
    catalog,
    changedPaths: ["deploy/fly/image-catalog.json"],
    forceAll: false,
  });
  assert.equal(impacted.length, 5);
});

test("Docker build-context changes rebuild every managed image", () => {
  const catalogWithDockerContext = {
    ...catalog,
    images: catalog.images.map((entry) => ({
      ...entry,
      inputs: [".dockerignore", ...entry.inputs],
    })),
  } satisfies FlyImageCatalog;
  const impacted = impactedFlyImages({
    catalog: catalogWithDockerContext,
    changedPaths: [".dockerignore"],
    forceAll: false,
  });
  assert.equal(impacted.length, 5);
});

test("incremental releases diff from the stable bundle revision", () => {
  const stableBundleRevision = "a".repeat(40);
  assert.equal(
    selectFlyImageDiffBase({
      requiresFullBundle: false,
      stableBundleRevision,
    }),
    stableBundleRevision,
  );
  assert.equal(
    selectFlyImageDiffBase({
      requiresFullBundle: true,
      stableBundleRevision: null,
    }),
    undefined,
  );
  assert.equal(
    flyImagePublicationStateSchema.safeParse({
      requiresFullBundle: false,
      stableBundleRevision: null,
    }).success,
    false,
  );
});

test("force-all publication state retains its stable diff base", () => {
  const stableBundleRevision = "b".repeat(40);
  const publicationState = flyImagePublicationStateSchema.parse({
    requiresFullBundle: false,
    stableBundleRevision,
  });
  assert.equal(selectFlyImageDiffBase(publicationState), stableBundleRevision);
});

function image(
  role: FlyImageCatalog["images"][number]["role"],
  inputs: string[],
): FlyImageCatalog["images"][number] {
  return {
    role,
    app: `app-${role}`,
    config: `${role}/fly.toml`,
    dockerfile: `${role}/Dockerfile`,
    smoke: `${role}/smoke.sh`,
    rollout: role === "workspace-runtime" ? "environment" : "global-app",
    inputs: ["deploy/fly/image-catalog.json", ...inputs],
  };
}
