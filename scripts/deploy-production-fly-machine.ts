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
  const role = argument(args, "--role");
  const machineId = argument(args, "--machine");
  const tag = productionImageTagSchema.parse(argument(args, "--tag"));
  rejectUnknownArgs(args, ["--role", "--machine", "--tag"]);
  if (!PLATFORM_ROLES.has(role)) {
    throw new Error(`${role} is not a directly deployed Fly Machine role.`);
  }
  if (!/^[a-zA-Z0-9]+$/u.test(machineId)) {
    throw new Error("--machine must be an exact Fly Machine ID.");
  }
  return { role, machineId, tag };
}

export function flyMachineStatusArgs(app: string, machineId: string) {
  return ["machine", "status", machineId, "--app", app, "--json"];
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
  const before = captureJson(
    runner,
    "fly",
    flyMachineStatusArgs(role.app, parsed.machineId),
  );
  if (readMachineId(before) !== parsed.machineId) {
    throw new Error(`Fly did not return Machine ${parsed.machineId} in ${role.app}.`);
  }
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
  const after = captureJson(
    runner,
    "fly",
    flyMachineStatusArgs(role.app, parsed.machineId),
  );
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

function readMachineId(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" ? record.id : null;
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
