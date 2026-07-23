import assert from "node:assert/strict";
import test from "node:test";
import { describeFlyMachineUsage } from "./fly-usage";

test("started Fly Machines meter their authoritative CPU and RAM shape", () => {
  assert.deepEqual(
    describeFlyMachineUsage(
      {
        id: "machine-1",
        state: "started",
        region: "iad",
        cpuKind: "shared",
        cpus: 2,
        memoryMb: 4096,
      },
      3_600_000
    ),
    {
      service: "machine.shared-cpu-2x.4096mb",
      meter: "running_seconds",
      quantity: 3600,
      unit: "second",
      pricingGap: null,
    }
  );
});

test("stopped Fly Machines remain explicitly unpriced without rootfs size", () => {
  assert.deepEqual(
    describeFlyMachineUsage(
      { id: "machine-1", state: "stopped", region: "iad" },
      3_600_000
    ),
    {
      service: "machine.rootfs",
      meter: "stopped_machine_hours",
      quantity: 1,
      unit: "machine_hour",
      pricingGap: "rootfs size or Machine configuration unavailable",
    }
  );
});
