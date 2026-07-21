import assert from "node:assert/strict";

import {
  HOSTED_MCP_PROTOCOL_VERSION,
  parseHostedMcpContext,
  parseHostedMcpRuntimeConnection,
} from "../../src/mcp/hosted-contracts.js";
import { contractTest } from "../helpers/contract-test.js";


const VALID_CONTEXT = {
  gatewayUrl: "https://mcp.kestrel.example/v1",
  grantId: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
  protocolVersion: HOSTED_MCP_PROTOCOL_VERSION,
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
};

contractTest("runtime.hermetic", "hosted MCP context carries grant identity without upstream credentials", () => {
  const parsed = parseHostedMcpContext(VALID_CONTEXT);

  assert.deepEqual(parsed, VALID_CONTEXT);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "environmentId",
    "gatewayUrl",
    "grantId",
    "organizationId",
    "projectId",
    "protocolVersion",
    "threadId",
  ]);
  assert.equal("headers" in parsed, false);
  assert.equal("oauthToken" in parsed, false);
  assert.equal("secret" in parsed, false);
});

contractTest("runtime.hermetic", "hosted MCP context rejects a non-UUID grant", () => {
  assert.throws(
    () => parseHostedMcpContext({ ...VALID_CONTEXT, grantId: "grant-1" }),
    /grantId must be a UUID/u
  );
});

contractTest("runtime.hermetic", "hosted MCP context rejects non-HTTP transports", () => {
  assert.throws(
    () =>
      parseHostedMcpContext({
        ...VALID_CONTEXT,
        gatewayUrl: "file:///tmp/mcp.sock",
      }),
    /gatewayUrl must use http or https/u
  );
});

contractTest("runtime.hermetic", "hosted MCP context rejects credentials embedded in the gateway URL", () => {
  assert.throws(
    () =>
      parseHostedMcpContext({
        ...VALID_CONTEXT,
        gatewayUrl: "https://token@example.com/mcp",
      }),
    /gatewayUrl must not contain credentials/u
  );
});

contractTest("runtime.hermetic", "hosted MCP context rejects unsupported protocol versions", () => {
  assert.throws(
    () =>
      parseHostedMcpContext({
        ...VALID_CONTEXT,
        protocolVersion: "2025-03-26",
      }),
    /protocolVersion must be '2025-11-25'/u
  );
});

contractTest("runtime.hermetic", "hosted MCP runtime connection reads only the short-lived execution ticket", () => {
  const connection = parseHostedMcpRuntimeConnection({
    mcpContext: VALID_CONTEXT,
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  });

  assert.deepEqual(connection, {
    context: VALID_CONTEXT,
    executionTicket: "signed-run-ticket",
  });
  assert.equal("credentials" in connection, false);
});

contractTest("runtime.hermetic", "hosted MCP runtime connection requires an execution ticket", () => {
  assert.throws(
    () =>
      parseHostedMcpRuntimeConnection({
        mcpContext: VALID_CONTEXT,
        mcpAuthorization: {},
      }),
    /executionTicket must be a non-empty string/u
  );
});
