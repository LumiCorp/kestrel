import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveRunnerServiceEntrypoint } from "../src/runner-entrypoint.js";

test("workspace runtime resolves the runner from the root build output", () => {
  const runtimeModuleUrl = pathToFileURL(
    "/app/apps/workspace-runtime/dist/runner-entrypoint.js"
  ).href;

  assert.equal(
    resolveRunnerServiceEntrypoint(runtimeModuleUrl),
    path.join("/app", "dist", "cli", "runner", "service.js")
  );
});
