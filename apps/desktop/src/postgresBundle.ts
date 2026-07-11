import { existsSync } from "node:fs";
import path from "node:path";

export interface BundledPostgresInstallation {
  rootPath: string;
  binDir: string;
  libDir: string;
  shareDir: string;
  initdbPath: string;
  postgresPath: string;
  pgCtlPath: string;
  createdbPath: string;
}

export function resolveBundledPostgresInstallation(input: {
  bundleRootPath: string;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  fileExists?: ((targetPath: string) => boolean) | undefined;
}): BundledPostgresInstallation | undefined {
  const fileExists = input.fileExists ?? existsSync;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const candidates = [
    path.join(input.bundleRootPath, `${platform}-${arch}`),
    input.bundleRootPath,
  ];

  for (const rootPath of candidates) {
    const installation = buildInstallation(rootPath);
    if (
      fileExists(installation.initdbPath) &&
      fileExists(installation.postgresPath) &&
      fileExists(installation.pgCtlPath) &&
      fileExists(installation.createdbPath)
    ) {
      return installation;
    }
  }

  return undefined;
}

function buildInstallation(rootPath: string): BundledPostgresInstallation {
  return {
    rootPath,
    binDir: path.join(rootPath, "bin"),
    libDir: path.join(rootPath, "lib"),
    shareDir: path.join(rootPath, "share"),
    initdbPath: path.join(rootPath, "bin", "initdb"),
    postgresPath: path.join(rootPath, "bin", "postgres"),
    pgCtlPath: path.join(rootPath, "bin", "pg_ctl"),
    createdbPath: path.join(rootPath, "bin", "createdb"),
  };
}
