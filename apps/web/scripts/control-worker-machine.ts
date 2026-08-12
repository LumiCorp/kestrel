import { execFileSync } from "node:child_process";

const REVISION_LABEL = "org.opencontainers.image.revision";
const RUNNING_STATE = "started";

type MachineInventoryRecord = {
  id: string;
  state: string;
  revision: string;
  standbys: string[];
};

export type ControlWorkerMachineAction =
  | { action: "use"; machineId: string }
  | { action: "start"; machineId: string };

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
  const imageRef = asRecord(
    record.image_ref ?? record.imageRef ?? record.ImageRef,
  );
  const labels = asRecord(imageRef?.labels ?? imageRef?.Labels);
  const revision = labels ? readString(labels, REVISION_LABEL) : null;
  const rawStandbys = config?.standbys ?? config?.Standbys;
  const standbys =
    rawStandbys == null
      ? []
      : Array.isArray(rawStandbys) &&
          rawStandbys.every((item) => typeof item === "string")
        ? rawStandbys
        : null;
  if (!(id && state && revision && standbys)) {
    throw new Error("Fly returned an incomplete control worker Machine record.");
  }
  return { id, state, revision, standbys };
}

export function selectControlWorkerMachineAction(input: {
  inventory: unknown;
  expectedRevision: string;
}): ControlWorkerMachineAction {
  if (!(Array.isArray(input.inventory) && input.inventory.length > 0)) {
    throw new Error("Fly returned no control worker Machines.");
  }
  const machines = input.inventory.map(parseMachine);
  if (new Set(machines.map((machine) => machine.id)).size !== machines.length) {
    throw new Error("Fly returned duplicate control worker Machine identities.");
  }
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
  return running[0]
    ? { action: "use", machineId: running[0].id }
    : { action: "start", machineId: primary.id };
}

async function readInventory(app: string, accessToken: string) {
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
    inventory: await readInventory(input.app, accessToken),
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
      inventory: await readInventory(input.app, accessToken),
      expectedRevision: input.expectedRevision,
    });
    if (current.action === "use") return current.machineId;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    "Control worker Machine did not become running within 90 seconds.",
  );
}
