import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const cases = ["grant", "browse", "takeover", "upload", "transfers", "cleanup"];
if (
  args.length &&
  !(args.length === 2 && args[0] === "--case" && cases.includes(args[1]))
) {
  throw new Error(`Usage: pnpm validate:browser [--case ${cases.join("|")}]`);
}
const id = `kestrel-browser-test-${randomUUID()}`;
const image = "kestrel-browser-connected-tests:local";
let child;
let interrupted = false;
let cleaning = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
}
const revision = (await run("git", ["rev-parse", "HEAD"], true)).trim();
const dirty = Boolean(
  (await run("git", ["status", "--porcelain"], true)).trim(),
);
const owned = [];
let networkCreated = false;
let failure;
try {
  await run("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    "tests/browser/Dockerfile",
    "-t",
    image,
    ".",
  ]);
  const imageId = (
    await run(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", image],
      true,
    )
  ).trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId))
    throw new Error("Test image identity is not an immutable image ID");
  // No outbound Internet while tests run. Browser destinations are exclusively
  // fixture hosts reached through the actual authenticated Gateway proxy.
  await run("docker", ["network", "create", "--internal", id]);
  networkCreated = true;
  for (const [role, source, options] of [
    [
      "postgres",
      "pgvector/pgvector:pg16",
      [
        "-e",
        "POSTGRES_PASSWORD=browser-local-only",
        "-e",
        "POSTGRES_DB=browser_test",
      ],
    ],
    ["redis", "redis:7-alpine", []],
  ]) {
    const name = `${id}-${role}`;
    owned.push(name);
    await run("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `dev.kestrel.browser-test=${id}`,
      "--network",
      id,
      "--network-alias",
      role,
      ...options,
      source,
    ]);
  }
  const name = `${id}-suite`;
  owned.push(name);
  await run("docker", [
    "run",
    "--name",
    name,
    "--init",
    "--platform",
    "linux/amd64",
    "--shm-size",
    "1g",
    "--label",
    `dev.kestrel.browser-test=${id}`,
    "--network",
    id,
    "--add-host",
    "gateway.vm.browser-test.internal:127.0.0.1",
    "-e",
    "DATABASE_URL=postgres://postgres:browser-local-only@postgres:5432/browser_test",
    "-e",
    "REDIS_URL=redis://redis:6379",
    "-e",
    `BROWSER_TEST_REVISION=${revision}${dirty ? "+working-tree" : ""}`,
    "-e",
    `BROWSER_TEST_IMAGE_ID=${imageId}`,
    imageId,
    ...args,
  ]);
} catch (error) {
  failure = error;
} finally {
  cleaning = true;
  // Exact names generated in this run only; never prune Docker or user volumes.
  for (const name of owned.reverse()) {
    try {
      await run("docker", ["rm", "-f", "-v", name]);
    } catch (error) {
      failure ??= error;
    }
  }
  if (networkCreated) {
    try {
      await run("docker", ["network", "rm", id]);
    } catch (error) {
      failure ??= error;
    }
  }
}
if (failure) throw failure;

function run(command, commandArgs, capture = false) {
  if (interrupted && !cleaning)
    return Promise.reject(new Error("Browser test interrupted"));
  return new Promise((resolve, reject) => {
    const active = spawn(command, commandArgs, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    child = active;
    let output = "";
    active.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    active.once("error", reject);
    active.once("exit", (status, signal) => {
      if (child === active) child = undefined;
      if (status !== 0 || (interrupted && !cleaning))
        reject(
          new Error(
            `${command} ${commandArgs[0]} failed (${signal ?? status})`,
          ),
        );
      else resolve(output);
    });
  });
}
