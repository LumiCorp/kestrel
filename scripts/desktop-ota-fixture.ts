import { createServer } from "node:net";
import path from "node:path";

import {
  DESKTOP_OTA_FIXTURE_UPDATE_URL,
  DESKTOP_OTA_FIXTURE_VERSIONS,
  type DesktopOtaFixtureBuildInput,
} from "../apps/desktop/src/builderConfig.js";

export const DESKTOP_OTA_FIXTURE_APPROVAL =
  "KESTREL_DESKTOP_OTA_FIXTURE_BUILD_APPROVED";
export const DESKTOP_OTA_FIXTURE_VERSION =
  "KESTREL_DESKTOP_OTA_FIXTURE_VERSION";
export const DESKTOP_OTA_FIXTURE_URL =
  "KESTREL_DESKTOP_OTA_FIXTURE_UPDATE_URL";
export const DESKTOP_OTA_FIXTURE_OUTPUT =
  "KESTREL_DESKTOP_OTA_FIXTURE_OUTPUT_DIR";

export interface DesktopOtaFixturePackageOptions {
  version: (typeof DESKTOP_OTA_FIXTURE_VERSIONS)[number];
  builderInput: DesktopOtaFixtureBuildInput;
}

export function parseDesktopOtaFixturePackageOptions(input: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): DesktopOtaFixturePackageOptions | undefined {
  const values = {
    approval: input.env[DESKTOP_OTA_FIXTURE_APPROVAL]?.trim(),
    version: input.env[DESKTOP_OTA_FIXTURE_VERSION]?.trim(),
    updateUrl: input.env[DESKTOP_OTA_FIXTURE_URL]?.trim(),
    outputDirectory: input.env[DESKTOP_OTA_FIXTURE_OUTPUT]?.trim(),
  };
  if (Object.values(values).every((value) => value === undefined)) {
    return undefined;
  }
  if (values.approval !== "1") {
    throw new Error(
      `Desktop OTA fixture packaging requires ${DESKTOP_OTA_FIXTURE_APPROVAL}=1.`,
    );
  }
  if (
    values.version === undefined ||
    !DESKTOP_OTA_FIXTURE_VERSIONS.includes(
      values.version as (typeof DESKTOP_OTA_FIXTURE_VERSIONS)[number],
    )
  ) {
    throw new Error(
      `Desktop OTA fixture version must be one of ${DESKTOP_OTA_FIXTURE_VERSIONS.join(", ")}.`,
    );
  }
  if (values.updateUrl !== DESKTOP_OTA_FIXTURE_UPDATE_URL) {
    throw new Error(
      `Desktop OTA fixture update URL must be ${DESKTOP_OTA_FIXTURE_UPDATE_URL}.`,
    );
  }
  const expectedOutputDirectory = path.join(
    input.repoRoot,
    "apps",
    "desktop",
    "out",
    "ota-fixtures",
    values.version,
  );
  if (
    values.outputDirectory === undefined ||
    path.resolve(values.outputDirectory) !== path.resolve(expectedOutputDirectory)
  ) {
    throw new Error(
      `Desktop OTA fixture output must be ${expectedOutputDirectory}.`,
    );
  }
  return {
    version: values.version as DesktopOtaFixturePackageOptions["version"],
    builderInput: {
      approved: true,
      updateUrl: values.updateUrl,
      outputDirectory: expectedOutputDirectory,
    },
  };
}

export async function assertDesktopOtaFixturePortAvailable(): Promise<void> {
  const url = new URL(DESKTOP_OTA_FIXTURE_UPDATE_URL);
  const port = Number(url.port);
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      reject(
        new Error(
          `Desktop OTA fixture HTTPS port ${url.hostname}:${port} is unavailable.`,
          { cause: error },
        ),
      );
    });
    server.listen(port, url.hostname, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}
