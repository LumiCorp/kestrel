import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  flyImageCatalogSchema,
  productionImageTagSchema,
} from "../../scripts/production-image-contract.js";
import {
  flyMachineStatusArgs,
  flyMachineUpdateArgs,
  parseFlyMachineDeploymentArgs,
} from "../../scripts/deploy-production-fly-machine.js";
import {
  parsePublishProductionImageArgs,
  productionImageBuildCommands,
} from "../../scripts/publish-production-image.js";

const tag = "operator-aug16";

test("operator tags follow the ordinary container tag contract", () => {
  assert.equal(productionImageTagSchema.parse("operator-aug16"), "operator-aug16");
  assert.throws(() => productionImageTagSchema.parse("not a tag"));
});

test("local publication builds one amd64 image, smokes it, then pushes", () => {
  assert.deepEqual(
    parsePublishProductionImageArgs(["--role", "preview-edge", "--tag", tag]),
    { role: "preview-edge", tag },
  );
  const commands = productionImageBuildCommands({
    dockerfile: "Dockerfile",
    image: `registry.fly.io/example:${tag}`,
    tag,
    smoke: "smoke.sh",
  });
  assert.deepEqual(
    commands.map((command) => `${command.command} ${command.args[0]}`),
    ["docker buildx", "bash smoke.sh", "docker push"],
  );
  assert.match(commands[0].args.join(" "), /--platform linux\/amd64/u);
});

test("local Fly deployment names one platform Machine and operator tag", () => {
  assert.deepEqual(
    parseFlyMachineDeploymentArgs([
      "--role",
      "preview-edge",
      "--machine",
      "e2865",
      "--tag",
      tag,
    ]),
    { role: "preview-edge", machineId: "e2865", tag },
  );
  assert.deepEqual(flyMachineStatusArgs("example", "e2865"), [
    "machine",
    "status",
    "e2865",
    "--app",
    "example",
    "--json",
  ]);
  assert.deepEqual(
    flyMachineUpdateArgs({
      app: "example",
      image: `registry.fly.io/kestrel-preview-edge:${tag}`,
      machineId: "e2865",
    }),
    [
      "machine",
      "update",
      "e2865",
      "--app",
      "example",
      "--image",
      `registry.fly.io/kestrel-preview-edge:${tag}`,
      "--yes",
    ],
  );
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
  ) as { images: Array<{ role: string }> };
  const workspaceRuntime = releaseCatalog.images.find(
    (entry) => entry.role === "workspace-runtime",
  );

  assert.ok(workspaceRuntime, "workspace-runtime image must be registered");
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
