// Called by the local/Fly Browser canary while its real worker is opening.
// Run inside the candidate control-worker image, without database credentials.
import assert from "node:assert/strict";
import { parseBrowserSessionV1 } from "../../../src/browser/contracts";
import { reconcileHostedBrowserSessionsForEnvironment } from "../lib/browser/reconciliation";
import type { HostedBrowserReconciliationRecord } from "../lib/browser/reconciliation";
import type { EnvironmentProviderMachine } from "../lib/environments/providers/contracts";

const input = JSON.parse(process.argv[2] ?? "null") as {
  record: HostedBrowserReconciliationRecord;
  machine: EnvironmentProviderMachine | null;
  image: string;
  region: string;
};
assert.ok(input?.record);
input.record.session = parseBrowserSessionV1(input.record.session);
assert.ok(["opening", "ready"].includes(input.record.session.state));
const result = await reconcileHostedBrowserSessionsForEnvironment({
  organizationId: "isolated-browser-canary",
  environmentId: "isolated-browser-canary",
  appName: "isolated-browser-canary",
  region: input.region,
  workerImageDigest: input.image,
  store: {
    async listForReconciliation() {
      return [structuredClone(input.record)];
    },
    async read(id) {
      assert.equal(id, input.record.session.sessionId);
      return structuredClone(input.record);
    },
    async recordReconciliationAttempt() {},
    async ownsPendingMachine() {
      return true;
    },
    async markTerminal() {
      throw new Error("Reconciliation tried to terminate the live canary");
    },
    async confirmCleanup() {
      throw new Error("Reconciliation tried to confirm live canary cleanup");
    },
  },
  machines: {
    async listBrowserMachines() {
      return input.machine ? [input.machine] : [];
    },
    async getMachine() {
      return input.machine;
    },
    async createBrowserMachine() {
      throw new Error("Unexpected provisioning");
    },
    async waitForMachine() {
      throw new Error("Unexpected wait");
    },
    async deleteMachine() {
      throw new Error("Reconciliation tried to delete the live canary");
    },
  },
});
assert.equal(result.failureCount, 0);
assert.equal(result.lostSessions, 0);
assert.equal(result.cleanedSessions, 0);
assert.equal(result.pendingSessions + result.healthySessions, 1);
console.log(
  JSON.stringify({
    ok: true,
    sessionState: input.record.session.state,
    machineState: input.machine?.state ?? "not_visible",
    result,
  }),
);
