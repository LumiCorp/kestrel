import assert from "node:assert/strict";

import { parseDesktopMcpServerMutationInput } from "../../../src/desktopShell/contracts.js";
import {
  completeDesktopMcpVerification,
  prepareDesktopMcpVerification,
} from "../src/mcpVerification.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

contractTest(
  "desktop.hermetic",
  "MCP mutation parser rejects unknown fields and malformed endpoints",
  () => {
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          id: "example",
          name: "Example",
          transport: "http",
          url: "file:///tmp/server",
          enabled: true,
        }),
      /HTTP or HTTPS/u,
    );
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          id: "example",
          name: "Example",
          transport: "stdio",
          command: "server",
          enabled: true,
          env: { SECRET: "value" },
        }),
      /unsupported field 'env'/u,
    );
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          id: "example",
          appId: "unknown",
          name: "Example",
          transport: "http",
          url: "https://mcp.example.test",
          enabled: true,
        }),
      /not a published standard App/u,
    );
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          id: "example",
          appId: "linear",
          name: "Linear",
          transport: "http",
          url: "https://lookalike.example.test/mcp",
          credentials: [{ kind: "bearer", secret: "token" }],
          enabled: true,
        }),
      /does not match its published contract/u,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "MCP verification preparation carries only credential references into the live request",
  () => {
    const input = parseDesktopMcpServerMutationInput({
      id: "example",
      appId: "linear",
      name: "Example",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      credentials: [{ kind: "bearer", secret: "candidate-token" }],
      enabled: true,
    });
    const prepared = prepareDesktopMcpVerification(input);
    assert.equal(prepared.request.credentials.length, 1);
    assert.equal(prepared.request.credentials[0]?.secret, "candidate-token");
    assert.equal(
      JSON.stringify(prepared.bindings).includes("candidate-token"),
      false,
    );

    const server = completeDesktopMcpVerification(input, prepared.bindings, {
      serverId: "example",
      verifiedAt: "2026-07-20T12:00:00.000Z",
      credentials: prepared.bindings.map((binding) => ({
        credentialId: binding.credentialId,
        configured: true,
      })),
      tools: [{ name: "lookup", description: "Look up a record." }],
    });
    assert.equal(server.sourceKind, "desktop-managed");
    assert.equal(server.appId, "linear");
    assert.deepEqual(server.tools, [
      {
        name: "lookup",
        description: "Look up a record.",
        approvalMode: "ask",
        allowedInteractionModes: ["build"],
      },
    ]);
  },
);

contractTest(
  "desktop.hermetic",
  "GitHub uses its canonical App identity and official remote endpoint",
  () => {
    const input = parseDesktopMcpServerMutationInput({
      id: "standard.github",
      appId: "github",
      name: "GitHub",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      credentials: [{ kind: "bearer", secret: "github_pat_example" }],
      enabled: true,
    });

    assert.equal(input.appId, "github");
    assert.equal(input.url, "https://api.githubcopilot.com/mcp/");
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          ...input,
          url: "https://github-mcp-lookalike.example/mcp/",
        }),
      /does not match its published contract/u,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "Notion uses its canonical App identity without exposing authorization secrets",
  () => {
    const input = parseDesktopMcpServerMutationInput({
      id: "standard.notion",
      appId: "notion",
      name: "Notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      oauthCredentialPrefix: "mcp.standard.notion",
      enabled: true,
    });
    const prepared = prepareDesktopMcpVerification(input);

    assert.equal(prepared.request.credentials.length, 0);
    assert.equal(
      prepared.request.server.oauthCredentialPrefix,
      "mcp.standard.notion",
    );
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          ...input,
          oauthCredentialPrefix: "mcp.standard.lookalike",
        }),
      /does not match its published contract/u,
    );
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          ...input,
          credentials: [{ kind: "bearer", secret: "mixed-secret" }],
        }),
      /does not match its published contract/u,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "Slack uses its canonical public-client App connection",
  () => {
    const input = parseDesktopMcpServerMutationInput({
      id: "standard.slack",
      appId: "slack",
      name: "Slack",
      transport: "http",
      url: "https://mcp.slack.com/mcp",
      oauthCredentialPrefix: "mcp.standard.slack",
      capabilityPacks: ["search"],
      enabled: true,
    });
    const prepared = prepareDesktopMcpVerification(input);

    assert.equal(prepared.request.credentials.length, 0);
    assert.equal(prepared.request.server.url, "https://mcp.slack.com/mcp");
    assert.equal(
      prepared.request.server.oauthCredentialPrefix,
      "mcp.standard.slack",
    );
    assert.equal(JSON.stringify(prepared).includes("client_secret"), false);
    assert.deepEqual(input.capabilityPacks, ["search"]);
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          ...input,
          capabilityPacks: [],
        }),
      /does not match its published contract/u,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "Vercel exposes only tools from the selected App capability packs",
  () => {
    const input = parseDesktopMcpServerMutationInput({
      id: "standard.vercel",
      appId: "vercel",
      name: "Vercel",
      transport: "http",
      url: "https://mcp.vercel.com",
      oauthCredentialPrefix: "mcp.standard.vercel",
      capabilityPacks: ["projects"],
      enabled: true,
    });
    const server = completeDesktopMcpVerification(input, [], {
      serverId: "standard.vercel",
      verifiedAt: "2026-07-22T00:00:00.000Z",
      credentials: [],
      tools: [
        { name: "list_projects" },
        { name: "get_project" },
        { name: "get_runtime_logs" },
        { name: "new_unreviewed_tool" },
      ],
    });

    assert.deepEqual(server.capabilityPacks, ["projects"]);
    assert.deepEqual(server.tools?.map((tool) => tool.name), [
      "list_projects",
      "get_project",
    ]);
    assert.equal(server.toolCount, 2);
    assert.throws(
      () =>
        completeDesktopMcpVerification(input, [], {
          serverId: "standard.vercel",
          verifiedAt: "2026-07-22T00:00:00.000Z",
          credentials: [],
          tools: [{ name: "search_documentation" }],
        }),
      /did not expose the capabilities selected/u,
    );
    assert.throws(
      () =>
        parseDesktopMcpServerMutationInput({
          ...input,
          capabilityPacks: ["unknown"],
        }),
      /does not match its published contract/u,
    );
  },
);
