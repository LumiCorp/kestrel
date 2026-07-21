import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function readAppSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

contractTest("web.hermetic", "Organization admins own App installation and Environment access ceilings", () => {
  for (const relativePath of [
    "app/api/apps/[appKey]/installation/route.ts",
    "app/api/environments/[environmentId]/apps/[appKey]/route.ts",
    "app/api/environments/[environmentId]/apps/[appKey]/connections/route.ts",
    "app/api/environments/[environmentId]/apps/[appKey]/connections/[connectionId]/route.ts",
    "app/api/environments/[environmentId]/apps/[appKey]/capabilities/[capabilityKey]/route.ts",
  ]) {
    assert.match(readAppSource(relativePath), /requireOrganizationAdmin\(/u);
  }
});

contractTest("web.hermetic", "Project editors own shared App and capability policy changes", () => {
  for (const relativePath of [
    "app/api/projects/[id]/apps/[appKey]/route.ts",
    "app/api/projects/[id]/apps/[appKey]/capabilities/[capabilityKey]/route.ts",
  ]) {
    const source = readAppSource(relativePath);
    assert.match(source, /requireProjectRole\(/u);
    assert.match(source, /minimumRole: "editor"/u);
  }

  const connectionRoute = readAppSource(
    "app/api/projects/[id]/apps/[appKey]/connections/[connectionId]/route.ts"
  );
  assert.match(
    connectionRoute,
    /minimumRole: input\.scope === "shared" \? "editor" : "member"/u
  );
  assert.match(
    connectionRoute,
    /canManageShared: projectRoleAllows\(access\.role, "editor"\)/u
  );
});

contractTest("web.hermetic", "Google Calendar runtime resolves the canonical personal App connection", () => {
  const policy = readAppSource("lib/integrations/google-calendar-policy.ts");
  const oauthService = readAppSource(
    "lib/integrations/google-calendar-oauth.ts"
  );
  assert.match(policy, /query\.appConnections\.findFirst/u);
  assert.match(
    policy,
    /equals\(table\.appKey, GOOGLE_WORKSPACE_PROVIDER_KEY\)/u
  );
  assert.match(policy, /equals\(table\.ownerType, "personal"\)/u);
  assert.doesNotMatch(policy, /query\.userToolConnections\.findFirst/u);
  assert.match(oauthService, /schema\.appConnections/u);
  assert.match(oauthService, /schema\.projectAppUserCapabilities/u);
  assert.doesNotMatch(oauthService, /userToolConnections/u);
  assert.doesNotMatch(oauthService, /organizationToolConnections/u);
});

contractTest("web.hermetic", "GitHub App status and resources read the canonical App control plane", () => {
  const statusRoute = readAppSource("app/api/apps/github/route.ts");
  const repositoriesRoute = readAppSource(
    "app/api/apps/github/repositories/route.ts"
  );
  const oauthService = readAppSource("lib/integrations/github-oauth.ts");
  const runtimePolicy = readAppSource("lib/integrations/github-policy.ts");
  const workspaceRoute = readAppSource(
    "app/api/projects/[id]/workspace/route.ts"
  );

  assert.match(statusRoute, /query\.appConnections\.findFirst/u);
  assert.doesNotMatch(statusRoute, /userToolConnections/u);
  assert.match(repositoriesRoute, /schema\.appConnections/u);
  assert.match(repositoriesRoute, /schema\.appConnectionResources/u);
  assert.doesNotMatch(repositoriesRoute, /userToolConnections/u);
  assert.doesNotMatch(repositoriesRoute, /toolConnectionResources/u);
  assert.match(oauthService, /schema\.appConnections/u);
  assert.match(oauthService, /schema\.appConnectionResources/u);
  assert.doesNotMatch(oauthService, /userToolConnections/u);
  assert.doesNotMatch(oauthService, /toolConnectionResources/u);
  assert.match(runtimePolicy, /resolveEffectiveProjectAppAccess/u);
  assert.match(runtimePolicy, /query\.appConnectionResources\.findFirst/u);
  assert.doesNotMatch(runtimePolicy, /environmentCapabilityGrants/u);
  assert.doesNotMatch(runtimePolicy, /projectCapabilityRestrictions/u);
  assert.match(workspaceRoute, /schema\.projectAppConnections/u);
  assert.match(workspaceRoute, /query\.environmentAppCapabilityGrants/u);
  assert.doesNotMatch(workspaceRoute, /userToolConnections/u);
});
