import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test(
  "hosted Fly infrastructure resolves only the tenant-owned connection",
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
    assert.doesNotMatch(connectionSource, /isPersonalOrganizationSlug/u);
    assert.doesNotMatch(connectionSource, /process\.env\.FLY_API_TOKEN/u);
    assert.doesNotMatch(connectionSource, /KESTREL_FLY_ORGANIZATION_SLUG/u);
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
