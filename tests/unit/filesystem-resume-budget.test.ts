import assert from "node:assert/strict";

import {
  LEGACY_FILESYSTEM_RESUME_STOP_REASON,
  BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
  BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS_WITH_EXPLICIT_TARGET,
  BROAD_RESUME_MAX_INVENTORY_ACTIONS,
  buildFilesystemResumeReadBudgetDetail,
} from "../../src/runtime/filesystemResumeBudget.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "buildFilesystemResumeReadBudgetDetail reports configured limits and usage", () => {
  const detail = buildFilesystemResumeReadBudgetDetail({
    inventoryActions: 3,
    groundedReadActions: 7,
  });

  assert.deepEqual(detail.configuredLimits, {
    inventoryReadActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
    groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
    groundedReadActionsWithExplicitTarget:
      BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS_WITH_EXPLICIT_TARGET,
  });
  assert.deepEqual(detail.usage, {
    inventoryReadActions: 3,
    groundedReadActions: 7,
  });
  assert.deepEqual(detail.remaining, {
    inventoryReadActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS - 3,
    groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS - 7,
    groundedReadActionsWithExplicitTarget:
      BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS_WITH_EXPLICIT_TARGET - 7,
  });
  assert.equal(detail.exhausted, false);
  assert.equal(detail.stoppedByBudget, false);
});

contractTest("runtime.hermetic", "buildFilesystemResumeReadBudgetDetail marks an exhausted stopped run", () => {
  const detail = buildFilesystemResumeReadBudgetDetail({
    inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
    groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
    stoppedByBudget: true,
    stopReason: LEGACY_FILESYSTEM_RESUME_STOP_REASON,
  });

  assert.equal(detail.exhausted, true);
  assert.equal(detail.stoppedByBudget, true);
  assert.equal(detail.stopReason, LEGACY_FILESYSTEM_RESUME_STOP_REASON);
  assert.deepEqual(detail.remaining, {
    inventoryReadActions: 0,
    groundedReadActions: 0,
    groundedReadActionsWithExplicitTarget: 1,
  });
});

contractTest("runtime.hermetic", "buildFilesystemResumeReadBudgetDetail restores legacy stop reason when newer stop reason is absent", () => {
  const detail = buildFilesystemResumeReadBudgetDetail({
    inventoryActions: BROAD_RESUME_MAX_INVENTORY_ACTIONS,
    groundedReadActions: BROAD_RESUME_MAX_GROUNDED_READ_ACTIONS,
    stoppedByBudget: true,
  });

  assert.equal(detail.stoppedByBudget, true);
  assert.equal(detail.stopReason, LEGACY_FILESYSTEM_RESUME_STOP_REASON);
});
