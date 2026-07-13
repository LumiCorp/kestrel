import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PUBLIC_PROTOCOL_PACKAGE_NAME = "@kestrel-agents/protocol";

export function resolveRuntimePackageDependencies(input: {
  repoRoot: string;
  runtimeVersion: string;
  dependencies?: Record<string, string> | undefined;
  tsxVersion?: string | undefined;
}): Record<string, string> {
  if (input.dependencies?.[PUBLIC_PROTOCOL_PACKAGE_NAME] === undefined) {
    throw new Error(`Runtime manifest must declare ${PUBLIC_PROTOCOL_PACKAGE_NAME}.`);
  }

  const protocolManifestPath = path.join(input.repoRoot, "packages", "protocol", "package.json");
  const protocolManifest = JSON.parse(readFileSync(protocolManifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (protocolManifest.name !== PUBLIC_PROTOCOL_PACKAGE_NAME) {
    throw new Error(`Protocol manifest at '${protocolManifestPath}' must be named ${PUBLIC_PROTOCOL_PACKAGE_NAME}.`);
  }
  if (typeof protocolManifest.version !== "string" || protocolManifest.version.trim().length === 0) {
    throw new Error(`Protocol manifest at '${protocolManifestPath}' must declare a version.`);
  }
  const protocolVersion = protocolManifest.version.trim();
  if (protocolVersion !== input.runtimeVersion) {
    throw new Error(
      `Runtime version ${input.runtimeVersion} must match ${PUBLIC_PROTOCOL_PACKAGE_NAME} ${protocolVersion}.`,
    );
  }

  return {
    ...input.dependencies,
    ...(input.tsxVersion !== undefined ? { tsx: input.tsxVersion } : {}),
    [PUBLIC_PROTOCOL_PACKAGE_NAME]: protocolVersion,
  };
}

export function packPublicProtocolPackage(input: {
  repoRoot: string;
  packDir: string;
}): string {
  const protocolDir = path.join(input.repoRoot, "packages", "protocol");
  const before = new Set(readdirSync(input.packDir));
  execFileSync(resolvePnpmCommand(), ["run", "build"], {
    cwd: protocolDir,
    stdio: "inherit",
  });
  execFileSync(resolvePnpmCommand(), ["pack", "--pack-destination", input.packDir], {
    cwd: protocolDir,
    stdio: "inherit",
  });
  const tarballs = readdirSync(input.packDir).filter(
    (entry) =>
      before.has(entry) === false &&
      entry.startsWith("kestrel-agents-protocol-") &&
      entry.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(`Expected one packed protocol artifact; found ${tarballs.length}.`);
  }
  return path.join(input.packDir, tarballs[0]!);
}

export function resolveRuntimeDependencyInstallArgs(localPackages: readonly string[] = []): string[] {
  return [
    "install",
    "--omit=dev",
    ...(localPackages.length > 0 ? ["--no-save", ...localPackages] : []),
  ];
}

function resolvePnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
