import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { ENVIRONMENT_RUNTIME_PROMOTION_AUDIENCE } from "../apps/web/lib/runtime/github-actions-oidc.js";

const artifactSchema = z.object({
  role: z.enum(["workspace-runtime", "environment-router"]),
  image: z.string().regex(/@sha256:[0-9a-f]{64}$/u),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
});

const versionSchema = z.object({
  id: z.string(),
  runtimeImage: z.string(),
  runtimeSourceRevision: z.string(),
  routerImage: z.string(),
  routerSourceRevision: z.string(),
});

const channelSchema = z.object({
  generation: z.number().int().nonnegative(),
  currentVersion: versionSchema.nullable(),
});

const selectedFlyRoleSchema = z.enum([
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "control-worker",
]);

async function main() {
  const workflowRevision = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.GITHUB_SHA);
  const githubRunId = requireEnv("GITHUB_RUN_ID");
  const githubRunAttempt = z.coerce.number().int().positive().parse(requireEnv("GITHUB_RUN_ATTEMPT"));
  const api = requireEnv("KESTREL_RUNTIME_API_URL").replace(/\/$/u, "");
  const selectedRuntimeRoles = z
    .array(selectedFlyRoleSchema)
    .parse(JSON.parse(requireEnv("KESTREL_SELECTED_FLY_ROLES")))
    .filter(
      (role) =>
        role === "workspace-runtime" || role === "environment-router",
    );
  const identity = { workflowRevision, githubRunId, githubRunAttempt };
  const channelResponse = await runtimeRequest({
    api,
    path: queryPath("/api/runtime/environment-runtime/versions", identity),
    method: "GET",
  });
  const channel = channelSchema.parse((channelResponse as { channel?: unknown }).channel);
  const current = channel.currentVersion;
  const workspace = await readArtifact("workspace-runtime");
  const router = await readArtifact("environment-router");
  for (const selectedRole of selectedRuntimeRoles) {
    if (
      (selectedRole === "workspace-runtime" && !workspace) ||
      (selectedRole === "environment-router" && !router)
    ) {
      throw new Error(
        `Selected Runtime role ${selectedRole} did not publish an immutable image artifact.`,
      );
    }
  }
  if (!(workspace || router)) return;
  if (!(workspace || current) || !(router || current)) {
    throw new Error("The first Runtime Version must publish both immutable images.");
  }
  const registration = (await runtimeRequest({
    api,
    path: "/api/runtime/environment-runtime/versions",
    method: "POST",
    body: {
      ...identity,
      workspaceRuntime: {
        image: workspace?.image ?? current!.runtimeImage,
        sourceRevision: workspace?.sourceRevision ?? current!.runtimeSourceRevision,
      },
      environmentRouter: {
        image: router?.image ?? current!.routerImage,
        sourceRevision: router?.sourceRevision ?? current!.routerSourceRevision,
      },
    },
  })) as { version: { id: string }; generation: number };
  if (registration.version.id === current?.id) return;
  const canary = (await runtimeRequest({
    api,
    path: `/api/runtime/environment-runtime/versions/${registration.version.id}/canary`,
    method: "POST",
    body: identity,
  })) as { operation: { id: string } };
  let operation: { status: string; stage: string; errorMessage?: string | null };
  for (;;) {
    const response = (await runtimeRequest({
      api,
      path: queryPath(
        `/api/runtime/environment-runtime/versions/${registration.version.id}/canary`,
        identity,
      ),
      method: "GET",
    })) as { operation: typeof operation };
    operation = response.operation;
    if (["completed", "failed", "cancelled"].includes(operation.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (
    operation.status !== "completed" ||
    operation.stage !== "environment.update.ready"
  ) {
    throw new Error(
      `Runtime canary did not become ready: ${operation.errorMessage ?? operation.stage}.`,
    );
  }
  execFileSync("pnpm", ["--dir", "apps/web", "canary:environment:workspace"], {
    stdio: "inherit",
  });
  execFileSync("pnpm", ["--dir", "apps/web", "canary:environment:preview"], {
    stdio: "inherit",
  });
  await runtimeRequest({
    api,
    path: `/api/runtime/environment-runtime/versions/${registration.version.id}/promote`,
    method: "POST",
    body: {
      ...identity,
      expectedCurrentVersionId: current?.id ?? null,
      expectedGeneration: channel.generation,
      canaryOperationId: canary.operation.id,
    },
  });
}

async function readArtifact(role: "workspace-runtime" | "environment-router") {
  const path = `production-image-${role}.json`;
  return existsSync(path)
    ? artifactSchema.parse(JSON.parse(await readFile(path, "utf8")))
    : null;
}

async function runtimeRequest(input: {
  api: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
}) {
  const token = await freshOidcToken();
  const response = await fetch(`${input.api}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Runtime API ${input.method} failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json();
}

async function freshOidcToken() {
  const requestUrl = requireEnv("ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = requireEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    `${requestUrl}${separator}audience=${encodeURIComponent(ENVIRONMENT_RUNTIME_PROMOTION_AUDIENCE)}`,
    { headers: { authorization: `Bearer ${requestToken}` } },
  );
  if (!response.ok) throw new Error("GitHub Actions did not mint a runtime OIDC token.");
  const payload = (await response.json()) as { value?: unknown };
  if (typeof payload.value !== "string") throw new Error("GitHub Actions OIDC response is invalid.");
  return payload.value;
}

function queryPath(path: string, identity: Record<string, string | number>) {
  const query = new URLSearchParams(
    Object.entries(identity).map(([key, value]) => [key, String(value)]),
  );
  return `${path}?${query}`;
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime promotion failed."}\n`,
  );
  process.exit(1);
});
