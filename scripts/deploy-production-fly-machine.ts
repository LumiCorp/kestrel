import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  flyImageCatalogSchema,
  productionImageTagSchema,
} from "./production-image-contract.js";

const PLATFORM_ROLES = new Set([
  "preview-edge",
  "turn-worker",
  "control-worker",
  "runpod-worker",
]);

type RunResult = { status: number | null; stdout: string };
type Runner = (command: string, args: string[], inherit?: boolean) => RunResult;

export function parseFlyMachineDeploymentArgs(args: string[]) {
  const normalized = operatorArgs(args);
  const role = argument(normalized, "--role");
  const machineId = argument(normalized, "--machine");
  const tag = productionImageTagSchema.parse(argument(normalized, "--tag"));
  rejectUnknownArgs(normalized, ["--role", "--machine", "--tag"]);
  if (!PLATFORM_ROLES.has(role)) {
    throw new Error(`${role} is not a directly deployed Fly Machine role.`);
  }
  if (!/^[a-zA-Z0-9]+$/u.test(machineId)) {
    throw new Error("--machine must be an exact Fly Machine ID.");
  }
  return { role, machineId, tag };
}

export function flyMachineListArgs(app: string) {
  return ["machine", "list", "--app", app, "--json"];
}

export function flyMachineUpdateArgs(input: {
  app: string;
  image: string;
  machineId: string;
}) {
  return [
    "machine",
    "update",
    input.machineId,
    "--app",
    input.app,
    "--image",
    input.image,
    "--yes",
  ];
}

export async function deployProductionFlyMachine(
  args: string[],
  runner: Runner = run,
  confirm: (expected: string) => Promise<void> = confirmDeployment,
) {
  const parsed = parseFlyMachineDeploymentArgs(args);
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile("deploy/fly/image-catalog.json", "utf8")),
  );
  const role = catalog.images.find((entry) => entry.role === parsed.role);
  if (!role || role.rollout !== "global-app") {
    throw new Error(`No direct Fly Machine target exists for ${parsed.role}.`);
  }
  const image = `${role.repository}:${parsed.tag}`;
  const providerIdentity = captureText(runner, "fly", ["auth", "whoami"]);
  const before = readMachine(
    captureJson(runner, "fly", flyMachineListArgs(role.app)),
    parsed.machineId,
  );
  if (!before) {
    throw new Error(`Fly did not return Machine ${parsed.machineId} in ${role.app}.`);
  }
  assertRoleDeploymentContract({
    role: parsed.role,
    machineId: parsed.machineId,
    machine: before,
    phase: "before",
  });
  const expected = `${parsed.role} ${parsed.machineId} ${parsed.tag}`;
  process.stdout.write(
    `${JSON.stringify({ action: "update-image", providerIdentity, app: role.app, role: parsed.role, machineId: parsed.machineId, current: before, requestedImage: image }, null, 2)}\n`,
  );
  await confirm(expected);
  const updated = runner(
    "fly",
    flyMachineUpdateArgs({
      app: role.app,
      image,
      machineId: parsed.machineId,
    }),
    true,
  );
  if (updated.status !== 0) throw new Error("fly machine update failed.");
  const after = readMachine(
    captureJson(runner, "fly", flyMachineListArgs(role.app)),
    parsed.machineId,
  );
  if (!after) {
    throw new Error(`Fly did not return Machine ${parsed.machineId} in ${role.app} after update.`);
  }
  assertRoleDeploymentContract({
    role: parsed.role,
    machineId: parsed.machineId,
    machine: after,
    phase: "after",
  });
  process.stdout.write(`${JSON.stringify({ providerResult: after }, null, 2)}\n`);
  return { providerIdentity, app: role.app, image, before, after, ...parsed };
}

async function confirmDeployment(expected: string) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const supplied = await readline.question(`Type '${expected}' to continue: `);
    if (supplied !== expected) throw new Error("Confirmation did not match the exact target.");
  } finally {
    readline.close();
  }
}

function captureJson(runner: Runner, command: string, args: string[]) {
  const result = runner(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`${command} returned invalid JSON.`);
  }
}

function captureText(runner: Runner, command: string, args: string[]) {
  const result = runner(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
  const value = result.stdout.trim();
  if (!value) throw new Error(`${command} returned an empty identity.`);
  return value;
}

function readMachine(value: unknown, machineId: string) {
  if (!Array.isArray(value)) return null;
  return (
    value.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      return (candidate as Record<string, unknown>).id === machineId;
    }) ?? null
  );
}

function assertRoleDeploymentContract(input: {
  role: string;
  machineId: string;
  machine: unknown;
  phase: "before" | "after";
}) {
  if (input.role !== "preview-edge") return;
  const machine = record(input.machine);
  const config = record(machine?.config);
  const services = config?.services;
  if (
    !Array.isArray(services) ||
    !services.some(hasPreviewEdgePublicIngress)
  ) {
    throw new Error(
      `Preview Edge Machine ${input.machineId} is missing its public ingress contract ${input.phase} image update. Repair configuration from fly.preview-edge.toml before retrying.`,
    );
  }
}

function hasPreviewEdgePublicIngress(value: unknown) {
  const service = record(value);
  if (
    service?.protocol !== "tcp" ||
    service.internal_port !== 8080 ||
    !Array.isArray(service.ports)
  ) {
    return false;
  }
  return (
    service.ports.some((port) =>
      matchesPort(port, {
        port: 80,
        handlers: ["http"],
        forceHttps: true,
      }),
    ) &&
    service.ports.some((port) =>
      matchesPort(port, { port: 443, handlers: ["tls", "http"] }),
    )
  );
}

function matchesPort(
  value: unknown,
  expected: { port: number; handlers: string[]; forceHttps?: boolean },
) {
  const port = record(value);
  const handlers = port?.handlers;
  if (port?.port !== expected.port || !Array.isArray(handlers)) {
    return false;
  }
  if (
    handlers.length !== expected.handlers.length ||
    !expected.handlers.every((handler) => handlers.includes(handler))
  ) {
    return false;
  }
  return expected.forceHttps === undefined
    ? true
    : port.force_https === expected.forceHttps;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function operatorArgs(args: string[]) {
  return args[0] === "--" ? args.slice(1) : args;
}

function argument(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) {
    throw new Error(
      "Usage: production:fly:machine --role <role> --machine <id> --tag <tag>",
    );
  }
  return value;
}

function rejectUnknownArgs(args: string[], names: string[]) {
  const consumed = new Set<number>();
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) {
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  const unknown = args.filter((_, index) => !consumed.has(index));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}.`);
}

function run(command: string, args: string[], inherit = false): RunResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

if (process.argv[1]?.endsWith("deploy-production-fly-machine.ts")) {
  void deployProductionFlyMachine(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Fly Machine deployment failed."}\n`,
      );
      process.exit(1);
    },
  );
}
