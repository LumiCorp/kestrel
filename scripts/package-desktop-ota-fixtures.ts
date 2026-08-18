import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import {
  DESKTOP_OTA_FIXTURE_UPDATE_URL,
  DESKTOP_OTA_FIXTURE_VERSIONS,
} from "../apps/desktop/src/builderConfig.js";
import {
  assertDesktopOtaFixturePortAvailable,
  DESKTOP_OTA_FIXTURE_APPROVAL,
  DESKTOP_OTA_FIXTURE_OUTPUT,
  DESKTOP_OTA_FIXTURE_URL,
  DESKTOP_OTA_FIXTURE_VERSION,
} from "./desktop-ota-fixture.js";

const repoRoot = resolveRepoRoot(process.cwd());
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const fixturesRoot = path.join(desktopRoot, "out", "ota-fixtures");

if (process.env[DESKTOP_OTA_FIXTURE_APPROVAL]?.trim() !== "1") {
  throw new Error(
    `Desktop OTA fixture packaging requires ${DESKTOP_OTA_FIXTURE_APPROVAL}=1.`,
  );
}
await assertDesktopOtaFixturePortAvailable();

const fixtures: Array<{
  version: string;
  updateUrl: string;
  outputDirectory: string;
  artifacts: Array<{ name: string; size: number; sha256: string }>;
}> = [];

for (const version of DESKTOP_OTA_FIXTURE_VERSIONS) {
  const outputDirectory = path.join(fixturesRoot, version);
  rmSync(outputDirectory, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, "scripts", "package-desktop.ts")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        KESTREL_DESKTOP_PACKAGE_MODE: "release",
        [DESKTOP_OTA_FIXTURE_APPROVAL]: "1",
        [DESKTOP_OTA_FIXTURE_VERSION]: version,
        [DESKTOP_OTA_FIXTURE_URL]: DESKTOP_OTA_FIXTURE_UPDATE_URL,
        [DESKTOP_OTA_FIXTURE_OUTPUT]: outputDirectory,
      },
      stdio: "inherit",
    },
  );
  verifyFixtureOutput({ outputDirectory, version });
  fixtures.push({
    version,
    updateUrl: DESKTOP_OTA_FIXTURE_UPDATE_URL,
    outputDirectory: path.relative(repoRoot, outputDirectory),
    artifacts: readdirSync(outputDirectory)
      .filter((name) => {
        const artifactPath = path.join(outputDirectory, name);
        return statSync(artifactPath).isFile() && name !== "builder-debug.yml";
      })
      .sort()
      .map((name) => {
        const artifactPath = path.join(outputDirectory, name);
        const bytes = readFileSync(artifactPath);
        return {
          name,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
  });
}

writeFileSync(
  path.join(fixturesRoot, "fixture-manifest.json"),
  `${JSON.stringify(
    {
      schema: "desktop-ota-fixtures-v1",
      fixtures,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
process.stdout.write(
  `[desktop-ota-fixtures] packaged ${fixtures.length} signed fixtures under ${
    path.relative(repoRoot, fixturesRoot)
  }\n`,
);

function verifyFixtureOutput(input: {
  outputDirectory: string;
  version: string;
}): void {
  const appPath = path.join(
    input.outputDirectory,
    "mac-arm64",
    "Kestrel.app",
  );
  const updateConfigPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app-update.yml",
  );
  const metadataPath = path.join(input.outputDirectory, "latest-mac.yml");
  if (!existsSync(appPath) || !existsSync(updateConfigPath)) {
    throw new Error(`Desktop OTA fixture ${input.version} app is incomplete.`);
  }
  if (!existsSync(metadataPath)) {
    throw new Error(
      `Desktop OTA fixture ${input.version} is missing latest-mac.yml.`,
    );
  }
  const updateConfig = parse(readFileSync(updateConfigPath, "utf8")) as {
    url?: unknown;
  };
  if (updateConfig.url !== DESKTOP_OTA_FIXTURE_UPDATE_URL) {
    throw new Error(
      `Desktop OTA fixture ${input.version} embedded the wrong update URL.`,
    );
  }
  const packagedVersion = execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(appPath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  if (packagedVersion !== input.version) {
    throw new Error(
      `Desktop OTA fixture ${input.version} packaged version ${packagedVersion}.`,
    );
  }
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}
