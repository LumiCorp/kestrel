import assert from "node:assert/strict";
import test from "node:test";
import { environmentOperationTypeSchema } from "./contracts";
import {
  isProvisionerOperationType,
  PROVISIONER_OPERATION_TYPES,
} from "./operation-routing";

test("provisioner recovery owns only lifecycle operations", () => {
  const owned = environmentOperationTypeSchema.options.filter(
    isProvisionerOperationType
  );

  assert.deepEqual(owned, [...PROVISIONER_OPERATION_TYPES]);
  assert.equal(isProvisionerOperationType("workspace.backup"), false);
  assert.equal(isProvisionerOperationType("workspace.restore"), false);
  assert.equal(isProvisionerOperationType("workspace.reconcile"), false);
});
