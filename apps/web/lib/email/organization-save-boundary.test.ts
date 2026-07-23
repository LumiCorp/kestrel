import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const routeSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../app/api/organization/email/route.ts",
  ),
  "utf8",
);

contractTest(
  "web.hermetic",
  "organization email save remains successful when derived side effects fail",
  () => {
    const save = routeSource.indexOf("await saveOrganizationEmailConfig");
    const sync = routeSource.indexOf(
      "await syncOrganizationEmailAppConnection",
      save,
    );
    const syncFailureIsolation = routeSource.indexOf(".catch(", sync);
    const audit = routeSource.indexOf(
      "await logAdminEvent",
      syncFailureIsolation,
    );
    const auditFailureIsolation = routeSource.indexOf(".catch(", audit);
    const successResponse = routeSource.indexOf(
      "return NextResponse.json",
      auditFailureIsolation,
    );

    assert.notEqual(save, -1);
    assert.ok(save < sync);
    assert.ok(sync < syncFailureIsolation);
    assert.ok(syncFailureIsolation < audit);
    assert.ok(audit < auditFailureIsolation);
    assert.ok(auditFailureIsolation < successResponse);
    assert.doesNotMatch(
      routeSource.slice(syncFailureIsolation, successResponse),
      /throw|return responseFor/,
    );
  },
);

contractTest(
  "web.hermetic",
  "organization email side-effect failures do not log underlying error details",
  () => {
    assert.match(
      routeSource,
      /syncOrganizationEmailAppConnection\([\s\S]*?\.catch\(\(\) => \{/u,
    );
    assert.match(routeSource, /logAdminEvent\([\s\S]*?\.catch\(\(\) => \{/u);
    assert.doesNotMatch(routeSource, /\.catch\(\(error\)/u);
  },
);
