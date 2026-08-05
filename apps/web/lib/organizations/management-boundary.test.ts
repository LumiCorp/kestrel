import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath: string) {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

const home = read("app/(workspace)/organization/page.tsx");
const systemsMapPage = read("app/(workspace)/organization/systems/page.tsx");
const homeUi = read("components/organization/organization-management-home.tsx");
const systemsMapRoute = read("app/api/organization/systems-map/route.ts");
const systemsMapService = read("lib/organizations/systems-map.ts");
const environmentWorkspaces = read(
  "app/(workspace)/organization/environments/[id]/workspaces/page.tsx",
);
const teamSwitcher = read("components/team-switcher.tsx");
const startRoute = read(
  "app/api/organization/environments/[id]/workspaces/[workspaceId]/start/route.ts",
);
const stopRoute = read(
  "app/api/organization/environments/[id]/workspaces/[workspaceId]/stop/route.ts",
);
const retireRoute = read(
  "app/api/organization/environments/[id]/workspaces/[workspaceId]/retire/route.ts",
);
const deletionRoute = read("app/api/organization/deletion/route.ts");
const deletionService = read("lib/organizations/deletion.ts");
const environmentStore = read("lib/environments/store.ts");
const queue = read("lib/knowledge/queue.ts");

test(
  "Organization management enters from the active organization and centers Environments",
  () => {
    assert.match(teamSwitcher, /Manage organization/u);
    assert.match(teamSwitcher, /href="\/organization"/u);
    assert.match(home, /requireOrganizationAdmin/u);
    assert.match(systemsMapPage, /requireOrganizationAdmin/u);
    assert.match(systemsMapRoute, /requireOrganizationAdmin/u);
    assert.match(homeUi, /Systems map/u);
    assert.match(systemsMapService, /threadCount/u);
    assert.doesNotMatch(systemsMapService, /title:\s*schema\.threads\.title/u);
    assert.doesNotMatch(systemsMapService, /provider\.getMachine\(/u);
    assert.match(systemsMapService, /eq\(schema\.members\.organizationId, input\.organizationId\)/u);
    assert.match(systemsMapService, /eq\(schema\.threadTurns\.organizationId, input\.organizationId\)/u);
    assert.match(
      homeUi,
      /Manage the execution environments this organization owns/u,
    );
    assert.doesNotMatch(homeUi, /title:\s*"Machines"/u);
    assert.match(
      environmentWorkspaces,
      /Each Workspace owns the machine and persistent volume/u,
    );
    assert.match(environmentWorkspaces, /Machine:/u);
    assert.match(environmentWorkspaces, /Volume:/u);
  },
);

test("Organization teardown queue delivery is single-writer and terminal-monotonic", () => {
  assert.match(queue, /singletonKey:\s*operationId/u);
  assert.match(
    queue,
    /createQueue\(ORGANIZATION_DELETION_QUEUE,\s*\{[\s\S]*?policy:\s*"singleton"/u,
  );
  assert.match(
    queue,
    /LEGACY_ORGANIZATION_DELETION_QUEUE\s*=\s*"organization\.deletion"/u,
  );
  assert.match(
    queue,
    /LEGACY_ORGANIZATION_DELETION_QUEUE_V2\s*=\s*"organization\.deletion\.v2"/u,
  );
  assert.match(
    queue,
    /LEGACY_ORGANIZATION_DELETION_QUEUE,[\s\S]*?LEGACY_ORGANIZATION_DELETION_QUEUE_V2,[\s\S]*?ORGANIZATION_DELETION_QUEUE/u,
  );
  assert.doesNotMatch(
    queue,
    /boss\.work\(LEGACY_ORGANIZATION_DELETION_QUEUE/u,
  );
  assert.match(queue, /boss\.work\(ORGANIZATION_DELETION_QUEUE/u);
  assert.match(deletionService, /withOrganizationDeletionLock/u);
  assert.match(
    deletionService,
    /inArray\([\s\S]*?status[\s\S]*?\["queued", "running"\]/u,
  );
  assert.match(deletionService, /status === "queued"/u);
});

test(
  "Workspace machine actions stay organization-admin scoped and durable",
  () => {
    for (const route of [startRoute, stopRoute, retireRoute]) {
      assert.match(route, /requireOrganizationAdmin/u);
      assert.match(route, /enqueueEnvironmentOperation/u);
      assert.match(route, /status: 202/u);
    }
    assert.match(retireRoute, /confirmationName/u);
    assert.match(environmentStore, /requestWorkspaceStart/u);
    assert.match(environmentStore, /requestWorkspaceStop/u);
    assert.match(environmentStore, /requestWorkspaceRetirement/u);
  },
);

test(
  "Organization teardown is owner-only, subscription-gated, and durable",
  () => {
    assert.match(deletionRoute, /requireOrganizationOwner/u);
    assert.match(deletionRoute, /enqueueOrganizationDeletion/u);
    assert.match(
      deletionService,
      /Cancel the active organization subscription/u,
    );
    assert.match(deletionService, /lifecycleState: "deleting"/u);
    assert.match(deletionService, /environment\.delete/u);
    assert.match(deletionService, /queueManagedRunPodDeletion/u);
    assert.match(deletionService, /organizationDeletionOperationId/u);
    assert.match(environmentStore, /requestWorkspaceRetirement/u);
    assert.match(
      deletionService,
      /transaction[\s\S]*\.delete\(schema\.organizations\)/u,
    );
    assert.match(deletionService, /retryOrganizationDeletion/u);
  },
);
