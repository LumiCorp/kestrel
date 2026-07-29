import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_OTA_FIXTURE_UPDATE_URL,
  parseDesktopUpdateChannel,
  resolveDesktopBuilderConfiguration,
  resolveDesktopUpdateUrl,
} from "../src/builderConfig.js";

test("Desktop builder emits signed arm64 DMG and ZIP update targets", () => {
  const config = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.7.0",
    electronVersion: "37.2.6",
    releaseBuild: true,
    signingIdentity: "Developer ID Application: Lumi",
    packageMode: "release",
  });
  assert.deepEqual(config.mac.target, [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] },
  ]);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.identity, "Lumi");
  assert.equal(config.publish.url, resolveDesktopUpdateUrl("stable"));
  assert.match(config.afterSign ?? "", /notarize-desktop\.mjs$/u);
  assert.deepEqual(
    config.extraResources.find(({ to }) =>
      to === path.join("kestrel-runtime", "node_modules")
    )?.filter,
    ["**/*"],
  );
});

test("development candidate builds receive candidate app-update metadata", () => {
  const config = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.6.0",
    electronVersion: "37.2.6",
    releaseBuild: false,
    updateChannel: "candidate",
    packageMode: "dir",
  });
  assert.equal(config.mac.identity, null);
  assert.equal(config.publish.url, resolveDesktopUpdateUrl("candidate"));
});

test("final artifacts reject missing signing and non-stable channels", () => {
  assert.throws(
    () =>
      resolveDesktopBuilderConfiguration({
        repoRoot: "/repo",
        version: "0.7.0",
        electronVersion: "37.2.6",
        releaseBuild: true,
        packageMode: "release",
      }),
    /Developer ID Application/u,
  );
  assert.throws(
    () =>
      resolveDesktopBuilderConfiguration({
        repoRoot: "/repo",
        version: "0.7.0",
        electronVersion: "37.2.6",
        releaseBuild: true,
        signingIdentity: "GREGORY MICHAEL ASHER (RD7P29T2BJ)",
        packageMode: "release",
      }),
    /full Developer ID Application authority/u,
  );
  assert.throws(
    () =>
      resolveDesktopBuilderConfiguration({
        repoRoot: "/repo",
        version: "0.7.0",
        electronVersion: "37.2.6",
        releaseBuild: true,
        signingIdentity: "Developer ID Application: Lumi",
        updateChannel: "candidate",
        packageMode: "release",
      }),
    /stable update channel/u,
  );
});

test("unsigned local proof emits only an unpacked arm64 app", () => {
  const config = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.7.0",
    electronVersion: "37.2.6",
    releaseBuild: false,
    packageMode: "dir",
  });
  assert.deepEqual(config.mac.target, [
    { target: "dir", arch: ["arm64"] },
  ]);
  assert.equal(config.mac.identity, null);
  assert.equal(config.afterSign, undefined);
});

test("Desktop update channel parsing is strict", () => {
  assert.equal(parseDesktopUpdateChannel(undefined), "stable");
  assert.equal(parseDesktopUpdateChannel(" candidate "), "candidate");
  assert.throws(() => parseDesktopUpdateChannel("preview"), /stable or candidate/u);
});

test("signed OTA fixtures are isolated from the final production feed", () => {
  const outputDirectory = path.join(
    "/repo",
    "apps",
    "desktop",
    "out",
    "ota-fixtures",
    "0.7.0-ota.1",
  );
  const fixture = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.7.0-ota.1",
    electronVersion: "37.2.6",
    releaseBuild: true,
    signingIdentity: "Developer ID Application: Lumi",
    packageMode: "release",
    otaFixture: {
      approved: true,
      updateUrl: DESKTOP_OTA_FIXTURE_UPDATE_URL,
      outputDirectory,
    },
  });
  assert.equal(fixture.publish.url, DESKTOP_OTA_FIXTURE_UPDATE_URL);
  assert.equal(fixture.directories.output, outputDirectory);

  const finalRelease = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.7.0",
    electronVersion: "37.2.6",
    releaseBuild: true,
    signingIdentity: "Developer ID Application: Lumi",
    packageMode: "release",
  });
  assert.equal(finalRelease.publish.url, resolveDesktopUpdateUrl("stable"));
  assert.equal(finalRelease.directories.output, path.join("/repo", "apps", "desktop", "out"));
});

test("OTA fixture packaging rejects unapproved or widened inputs", () => {
  const validFixture = {
    approved: true,
    updateUrl: DESKTOP_OTA_FIXTURE_UPDATE_URL,
    outputDirectory: path.join(
      "/repo",
      "apps",
      "desktop",
      "out",
      "ota-fixtures",
      "0.7.0-ota.1",
    ),
  };
  const build = (overrides: Partial<typeof validFixture> = {}, version = "0.7.0-ota.1") =>
    resolveDesktopBuilderConfiguration({
      repoRoot: "/repo",
      version,
      electronVersion: "37.2.6",
      releaseBuild: true,
      signingIdentity: "Developer ID Application: Lumi",
      packageMode: "release",
      otaFixture: { ...validFixture, ...overrides },
    });

  assert.throws(() => build({ approved: false }), /APPROVED=1/u);
  assert.throws(
    () => build({ updateUrl: "https://example.com/desktop/stable/arm64" }),
    /must use https:\/\/localhost:45173/u,
  );
  assert.throws(
    () => build({ outputDirectory: "/tmp/ota-fixture" }),
    /fixture output must be/u,
  );
  assert.throws(() => build({}, "0.7.0"), /fixture version must be one of/u);
});
