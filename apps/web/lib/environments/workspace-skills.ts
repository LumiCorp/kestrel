import { createEnvironmentMachineRoute } from "./execution-route";
import { knowledgeDb } from "@/lib/knowledge/db";

export async function proxyProjectWorkspaceSkillRequest(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path?: string | undefined;
  body?: unknown;
}) {
  const workspace = await knowledgeDb.query.environmentWorkspaces.findFirst({
    where: (table, { and, eq, isNull }) => and(
      eq(table.organizationId, input.organizationId),
      eq(table.projectId, input.projectId),
      isNull(table.deletedAt),
    ),
  });
  if (!workspace?.flyMachineId || workspace.status !== "ready") {
    throw new Error("Project Workspace must be running before its skills can be managed.");
  }
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq }) => and(
      eq(table.id, workspace.environmentId),
      eq(table.organizationId, input.organizationId),
    ),
  });
  if (!environment?.flyAppName || !environment.routerUrl) {
    throw new Error("Project Workspace Environment route is unavailable.");
  }
  const route = createEnvironmentMachineRoute({
    organizationId: input.organizationId,
    environmentId: environment.id,
    workspaceId: workspace.id,
    threadId: input.projectId,
    actorId: input.actorUserId,
    agentId: "kestrel-workspace-skills",
    flyAppName: environment.flyAppName,
    flyMachineId: workspace.flyMachineId,
    routerUrl: environment.routerUrl,
    capabilities: ["workspace.skills.read", "workspace.skills.write"],
  });
  const target = new URL(`/v1/skills${input.path ? `/${input.path}` : ""}`, route.baseUrl);
  const upstream = await fetch(target, {
    method: input.method,
    headers: {
      authorization: `Bearer ${route.authToken}`,
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    cache: "no-store",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
