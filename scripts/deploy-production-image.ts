import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { flyImageCatalogSchema } from "./production-image-contract.js";

const roleSchema = z.enum([
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "control-worker",
  "runpod-worker",
]);

async function main() {
  const role = roleSchema.parse(process.argv[2]);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(process.env.GITHUB_SHA);
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile("deploy/fly/image-catalog.json", "utf8")),
  );
  const image = catalog.images.find((candidate) => candidate.role === role);
  if (!image) throw new Error(`Catalog role ${role} is unavailable.`);
  const label = `production-${revision.slice(0, 12)}-${requireEnv("GITHUB_RUN_ID")}`;
  const taggedImage = `${image.repository}:${label}`;
  if (image.publisher === "ghcr") {
    run("docker", [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      image.dockerfile,
      "--tag",
      taggedImage,
      "--build-arg",
      `KESTREL_GIT_SHA=${revision}`,
      "--push",
      ".",
    ]);
  } else {
    run("flyctl", [
      "deploy",
      ".",
      "--app",
      image.app,
      "--config",
      image.config,
      "--dockerfile",
      image.dockerfile,
      "--build-only",
      "--push",
      "--remote-only",
      "--image-label",
      label,
      "--build-arg",
      `KESTREL_GIT_SHA=${revision}`,
    ]);
  }
  run("docker", ["pull", taggedImage]);
  const digest = capture("docker", [
    "inspect",
    "--format",
    "{{index .RepoDigests 0}}",
    taggedImage,
  ]).trim();
  if (!digest.startsWith(`${image.repository}@sha256:`)) {
    throw new Error(`Registry did not resolve an immutable ${role} digest.`);
  }
  run("bash", [image.smoke, digest], { EXPECTED_GIT_SHA: revision });
  if (image.publisher === "ghcr") {
    run("cosign", ["sign", "--yes", digest]);
    run("cosign", [
      "verify",
      "--certificate-identity-regexp",
      "^https://github.com/LumiCorp/kestrel/",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      digest,
    ]);
  }
  const artifact = { role, image: digest, sourceRevision: revision };
  await writeFile(
    `production-image-${role}.json`,
    JSON.stringify(artifact),
    "utf8",
  );
  if (image.channel === "environment-runtime") {
    await writeOutput("image", digest);
    return;
  }

  const previousImage = currentMachineImage(image.app, image.repository);
  if (!previousImage) {
    throw new Error(
      `${image.app} has no prior Machine digest to restore safely.`,
    );
  }
  try {
    if (["turn-worker", "control-worker", "runpod-worker"].includes(role)) {
      run("pnpm", [
        "--dir",
        "apps/web",
        "sync:worker-config",
        "--",
        "--role",
        role,
      ]);
    }
    run("flyctl", [
      "deploy",
      ".",
      "--app",
      image.app,
      "--config",
      image.config,
      "--image",
      digest,
      "--strategy",
      "rolling",
      "--yes",
    ]);
    assertMachinesUseImage(image.app, image.repository, digest);
    if (["turn-worker", "control-worker", "runpod-worker"].includes(role)) {
      assertWorkerChecksPass(image.app);
    }
  } catch (error) {
    run("flyctl", [
      "deploy",
      ".",
      "--app",
      image.app,
      "--config",
      image.config,
      "--image",
      previousImage,
      "--strategy",
      "rolling",
      "--yes",
    ]);
    assertMachinesUseImage(image.app, image.repository, previousImage);
    if (["turn-worker", "control-worker", "runpod-worker"].includes(role)) {
      assertWorkerChecksPass(image.app);
    }
    throw error;
  }
  await writeOutput("image", digest);
  await writeOutput("previous_image", previousImage);
}

function machineInventory(app: string) {
  return z
    .array(z.record(z.string(), z.unknown()))
    .parse(
      JSON.parse(
        capture("flyctl", ["machines", "list", "--app", app, "--json"]),
      ),
    );
}

function currentMachineImage(app: string, repository: string) {
  const images = new Set(
    machineInventory(app).flatMap((machine) => {
      const imageRef = asRecord(machine.image_ref ?? machine.imageRef);
      const digest = imageRef?.digest;
      return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest)
        ? [`${repository}@${digest}`]
        : [];
    }),
  );
  if (images.size > 1)
    throw new Error(`${app} Machines do not share one prior digest.`);
  return [...images][0] ?? null;
}

function assertMachinesUseImage(
  app: string,
  repository: string,
  expected: string,
) {
  const current = currentMachineImage(app, repository);
  if (current !== expected) {
    throw new Error(
      `${app} Machines did not converge on the exact deployed digest.`,
    );
  }
}

function assertWorkerChecksPass(app: string) {
  const checks = z
    .array(z.record(z.string(), z.unknown()))
    .parse(
      JSON.parse(capture("flyctl", ["checks", "list", "--app", app, "--json"])),
    );
  if (
    checks.length === 0 ||
    checks.some((check) => {
      const status = check.status ?? check.Status;
      return status !== "passing";
    })
  ) {
    throw new Error(`${app} private worker checks are not passing.`);
  }
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function run(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args[0] ?? ""} failed.`);
}

function capture(command: string, args: string[]) {
  return execFileSync(command, args, { encoding: "utf8" });
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function writeOutput(name: string, value: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `${name}=${value}\n`, "utf8");
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Production image deployment failed."}\n`,
  );
  process.exit(1);
});
