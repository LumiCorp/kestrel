import assert from "node:assert/strict";
import { KESTREL_APP_IDS } from "@kestrel-agents/protocol";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  getOfficialRemoteTokenApp,
  getOfficialRemoteOauthApp,
  listOfficialRemoteOauthApps,
  listOfficialRemoteTokenApps,
  resolveOfficialOauthCapabilitySelection,
} from "./official-remote-apps";
import { mcpAppRuntimeName } from "./mcp-app";

contractTest("web.hermetic", "official remote delivery keeps a stable App identity", () => {
  const linear = getOfficialRemoteTokenApp(KESTREL_APP_IDS.LINEAR);
  const atlassian = getOfficialRemoteTokenApp(KESTREL_APP_IDS.ATLASSIAN);
  assert.ok(linear);
  assert.ok(atlassian);
  assert.equal(linear.appKey, "linear");
  assert.equal(linear.remoteUrl, "https://mcp.linear.app/mcp");
  assert.equal(linear.authorizationHeader("lin_api_test"), "Bearer lin_api_test");
  assert.equal(atlassian.appKey, "atlassian");
  assert.equal(atlassian.remoteUrl, "https://mcp.atlassian.com/v1/mcp");
  assert.equal(
    atlassian.authorizationHeader("atlassian_service_key"),
    "Bearer atlassian_service_key",
  );
  assert.deepEqual(
    listOfficialRemoteTokenApps().map((app) => app.appKey),
    ["linear", "atlassian"],
  );
  assert.equal(
    mcpAppRuntimeName("linear", "tool:issue.create"),
    "mcp.app.linear.tool%3Aissue.create",
  );
});

contractTest("web.hermetic", "official OAuth delivery keeps Notion behind its App identity", () => {
  const notion = getOfficialRemoteOauthApp(KESTREL_APP_IDS.NOTION);
  assert.ok(notion);
  assert.equal(notion.appKey, "notion");
  assert.equal(notion.remoteUrl, "https://mcp.notion.com/mcp");
  assert.deepEqual(
    listOfficialRemoteOauthApps().map((app) => app.appKey),
    ["notion", "slack"],
  );
  assert.equal(
    mcpAppRuntimeName("notion", "tool:notion-search"),
    "mcp.app.notion.tool%3Anotion-search",
  );
});

contractTest("web.hermetic", "Slack App maps capability choices to its official granular scopes", () => {
  const slack = getOfficialRemoteOauthApp(KESTREL_APP_IDS.SLACK);
  assert.ok(slack);
  assert.equal(slack.remoteUrl, "https://mcp.slack.com/mcp");
  assert.equal(
    slack.oauthClient?.clientIdEnvironmentVariable,
    "SLACK_MCP_CLIENT_ID"
  );
  assert.deepEqual(slack.acceptedTokenTypes, ["bearer", "user"]);
  const messages = resolveOfficialOauthCapabilitySelection({
    app: slack,
    capabilityPacks: ["messages"],
  });
  assert.deepEqual(messages, {
    capabilityPacks: ["messages"],
    scopes: ["chat:write"],
  });
  assert.throws(
    () =>
      resolveOfficialOauthCapabilitySelection({
        app: slack,
        capabilityPacks: ["unknown"],
      }),
    /selection is invalid/u
  );
});
