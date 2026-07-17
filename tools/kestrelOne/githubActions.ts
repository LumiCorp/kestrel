import { RuntimeFailure, createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type {
  SharedToolContext,
  SharedToolDefinition,
  SharedToolModule,
} from "../contracts.js";
import { parseObjectInput } from "../helpers.js";

type GitHubActionToolOptions = {
  name: string;
  displayName: string;
  description: string;
  operation:
    | "repository.read_file"
    | "issue.create"
    | "pull_request.create"
    | "pull_request.merge"
    | "release.create"
    | "workflow.dispatch";
  inputSchema: Record<string, unknown>;
  readOnly?: boolean | undefined;
  requiresApproval?: boolean | undefined;
};

function createGitHubActionTool(options: GitHubActionToolOptions): SharedToolModule {
  const definition: SharedToolDefinition = {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "free",
      executionClass: options.readOnly ? "read_only" : "external_side_effect",
      ...(options.readOnly
        ? {} : { allowedInteractionModes: ["chat", "build"] as Array<"chat" | "build"> }),
      capabilityClasses: ["github.organization", "network.call"],
      approvalCapabilities: [
        "network.call",
        ...(options.requiresApproval ? (["external.confirm"] as const) : []),
      ],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: false,
        typicalFailureModes: [
          "repository_not_granted",
          "approval_required",
          "github_unavailable",
        ],
      },
    },
    presentation: {
      displayName: options.displayName,
      aliases: [options.displayName.toLowerCase()],
      keywords: ["github", "organization", options.operation],
      provider: "kestrel-one",
      toolFamily: "github",
    },
  };
  return {
    definition,
    createHandler(context) {
      return async (input: unknown) => {
        const parsed = parseObjectInput(options.name, input);
        return invokeGitHubAction(context, {
          operation: options.operation,
          input: parsed,
          requiresApproval: options.requiresApproval === true,
          toolName: options.name,
        });
      };
    },
  };
}

const repositoryProperty = {
  type: "string",
  pattern: "^[^/\\s]+/[^/\\s]+$",
} as const;

export const kestrelOneGitHubRepositoryReadTool = createGitHubActionTool({
  name: "kestrel_one.github_repository_read",
  displayName: "GitHub Repository Read",
  description:
    "Read a file or directory from a GitHub repository explicitly granted to this Environment.",
  operation: "repository.read_file",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      repository: repositoryProperty,
      path: { type: "string", minLength: 1, maxLength: 4096 },
      ref: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["repository", "path"],
    additionalProperties: false,
  },
});

export const kestrelOneGitHubIssueCreateTool = createGitHubActionTool({
  name: "kestrel_one.github_issue_create",
  displayName: "GitHub Issue Create",
  description:
    "Create a GitHub issue after explicit user approval in a repository granted to this Environment.",
  operation: "issue.create",
  requiresApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      repository: repositoryProperty,
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: 65_536 },
    },
    required: ["repository", "title"],
    additionalProperties: false,
  },
});

export const kestrelOneGitHubPullRequestCreateTool = createGitHubActionTool({
  name: "kestrel_one.github_pull_request_create",
  displayName: "GitHub Pull Request Create",
  description:
    "Create a GitHub pull request after explicit user approval in a repository granted to this Environment.",
  operation: "pull_request.create",
  requiresApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      repository: repositoryProperty,
      title: { type: "string", minLength: 1, maxLength: 256 },
      head: { type: "string", minLength: 1, maxLength: 255 },
      base: { type: "string", minLength: 1, maxLength: 255 },
      body: { type: "string", maxLength: 65_536 },
    },
    required: ["repository", "title", "head", "base"],
    additionalProperties: false,
  },
});

export const kestrelOneGitHubPullRequestMergeTool = createGitHubActionTool({
  name: "kestrel_one.github_pull_request_merge",
  displayName: "GitHub Pull Request Merge",
  description:
    "Merge a GitHub pull request after explicit user approval in a repository granted to this Environment.",
  operation: "pull_request.merge",
  requiresApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      repository: repositoryProperty,
      pullNumber: { type: "integer", minimum: 1 },
      method: { type: "string", enum: ["merge", "squash", "rebase"] },
    },
    required: ["repository", "pullNumber"],
    additionalProperties: false,
  },
});

export const kestrelOneGitHubReleaseCreateTool = createGitHubActionTool({
  name: "kestrel_one.github_release_create",
  displayName: "GitHub Release Create",
  description:
    "Create a GitHub release after explicit user approval in a repository granted to this Environment.",
  operation: "release.create",
  requiresApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      repository: repositoryProperty,
      tagName: { type: "string", minLength: 1, maxLength: 255 },
      name: { type: "string", maxLength: 256 },
      body: { type: "string", maxLength: 125_000 },
      targetCommitish: { type: "string", minLength: 1, maxLength: 255 },
      draft: { type: "boolean" },
      prerelease: { type: "boolean" },
    },
    required: ["repository", "tagName"],
    additionalProperties: false,
  },
});

export const kestrelOneGitHubWorkflowDispatchTool = createGitHubActionTool({
  name: "kestrel_one.github_workflow_dispatch",
  displayName: "GitHub Workflow Dispatch",
  description:
    "Dispatch a GitHub Actions workflow after explicit user approval in a repository granted to this Environment.",
  operation: "workflow.dispatch",
  requiresApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      repository: repositoryProperty,
      workflowId: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
      },
      ref: { type: "string", minLength: 1, maxLength: 255 },
      inputs: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["repository", "workflowId", "ref"],
    additionalProperties: false,
  },
});

async function invokeGitHubAction(
  context: SharedToolContext,
  input: {
    operation: GitHubActionToolOptions["operation"];
    input: Record<string, unknown>;
    requiresApproval: boolean;
    toolName: string;
  }
) {
  const appUrl = requireContextValue(
    context.kestrelOne?.appUrl,
    "KESTREL_ONE_APP_URL"
  );
  const ticket = requireContextValue(
    context.kestrelOne?.executionTicket,
    "Environment execution ticket"
  );
  const approvalId = input.requiresApproval
    ? requireContextValue(
        context.runtime?.approvalId,
        "Runtime GitHub approval ID"
      )
    : undefined;
  const response = await (context.fetchImpl ?? fetch)(
    new URL("/api/runtime/github/action", appUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "content-type": "application/json",
        ...(approvalId ? { "x-kestrel-approval-id": approvalId } : {}),
      },
      body: JSON.stringify({
        operation: input.operation,
        ...input.input,
      }),
    }
  );
  const body = parseObjectInput(
    `${input.toolName} response`,
    await response.json().catch(() => ({}))
  );
  if (!response.ok) {
    throw new RuntimeFailure(
      "KESTREL_ONE_GITHUB_ACTION_FAILED",
      `Kestrel One rejected ${input.toolName} with HTTP ${response.status}.`,
      {
        subsystem: "tooling",
        toolName: input.toolName,
        status: response.status,
        classification: response.status >= 500 ? "runtime" : "policy",
        recoverable: response.status >= 500,
      }
    );
  }
  return body;
}

function requireContextValue(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw createRuntimeFailure(
      "KESTREL_ONE_GITHUB_CONTEXT_MISSING",
      `${label} is required for Kestrel One GitHub tools.`,
      {
        subsystem: "tooling",
        classification: "configuration",
        recoverable: true,
      }
    );
  }
  return value.trim();
}
