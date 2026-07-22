import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const routeSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../app/api/platform/email/route.ts"
  ),
  "utf8"
);

contractTest("web.hermetic", "email configuration audit failure cannot turn a committed save into failure", () => {
  const save = routeSource.indexOf("await saveEmailConfig");
  const audit = routeSource.indexOf("await logAdminEvent", save);
  const isolatedAuditFailure = routeSource.indexOf(".catch(() =>", audit);
  const successResponse = routeSource.indexOf(
    "return NextResponse.json",
    audit
  );

  assert.notEqual(save, -1);
  assert.ok(save < audit);
  assert.ok(audit < isolatedAuditFailure);
  assert.ok(isolatedAuditFailure < successResponse);
  assert.doesNotMatch(
    routeSource.slice(isolatedAuditFailure, successResponse),
    /throw|return responseFor/
  );
});

contractTest("web.hermetic", "email configuration audit failure logs no underlying error details", () => {
  assert.match(routeSource, /\.catch\(\(\) => \{/);
  assert.doesNotMatch(routeSource, /\.catch\(\(error\)/);
});
