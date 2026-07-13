import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { resolveEnvironmentExecutionRoute } from "@/lib/environments/execution-route";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { getThreadAccessForUser } from "@/lib/threads/store";

const ALLOWED_PATHS = new Set(["apps", "files", "tree", "terminal/exec"]);

type WorkspaceApplicationPayload = {
  id: string;
  name: string;
  command: string;
  workingDirectory: string;
  port: number;
  desiredState?: "running" | "stopped";
  status: "starting" | "running" | "stopped" | "failed";
  processId: number | null;
};

async function handle(
  request: Request,
  context: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const { id, path } = await context.params;
    const apiPath = path.join("/");
    const isApplicationProxy = /^apps\/[^/]+\/proxy(?:\/.*)?$/u.test(apiPath);
    const isTerminalSession =
      /^terminal\/sessions(?:\/[^/]+(?:\/(?:input|output))?)?$/u.test(apiPath);
    const isPromotion =
      apiPath === "promotions" ||
      /^promotions\/[^/]+(?:\/apply)?$/u.test(apiPath);
    if (
      !(
        ALLOWED_PATHS.has(apiPath) ||
        isApplicationProxy ||
        isTerminalSession ||
        isPromotion
      )
    ) {
      return NextResponse.json(
        { error: "Workspace route not found" },
        { status: 404 }
      );
    }
    const { organizationId, session } = await requireActiveOrganization();
    const access = await getThreadAccessForUser(
      id,
      session.user.id,
      organizationId
    );
    if (!access) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const route = await resolveEnvironmentExecutionRoute({
      organizationId,
      threadId: id,
      actorUserId: session.user.id,
    });
    const incoming = new URL(request.url);
    const target = new URL(`/v1/${apiPath}`, route.baseUrl);
    target.search = incoming.search;
    const requestBody =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        authorization: `Bearer ${route.authToken}`,
        ...(request.headers.get("content-type")
          ? { "content-type": request.headers.get("content-type")! }
          : {}),
        ...(request.headers.get("if-match")
          ? { "if-match": request.headers.get("if-match")! }
          : {}),
      },
      body: requestBody,
      signal: request.signal,
      cache: "no-store",
    });
    if (
      apiPath === "terminal/exec" &&
      request.method === "POST" &&
      upstream.ok
    ) {
      const payload = (await upstream.json()) as {
        exitCode?: number | null;
        stdout?: string;
        stderr?: string;
      };
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "environment-workspace",
        action: "workspace.terminal.executed",
        targetType: "workspace",
        targetId: route.workspaceId,
        message: "Executed an authorized Workspace terminal command.",
        metadata: {
          environmentId: route.environmentId,
          threadId: id,
          exitCode: payload.exitCode ?? null,
        },
      });
      return NextResponse.json(payload, { status: upstream.status });
    }
    if (
      apiPath === "terminal/sessions" &&
      request.method === "POST" &&
      upstream.ok
    ) {
      const payload = (await upstream.json()) as {
        id: string;
        status: string;
      };
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "environment-workspace",
        action: "workspace.terminal.opened",
        targetType: "workspace",
        targetId: route.workspaceId,
        message: "Opened an authorized Workspace PTY terminal.",
        metadata: {
          environmentId: route.environmentId,
          threadId: id,
          terminalSessionId: payload.id,
        },
      });
      return NextResponse.json(payload, { status: upstream.status });
    }
    if (
      /^terminal\/sessions\/[^/]+$/u.test(apiPath) &&
      request.method === "DELETE" &&
      upstream.ok
    ) {
      const payload = (await upstream.json()) as { ok: boolean };
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "environment-workspace",
        action: "workspace.terminal.closed",
        targetType: "workspace",
        targetId: route.workspaceId,
        message: "Closed an authorized Workspace PTY terminal.",
        metadata: { environmentId: route.environmentId, threadId: id },
      });
      return NextResponse.json(payload, { status: upstream.status });
    }
    if (apiPath === "apps" && request.method === "GET" && upstream.ok) {
      const payload = (await upstream.json()) as {
        applications?: WorkspaceApplicationPayload[];
      };
      for (const application of payload.applications ?? []) {
        await syncApplication({
          application,
          organizationId,
          environmentId: route.environmentId,
          workspaceId: route.workspaceId,
          actorUserId: session.user.id,
        });
      }
      return NextResponse.json(payload, { status: upstream.status });
    }
    if (apiPath === "apps" && request.method === "POST" && upstream.ok) {
      const payload = (await upstream.json()) as {
        application?: WorkspaceApplicationPayload;
      };
      if (payload.application) {
        await syncApplication({
          application: payload.application,
          organizationId,
          environmentId: route.environmentId,
          workspaceId: route.workspaceId,
          actorUserId: session.user.id,
        });
      }
      return NextResponse.json(payload, { status: upstream.status });
    }
    if (
      /^promotions\/[^/]+\/apply$/u.test(apiPath) &&
      request.method === "POST" &&
      upstream.ok
    ) {
      const payload = (await upstream.json()) as {
        promotion?: { promotionId?: string; status?: string };
      };
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "environment-workspace",
        action: "workspace.promotion.accepted",
        targetType: "workspace",
        targetId: route.workspaceId,
        message: "Accepted an isolated candidate into the canonical Workspace.",
        metadata: {
          environmentId: route.environmentId,
          threadId: id,
          promotionId: payload.promotion?.promotionId ?? null,
          status: payload.promotion?.status ?? null,
        },
      });
      return NextResponse.json(payload, { status: upstream.status });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
        ...(upstream.headers.get("etag")
          ? { etag: upstream.headers.get("etag")! }
          : {}),
      },
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;

async function syncApplication(input: {
  application: WorkspaceApplicationPayload;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  actorUserId: string;
}) {
  const app = input.application;
  await knowledgeDb
    .insert(schema.environmentApplications)
    .values({
      id: app.id,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      createdByUserId: input.actorUserId,
      name: app.name,
      slug: `app-${app.id}`,
      workingDirectory: app.workingDirectory,
      startCommand: app.command,
      port: app.port,
      desiredState: app.desiredState ?? "running",
      status: app.status,
      processId: app.processId ? String(app.processId) : null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.environmentApplications.id,
      set: {
        desiredState: app.desiredState ?? "running",
        status: app.status,
        processId: app.processId ? String(app.processId) : null,
        updatedAt: new Date(),
      },
    });
}
