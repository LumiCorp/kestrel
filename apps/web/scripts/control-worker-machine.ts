import { execFileSync } from "node:child_process";

const REVISION_LABEL = "org.opencontainers.image.revision";
const FINGERPRINT_LABEL = "org.kestrel.control-worker.fingerprint";
const RUNNING_STATE = "started";
const STOPPED_STATE = "stopped";
export const CONTROL_WORKER_STARTUP_COMMAND = "node /app/control-worker.cjs";

export type MachineInventoryRecord = {
  id: string;
  state: string;
  revision: string;
  fingerprint: string | null;
  digest: string;
  startupCommand: string | null;
  standbys: string[];
  environment: Record<string, string>;
};

class IncompleteControlWorkerMachineError extends Error {
  constructor() {
    super("Fly returned an incomplete control worker Machine record.");
    this.name = "IncompleteControlWorkerMachineError";
  }
}

export function isIncompleteControlWorkerMachineError(error: unknown) {
  return error instanceof IncompleteControlWorkerMachineError;
}

export type ControlWorkerMachineAction =
  | { action: "use"; machineId: string }
  | { action: "start"; machineId: string };

export type ControlWorkerMachineUpdate = {
  machineId: string;
  expectedState: "started" | "stopped";
  skipStart: boolean;
};

export type ControlWorkerMachineUpdatePlan = {
  runningMachineId: string | null;
  updates: ControlWorkerMachineUpdate[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseMachine(value: unknown): MachineInventoryRecord {
  const record = asRecord(value);
  if (!record) throw new Error("Fly returned an invalid Machine record.");
  const id = readString(record, "id", "ID");
  const state = readString(record, "state", "State");
  const config = asRecord(record.config ?? record.Config);
  const init = asRecord(config?.init ?? config?.Init);
  const imageRef = asRecord(
    record.image_ref ?? record.imageRef ?? record.ImageRef,
  );
  const labels = asRecord(imageRef?.labels ?? imageRef?.Labels);
  const revision = labels ? readString(labels, REVISION_LABEL) : null;
  const fingerprint = labels ? readString(labels, FINGERPRINT_LABEL) : null;
  const digest = imageRef ? readString(imageRef, "digest", "Digest") : null;
  const rawCommand = init?.cmd ?? init?.Cmd;
  const startupCommand =
    Array.isArray(rawCommand) &&
    rawCommand.length > 0 &&
    rawCommand.every((item) => typeof item === "string" && item.trim())
      ? rawCommand.join(" ")
      : null;
  const rawStandbys = config?.standbys ?? config?.Standbys;
  const standbys =
    rawStandbys == null
      ? []
      : Array.isArray(rawStandbys) &&
          rawStandbys.every((item) => typeof item === "string")
        ? rawStandbys
        : null;
  const rawEnvironment = asRecord(config?.env ?? config?.Env);
  const environment = Object.fromEntries(
    Object.entries(rawEnvironment ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (!(id && state && revision && digest && standbys)) {
    throw new IncompleteControlWorkerMachineError();
  }
  return {
    id,
    state,
    revision,
    fingerprint,
    digest,
    startupCommand,
    standbys,
    environment,
  };
}

export function isControlWorkerMachinePostcondition(input: {
  machine: MachineInventoryRecord;
  expectedState: "started" | "stopped";
  expectedFingerprint: string;
  expectedRevision: string;
  expectedEnvironment?: Record<string, string>;
}) {
  return (
    input.machine.state === input.expectedState &&
    input.machine.fingerprint === input.expectedFingerprint &&
    input.machine.revision === input.expectedRevision &&
    input.machine.startupCommand === CONTROL_WORKER_STARTUP_COMMAND &&
    Object.entries(input.expectedEnvironment ?? {}).every(
      ([key, value]) => input.machine.environment[key] === value,
    )
  );
}

export function parseControlWorkerInventory(inventory: unknown) {
  if (!(Array.isArray(inventory) && inventory.length > 0)) {
    throw new Error("Fly returned no control worker Machines.");
  }
  const machines = inventory.map(parseMachine);
  if (machines.length > 2) {
    throw new Error(
      `Control worker requires at most one standby Machine; found ${machines.length - 1}.`,
    );
  }
  if (new Set(machines.map((machine) => machine.id)).size !== machines.length) {
    throw new Error("Fly returned duplicate control worker Machine identities.");
  }
  const primaries = machines.filter((machine) => machine.standbys.length === 0);
  if (primaries.length !== 1) {
    throw new Error(
      `Control worker requires one unique primary Machine; found ${primaries.length}.`,
    );
  }
  const primary = primaries[0]!;
  const unrelated = machines.filter(
    (machine) =>
      machine.id !== primary.id &&
      (machine.standbys.length !== 1 || machine.standbys[0] !== primary.id),
  );
  if (unrelated.length > 0) {
    throw new Error(
      `Control worker inventory contains unrelated Machines: ${unrelated
        .map((machine) => machine.id)
        .join(", ")}.`,
    );
  }
  const running = machines.filter((machine) => machine.state === RUNNING_STATE);
  if (running.length > 1) {
    throw new Error(
      `Control worker requires at most one running Machine; found ${running.length}.`,
    );
  }
  return { machines, primary, running: running[0] ?? null };
}

export function findControlWorkerMachine(input: {
  inventory: unknown;
  machineId: string;
}) {
  const { machines } = parseControlWorkerInventory(input.inventory);
  const machine = machines.find((candidate) => candidate.id === input.machineId);
  if (!machine) {
    throw new Error(`Fly did not return control worker Machine ${input.machineId}.`);
  }
  return machine;
}

export function selectControlWorkerMachineAction(input: {
  inventory: unknown;
  expectedRevision: string;
}): ControlWorkerMachineAction {
  const { machines, primary, running } = parseControlWorkerInventory(
    input.inventory,
  );
  const mismatched = machines.filter(
    (machine) => machine.revision !== input.expectedRevision,
  );
  if (mismatched.length > 0) {
    throw new Error(
      `Control worker Machine revision mismatch: ${mismatched
        .map((machine) => machine.id)
        .join(", ")}.`,
    );
  }
  return running
    ? { action: "use", machineId: running.id }
    : { action: "start", machineId: primary.id };
}

export function selectControlWorkerMachineUpdatePlan(input: {
  inventory: unknown;
}): ControlWorkerMachineUpdatePlan {
  const { machines, primary, running } = parseControlWorkerInventory(
    input.inventory,
  );
  const machineToRun = running?.id ?? primary.id;
  return {
    runningMachineId: running?.id ?? null,
    updates: machines
      .map<ControlWorkerMachineUpdate>((machine) => {
        const expectedState =
          machine.id === machineToRun ? RUNNING_STATE : STOPPED_STATE;
        return {
          machineId: machine.id,
          expectedState,
          skipStart: expectedState === STOPPED_STATE,
        };
      })
      .sort((left, right) => Number(right.skipStart) - Number(left.skipStart)),
  };
}

export function canSkipControlWorkerMachineDeploy(input: {
  inventory: unknown;
  expectedFingerprint: string;
}) {
  const { machines, running } = parseControlWorkerInventory(input.inventory);
  return (
    Boolean(running) &&
    machines.every(
      (machine) =>
        machine.fingerprint === input.expectedFingerprint &&
        machine.startupCommand === CONTROL_WORKER_STARTUP_COMMAND,
    )
  );
}

export async function readControlWorkerInventory(
  app: string,
  accessToken: string,
) {
  const response = await fetch(
    `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Fly returned HTTP ${response.status} for the control worker Machine inventory.`,
    );
  }
  const inventory: unknown = await response.json();
  if (!Array.isArray(inventory)) {
    throw new Error("Fly did not return the control worker Machine inventory.");
  }
  return inventory;
}

export async function restoreControlWorkerMachine(input: {
  app: string;
  expectedRevision: string;
  timeoutMs?: number | undefined;
  flyCommand?: string | undefined;
  accessToken?: string | undefined;
}) {
  const flyCommand = input.flyCommand ?? "flyctl";
  const accessToken = input.accessToken ?? process.env.FLY_API_TOKEN?.trim();
  if (!accessToken) throw new Error("FLY_API_TOKEN is required.");
  const first = selectControlWorkerMachineAction({
    inventory: await readControlWorkerInventory(input.app, accessToken),
    expectedRevision: input.expectedRevision,
  });
  if (first.action === "start") {
    execFileSync(
      flyCommand,
      ["machine", "start", first.machineId, "--app", input.app],
      { stdio: "inherit" },
    );
  }
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    const current = selectControlWorkerMachineAction({
      inventory: await readControlWorkerInventory(input.app, accessToken),
      expectedRevision: input.expectedRevision,
    });
    if (current.action === "use") return current.machineId;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    "Control worker Machine did not become running within 90 seconds.",
  );
}
