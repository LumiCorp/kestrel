import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const route = readFileSync(
  new URL("../../app/api/organization/environments/[id]/route.ts", import.meta.url),
  "utf8"
);
const admin = readFileSync(new URL("../admin/environments.ts", import.meta.url), "utf8");
const overview = readFileSync(
  new URL(
    "../../app/(workspace)/settings/environments/[id]/environment-delete-action.tsx",
    import.meta.url
  ),
  "utf8"
);

contractTest("web.hermetic", "Environment deletion is admin-authenticated, confirmed, and asynchronous", () => {
  const deletion = route.indexOf("export async function DELETE");
  const authorization = route.indexOf("requireOrganizationAdmin", deletion);
  const confirmation = route.indexOf("deleteEnvironmentInputSchema.parse", deletion);
  const request = route.indexOf("requestAdminEnvironmentDeletion", confirmation);
  const accepted = route.indexOf("status: 202", request);

  assert.ok(deletion >= 0);
  assert.ok(deletion < authorization);
  assert.ok(authorization < confirmation);
  assert.ok(confirmation < request);
  assert.ok(request < accepted);
});

contractTest("web.hermetic", "Environment deletion remains durable when audit logging is unavailable", () => {
  const request = admin.indexOf("requestOrganizationEnvironmentDelete");
  const enqueue = admin.indexOf("enqueueEnvironmentOperation", request);
  const audit = admin.indexOf("environment.delete.requested", enqueue);
  const auditFailure = admin.indexOf(".catch(() => {})", audit);

  assert.ok(request >= 0);
  assert.ok(request < enqueue);
  assert.ok(enqueue < audit);
  assert.ok(audit < auditFailure);
});

contractTest("web.hermetic", "Environment deletion UI names the permanent data-loss boundary", () => {
  assert.match(overview, /No automatic backup is created/u);
  assert.match(overview, /confirmationName/u);
  assert.match(overview, /Create another Environment, wait for it to be ready/u);
});
