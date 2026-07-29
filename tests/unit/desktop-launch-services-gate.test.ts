import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunchServicesOpenArguments,
  listExecutableProcessIds,
  parseCodeSignatureDetails,
  resolveLaunchServicesInstalledAppPath,
  runLaunchServicesCleanupActions,
} from "../../scripts/desktop-launch-services-gate.js";

test("LaunchServices gate installs under a unique Applications path", () => {
  assert.equal(
    resolveLaunchServicesInstalledAppPath({
      version: "0.7.0",
      runId: "12345",
    }),
    "/Applications/Kestrel LaunchServices Gate 0.7.0 12345.app",
  );
  assert.throws(
    () =>
      resolveLaunchServicesInstalledAppPath({
        version: "../0.7.0",
        runId: "12345",
      }),
    /Invalid Desktop version/u,
  );
  assert.throws(
    () =>
      resolveLaunchServicesInstalledAppPath({
        version: "0.7.0",
        runId: "../escape",
      }),
    /Invalid LaunchServices gate run ID/u,
  );
});

test("LaunchServices launch uses open with isolated state and explicit environment", () => {
  assert.deepEqual(
    buildLaunchServicesOpenArguments({
      appPath: "/Applications/Kestrel Gate.app",
      userDataPath: "/tmp/kestrel-gate/user-data",
      debugPort: 31_181,
      environment: {
        KESTREL_HOME: "/tmp/kestrel-gate/core-home",
        ELECTRON_ENABLE_LOGGING: "1",
      },
    }),
    [
      "-n",
      "-W",
      "--fresh",
      "--env",
      "ELECTRON_ENABLE_LOGGING=1",
      "--env",
      "KESTREL_HOME=/tmp/kestrel-gate/core-home",
      "-a",
      "/Applications/Kestrel Gate.app",
      "--args",
      "--user-data-dir=/tmp/kestrel-gate/user-data",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=31181",
    ],
  );
  const withCertificatePin = buildLaunchServicesOpenArguments({
    appPath: "/Applications/Kestrel Gate.app",
    userDataPath: "/tmp/kestrel-gate/user-data",
    debugPort: 31_181,
    environment: {},
    applicationArguments: [
      "--ignore-certificate-errors-spki-list=fixture-pin",
    ],
  });
  assert.equal(
    withCertificatePin.at(-1),
    "--ignore-certificate-errors-spki-list=fixture-pin",
  );
  assert.throws(
    () =>
      buildLaunchServicesOpenArguments({
        appPath: "/Applications/Kestrel Gate.app",
        userDataPath: "/tmp/kestrel-gate/user-data",
        debugPort: 31_181,
        environment: {},
        applicationArguments: ["fixture-pin"],
      }),
    /Invalid LaunchServices application argument/u,
  );
});

test("LaunchServices process ownership matches only the installed executable", () => {
  assert.deepEqual(
    listExecutableProcessIds(
      [
        "  101 /Applications/Kestrel.app/Contents/MacOS/Kestrel",
        "  202 /Applications/Kestrel Gate.app/Contents/MacOS/Kestrel --flag",
        "  303 /Applications/Kestrel Gate.app/Contents/MacOS/Kestrel --type=renderer",
      ].join("\n"),
      "/Applications/Kestrel Gate.app/Contents/MacOS/Kestrel",
    ),
    [202, 303],
  );
});

test("LaunchServices gate requires Developer ID and hardened runtime", () => {
  assert.deepEqual(
    parseCodeSignatureDetails(
      [
        "Authority=Developer ID Application: Lumi (TEAM123)",
        "TeamIdentifier=TEAM123",
        "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+2",
      ].join("\n"),
    ),
    {
      authority: "Developer ID Application: Lumi (TEAM123)",
      teamIdentifier: "TEAM123",
      hardenedRuntime: true,
    },
  );
  assert.throws(
    () =>
      parseCodeSignatureDetails(
        "Authority=Apple Development: Lumi\nTeamIdentifier=TEAM123\nflags=0x10000(runtime)",
      ),
    /Developer ID Application/u,
  );
  assert.throws(
    () =>
      parseCodeSignatureDetails(
        "Authority=Developer ID Application: Lumi\nTeamIdentifier=TEAM123\nflags=0x0(none)",
      ),
    /hardened runtime/u,
  );
});

test("LaunchServices cleanup attempts every action and aggregates failures", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    runLaunchServicesCleanupActions([
      () => {
        attempted.push("first");
        throw new Error("first cleanup failed");
      },
      async () => {
        attempted.push("second");
        throw new Error("second cleanup failed");
      },
      () => {
        attempted.push("third");
      },
    ]),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(
        (error as AggregateError).errors.map((entry) => entry.message),
        ["first cleanup failed", "second cleanup failed"],
      );
      return true;
    },
  );
  assert.deepEqual(attempted, ["first", "second", "third"]);
});
