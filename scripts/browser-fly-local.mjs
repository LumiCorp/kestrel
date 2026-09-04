import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFlyLocalProxy } from "../apps/web/tests/browser/fly-local-proxy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--check"));
for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  assert.equal(await access(path.join(web, name)).then(() => true, () => false), false, `Refusing local setup with ${name} present`);
}
await access(path.join(web, ".next/BUILD_ID"));
for (const port of [3000, 3001]) {
  const probe = createServer();
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise(resolve => probe.close(resolve));
}
const directory = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-fly-local-"));
const container = `kestrel-browser-fly-local-${randomUUID()}`;
const log = createWriteStream(path.join(directory, "setup.log"), { mode: 0o600 });
const keys = () => {
  const pair = generateKeyPairSync("ed25519");
  return { private: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), public: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const environmentKeys = keys();
const browserKeys = keys();
const gatewayToken = randomUUID();
const workspaceToken = randomUUID();
const env = {
  ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])),
  NODE_ENV: "production", KESTREL_DISABLE_DOTENV: "1", NEXT_TELEMETRY_DISABLED: "1",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_URL: "http://127.0.0.1:3000",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000", KESTREL_ONE_APP_URL: "http://127.0.0.1:3000",
  KESTREL_ENVIRONMENT_RUNTIME: "fly", STORAGE_PROVIDER: "local", STORAGE_LOCAL_ROOT: path.join(directory, "files"),
  KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: environmentKeys.private, KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: environmentKeys.public,
  KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY: browserKeys.private,
  KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "browser-local-test",
  KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({ "browser-local-test": randomBytes(32).toString("base64") }),
  BROWSER_TEST_GATEWAY_TOKEN: gatewayToken, BROWSER_TEST_WORKSPACE_TOKEN: workspaceToken,
  BROWSER_TEST_IDS_FILE: path.join(directory, "ids.json"),
};
let next;
let proxy;
let cancelled = false;
let wake;
const stop = new Promise(resolve => { wake = resolve; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cancelled = true; next?.kill("SIGTERM"); wake(); });
async function run(command, args, capture = false) {
  if (cancelled) throw new Error("Local setup cancelled");
  const child = spawn(command, args, { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { if (capture) output += bytes; else log.write(bytes); });
  child.stderr.on("data", bytes => log.write(bytes));
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${args[0]} failed; inspect ${directory}/setup.log`);
  return output.trim();
}
try {
  console.info("[browser-local] Creating disposable PostgreSQL");
  await run("docker", ["run", "--detach", "--name", container, "--label", "dev.kestrel.browser-fly-local=true", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_PASSWORD=local-browser-test-only", "--env", "POSTGRES_DB=browser_fly_local", "pgvector/pgvector:pg16"]);
  const binding = await run("docker", ["port", container, "5432/tcp"], true);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  env.DATABASE_URL = `postgres://postgres:local-browser-test-only@${binding}/browser_fly_local`;
  await writeFile(path.join(directory, "state.json"), JSON.stringify({ container, env }), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { await run("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "browser_fly_local"]); break; }
    catch (error) { if (attempt >= 29 || cancelled) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  for (const script of ["lib/db/migrate.ts", "lib/db/contract-migrate.ts", "tests/browser/fly-local-seed.ts"]) {
    await run(process.execPath, ["--import", "./scripts/register-server-only.mjs", "--import", "tsx", script]);
  }
  const ids = JSON.parse(await readFile(env.BROWSER_TEST_IDS_FILE, "utf8"));
  console.info("[browser-local] Starting candidate Web on 127.0.0.1:3000");
  next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3000"], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.pipe(log, { end: false }); next.stderr.pipe(log, { end: false });
  next.on("exit", wake);
  const configPath = `/api/runtime/environments/${ids.environmentId}/gateway/config`;
  const deadline = Date.now() + 60_000;
  while (true) {
    if (next.exitCode !== null || cancelled) throw new Error("Candidate Web stopped during startup");
    try { const res = await fetch(`http://127.0.0.1:3000${configPath}`, { signal: AbortSignal.timeout(2000) }); if (res.status === 401) break; }
    catch {}
    assert.ok(Date.now() < deadline, `Candidate Web not ready; inspect ${directory}/setup.log`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  proxy = createFlyLocalProxy({ environmentId: ids.environmentId, webPort: 3000 });
  proxy.server.listen(3001, "127.0.0.1");
  await once(proxy.server, "listening");
  const base = "http://127.0.0.1:3001";
  assert.equal((await fetch(base + configPath)).status, 401);
  const authorized = await fetch(base + configPath, { headers: { authorization: `Bearer ${gatewayToken}` } });
  assert.equal(authorized.status, 200);
  const config = await authorized.json();
  assert.equal(config.environmentId, ids.environmentId);
  assert.equal(config.appGrants.length, 1);
  assert.equal(config.workspaces.length, 1);
  // Exercise the real route adapter and actor/capability authorization. The
  // deliberately unconfigured provider must be the first remaining failure.
  const routeFailures = [];
  for (const [capability, action] of [["request_grant", "policy"], ["open", "accept"], ["upload", "prepare-upload"], ["download", "prepare-download"], ["download", "release-download"]]) {
    const response = await fetch(`${base}/api/runtime/apps/built_in.browser/${capability}/auto/control/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${config.appGrants[0].executionTicket}`, "content-type": "application/json" }, body: "{}",
    });
    const code = (await response.json()).error?.code;
    console.info(`[browser-local] ${capability}/${action}: ${response.status} ${code}`);
    if (response.status !== 503 || code !== "BROWSER_SERVICE_UNAVAILABLE") {
      routeFailures.push(`${capability}/${action}: ${response.status} ${code}`);
    }
  }
  assert.deepEqual(routeFailures, [], "Signed routes must reach Browser composition before Fly qualification");
  for (const route of ["/dashboard", "/api/auth/session", "/api/health", configPath + "?extra=1"]) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + "/api/runtime/apps/built_in.browser/open/auto/control/policy", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 401);
  assert.match(await (await fetch(base + "/fixture")).text(), /Kestrel transfer fixture/);
  const bytes = Buffer.from("local preflight upload");
  assert.equal((await fetch(base + "/fixture/upload", { method: "POST", body: bytes })).status, 200);
  assert.deepEqual(proxy.uploads, [bytes]); proxy.uploads.length = 0;
  assert.deepEqual(Buffer.from(await (await fetch(base + "/fixture/download")).arrayBuffer()), proxy.download);
  console.info(`[browser-local] READY: authorization, route isolation, and fixture bytes passed.\nProxy: ${base}\nFixture: ${base}/fixture\nPrivate state: ${directory}\nNo Fly credentials loaded or Machines created. Stop with Ctrl-C.`);
  if (process.argv[2] !== "--check") await stop;
  if (next.exitCode !== null && !cancelled) throw new Error("Candidate Web exited unexpectedly");
} finally {
  if (proxy) { proxy.server.closeAllConnections(); await new Promise(resolve => proxy.server.close(resolve)); }
  if (next && next.exitCode === null) { const exited = once(next, "exit"); next.kill("SIGTERM"); await exited; }
  // Only the exact container allocated by this invocation. Keep logs/state on
  // failure so cleanup can be retried; never prune Docker or load production env.
  const cleanup = spawn("docker", ["rm", "--force", "--volumes", container], { env, stdio: "ignore" });
  const [code] = await once(cleanup, "exit");
  log.end();
  if (code === 0) {
    await rm(path.join(directory, "state.json"), { force: true });
    await rm(path.join(directory, "files"), { recursive: true, force: true });
  } else throw new Error(`Cleanup unconfirmed for ${container}; private state retained at ${directory}`);
}
