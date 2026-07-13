import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseRunnerHealthV1 } from "../packages/protocol/src/index.js";

const TARGET_VERSION = "0.5.1";
const TARGET_PLATFORM = "darwin";
const TARGET_ARCH = "arm64";
const CLI_NAMES = ["kestrel", "ks", "kcron"] as const;
const REMOVED_CLI_NAMES = ["kwork", "kchat", "kcode"] as const;
const REQUIRED_LIBEXEC_PATHS = [
  "package.json",
  "cli/tui.ts",
  "cli/kcron.ts",
  "cli/client/ProtocolClient.ts",
  "cli/client/RemoteRunnerTransport.ts",
  "src/localCore/LocalCoreRunnerTransport.ts",
  "cli/client/configuredTransport.ts",
  "cli/client/configuredClient.ts",
  "cli/client/coreExecutionProfile.ts",
  "cli/webRunnerProxy.ts",
  "cli/runner/RunnerServiceEventJournal.ts",
  "cli/runner/RunnerServiceHost.ts",
  "src/localCore/index.ts",
  "src/localCore/contracts.ts",
  "src/localCore/home.ts",
  "src/localCore/api.ts",
  "src/localCore/client.ts",
  "src/localCore/connection.ts",
  "src/localCore/daemon.ts",
  "src/localCore/daemonMain.ts",
  "src/localCore/legacyState.ts",
  "src/localCore/executionRuntime.ts",
  "src/localCore/profileProvider.ts",
  "src/localCore/protocolEventJournal.ts",
  "src/localCore/store.ts",
  "src/replay/RuntimeReplayBundle.ts",
  "postgres-bundle/darwin-arm64/bin/initdb",
  "postgres-bundle/darwin-arm64/bin/postgres",
  "postgres-bundle/darwin-arm64/bin/pg_ctl",
  "postgres-bundle/darwin-arm64/bin/createdb",
  "src/runtime/RuntimeTurn.ts",
  "agents/reference-react/src/index.ts",
  "tools/createDefaultToolGateway.ts",
  "db/migrations/001_sessions_runs.sql",
  "db/migrations/023_runner_protocol_events.sql",
  "scripts/migrate.ts",
  "scripts/kchat-smoke.ts",
  "scripts/local-core-release-smoke.ts",
  "models/ollama/createOllamaModelGateway.ts",
  "bin/kestrel.js",
  "bin/kestrel-core.js",
] as const;
const FORBIDDEN_LIBEXEC_PATHS = [
  "cli/client/InProcessRunnerTransport.ts",
  "cli/client/RunnerProcess.ts",
  "cli/runner/main.ts",
] as const;
const REQUIRED_DEPENDENCIES = [
  "tsx",
  "pg",
  "ink",
  "@electric-sql/pglite",
  "@kestrel-agents/protocol",
] as const;

const root = resolveRepoRoot(process.cwd());
const artifactPath = path.join(root, "apps", "cli", "out", `kestrel-cli-${TARGET_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}.tar.gz`);
const errors: string[] = [];

await main();

async function main(): Promise<void> {
  checkSuiteVersion();
  if (!existsSync(artifactPath)) {
    errors.push(`missing CLI artifact: ${path.relative(root, artifactPath)}`);
    report();
    return;
  }

  const extractRoot = mkdtempSync(path.join(os.tmpdir(), "kestrel-cli-release-"));
  try {
    execFileSync("tar", ["-xzf", artifactPath, "-C", extractRoot], { cwd: root, stdio: "pipe" });
    await checkExtractedArtifact(extractRoot);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }

  report();
}

function checkSuiteVersion(): void {
  const manifest = readJson(path.join(root, "package.json")) as { version?: unknown };
  if (manifest.version !== TARGET_VERSION) {
    errors.push(`root package.json version must be ${TARGET_VERSION}; found ${String(manifest.version)}`);
  }
}

async function checkExtractedArtifact(extractRoot: string): Promise<void> {
  const binRoot = path.join(extractRoot, "bin");
  const libexecRoot = realpathSync(path.join(extractRoot, "libexec"));
  for (const name of CLI_NAMES) {
    const launcherPath = path.join(binRoot, name);
    if (!existsSync(launcherPath)) {
      errors.push(`artifact missing bin/${name}`);
      continue;
    }
    if ((statSync(launcherPath).mode & 0o111) === 0) {
      errors.push(`artifact launcher bin/${name} must be executable`);
    }
    const launcherSource = readFileSync(launcherPath, "utf8");
    if (launcherSource.includes(root)) {
      errors.push(`artifact launcher bin/${name} must not reference the source checkout`);
    }
    if (!launcherSource.includes("libexecRoot") || !launcherSource.includes("\"libexec\"")) {
      errors.push(`artifact launcher bin/${name} must resolve ../libexec`);
    }
  }
  for (const name of REMOVED_CLI_NAMES) {
    if (existsSync(path.join(binRoot, name))) {
      errors.push(`artifact must not include removed CLI alias bin/${name}`);
    }
  }
  if (existsSync(path.join(binRoot, "kestrel-core"))) {
    errors.push("artifact must not expose internal daemon as public bin/kestrel-core");
  }

  for (const relativePath of REQUIRED_LIBEXEC_PATHS) {
    if (!existsSync(path.join(libexecRoot, relativePath))) {
      errors.push(`artifact missing libexec/${relativePath}`);
    }
  }
  for (const relativePath of FORBIDDEN_LIBEXEC_PATHS) {
    if (existsSync(path.join(libexecRoot, relativePath))) {
      errors.push(`artifact must not include embedded CLI execution authority libexec/${relativePath}`);
    }
  }

  const runtimePackage = readJson(path.join(libexecRoot, "package.json")) as {
    version?: unknown;
    dependencies?: Record<string, unknown> | undefined;
  };
  if (runtimePackage.version !== TARGET_VERSION) {
    errors.push(`libexec/package.json version must be ${TARGET_VERSION}; found ${String(runtimePackage.version)}`);
  }
  for (const dependency of REQUIRED_DEPENDENCIES) {
    if (runtimePackage.dependencies?.[dependency] === undefined) {
      errors.push(`libexec/package.json must include dependency '${dependency}'`);
    }
    if (!existsSync(path.join(libexecRoot, "node_modules", dependency, "package.json"))) {
      errors.push(`artifact missing libexec/node_modules/${dependency}`);
    }
  }
  if (runtimePackage.dependencies?.["@kestrel-agents/protocol"] !== TARGET_VERSION) {
    errors.push(`libexec/package.json must declare @kestrel-agents/protocol ${TARGET_VERSION}`);
  }
  const installedProtocolPath = path.join(
    libexecRoot,
    "node_modules",
    "@kestrel-agents",
    "protocol",
    "package.json",
  );
  if (existsSync(installedProtocolPath)) {
    const installedProtocol = readJson(installedProtocolPath) as { version?: unknown };
    if (installedProtocol.version !== TARGET_VERSION) {
      errors.push(`artifact must install @kestrel-agents/protocol ${TARGET_VERSION}`);
    }
  }
  if (existsSync(path.join(libexecRoot, "packages", "protocol"))) {
    errors.push("artifact must install protocol from its packed artifact, not copied package source");
  }

  for (const envFile of collectLocalEnvFiles(libexecRoot)) {
    errors.push(`artifact must not include local env file '${envFile}'`);
  }

  await runSmokeChecks(extractRoot);
}

async function runSmokeChecks(extractRoot: string): Promise<void> {
  const home = mkdtempSync(path.join(os.tmpdir(), "kestrel-cli-home-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "kestrel-cli-cwd-"));
  const env = {
    ...process.env,
    KESTREL_CORE_HOME: home,
    KESTREL_CORE_IDLE_TIMEOUT_MS: "1000",
    DATABASE_URL: "postgresql://host-env-should-not-be-used.invalid:5432/kestrel",
    KESTREL_DISABLE_DOTENV: "1",
    FORCE_COLOR: "0",
  };
  const kestrel = path.join(extractRoot, "bin", "kestrel");
  const kcron = path.join(extractRoot, "bin", "kcron");

  try {
    expectOutput(kestrel, ["--version"], cwd, env, /0\.5\.1/u, "kestrel --version");
    expectOutput(kestrel, ["--help"], cwd, env, /Usage: kestrel/u, "kestrel --help");
    expectOutput(kestrel, ["workspace", "status"], cwd, env, /Workspace:/u, "kestrel workspace status");
    expectOutput(kestrel, ["status"], cwd, env, /Kestrel Local Core|Local Core/u, "kestrel status");
    expectOutput(kcron, ["--version"], cwd, env, /0\.5\.1/u, "kcron --version");
    expectOutput(kcron, ["status"], cwd, env, /kcron:/u, "kcron status");
    smokePackagedProtocolClient(extractRoot, cwd, env);
    await smokeWebRunner(kestrel, cwd, env);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function smokePackagedProtocolClient(
  extractRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const libexecRoot = realpathSync(path.join(extractRoot, "libexec"));
  const require = createRequire(path.join(libexecRoot, "package.json"));
  const tsxImport = require.resolve("tsx");
  const smokeScript = path.join(libexecRoot, "scripts", "kchat-smoke.ts");
  try {
    const output = execFileSync(process.execPath, ["--import", tsxImport, smokeScript], {
      cwd,
      env: {
        ...env,
        KESTREL_CLI_LIBEXEC: libexecRoot,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (!/kchat smoke: protocol ok/u.test(output)) {
      errors.push(`packaged protocol client smoke output was unexpected: ${JSON.stringify(output.slice(0, 400))}`);
    }
  } catch (error) {
    errors.push(`packaged protocol client smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expectOutput(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  pattern: RegExp,
  label: string,
): void {
  try {
    const output = execFileSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    if (!pattern.test(output)) {
      errors.push(`${label} output did not match ${pattern}: ${JSON.stringify(output.slice(0, 400))}`);
    }
  } catch (error) {
    errors.push(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function smokeWebRunner(kestrel: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const port = await reservePort();
  const child = spawn(kestrel, ["web", "--port", String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childClose = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitFor(() => stdout.includes("export KESTREL_RUNNER_SERVICE_TOKEN="), 20_000);
    const url = stdout.match(/export KESTREL_RUNNER_SERVICE_URL='([^']+)'/u)?.[1];
    const token = stdout.match(/export KESTREL_RUNNER_SERVICE_TOKEN='([^']+)'/u)?.[1];
    if (url === undefined || token === undefined) {
      errors.push(`kestrel web did not print URL/token exports: ${stdout.slice(0, 800)}`);
      return;
    }
    const health = await httpJson(`${url}/health`);
    if (health.status !== 200) {
      errors.push(`kestrel web health check failed: ${JSON.stringify(health)}`);
    } else {
      try {
        parseRunnerHealthV1(health.body);
      } catch (error) {
        errors.push(`kestrel web health contract failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const ping = await httpJson(`${url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: "cli-release-ping",
        type: "runner.ping",
        metadata: {
          actor: {
            actorId: "cli-release-check",
            actorType: "operator",
            tenantId: "internal",
          },
          tenantId: "internal",
        },
        payload: {
          nonce: "cli-release-check",
        },
      }),
    });
    if (ping.status !== 200 || (ping.body as { type?: unknown }).type !== "runner.pong") {
      errors.push(`kestrel web ping failed: ${JSON.stringify(ping)}`);
    }
  } catch (error) {
    errors.push(`kestrel web smoke failed: ${error instanceof Error ? error.message : String(error)} stderr=${stderr.slice(0, 800)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
    }
    await waitForChild(childClose, 30_000).catch((error) => {
      errors.push(`kestrel web did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
      child.kill("SIGKILL");
    });
  }
}

function httpJson(url: string, options: {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
} = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method ?? "GET",
      headers: options.headers,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : undefined });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out after ${timeoutMs}ms.`));
      }
    }, 100);
  });
}

function waitForChild(childClose: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    childClose.then(() => {
      clearTimeout(timer);
      resolve();
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function collectLocalEnvFiles(rootPath: string): string[] {
  const matches: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.name === "node_modules") {
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env."))) {
        matches.push(path.relative(rootPath, entryPath).split(path.sep).join("/"));
      }
    }
  };
  visit(rootPath);
  return matches;
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

function report(): void {
  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`[cli-release] ${error}\n`);
    }
    process.stderr.write(`[cli-release] failed with ${errors.length} issue(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[cli-release] CLI ${TARGET_VERSION} ${TARGET_PLATFORM}-${TARGET_ARCH} release checks passed\n`);
}
