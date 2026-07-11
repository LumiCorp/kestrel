import test from "node:test";
import assert from "node:assert/strict";

import { renderLaunchAgentPlist, renderSystemdUserUnit } from "../../cli/kcron/service.js";

test("renderLaunchAgentPlist includes command and KESTREL_HOME", () => {
  const rendered = renderLaunchAgentPlist({
    command: "/usr/local/bin/kcron",
    homeDir: "/tmp/kestrel-home",
  });

  assert.match(rendered, /com\.kestrel\.kcron/u);
  assert.match(rendered, /\/usr\/local\/bin\/kcron/u);
  assert.match(rendered, /KESTREL_HOME/u);
  assert.match(rendered, /\/tmp\/kestrel-home/u);
});

test("renderLaunchAgentPlist includes KESTREL_CORE_HOME when provided", () => {
  const rendered = renderLaunchAgentPlist({
    command: "/usr/local/bin/kcron",
    homeDir: "/tmp/kestrel-core",
    coreHomeDir: "/tmp/kestrel-core",
  });

  assert.match(rendered, /KESTREL_CORE_HOME/u);
  assert.match(rendered, /\/tmp\/kestrel-core/u);
});

test("renderSystemdUserUnit includes command and environment", () => {
  const rendered = renderSystemdUserUnit({
    command: "/usr/local/bin/kcron",
    homeDir: "/tmp/kestrel-home",
  });

  assert.match(rendered, /ExecStart=\/usr\/local\/bin\/kcron start/u);
  assert.match(rendered, /Environment=KESTREL_HOME=\/tmp\/kestrel-home/u);
  assert.match(rendered, /WantedBy=default\.target/u);
});

test("renderSystemdUserUnit includes KESTREL_CORE_HOME when provided", () => {
  const rendered = renderSystemdUserUnit({
    command: "/usr/local/bin/kcron",
    homeDir: "/tmp/kestrel-core",
    coreHomeDir: "/tmp/kestrel-core",
  });

  assert.match(rendered, /Environment=KESTREL_CORE_HOME=\/tmp\/kestrel-core/u);
});
