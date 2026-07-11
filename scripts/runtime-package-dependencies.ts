import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

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
