import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseDesktopPublicAppConnectionConfig,
  resolveDesktopPublicAppClientId,
} from "../src/appConnectionConfig.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

contractTest(
  "desktop.hermetic",
  "Desktop public App configuration contains client identities but no secrets",
  () => {
    assert.deepEqual(
      parseDesktopPublicAppConnectionConfig({
        version: 1,
        publicClientIds: { slack: "kestrel-slack-public-client" },
      }),
      {
        version: 1,
        publicClientIds: { slack: "kestrel-slack-public-client" },
      },
    );
    assert.throws(
      () =>
        parseDesktopPublicAppConnectionConfig({
          version: 1,
          publicClientIds: { slack: "client" },
          clientSecret: "must-not-be-packaged",
        }),
      /invalid/u,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "Desktop resolves a packaged public App identity without exposing it to the renderer",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-desktop-app-config-"),
    );
    const configPath = path.join(directory, "app-connections.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        publicClientIds: { slack: "packaged-slack-client" },
      }),
      "utf8",
    );

    assert.equal(
      resolveDesktopPublicAppClientId({
        appId: "slack",
        environmentVariable: "KESTREL_SLACK_MCP_CLIENT_ID",
        env: {},
        configPath,
      }),
      "packaged-slack-client",
    );
    assert.equal(
      resolveDesktopPublicAppClientId({
        appId: "slack",
        environmentVariable: "KESTREL_SLACK_MCP_CLIENT_ID",
        env: { KESTREL_SLACK_MCP_CLIENT_ID: "development-client" },
        configPath,
      }),
      "development-client",
    );
  },
);
