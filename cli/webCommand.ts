import { randomBytes } from "node:crypto";
import process from "node:process";

import { loadShellAndDotEnv } from "./config/EnvLoader.js";
import { createRunnerServiceServer, type RunnerServiceServer } from "./runner/RunnerService.js";
import { DEFAULT_KESTREL_RUNNER_SERVICE_PORT } from "../src/config/localDev.js";

const DEFAULT_RUNNER_SERVICE_HOST = "127.0.0.1";
const DEFAULT_WEB_COMMAND_SHUTDOWN_GRACE_MS = 10_000;

export interface WebCommandArgs {
  host?: string | undefined;
  port?: number | undefined;
  token?: string | undefined;
}

export interface WebCommandConfig {
  host: string;
  port: number;
  token: string;
  tokenSource: "provided" | "generated";
}

export interface WebCommandStartupMetadata {
  type: "runner.service.started";
  url: string;
  host: string;
  port: number;
  token: string;
  tokenSource: "provided" | "generated";
}

export async function runWebCommand(args: string[], cwd = process.cwd()): Promise<void> {
  await loadShellAndDotEnv(cwd, {
    preferDotEnvKeys: [
      "KESTREL_RUNNER_SERVICE_HOST",
      "KESTREL_RUNNER_SERVICE_PORT",
      "KESTREL_RUNNER_SERVICE_TOKEN",
    ],
  });

  const config = resolveWebCommandConfig(args, process.env);
  let server: RunnerServiceServer;

  try {
    server = await createRunnerServiceServer({
      host: config.host,
      port: config.port,
      authToken: config.token,
    });
  } catch (error) {
    throw new Error(formatStartupError(config, error));
  }

  try {
    const startup = createWebCommandStartupMetadata(server, config);
    for (const line of formatWebCommandStartupLines(startup)) {
      process.stdout.write(`${line}\n`);
    }

    const shutdown = await waitForShutdownSignal(server, resolveShutdownGraceMs(process.env));
    process.stderr.write("kestrel web: runner service stopped\n");
    if (shutdown.forced === true) {
      process.exit(0);
    }
  } catch (error) {
    await server.close().catch(() => {
      // Best-effort forced cleanup after an unexpected shutdown failure.
    });
    throw error;
  }
}

export function parseWebCommandArgs(args: string[]): WebCommandArgs {
  const parsed: WebCommandArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--host") {
      parsed.host = readFlagValue(args, index, "--host").trim();
      index += 1;
      continue;
    }
    if (token === "--port") {
      parsed.port = parsePort(readFlagValue(args, index, "--port"), "--port");
      index += 1;
      continue;
    }
    if (token === "--token") {
      parsed.token = readFlagValue(args, index, "--token");
      index += 1;
      continue;
    }
    throw new Error("Usage: kestrel web [--host <host>] [--port <port>] [--token <token>]");
  }

  return parsed;
}

export function resolveWebCommandConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): WebCommandConfig {
  const parsed = parseWebCommandArgs(args);
  const host = parsed.host ?? readNonEmptyString(env.KESTREL_RUNNER_SERVICE_HOST) ?? DEFAULT_RUNNER_SERVICE_HOST;
  const port =
    parsed.port ??
    (env.KESTREL_RUNNER_SERVICE_PORT !== undefined
      ? parsePort(env.KESTREL_RUNNER_SERVICE_PORT, "KESTREL_RUNNER_SERVICE_PORT")
      : DEFAULT_KESTREL_RUNNER_SERVICE_PORT);
  const explicitToken = parsed.token ?? readNonEmptyString(env.KESTREL_RUNNER_SERVICE_TOKEN);

  if (host.length === 0) {
    throw new Error("KESTREL_RUNNER_SERVICE_HOST must be a non-empty string.");
  }

  if (explicitToken !== undefined) {
    return {
      host,
      port,
      token: explicitToken,
      tokenSource: "provided",
    };
  }

  return {
    host,
    port,
    token: generateRunnerServiceToken(),
    tokenSource: "generated",
  };
}

export function generateRunnerServiceToken(): string {
  return randomBytes(24).toString("hex");
}

export function createWebCommandStartupMetadata(
  server: Pick<RunnerServiceServer, "url" | "host" | "port">,
  config: Pick<WebCommandConfig, "host" | "token" | "tokenSource">,
): WebCommandStartupMetadata {
  return {
    type: "runner.service.started",
    url: buildAdvertisedRunnerServiceUrl(config.host, server.port),
    host: server.host,
    port: server.port,
    token: config.token,
    tokenSource: config.tokenSource,
  };
}

export function formatWebCommandStartupLines(metadata: WebCommandStartupMetadata): string[] {
  const publicMetadata =
    metadata.tokenSource === "generated"
      ? metadata
      : { ...metadata, token: "[redacted]" };
  const lines = [
    JSON.stringify(publicMetadata),
    "kestrel web: runner service is ready",
    `export KESTREL_RUNNER_SERVICE_URL=${toShellLiteral(metadata.url)}`,
  ];
  if (metadata.tokenSource === "generated") {
    lines.push(
      `export KESTREL_RUNNER_SERVICE_TOKEN=${toShellLiteral(metadata.token)}`,
      "Use these exports in your web app server environment. Press Ctrl+C to stop.",
    );
  } else {
    lines.push(
      "KESTREL_RUNNER_SERVICE_TOKEN is configured; value withheld.",
      "Use the configured runner service token in your web app server environment. Press Ctrl+C to stop.",
    );
  }
  return lines;
}

function waitForShutdownSignal(
  server: Pick<RunnerServiceServer, "gracefulClose" | "forceClose">,
  graceMs: number,
): Promise<{ forced: boolean }> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let shuttingDown = false;
    let finished = false;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };

    const finish = (result: { forced: boolean }) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(result);
    };

    const forceShutdown = (reason: "timeout" | "signal" | "error", error?: unknown) => {
      if (finished) {
        return;
      }
      if (reason === "timeout") {
        process.stderr.write("kestrel web: shutdown grace period elapsed; forcing shutdown\n");
      } else if (reason === "signal") {
        process.stderr.write("kestrel web: received another shutdown signal; forcing shutdown\n");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`kestrel web: graceful shutdown failed; forcing shutdown (${message})\n`);
      }
      void server.forceClose().catch(() => {
        // Force shutdown is best-effort because the process is about to exit.
      });
      finish({ forced: true });
    };

    const onSignal = () => {
      if (shuttingDown) {
        forceShutdown("signal");
        return;
      }
      shuttingDown = true;
      process.stderr.write(
        `kestrel web: shutting down gracefully (up to ${graceMs}ms before forcing shutdown)\n`,
      );
      timer = setTimeout(() => {
        forceShutdown("timeout");
      }, graceMs);
      void server.gracefulClose().then(() => {
        if (finished) {
          return;
        }
        finish({ forced: false });
      }).catch((error) => {
        forceShutdown("error", error);
      });
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function resolveShutdownGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = readNonEmptyString(env.KESTREL_RUNNER_SERVICE_SHUTDOWN_GRACE_MS);
  if (raw === undefined) {
    return DEFAULT_WEB_COMMAND_SHUTDOWN_GRACE_MS;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) === false || parsed < 0) {
    throw new Error("KESTREL_RUNNER_SERVICE_SHUTDOWN_GRACE_MS must be a non-negative integer.");
  }
  return parsed;
}

function readFlagValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: string, label: string): number {
  const parsed = Number(value.trim());
  if (Number.isInteger(parsed) === false || parsed <= 0 || parsed > 65535) {
    throw new Error(`${label} must be a valid TCP port.`);
  }
  return parsed;
}

function formatStartupError(config: WebCommandConfig, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Unable to start kestrel web on ${config.host}:${config.port}: ${message}`;
}

function buildAdvertisedRunnerServiceUrl(host: string, port: number): string {
  const advertisedHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
  return `http://${advertisedHost}:${port}`;
}

function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
