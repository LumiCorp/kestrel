import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { RuntimeFailure, createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput, readString } from "../helpers.js";
import { throwIfExecutionAuthorizationRejected } from "./authorizationError.js";
import { resolveKestrelOneAppRequest } from "./appTransport.js";

const execFileAsync = promisify(execFile);
const TOOL_NAME = "kestrel_one.github_push_agent_branch";

export const kestrelOneGitHubPushAgentBranchTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description:
      "Publish the complete current managed-worktree candidate to a deterministic Kestrel-owned agent branch in an explicitly granted GitHub repository. If the repository is empty, return a Workspace review link instead of probing a file or retrying.",
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
      if (!(workspaceRoot && sessionId && runId)) {
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
      const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-github-push-"));
      const bundlePath = path.join(temporaryRoot, "candidate.bundle");
      const indexPath = path.join(temporaryRoot, "candidate.index");
      const bundleRef = `refs/kestrel/bundles/${gitRefSegment(runId)}`;
      try {
        const baseHead = await gitOutput(workspaceRoot, ["rev-parse", "HEAD"]);
        const candidateEnvironment = {
          GIT_INDEX_FILE: indexPath,
          GIT_AUTHOR_NAME: "Kestrel Agent",
          GIT_AUTHOR_EMAIL: "agent@kestrel.invalid",
          GIT_COMMITTER_NAME: "Kestrel Agent",
          GIT_COMMITTER_EMAIL: "agent@kestrel.invalid",
        };
        await git(workspaceRoot, ["read-tree", baseHead], candidateEnvironment);
        await git(workspaceRoot, ["add", "-A", "--", "."], candidateEnvironment);
        const candidateTree = await gitOutput(
          workspaceRoot,
          ["write-tree"],
          candidateEnvironment,
        );
        const candidateCommit = await gitOutput(
          workspaceRoot,
          [
            "commit-tree",
            candidateTree,
            "-p",
            baseHead,
            "-m",
            `Kestrel candidate ${runId}`,
          ],
          candidateEnvironment,
        );
        await git(workspaceRoot, ["update-ref", bundleRef, candidateCommit]);
        await git(workspaceRoot, [
          "bundle",
          "create",
          bundlePath,
          bundleRef,
        ]);

        const credentialTransport = resolveKestrelOneAppRequest(
          context,
          "/api/runtime/github/credentials",
        );
        const credentialResponse = await (context.fetchImpl ?? fetch)(
          credentialTransport.url,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${credentialTransport.authorization}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              operation: "repository.push_agent_branch",
              repository,
              candidateFingerprint: candidateCommit,
              candidateCommit,
            }),
          },
        );
        const credential = parseObjectInput(
          `${TOOL_NAME} credential response`,
          await credentialResponse.json().catch(() => ({})),
        );
        await throwIfExecutionAuthorizationRejected({
          response: credentialResponse,
          body: credential,
          toolName: TOOL_NAME,
        });
        const credentialToken = readString(credential, "token");
        const resourceId = readString(credential, "resourceId");
        if (!(credentialResponse.ok && credentialToken && resourceId)) {
          throw githubFailure(
            credentialResponse,
            credential,
            "GITHUB_CREDENTIAL_UNAVAILABLE",
          );
        }

        const pushTransport = resolveKestrelOneAppRequest(
          context,
          "/api/runtime/github/push",
        );
        const pushResponse = await (context.fetchImpl ?? fetch)(
          pushTransport.url,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${
                pushTransport.viaRelay
                  ? pushTransport.authorization
                  : credentialToken
              }`,
              "content-type": "application/x-git-bundle",
              ...(pushTransport.viaRelay
                ? { "x-kestrel-tool-credential": credentialToken }
                : {}),
              "x-kestrel-resource-id": resourceId,
              "x-kestrel-candidate-fingerprint": candidateCommit,
              "x-kestrel-candidate-commit": candidateCommit,
            },
            // Node's node:stream/web declaration and the DOM declaration used by
            // RequestInit identify the same runtime stream with incompatible types.
            body: Readable.toWeb(createReadStream(bundlePath)) as unknown as ReadableStream,
            duplex: "half",
          } as RequestInit & { duplex: "half" },
        );
        const pushed = parseObjectInput(
          `${TOOL_NAME} push response`,
          await pushResponse.json().catch(() => ({})),
        );
        if (!pushResponse.ok) {
          const errorCode = readErrorCode(pushed);
          if (errorCode === "GITHUB_REPOSITORY_INITIALIZATION_REQUIRED") {
            const workspaceUrl = `/threads/${encodeURIComponent(
              sessionId,
            )}/workspace?runId=${encodeURIComponent(
              runId,
            )}&repository=${encodeURIComponent(repository)}`;
            const output = {
              status: "review_required",
              repository,
              candidateFingerprint: candidateCommit,
              workspaceUrl,
              message: "Review and initialize in Workspace",
            };
            return {
              output,
              presentation: {
                artifacts: [
                  {
                    id: `github-initialize:${repository}:${runId}`,
                    title: "Review and initialize in Workspace",
                    kind: "workspace_action",
                    url: workspaceUrl,
                    metadata: { repository, candidateFingerprint: candidateCommit },
                  },
                ],
              },
            };
          }
          throw githubFailure(pushResponse, pushed, "GITHUB_PUSH_FAILED");
        }
        return pushed;
      } finally {
        await git(workspaceRoot, ["update-ref", "-d", bundleRef]).catch(() => {});
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    };
  },
  normalizeResult(value) {
    const result = parseObjectInput(`${TOOL_NAME} result`, value);
    if (Object.hasOwn(result, "output")) {
      return {
        output: result.output,
        ...(Object.hasOwn(result, "presentation")
          ? { presentation: result.presentation as never }
          : {}),
      };
    }
    return { output: result };
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

async function git(
  workspaceRoot: string,
  args: string[],
  environment: Record<string, string> = {},
) {
  await execFileAsync("git", ["-C", workspaceRoot, ...args], {
    env: { ...process.env, ...environment },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function gitOutput(
  workspaceRoot: string,
  args: string[],
  environment: Record<string, string> = {},
) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, ...args],
    {
      env: { ...process.env, ...environment },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

function readErrorCode(value: Record<string, unknown>) {
  const error = value.error;
  return error && typeof error === "object"
    ? readString(error as Record<string, unknown>, "code")
    : undefined;
}

function githubFailure(
  response: Response,
  body: Record<string, unknown>,
  fallbackCode: string,
) {
  const code = readErrorCode(body) ?? fallbackCode;
  return new RuntimeFailure(code, `GitHub publication failed: ${code}.`, {
    subsystem: "tooling",
    toolName: TOOL_NAME,
    status: response.status,
    classification: response.status >= 500 ? "runtime" : "policy",
    recoverable: response.status === 409 || response.status >= 500,
  });
}
