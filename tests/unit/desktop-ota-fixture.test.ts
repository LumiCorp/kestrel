import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_OTA_FIXTURE_UPDATE_URL,
  DESKTOP_OTA_FIXTURE_VERSIONS,
} from "../../apps/desktop/src/builderConfig.js";
import {
  DESKTOP_OTA_FIXTURE_APPROVAL,
  DESKTOP_OTA_FIXTURE_OUTPUT,
  DESKTOP_OTA_FIXTURE_URL,
  DESKTOP_OTA_FIXTURE_VERSION,
  parseDesktopOtaFixturePackageOptions,
} from "../../scripts/desktop-ota-fixture.js";

test("fixture environment is absent from normal release packaging", () => {
  assert.equal(
    parseDesktopOtaFixturePackageOptions({
      env: {},
      repoRoot: "/repo",
    }),
    undefined,
  );
});

test("fixture environment resolves only the exact approved fixture", () => {
  const version = DESKTOP_OTA_FIXTURE_VERSIONS[1];
  const outputDirectory = path.join(
    "/repo",
    "apps",
    "desktop",
    "out",
    "ota-fixtures",
    version,
  );
  assert.deepEqual(
    parseDesktopOtaFixturePackageOptions({
      env: {
        [DESKTOP_OTA_FIXTURE_APPROVAL]: "1",
        [DESKTOP_OTA_FIXTURE_VERSION]: version,
        [DESKTOP_OTA_FIXTURE_URL]: DESKTOP_OTA_FIXTURE_UPDATE_URL,
        [DESKTOP_OTA_FIXTURE_OUTPUT]: outputDirectory,
      },
      repoRoot: "/repo",
    }),
    {
      version,
      builderInput: {
        approved: true,
        updateUrl: DESKTOP_OTA_FIXTURE_UPDATE_URL,
        outputDirectory,
      },
    },
  );
});

test("fixture environment rejects partial, unapproved, and escaped inputs", () => {
  const valid = {
    [DESKTOP_OTA_FIXTURE_APPROVAL]: "1",
    [DESKTOP_OTA_FIXTURE_VERSION]: DESKTOP_OTA_FIXTURE_VERSIONS[0],
    [DESKTOP_OTA_FIXTURE_URL]: DESKTOP_OTA_FIXTURE_UPDATE_URL,
    [DESKTOP_OTA_FIXTURE_OUTPUT]: path.join(
      "/repo",
      "apps",
      "desktop",
      "out",
      "ota-fixtures",
      DESKTOP_OTA_FIXTURE_VERSIONS[0],
    ),
  };
  const parse = (env: NodeJS.ProcessEnv) =>
    parseDesktopOtaFixturePackageOptions({ env, repoRoot: "/repo" });

  assert.throws(
    () => parse({ [DESKTOP_OTA_FIXTURE_VERSION]: "0.7.0-ota.1" }),
    /APPROVED=1/u,
  );
  assert.throws(
    () => parse({ ...valid, [DESKTOP_OTA_FIXTURE_VERSION]: "0.7.0-ota.4" }),
    /version must be one of/u,
  );
  assert.throws(
    () =>
      parse({
        ...valid,
        [DESKTOP_OTA_FIXTURE_URL]:
          "https://localhost:45173/desktop/candidate/arm64",
      }),
    /update URL must be/u,
  );
  assert.throws(
    () => parse({ ...valid, [DESKTOP_OTA_FIXTURE_OUTPUT]: "/tmp/escaped" }),
    /fixture output must be/u,
  );
});
