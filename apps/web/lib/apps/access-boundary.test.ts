import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function readAppSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

test("Organization admins own App installation and Environment access ceilings", () => {
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

test("Project editors own shared App and capability policy changes", () => {
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

test("Google Calendar runtime resolves the canonical personal App connection", () => {
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

test("GitHub App status and resources read the canonical App control plane", () => {
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

test("personal App connections own OAuth and transactional disconnect cleanup", () => {
  const githubConnect = readAppSource(
    "app/api/apps/github/connect/route.ts",
  );
  const googleRoute = readAppSource("app/api/apps/google/route.ts");
  const microsoftRoute = readAppSource(
    "app/api/apps/microsoft-365/route.ts",
  );
  const githubOauth = readAppSource("lib/integrations/github-oauth.ts");
  const projectService = readAppSource("lib/apps/project-service.ts");
  const googleService = readAppSource(
    "lib/integrations/google-calendar-oauth.ts",
  );
  const service = readAppSource("lib/apps/service.ts");

  assert.match(
    githubConnect,
    /\/settings\/connections\?github=linked#github/u,
  );
  assert.match(googleRoute, /callback\.hash = "google-workspace"/u);
  assert.match(microsoftRoute, /callback\.hash = "microsoft-365"/u);
  assert.match(microsoftRoute, /export async function DELETE/u);
  for (const oauthBoundary of [githubConnect, googleRoute, microsoftRoute]) {
    assert.match(oauthBoundary, /requireInstalledAppForOrganization/u);
  }
  assert.match(githubOauth, /requireInstalledAppForOrganization/u);
  assert.match(
    googleRoute,
    /getAccessToken[\s\S]*?\.catch\(\(\) => null\)/u,
  );
  assert.match(service, /disconnectPersonalAppConnection/u);
  assert.match(service, /equals\(table\.organizationId, input\.organizationId\)/u);
  assert.match(service, /equals\(table\.userId, input\.userId\)/u);
  assert.match(service, /knowledgeDb\.transaction/u);
  assert.match(service, /delete\(schema\.projectAppUserCapabilities\)/u);
  assert.match(service, /delete\(schema\.projectAppConnections\)/u);
  assert.match(service, /delete\(schema\.appConnectionResources\)/u);
  assert.match(service, /personal-app-connection:/u);
  assert.match(service, /pg_advisory_xact_lock/u);
  assert.match(projectService, /personal-app-connection:/u);
  assert.match(projectService, /transaction\.query\.appConnections\.findFirst/u);
  assert.match(googleService, /personal-app-connection:/u);
  assert.match(googleService, /equals\(table\.status, "connected"\)/u);
  assert.doesNotMatch(service, /delete\(schema\.accounts\)/u);
});

test("Google Project routes attach an existing personal connection only", () => {
  const googleService = readAppSource(
    "lib/integrations/google-calendar-oauth.ts",
  );
  const personalRoute = readAppSource("app/api/apps/google/route.ts");

  assert.match(personalRoute, /syncGoogleCalendarUserConnection/u);
  assert.doesNotMatch(
    personalRoute,
    /attachGoogleCalendarConnectionToProject/u,
  );

  for (const route of [
    "app/api/projects/[id]/apps/google/connect/route.ts",
    "app/api/projects/[id]/apps/google/sync/route.ts",
  ]) {
    const source = readAppSource(route);
    assert.match(source, /attachGoogleCalendarConnectionToProject/u);
    assert.match(source, /PersonalConnectionRequiredError/u);
    assert.match(source, /status: 409/u);
    assert.doesNotMatch(source, /auth\.api\.getAccessToken/u);
  }

  assert.match(googleService, /code = "PERSONAL_CONNECTION_REQUIRED"/u);
  assert.match(
    googleService,
    /settingsUrl = "\/settings\/connections#google-workspace"/u,
  );
});
