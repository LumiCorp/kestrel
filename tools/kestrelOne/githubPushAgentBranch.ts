import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RuntimeFailure, createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput, readString } from "../helpers.js";

const execFileAsync = promisify(execFile);
const TOOL_NAME = "kestrel_one.github_push_agent_branch";

export const kestrelOneGitHubPushAgentBranchTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description:
      "Push the current managed worktree HEAD to a deterministic Kestrel-owned agent branch in an explicitly granted GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          pattern: "^[^/\\s]+/[^/\\s]+$",
        },
      },
      required: ["repository"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "high",
      costClass: "free",
      executionClass: "external_side_effect",
      capabilityClasses: ["github.organization", "network.call"],
      approvalCapabilities: ["network.call"],
      suitability: {
        supportsAttribution: true,
        supportsAggregation: false,
        typicalFailureModes: [
          "repository_not_granted",
          "managed_worktree_missing",
          "push_rejected",
        ],
      },
    },
    presentation: {
      displayName: "GitHub Push Agent Branch",
      aliases: ["push agent branch"],
      keywords: ["github", "push", "branch", "agent"],
      provider: "kestrel-one",
      toolFamily: "github",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const repository = readRepository(input);
      const workspaceRoot = context.fileSystem?.workspaceRoot?.trim();
      const sessionId = context.runtime?.sessionId;
      const runId = context.runtime?.runId;
      const appUrl = context.kestrelOne?.appUrl?.trim();
      const ticket = context.kestrelOne?.executionTicket?.trim();
      if (!(workspaceRoot && sessionId && runId && appUrl && ticket)) {
        throw createRuntimeFailure(
          "KESTREL_ONE_GITHUB_PUSH_CONTEXT_MISSING",
          "GitHub agent-branch push requires managed Workspace and signed run context.",
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            classification: "configuration",
            recoverable: true,
          }
        );
      }
      const credentialResponse = await (context.fetchImpl ?? fetch)(
        new URL("/api/runtime/github/token", appUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ticket}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            repository,
            capability: "repository.push_agent_branch",
          }),
        }
      );
      const credential = parseObjectInput(
        `${TOOL_NAME} credential response`,
        await credentialResponse.json().catch(() => ({}))
      );
      const credentialToken = readString(credential, "token");
      if (!(credentialResponse.ok && credentialToken)) {
        throw new RuntimeFailure(
          "KESTREL_ONE_GITHUB_PUSH_CREDENTIAL_FAILED",
          `Kestrel One rejected GitHub branch credentials with HTTP ${credentialResponse.status}.`,
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            status: credentialResponse.status,
            classification: "policy",
            recoverable: false,
          }
        );
      }
      const branch = `kestrel/agents/${gitRefSegment(sessionId)}/${gitRefSegment(runId)}`;
      const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-github-push-"));
      const askPassPath = path.join(temporaryRoot, "askpass.sh");
      await writeFile(
        askPassPath,
        '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token ;; *) echo "$KESTREL_GITHUB_TOKEN" ;; esac\n',
        "utf8"
      );
      await chmod(askPassPath, 0o700);
      try {
        await execFileAsync(
          "git",
          [
            "-C",
            workspaceRoot,
            "push",
            "--porcelain",
            `https://github.com/${repository}.git`,
            `HEAD:refs/heads/${branch}`,
          ],
          {
            env: {
              ...process.env,
              GIT_ASKPASS: askPassPath,
              GIT_TERMINAL_PROMPT: "0",
              KESTREL_GITHUB_TOKEN: credentialToken,
            },
            maxBuffer: 10 * 1024 * 1024,
          }
        );
      } catch (error) {
        throw new RuntimeFailure(
          "KESTREL_ONE_GITHUB_PUSH_FAILED",
          "GitHub rejected the Kestrel agent branch push.",
          {
            subsystem: "tooling",
            toolName: TOOL_NAME,
            classification: "runtime",
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }
        );
      } finally {
        delete credential.token;
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      return {
        repository,
        branch,
        ref: `refs/heads/${branch}`,
        pushed: true,
      };
    };
  },
};

function readRepository(input: unknown) {
  const repository = readString(
    parseObjectInput(TOOL_NAME, input),
    "repository"
  )?.trim() ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      `Tool '${TOOL_NAME}' requires owner/repository.`,
      { subsystem: "tooling", toolName: TOOL_NAME }
    );
  }
  return repository;
}

function gitRefSegment(value: string) {
  const segment = value.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80);
  return segment || "run";
}
