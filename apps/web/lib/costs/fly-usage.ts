import type { EnvironmentProviderMachine } from "@/lib/environments/providers/contracts";

export function describeFlyMachineUsage(
  machine: EnvironmentProviderMachine,
  durationMs: number
) {
  const isStarted = machine.state === "started";
  const hasConfiguration = Boolean(
    machine.cpuKind && machine.cpus && machine.memoryMb
  );
  if (isStarted && hasConfiguration) {
    return {
      service: `machine.${machine.cpuKind}-cpu-${machine.cpus}x.${machine.memoryMb}mb`,
      meter: "running_seconds",
      quantity: durationMs / 1000,
      unit: "second",
      pricingGap: null,
    };
  }
  return {
    service: "machine.rootfs",
    meter: `${machine.state}_machine_hours`,
    quantity: durationMs / 3_600_000,
    unit: "machine_hour",
    pricingGap: "rootfs size or Machine configuration unavailable",
  };
}
