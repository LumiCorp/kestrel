import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest("web.hermetic", "hosted Environment images have distinct revisioned release contracts", async () => {
  const [workspaceDockerfile, routerDockerfile, rollout] = await Promise.all([
    readFile(new URL("../../../workspace-runtime/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../../../environment-router/Dockerfile", import.meta.url), "utf8"),
    readFile(
      new URL("../../../../deploy/fly/kestrel-one-runner/ROLLOUT.md", import.meta.url),
      "utf8",
    ),
  ]);

  for (const dockerfile of [workspaceDockerfile, routerDockerfile]) {
    assert.match(dockerfile, /ARG KESTREL_GIT_SHA=unknown/u);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$KESTREL_GIT_SHA/u);
  }
  assert.match(rollout, /--file apps\/workspace-runtime\/Dockerfile/u);
  assert.match(rollout, /--file apps\/environment-router\/Dockerfile/u);
  assert.match(rollout, /apps\/workspace-runtime\/scripts\/image-smoke\.sh/u);
  assert.match(rollout, /apps\/environment-router\/scripts\/image-smoke\.sh/u);
  assert.doesNotMatch(
    rollout,
    /Both\s+`KESTREL_ENVIRONMENT_ROUTER_IMAGE` and `KESTREL_WORKSPACE_RUNTIME_IMAGE`/u,
  );
});
