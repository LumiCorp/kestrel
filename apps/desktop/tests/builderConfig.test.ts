import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  parseDesktopUpdateChannel,
  resolveDesktopBuilderConfiguration,
  resolveDesktopUpdateUrl,
} from "../src/builderConfig.js";

test("Desktop builder emits signed arm64 DMG and ZIP update targets", () => {
  const config = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.7.0",
    releaseBuild: true,
    signingIdentity: "Developer ID Application: Lumi",
  });
  assert.deepEqual(config.mac.target, [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] },
  ]);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.publish.url, resolveDesktopUpdateUrl("stable"));
  assert.match(config.afterSign ?? "", /notarize-desktop\.mjs$/u);
  assert.deepEqual(
    config.extraResources.find(({ to }) =>
      to.endsWith(path.join("kestrel-repo", "node_modules")),
    )?.filter,
    ["**/*"],
  );
});

test("development candidate builds receive candidate app-update metadata", () => {
  const config = resolveDesktopBuilderConfiguration({
    repoRoot: "/repo",
    version: "0.6.0",
    releaseBuild: false,
    updateChannel: "candidate",
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
        releaseBuild: true,
      }),
    /Developer ID Application/u,
  );
  assert.throws(
    () =>
      resolveDesktopBuilderConfiguration({
        repoRoot: "/repo",
        version: "0.7.0",
        releaseBuild: true,
        signingIdentity: "Developer ID Application: Lumi",
        updateChannel: "candidate",
      }),
    /stable update channel/u,
  );
});

test("Desktop update channel parsing is strict", () => {
  assert.equal(parseDesktopUpdateChannel(undefined), "stable");
  assert.equal(parseDesktopUpdateChannel(" candidate "), "candidate");
  assert.throws(() => parseDesktopUpdateChannel("preview"), /stable or candidate/u);
});
