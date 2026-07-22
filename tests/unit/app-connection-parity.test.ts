import assert from "node:assert/strict";

import { getOfficialRemoteOauthApp } from "../../apps/web/lib/apps/official-remote-apps.js";
import {
  desktopStandardAppToolRequiresApproval,
  getDesktopStandardAppConnection,
} from "../../src/desktopShell/standardAppConnections.js";
import { contractTest } from "../helpers/contract-test.js";
import { MICROSOFT_365_PACKS, scopesForMicrosoft365Packs } from "../../apps/web/lib/integrations/microsoft-365-contract.js";
import { GOOGLE_CALENDAR_SCOPES } from "../../apps/web/lib/integrations/google-calendar-contract.js";

contractTest(
  "runtime.hermetic",
  "Desktop and Kestrel One share official Notion and Slack connection contracts",
  () => {
    for (const appId of ["notion", "slack"] as const) {
      const desktop = getDesktopStandardAppConnection(appId);
      const hosted = getOfficialRemoteOauthApp(appId);
      assert.equal(desktop?.kind, "authorization");
      assert.equal(desktop?.url, hosted?.remoteUrl);
    }

    const desktopSlack = getDesktopStandardAppConnection("slack");
    const hostedSlack = getOfficialRemoteOauthApp("slack");
    assert.equal(desktopSlack?.kind, "authorization");
    if (desktopSlack?.kind !== "authorization") return;
    assert.deepEqual(
      desktopSlack.capabilityPackScopes,
      hostedSlack?.capabilityPackScopes,
    );
  },
);

contractTest(
  "runtime.hermetic",
  "Desktop native App write approvals are explicit capability contracts",
  () => {
    assert.equal(
      desktopStandardAppToolRequiresApproval(
        "google_workspace",
        "google_workspace.create_event",
      ),
      true,
    );
    assert.equal(
      desktopStandardAppToolRequiresApproval(
        "microsoft_365",
        "microsoft_365.send_mail",
      ),
      true,
    );
    assert.equal(
      desktopStandardAppToolRequiresApproval(
        "microsoft_365",
        "microsoft_365.list_mail",
      ),
      false,
    );
  },
);

contractTest("runtime.hermetic", "Desktop and Kestrel One share the Google Workspace Calendar scope contract", () => {
  const desktop = getDesktopStandardAppConnection("google_workspace");
  assert.equal(desktop?.kind, "authorization");
  if (desktop?.kind !== "authorization") return;
  assert.equal(desktop.runtime, "native");
  const desktopScopes = desktop.capabilityPackScopes?.calendar ?? [];
  for (const scope of GOOGLE_CALENDAR_SCOPES) assert.ok(desktopScopes.includes(scope));
  assert.deepEqual(Object.keys(desktop.capabilityPackScopes ?? {}), ["calendar"]);
});

contractTest(
  "runtime.hermetic",
  "Desktop and Kestrel One share the Microsoft 365 capability and least-scope contract",
  () => {
    const desktop = getDesktopStandardAppConnection("microsoft_365");
    assert.equal(desktop?.kind, "authorization");
    if (desktop?.kind !== "authorization") return;
    assert.equal(desktop.runtime, "native");
    assert.deepEqual(Object.keys(desktop.capabilityPackScopes ?? {}), Object.keys(MICROSOFT_365_PACKS));
    for (const pack of Object.keys(MICROSOFT_365_PACKS) as Array<keyof typeof MICROSOFT_365_PACKS>) {
      assert.deepEqual(
        new Set(desktop.capabilityPackScopes?.[pack]),
        new Set(scopesForMicrosoft365Packs([pack])),
      );
    }
  },
);

contractTest(
  "runtime.hermetic",
  "Desktop Vercel uses the official OAuth App endpoint with local capability narrowing",
  () => {
    const desktop = getDesktopStandardAppConnection("vercel");
    assert.equal(desktop?.kind, "authorization");
    assert.equal(desktop?.url, "https://mcp.vercel.com");
    if (desktop?.kind !== "authorization") return;
    assert.deepEqual(Object.keys(desktop.capabilityPackTools ?? {}), [
      "projects",
      "deployments",
      "operations",
    ]);
    assert.ok(desktop.capabilityPackTools?.operations?.includes("get_runtime_logs"));
    assert.ok(desktop.capabilityPackTools?.deployments?.includes("deploy_to_vercel"));
  },
);
