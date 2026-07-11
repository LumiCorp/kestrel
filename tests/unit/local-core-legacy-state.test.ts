import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectLocalCoreMigrationState } from "../../src/localCore/index.js";

test("Local Core migration readiness reports legacy Desktop and CLI state without moving it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-legacy-home-"));
  const coreHome = path.join(home, "Core");
  const desktopHome = path.join(home, "Library", "Application Support", "@kestrel", "desktop");
  const cliHome = path.join(home, ".kestrel");

  try {
    await mkdir(path.join(coreHome, "core"), { recursive: true });
    await writeFile(path.join(coreHome, "core", "manifest.json"), "{}\n", "utf8");
    await mkdir(path.join(desktopHome, "runtime-home"), { recursive: true });
    await writeFile(path.join(desktopHome, "desktop-settings.json"), "{}\n", "utf8");
    await mkdir(cliHome, { recursive: true });
    await writeFile(path.join(cliHome, "profiles.json"), "{}\n", "utf8");

    const report = detectLocalCoreMigrationState({
      env: { KESTREL_CORE_HOME: coreHome },
      platform: "darwin",
      homeDir: home,
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    assert.equal(report.coreHome, coreHome);
    assert.equal(report.coreHomeSource, "explicit_core_home");
    assert.equal(report.isolatedDevMode, false);
    assert.equal(report.entries.find((entry) => entry.name === "local_core")?.status, "present");
    assert.deepEqual(report.entries.find((entry) => entry.name === "desktop_legacy")?.evidence, [
      "desktop-settings.json",
      "runtime-home",
    ]);
    assert.deepEqual(report.entries.find((entry) => entry.name === "cli_legacy")?.evidence, ["profiles.json"]);
    assert.ok(report.messages.some((message) => message.includes("found old Desktop state")));
    assert.ok(report.messages.some((message) => message.includes("found old CLI state")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Local Core migration readiness labels KESTREL_HOME as isolated dev mode", () => {
  const report = detectLocalCoreMigrationState({
    env: { KESTREL_HOME: "~/kestrel-isolated" },
    platform: "darwin",
    homeDir: "/tmp/kestrel-empty-home",
    now: new Date("2026-06-17T12:00:00.000Z"),
  });

  assert.equal(report.coreHomeSource, "isolated_dev_home");
  assert.equal(report.isolatedDevMode, true);
  assert.ok(report.messages.some((message) => message.includes("isolated/dev mode active")));
});
