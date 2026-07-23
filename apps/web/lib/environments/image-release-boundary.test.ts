import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest("web.hermetic", "hosted Environment images have distinct revisioned release contracts", async () => {
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
  ] = await Promise.all([
    readFile(new URL("../../../workspace-runtime/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../../../environment-router/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../../../preview-edge/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../../../workspace-runtime/fly.build.toml", import.meta.url), "utf8"),
    readFile(new URL("../../../environment-router/fly.build.toml", import.meta.url), "utf8"),
    readFile(new URL("../../../preview-edge/fly.build.toml", import.meta.url), "utf8"),
    readFile(new URL("../../../preview-edge/fly.toml.example", import.meta.url), "utf8"),
    readFile(
      new URL("../../../../deploy/fly/kestrel-one-runner/ROLLOUT.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../../preview-edge/ROLLOUT.md", import.meta.url), "utf8"),
  ]);

  for (const dockerfile of [
    workspaceDockerfile,
    routerDockerfile,
    previewEdgeDockerfile,
  ]) {
    assert.match(dockerfile, /ARG KESTREL_GIT_SHA=unknown/u);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$KESTREL_GIT_SHA/u);
  }
  assert.match(
    workspaceDockerfile,
    /pnpm --filter @lumi\/kestrel-environment-auth build/u,
  );
  assert.match(
    workspaceDockerfile,
    /pnpm --filter @kestrel-agents\/workspace-skills build/u,
  );
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
  assert.doesNotMatch(
    rollout,
    /Both\s+`KESTREL_ENVIRONMENT_ROUTER_IMAGE` and `KESTREL_WORKSPACE_RUNTIME_IMAGE`/u,
  );
});
