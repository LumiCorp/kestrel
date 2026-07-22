import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest(
  "web.hermetic",
  "hosted Fly infrastructure uses team-owned authority with a personal fallback",
  async () => {
    const [connectionSource, processSource, reconcileSource, environmentsSource] =
      await Promise.all([
        readFile(new URL("./fly-connection.ts", import.meta.url), "utf8"),
        readFile(new URL("./process-runtime.ts", import.meta.url), "utf8"),
        readFile(new URL("./reconcile.ts", import.meta.url), "utf8"),
        readFile(
          new URL(
            "../../components/settings/environments-client.tsx",
            import.meta.url
          ),
          "utf8"
        ),
      ]);

    assert.match(connectionSource, /aiProviderConnections/u);
    assert.match(connectionSource, /organizationSlug/u);
    assert.match(connectionSource, /status: "ready"/u);
    assert.match(connectionSource, /isPersonalOrganizationSlug/u);
    assert.match(connectionSource, /process\.env\.FLY_API_TOKEN/u);
    assert.match(
      processSource,
      /createFlyProviderClient\(operation\.organizationId\)/u
    );
    assert.match(
      reconcileSource,
      /createFlyProviderClient\(organization\.organizationId\)/u
    );
    assert.match(environmentsSource, /FlyWorkspaceProviderClient/u);
  }
);
