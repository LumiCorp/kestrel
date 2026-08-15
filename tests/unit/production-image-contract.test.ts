import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  flyImageCatalogSchema,
  flyMigrationChanged,
  impactedFlyImages,
  matchesCatalogInput,
  type FlyImageCatalog,
} from "../../scripts/production-image-contract.js";

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
    image("control-worker", ["apps/web/**"]),
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
      changedPaths: ["apps/web/lib/environments/runtime-channel.ts"],
    }).map((entry) => entry.role),
    ["turn-worker", "control-worker", "runpod-worker"],
  );
});

test("migration detection covers authoritative web schema inputs", () => {
  assert.equal(flyMigrationChanged(["apps/web/drizzle/schema.ts"]), true);
  assert.equal(
    flyMigrationChanged(["apps/web/lib/db/migrations/0058_example.sql"]),
    true,
  );
  assert.equal(
    flyMigrationChanged(["apps/web/lib/environments/runtime-channel.ts"]),
    false,
  );
});

test("catalog changes rebuild every managed image", () => {
  const impacted = impactedFlyImages({
    catalog,
    changedPaths: ["deploy/fly/image-catalog.json"],
  });
  assert.equal(impacted.length, 6);
});

test("tenant runtime catalog roles publish from exact public GHCR repositories", async () => {
  const releaseCatalog = flyImageCatalogSchema.parse(
    JSON.parse(
      await readFile(
        path.join(process.cwd(), "deploy/fly/image-catalog.json"),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    releaseCatalog.images
      .filter((entry) => entry.rollout === "environment")
      .map(({ role, publisher, repository }) => ({
        role,
        publisher,
        repository,
      })),
    [
      {
        role: "workspace-runtime",
        publisher: "ghcr",
        repository: "ghcr.io/lumicorp/kestrel-workspace-runtime",
      },
      {
        role: "environment-router",
        publisher: "ghcr",
        repository: "ghcr.io/lumicorp/kestrel-environment-router",
      },
    ],
  );
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
  });
  assert.equal(impacted.length, 6);
});

test("workspace-runtime image builds and carries the shared memory package", async () => {
  const dockerfile = await readFile(
    path.join(process.cwd(), "apps/workspace-runtime/Dockerfile"),
    "utf8",
  );
  const releaseCatalog = JSON.parse(
    await readFile(
      path.join(process.cwd(), "deploy/fly/image-catalog.json"),
      "utf8",
    ),
  ) as FlyImageCatalog;
  const workspaceRuntime = releaseCatalog.images.find(
    (entry) => entry.role === "workspace-runtime",
  );

  assert.ok(workspaceRuntime, "workspace-runtime image must be registered");
  assert.ok(
    workspaceRuntime.inputs.includes("packages/memory/**"),
    "memory changes must rebuild the workspace-runtime image",
  );
  const memoryManifestCopy = dockerfile.indexOf(
    "COPY packages/memory/package.json packages/memory/package.json",
  );
  const dependencyInstall = dockerfile.indexOf(
    "RUN pnpm install --frozen-lockfile",
  );
  assert.ok(
    memoryManifestCopy >= 0 && memoryManifestCopy < dependencyInstall,
    "the memory manifest must be present before pnpm install",
  );
  const memorySourceCopy = dockerfile.indexOf(
    "COPY packages/memory packages/memory",
  );
  const memoryBuild = dockerfile.indexOf(
    "pnpm --filter @kestrel-agents/memory build",
  );
  assert.ok(
    memorySourceCopy >= 0 && memorySourceCopy < memoryBuild,
    "the memory sources must be present in the build stage",
  );
  assert.ok(
    memoryBuild >= 0 && memoryBuild < dockerfile.indexOf("pnpm run clean"),
    "the memory package must be built before the root runtime",
  );
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/packages\/memory \.\/packages\/memory/u,
    "the memory package must be present behind the production workspace symlink",
  );
});

function image(
  role: FlyImageCatalog["images"][number]["role"],
  inputs: string[],
): FlyImageCatalog["images"][number] {
  return {
    role,
    publisher:
      role === "workspace-runtime" || role === "environment-router"
        ? "ghcr"
        : "fly",
    repository:
      role === "workspace-runtime"
        ? "ghcr.io/lumicorp/kestrel-workspace-runtime"
        : role === "environment-router"
          ? "ghcr.io/lumicorp/kestrel-environment-router"
          : `registry.fly.io/app-${role}`,
    app: `app-${role}`,
    config: `${role}/fly.toml`,
    dockerfile: `${role}/Dockerfile`,
    smoke: `${role}/smoke.sh`,
    channel:
      role === "runpod-worker"
        ? "runpod"
        : role === "workspace-runtime" || role === "environment-router"
          ? "environment-runtime"
          : "fly",
    rollout: role === "workspace-runtime" ? "environment" : "global-app",
    inputs: ["deploy/fly/image-catalog.json", ...inputs],
  };
}
