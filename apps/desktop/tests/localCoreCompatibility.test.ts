import assert from "node:assert/strict";

import {
  LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_CAPABILITY,
} from "../../../src/localCore/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import {
  DESKTOP_LOCAL_CORE_EXECUTION_PROFILE_INCOMPATIBLE,
  assertDesktopLocalCoreExecutionProfileCompatibility,
} from "../src/localCoreCompatibility.js";

contractTest(
  "desktop.hermetic",
  "Desktop blocks startup when a live Local Core does not advertise execution-profile resolution",
  () => {
    assert.throws(
      () => assertDesktopLocalCoreExecutionProfileCompatibility({
        manifest: { capabilities: ["local-core.contract.v2"] },
      }),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === DESKTOP_LOCAL_CORE_EXECUTION_PROFILE_INCOMPATIBLE,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "Desktop accepts a Local Core that explicitly supports execution-profile resolution",
  () => {
    assert.doesNotThrow(() =>
      assertDesktopLocalCoreExecutionProfileCompatibility({
        manifest: {
          capabilities: [
            "local-core.contract.v2",
            LOCAL_CORE_EXECUTION_PROFILE_RESOLUTION_CAPABILITY,
          ],
        },
      }),
    );
  },
);
