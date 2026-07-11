#!/usr/bin/env node

import readline from "node:readline";

import { CommandRouter } from "./CommandRouter.js";
import { EventWriter } from "./EventWriter.js";
import { RunnerHost } from "./RunnerHost.js";

async function main(): Promise<void> {
  const writer = new EventWriter(process.stdout);
  const host = new RunnerHost(writer);
  const router = new CommandRouter(host, writer);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line) => {
    void router.acceptLine(line);
  });

  rl.on("close", () => {
    void host.close();
  });

  process.on("SIGINT", () => {
    rl.close();
  });

  process.on("SIGTERM", () => {
    rl.close();
  });
}

void main().catch((error) => {
  const writer = new EventWriter(process.stdout);
  writer.emit("runner.error", {
    code: "RUNNER_RUNTIME_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
