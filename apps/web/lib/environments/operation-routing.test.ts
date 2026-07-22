import assert from "node:assert/strict";
import { environmentOperationTypeSchema } from "./contracts";
import {
  isProvisionerOperationType,
  PROVISIONER_OPERATION_TYPES,
  RESOURCE_MUTATING_OPERATION_TYPES,
} from "./operation-routing";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "provisioner recovery owns only lifecycle operations", () => {
  const owned = environmentOperationTypeSchema.options.filter(
    isProvisionerOperationType
  );

  assert.deepEqual(owned, [...PROVISIONER_OPERATION_TYPES]);
  assert.equal(isProvisionerOperationType("workspace.backup"), false);
  assert.equal(isProvisionerOperationType("workspace.restore"), false);
  assert.equal(isProvisionerOperationType("workspace.reconcile"), false);
});

contractTest("web.hermetic", "backup work cannot suppress orphan resource cleanup", () => {
  assert.equal(RESOURCE_MUTATING_OPERATION_TYPES.includes("workspace.backup" as never), false);
  assert.equal(RESOURCE_MUTATING_OPERATION_TYPES.includes("workspace.restore"), true);
  assert.equal(RESOURCE_MUTATING_OPERATION_TYPES.includes("workspace.provision"), true);
});
