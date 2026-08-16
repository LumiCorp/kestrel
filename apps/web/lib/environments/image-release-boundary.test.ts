import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("hosted Environment images carry the production build identity", async () => {
  const [
    workspaceDockerfile,
    routerDockerfile,
    previewEdgeDockerfile,
    workspaceFlyConfig,
    routerFlyConfig,
    previewEdgeFlyConfig,
    previewEdgeServiceConfig,
    rollout,
    previewEdgeRollout,
    imageCatalog,
    previewEdgeServer,
    previewEdgeSmoke,
  ] = await Promise.all([
    readFile(
      new URL("../../../workspace-runtime/Dockerfile", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../environment-router/Dockerfile", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../preview-edge/Dockerfile", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../workspace-runtime/fly.build.toml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../environment-router/fly.build.toml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../preview-edge/fly.build.toml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../preview-edge/fly.toml.example", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../../deploy/fly/kestrel-one-runner/ROLLOUT.md",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../../preview-edge/ROLLOUT.md", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../../deploy/fly/image-catalog.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../preview-edge/src/server.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../preview-edge/scripts/image-smoke.sh", import.meta.url),
      "utf8",
    ),
  ]);

  for (const dockerfile of [
    workspaceDockerfile,
    routerDockerfile,
    previewEdgeDockerfile,
  ]) {
    assert.match(dockerfile, /ARG KESTREL_BUILD_ID=unknown/u);
    assert.match(
      dockerfile,
      /org\.opencontainers\.image\.version=\$KESTREL_BUILD_ID/u,
    );
  }
  assert.match(
    workspaceDockerfile,
    /pnpm --filter @lumi\/kestrel-environment-auth build/u,
  );
  assert.match(
    workspaceDockerfile,
    /pnpm --filter @kestrel-agents\/workspace-skills build/u,
  );
  assert.match(
    workspaceDockerfile,
    /COPY packages\/mcp-security\/package\.json packages\/mcp-security\/package\.json/u,
  );
  assert.match(
    workspaceDockerfile,
    /COPY packages\/mcp-security packages\/mcp-security/u,
  );
  const workspaceImage = (
    JSON.parse(imageCatalog) as {
      images: Array<{ role: string; inputs: string[] }>;
    }
  ).images.find((image) => image.role === "workspace-runtime");
  assert.ok(workspaceImage);
  assert.ok(workspaceImage.inputs.includes("packages/mcp-security/**"));
  for (const flyConfig of [
    workspaceFlyConfig,
    routerFlyConfig,
    previewEdgeFlyConfig,
  ]) {
    assert.match(flyConfig, /dockerfile = "Dockerfile"/u);
  }
  assert.match(rollout, /--config apps\/workspace-runtime\/fly\.build\.toml/u);
  assert.match(rollout, /--config apps\/environment-router\/fly\.build\.toml/u);
  assert.match(rollout, /apps\/workspace-runtime\/scripts\/image-smoke\.sh/u);
  assert.match(rollout, /apps\/environment-router\/scripts\/image-smoke\.sh/u);
  assert.match(
    previewEdgeRollout,
    /--config apps\/preview-edge\/fly\.build\.toml/u,
  );
  assert.match(
    previewEdgeRollout,
    /apps\/preview-edge\/scripts\/image-smoke\.sh/u,
  );
  assert.match(previewEdgeServiceConfig, /HEALTH_PORT = "8081"/u);
  assert.match(previewEdgeServiceConfig, /\[checks\.preview_edge\]/u);
  assert.match(previewEdgeServiceConfig, /port = 8081/u);
  assert.match(previewEdgeServiceConfig, /auto_stop_machines = "off"/u);
  const previewContractRevision = previewEdgeServer.match(
    /const RUNTIME_CONTRACT_REVISION = (\d+);/u,
  )?.[1];
  assert.ok(previewContractRevision);
  assert.match(
    previewEdgeSmoke,
    new RegExp(
      `health\\.runtimeContractRevision !== ${previewContractRevision}`,
      "u",
    ),
  );
  assert.doesNotMatch(
    rollout,
    /Both\s+`KESTREL_ENVIRONMENT_ROUTER_IMAGE` and `KESTREL_WORKSPACE_RUNTIME_IMAGE`/u,
  );
});

test("hosted Workspace Runtime consumers request the canonical Kestrel profile", async () => {
  const [
    workspaceSmoke,
    workspaceServer,
    localCanary,
    backupService,
    environmentExample,
    webReadme,
  ] = await Promise.all([
    readFile(
      new URL("../../../workspace-runtime/scripts/image-smoke.sh", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../workspace-runtime/src/server.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../workspace-runtime/scripts/local-canary.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("./backups.ts", import.meta.url), "utf8"),
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(workspaceSmoke, /findById\(profiles, "kestrel"\)/u);
  assert.doesNotMatch(workspaceSmoke, /findById\(profiles, "kestrel-one"\)/u);
  assert.match(
    workspaceServer,
    /KESTREL_ONE_PROFILE_ID\?\.trim\(\) \|\| "kestrel"/u,
  );
  assert.match(localCanary, /getProfile\("kestrel",/u);
  assert.equal(
    backupService.includes('const DEFAULT_WORKSPACE_PROFILE_ID = "kestrel";'),
    true,
  );
  assert.match(environmentExample, /^KESTREL_ONE_PROFILE_ID=kestrel$/mu);
  assert.match(webReadme, /^KESTREL_ONE_PROFILE_ID=kestrel$/mu);
});

test("Workspace Runtime image smoke requires its advertised contract revision", async () => {
  const [workspaceSmoke, workspaceServer] = await Promise.all([
    readFile(
      new URL("../../../workspace-runtime/scripts/image-smoke.sh", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../workspace-runtime/src/server.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const contractRevision = workspaceServer.match(
    /const WORKSPACE_RUNTIME_CONTRACT_REVISION = (\d+);/u,
  )?.[1];
  assert.ok(contractRevision);
  assert.match(
    workspaceSmoke,
    new RegExp(
      `health\\.runtimeContractRevision !== ${contractRevision}`,
      "u",
    ),
  );
});
