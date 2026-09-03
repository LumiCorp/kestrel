import type { BrowserMachineInfrastructureProvider } from "@/lib/environments/providers/contracts";

export async function deleteConfirmedBrowserMachine(input: {
  machines: BrowserMachineInfrastructureProvider;
  appName: string;
  machineId: string;
}): Promise<void> {
  await input.machines.deleteMachine({
    appName: input.appName,
    machineId: input.machineId,
  });
  if (!(await readMachine(input))) return;

  try {
    await input.machines.waitForMachine({
      appName: input.appName,
      machineId: input.machineId,
      state: "destroyed",
      timeoutSeconds: 30,
    });
  } catch (error) {
    if (!(await readMachine(input))) return;
    throw error;
  }

  if (await readMachine(input)) throw new Error("BROWSER_ENGINE_FAILURE");
}

async function readMachine(input: {
  machines: BrowserMachineInfrastructureProvider;
  appName: string;
  machineId: string;
}) {
  const machine = await input.machines.getMachine({
    appName: input.appName,
    machineId: input.machineId,
  });
  if (machine && machine.id !== input.machineId) throw new Error("BROWSER_ENGINE_FAILURE");
  // Fly retains GET tombstones after auto_destroy. Its exact current-Machine
  // state `destroyed` means no longer exists; `destroying`, `replaced`, and
  // `migrated` do not prove absence. See fly.io/docs/machines/machine-states/.
  return machine?.state === "destroyed" ? null : machine;
}
