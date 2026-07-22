import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "gateway model mutations remain scoped to the gateway in the route", async () => {
  const source = await readFile(
    new URL(
      "../../app/api/organization/ai/gateways/[id]/models/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    source,
    /saveGatewayModel\(\{[\s\S]*gatewayId: params\.id,[\s\S]*\}\)/u
  );
  assert.match(
    source,
    /deleteGatewayModel\(\s*organizationId,\s*params\.id,\s*query\.modelId\s*\)/u
  );
});

contractTest("web.hermetic", "gateway model update and delete require matching gateway ownership", async () => {
  const source = await readFile(new URL("./gateways.ts", import.meta.url), "utf8");
  const updateStart = source.indexOf("if (input.id) {");
  const updateEnd = source.indexOf("const [created]", updateStart);
  const deleteStart = source.indexOf("export async function deleteGatewayModel");
  const deleteEnd = source.indexOf(
    "export async function hasApprovedModelsForModalities",
    deleteStart
  );

  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);

  const updateSource = source.slice(updateStart, updateEnd);
  assert.match(updateSource, /eq\(schema\.aiGatewayModels\.id, input\.id\)/u);
  assert.match(
    updateSource,
    /eq\(schema\.aiGatewayModels\.gatewayId, input\.gatewayId\)/u
  );

  const deleteSource = source.slice(deleteStart, deleteEnd);
  assert.match(deleteSource, /eq\(schema\.aiGatewayModels\.id, modelId\)/u);
  assert.match(
    deleteSource,
    /eq\(schema\.aiGatewayModels\.gatewayId, gatewayId\)/u
  );
});
