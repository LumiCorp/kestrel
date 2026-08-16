import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";

export async function loadProductionEnvironment() {
  const operator = capture("vercel", ["whoami", "--no-color"]);
  const directory = await mkdtemp(join(tmpdir(), "kestrel-production-command-"));
  const envFile = join(directory, "production.env");
  try {
    run("vercel", [
      "link",
      "--cwd",
      directory,
      "--project",
      "one",
      "--scope",
      "lumi-kestrel",
      "--yes",
    ]);
    run("vercel", [
      "env",
      "pull",
      envFile,
      "--environment=production",
      "--cwd",
      directory,
      "--yes",
    ]);
    Object.assign(process.env, dotenv.parse(await readFile(envFile, "utf8")));
    return operator;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function productionRuntimeImages(tag: string) {
  const parsed = productionTag(tag);
  return {
    runtimeImage: `ghcr.io/lumicorp/kestrel-workspace-runtime:${parsed}`,
    routerImage: `ghcr.io/lumicorp/kestrel-environment-router:${parsed}`,
  };
}

export function productionTag(value: string) {
  const tag = value.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(tag)) {
    throw new Error("--tag must be a valid container image tag.");
  }
  return tag;
}

export async function confirmExact(expected: string) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const supplied = await readline.question(`Type '${expected}' to continue: `);
    if (supplied !== expected) throw new Error("Confirmation did not match the exact target.");
  } finally {
    readline.close();
  }
}

export function requiredArgument(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function rejectUnknownArguments(args: string[], names: string[]) {
  const consumed = new Set<number>();
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) {
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  const unknown = args.filter(
    (value, index) => value !== "--" && !consumed.has(index),
  );
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}.`);
}

function capture(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
  const value = result.stdout.trim();
  if (!value) throw new Error(`${command} ${args[0] ?? ""} returned no identity.`);
  return value;
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
}
