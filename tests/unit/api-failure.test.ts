import assert from "node:assert/strict";
import test from "node:test";

import { toApiFailure } from "../../src/governance/apiFailure.js";

test("toApiFailure preserves structured database failure details", () => {
  const error = Object.assign(
    new Error("Local Postgres is not reachable at localhost:55432/kestrel."),
    {
      code: "ECONNREFUSED",
      details: {
        host: "localhost",
        port: 55_432,
        database: "kestrel",
        databaseUrlSource: "desktop_default",
        recommendedAction: "Start the local database with `pnpm run db:up`.",
      },
    },
  );

  const failure = toApiFailure(error, {
    code: "WEB_CONTROL_REQUEST_FAILED",
    message: "Control request failed.",
  });

  assert.equal(failure.code, "ECONNREFUSED");
  assert.equal(failure.message, "Local Postgres is not reachable at localhost:55432/kestrel.");
  assert.equal(failure.details?.host, "localhost");
  assert.equal(failure.details?.port, 55_432);
  assert.equal(failure.details?.recommendedAction, "Start the local database with `pnpm run db:up`.");
});
