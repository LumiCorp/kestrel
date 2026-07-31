import test from "node:test";
import assert from "node:assert/strict";
import { readPreviewEdgeConfig } from "../src/config.js";

const validEnvironment = {
  KESTREL_CONTROL_PLANE_URL: "https://kestrelagents.dev",
  KESTREL_PREVIEW_EDGE_SERVICE_TOKEN: "edge-service-token",
  KESTREL_PREVIEW_HOST_SUFFIX: "preview.kestrelagents.dev",
};

test(
  "Preview Edge requires canonical production routing configuration",
  () => {
    assert.deepEqual(readPreviewEdgeConfig(validEnvironment), {
      port: 8080,
      healthPort: 8081,
      controlPlaneUrl: "https://kestrelagents.dev",
      serviceToken: "edge-service-token",
      hostSuffix: "preview.kestrelagents.dev",
    });
    for (const [name, value] of [
      ["KESTREL_CONTROL_PLANE_URL", "http://kestrelagents.dev"],
      ["KESTREL_CONTROL_PLANE_URL", "https://kestrelagents.dev/path"],
      ["KESTREL_PREVIEW_HOST_SUFFIX", "Preview.kestrelagents.dev"],
      ["KESTREL_PREVIEW_HOST_SUFFIX", "*.preview.kestrelagents.dev"],
      ["KESTREL_PREVIEW_HOST_SUFFIX", "preview.kestrelagents.dev."],
    ] as const) {
      assert.throws(() =>
        readPreviewEdgeConfig({ ...validEnvironment, [name]: value })
      );
    }
  }
);
