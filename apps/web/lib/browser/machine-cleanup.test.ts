import assert from "node:assert/strict";
import test from "node:test";

import type {
  BrowserMachineInfrastructureProvider,
  EnvironmentProviderMachine,
} from "@/lib/environments/providers/contracts";
import { deleteConfirmedBrowserMachine } from "./machine-cleanup";

const machine: EnvironmentProviderMachine = {
  id: "machine-1",
  state: "started",
  region: "iad",
};

test("already absent Browser Machine confirms cleanup without waiting", async () => {
  let waits = 0;
  const provider = providerFixture({
    reads: [null],
    onWait: () => { waits += 1; },
  });
  await deleteConfirmedBrowserMachine({
    machines: provider,
    appName: "browser-app",
    machineId: machine.id,
  });
  assert.equal(waits, 0);
});

test("present Browser Machine waits and confirms only after an absent re-read", async () => {
  let waits = 0;
  const provider = providerFixture({
    reads: [machine, null],
    onWait: () => { waits += 1; },
  });
  await deleteConfirmedBrowserMachine({
    machines: provider,
    appName: "browser-app",
    machineId: machine.id,
  });
  assert.equal(waits, 1);
});

test("destroy wait not-found race succeeds only after an absent re-read", async () => {
  const provider = providerFixture({
    reads: [machine, null],
    onWait: () => { throw new Error("machine not found"); },
  });
  await deleteConfirmedBrowserMachine({
    machines: provider,
    appName: "browser-app",
    machineId: machine.id,
  });
});

test("Fly auto-destroy tombstone confirms exact absence without a failing wait", async () => {
  const provider = providerFixture({
    reads: [{ ...machine, state: "destroyed" }],
    onWait: () => { throw new Error("must not wait for an absent Machine"); },
  });
  await deleteConfirmedBrowserMachine({ machines: provider, appName: "browser-app", machineId: machine.id });
});

test("non-absent states, foreign tombstones, and unverifiable reads cannot confirm cleanup", async () => {
  for (const remaining of [
    { ...machine, state: "destroying" },
    { ...machine, state: "replaced" },
    { ...machine, state: "migrated" },
    { ...machine, id: "other-machine", state: "destroyed" },
  ]) {
    await assert.rejects(deleteConfirmedBrowserMachine({
      machines: providerFixture({ reads: [remaining] }), appName: "browser-app", machineId: machine.id,
    }));
  }
  await assert.rejects(deleteConfirmedBrowserMachine({
    machines: { ...providerFixture({ reads: [] }), async getMachine() { throw new Error("lookup unavailable"); } },
    appName: "browser-app", machineId: machine.id,
  }), /lookup unavailable/u);
});

test("remaining Browser Machine leaves cleanup unconfirmed", async () => {
  const provider = providerFixture({ reads: [machine, machine] });
  await assert.rejects(
    deleteConfirmedBrowserMachine({
      machines: provider,
      appName: "browser-app",
      machineId: machine.id,
    }),
    /BROWSER_ENGINE_FAILURE/u,
  );
});

function providerFixture(input: {
  reads: Array<EnvironmentProviderMachine | null>;
  onWait?: (() => void) | undefined;
}): BrowserMachineInfrastructureProvider {
  let readIndex = 0;
  return {
    async createBrowserMachine() { throw new Error("not used"); },
    async listBrowserMachines() { return []; },
    async getMachine() {
      const value = input.reads[Math.min(readIndex, input.reads.length - 1)];
      readIndex += 1;
      return value ?? null;
    },
    async deleteMachine() {},
    async waitForMachine() { input.onWait?.(); },
  };
}
