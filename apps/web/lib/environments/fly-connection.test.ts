import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest(
  "web.hermetic",
  "hosted Fly infrastructure uses only platform-managed authority",
  async () => {
    const [connectionSource, reconcileSource, environmentsSource, routeManifest] =
      await Promise.all([
        readFile(new URL("./fly-connection.ts", import.meta.url), "utf8"),
        readFile(new URL("./reconcile.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../../components/settings/environments-client.tsx", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../../app/route-ownership.manifest.ts", import.meta.url),
          "utf8",
        ),
      ]);

    assert.match(connectionSource, /env\.FLY_API_TOKEN/u);
    assert.match(connectionSource, /env\.KESTREL_FLY_ORGANIZATION_SLUG/u);
    assert.doesNotMatch(connectionSource, /aiProviderConnections/u);
    assert.match(reconcileSource, /selectDistinct/u);
    assert.match(reconcileSource, /await createFlyProviderClient\(\)/u);
    assert.doesNotMatch(environmentsSource, /FlyWorkspaceProviderClient/u);
    assert.doesNotMatch(routeManifest, /connections\/fly/u);
  },
);
