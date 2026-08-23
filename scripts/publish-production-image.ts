import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  flyImageCatalogSchema,
  productionImageTagSchema,
} from "./production-image-contract.js";

type RunResult = { status: number | null; stdout: string };
type Runner = (command: string, args: string[], inherit?: boolean) => RunResult;

export function parsePublishProductionImageArgs(args: string[]) {
  const normalized = operatorArgs(args);
  const role = argument(normalized, "--role");
  const tag = productionImageTagSchema.parse(argument(normalized, "--tag"));
  rejectUnknownArgs(normalized, ["--role", "--tag"]);
  return { role, tag };
}

function operatorArgs(args: string[]) {
  return args[0] === "--" ? args.slice(1) : args;
}

export function productionImageBuildCommands(input: {
  dockerfile: string;
  image: string;
  tag: string;
  smoke: string;
}) {
  return [
    {
      command: "docker",
      args: [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--load",
        "--file",
        input.dockerfile,
        "--tag",
        input.image,
        "--build-arg",
        `KESTREL_BUILD_ID=${input.tag}`,
        ".",
      ],
    },
    { command: "bash", args: [input.smoke, input.image] },
    { command: "docker", args: ["push", input.image] },
  ] as const;
}

export async function publishProductionImage(
  args: string[],
  runner: Runner = run,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { role, tag } = parsePublishProductionImageArgs(args);
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile("deploy/fly/image-catalog.json", "utf8")),
  );
  const image = catalog.images.find((candidate) => candidate.role === role);
  if (!image) throw new Error(`Unknown production image role: ${role}.`);
  assertProductionImageCanaryEnvironment(role, environment);
  const taggedImage = `${image.repository}:${tag}`;
  for (const command of productionImageBuildCommands({
    dockerfile: image.dockerfile,
    image: taggedImage,
    tag,
    smoke: image.smoke,
  })) {
    requireSuccess(runner(command.command, [...command.args], true), command.command);
  }
  const result = { role: image.role, tag, image: taggedImage };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export function assertProductionImageCanaryEnvironment(
  role: string,
  environment: NodeJS.ProcessEnv,
) {
  if (role !== "turn-worker" && role !== "workspace-runtime") return;
  for (const name of [
    "KESTREL_ONE_APP_URL",
    "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  ]) {
    if (!environment[name]?.trim()) {
      throw new Error(
        `${role} publication requires the live attachment canary environment: ${name}.`,
      );
    }
  }
}

function argument(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) {
    throw new Error(
      "Usage: production:image:publish --role <role> --tag <tag>",
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

function requireSuccess(result: RunResult, command: string) {
  if (result.status !== 0) throw new Error(`${command} failed.`);
}

function run(command: string, args: string[], inherit = false): RunResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

if (process.argv[1]?.endsWith("publish-production-image.ts")) {
  void publishProductionImage(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production image publication failed."}\n`,
    );
    process.exit(1);
  });
}
