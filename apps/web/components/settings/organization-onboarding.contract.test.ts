import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

contractTest("web.hermetic", "organization creation uses supported slug and active organization APIs", () => {
  const source = read("components/create-organization-dialog.tsx");
  assert.match(source, /organization\.checkSlug/u);
  assert.match(source, /keepCurrentActiveOrganization: false/u);
  assert.match(source, /organization\.setActive/u);
  assert.match(source, /router\.push\("\/settings\/organization\/setup"\)/u);
  assert.match(source, /disabled=\{loading \|\| !name\.trim\(\)\}/u);
  assert.doesNotMatch(source, /Logo/u);
});

contractTest("web.hermetic", "new user turns share the stable setup gate while approvals bypass it", () => {
  const mainRoute = read("app/api/threads/[id]/route.ts");
  const turnRoute = read("app/api/threads/[id]/turns/route.ts");
  const mobileRoute = read("app/api/mobile/v1/threads/[id]/turns/route.ts");
  const mobileCreateRoute = read("app/api/mobile/v1/threads/route.ts");
  const mobileBranchRoute = read(
    "app/api/mobile/v2/threads/[id]/branches/route.ts"
  );
  const mobileRetryRoute = read(
    "app/api/mobile/v2/turns/[turnId]/retry/route.ts"
  );
  const gate = read("lib/organizations/turn-readiness.ts");
  assert.match(
    mainRoute,
    /!persistedMessageIds\.has\(message\.id\)[\s\S]*if \(newUserMessage\)[\s\S]*organizationSetupRequiredTurnResponse/u
  );
  assert.doesNotMatch(mainRoute, /if \(approvalResponse\)[\s\S]{0,180}organizationSetupRequiredTurnResponse/u);
  assert.match(turnRoute, /organizationSetupRequiredTurnResponse/u);
  assert.match(mobileRoute, /mobileOrganizationSetupRequiredTurnResponse/u);
  assert.match(
    mobileCreateRoute,
    /mobileOrganizationSetupRequiredTurnResponse/u
  );
  assert.match(
    mobileBranchRoute,
    /mobileOrganizationSetupRequiredTurnResponse/u
  );
  assert.match(
    mobileRetryRoute,
    /mobileOrganizationSetupRequiredTurnResponse/u
  );
  assert.match(gate, /ORGANIZATION_SETUP_REQUIRED/u);
  assert.match(gate, /retryable: false/u);
  assert.match(gate, /status: 409/u);
});

contractTest("web.hermetic", "mobile setup errors retain the public mobile envelope", () => {
  for (const version of ["mobile-v1.json", "mobile-v2.json"]) {
    const contract = JSON.parse(read(`openapi/${version}`)) as {
      components: {
        schemas: {
          ErrorResponse: {
            properties: {
              error: {
                properties: {
                  code: { enum: string[] };
                  nextStep: { enum: string[] };
                };
              };
            };
          };
        };
      };
    };
    const properties =
      contract.components.schemas.ErrorResponse.properties.error.properties;
    assert.ok(properties.code.enum.includes("ORGANIZATION_SETUP_REQUIRED"));
    assert.deepEqual(properties.nextStep.enum, [
      "model_access",
      "workspace_compute",
      "environment_execution",
    ]);
  }
});

contractTest("web.hermetic", "setup offers only enabled models that apply to the default Environment", () => {
  const source = read("components/settings/setup-client.tsx");
  assert.match(source, /gateway\.enabled/u);
  assert.match(
    source,
    /gateway\.environmentId === null[\s\S]*readiness\.environmentExecution\.environmentId/u
  );
});
