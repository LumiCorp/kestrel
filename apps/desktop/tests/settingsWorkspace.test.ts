import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopCapability } from "../../../src/desktopShell/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import {
  createToolServicesNavigationRequest,
  getDesktopCapabilityAttentionQueue,
} from "../renderer/src/SettingsWorkspace.js";

const rendererDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src",
);

function capability(id: DesktopCapability["id"], readiness: DesktopCapability["readiness"]): DesktopCapability {
  return {
    id,
    category: "local_capabilities",
    name: id,
    description: "Test capability.",
    toolNames: [],
    enabled: readiness !== "disabled",
    readiness,
    detail: "Test detail.",
    requirements: [],
    settings: [],
    verificationStrategy: "Test verification.",
    runtimeApplication: "Test application.",
    settingsSection: "settings/test",
  };
}

contractTest("desktop.hermetic", "Settings surfaces only explicit readiness blockers in source order", () => {
  const queue = getDesktopCapabilityAttentionQueue([
    capability("local.filesystem", "ready"),
    capability("local.developer_shell", "unavailable"),
    capability("local.sandbox_code", "setup_required"),
    capability("data.database", "verification_failed"),
    capability("permission.microphone", "optional"),
  ]);

  assert.deepEqual(queue.map((entry) => entry.id), [
    "local.developer_shell",
    "local.sandbox_code",
    "data.database",
  ]);
});

contractTest("desktop.hermetic", "Settings does not let an older readiness probe overwrite a later apply result", async () => {
  const source = await readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8");

  assert.match(source, /const refreshVersionRef = useRef\(0\)/u);
  assert.match(source, /if \(refreshVersion !== refreshVersionRef\.current\) return;/u);
  assert.match(source, /function commitCapabilityView[\s\S]*refreshVersionRef\.current \+= 1;/u);
});

contractTest("desktop.hermetic", "repeated tool-service recovery requests carry a fresh navigation signal", () => {
  const initial = createToolServicesNavigationRequest("tools.internet.tavily");
  const repeated = createToolServicesNavigationRequest("tools.internet.tavily", initial);

  assert.deepEqual(initial, { capabilityId: "tools.internet.tavily", requestId: 1 });
  assert.deepEqual(repeated, { capabilityId: "tools.internet.tavily", requestId: 2 });
});
