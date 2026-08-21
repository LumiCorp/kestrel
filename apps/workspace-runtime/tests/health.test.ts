import test from "node:test";
import assert from "node:assert/strict";
import { trackWorkspaceHealthDependency } from "../src/health.js";

test("Workspace health observes a never-settling dependency without waiting", () => {
  const dependency = trackWorkspaceHealthDependency(
    new Promise<never>(() => {})
  );

  assert.equal(dependency.state(), "pending");
});

test("Workspace health records ready and failed startup dependencies", async () => {
  const ready = trackWorkspaceHealthDependency(Promise.resolve());
  const failed = trackWorkspaceHealthDependency(
    Promise.reject(new Error("skill sync failed"))
  );

  await Promise.all([ready.settled, failed.settled]);

  assert.equal(ready.state(), "ready");
  assert.equal(failed.state(), "failed");
});
