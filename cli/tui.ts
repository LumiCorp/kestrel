#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { App } from "./app/App.js";
import { runCliCommand, shouldRunCommandMode } from "./commandMode.js";

interface CliArgs {
  profileId?: string;
  sessionName?: string;
  freshSessionName?: string;
  runnerMode?: "child" | "inprocess";
  scripted?: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isVersionArgs(argv)) {
    process.stdout.write(`kestrel ${readSuiteVersion()}\n`);
    return;
  }
  if (isHelpArgs(argv)) {
    process.stdout.write(formatKestrelHelp());
    return;
  }
  if (shouldRunCommandMode(argv)) {
    await runCliCommand(argv, process.cwd());
    return;
  }

  const args = parseArgs(argv);
  const app = new App({
    cwd: process.cwd(),
    ...(args.profileId !== undefined ? { profileId: args.profileId } : {}),
    ...(args.sessionName !== undefined ? { sessionName: args.sessionName } : {}),
    ...(args.freshSessionName !== undefined ? { freshSessionName: args.freshSessionName } : {}),
    ...(args.runnerMode !== undefined ? { runnerMode: args.runnerMode } : {}),
    ...(args.scripted === true ? { scripted: true } : {}),
  });

  await app.start();
}

if (isDirectEntry()) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kestrel failed: ${message}\n`);
    process.exitCode = 1;
  });
}

export function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--profile") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--profile requires a value");
      }

      parsed.profileId = value;
      index += 1;
      continue;
    }

    if (token === "--session") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--session requires a value");
      }

      parsed.sessionName = value;
      index += 1;
      continue;
    }

    if (token === "--new-session") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--new-session requires a value");
      }

      parsed.freshSessionName = value;
      index += 1;
      continue;
    }

    if (token === "--inprocess-runner") {
      parsed.runnerMode = "inprocess";
      continue;
    }

    if (token === "--scripted") {
      parsed.scripted = true;
      continue;
    }

    throw new Error(`Unknown argument '${token}'`);
  }

  return parsed;
}

export function isVersionArgs(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-v" || args[0] === "version");
}

export function isHelpArgs(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help");
}

export function formatKestrelHelp(): string {
  return [
    "Usage: kestrel [command] [options]",
    "",
    "Interactive commands: kestrel, ks",
    "",
    "Commands:",
    "  status",
    "  workspace status|list",
    "  web [--host <host>] [--port <port>] [--token <token>]",
    "  job run --json-in <file> --json-out <file> [--profile <id>] [--store auto|postgres|sqlite]",
    "  setup [--profile <id>] [--store auto|postgres|sqlite]",
    "  runtime bundle --run-id|--thread-id <id> --out <file> [--store auto|postgres|sqlite]",
    "",
    "Options:",
    "  --profile <id>",
    "  --session <name>",
    "  --new-session <name>",
    "  --inprocess-runner",
    "  --scripted",
    "  --version",
    "  --help",
    "",
  ].join("\n");
}

function readSuiteVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" && manifest.version.trim().length > 0
    ? manifest.version
    : "unknown";
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}
