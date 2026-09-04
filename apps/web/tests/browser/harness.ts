import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import postgres from "postgres";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "redis";
import {
  ENVIRONMENT_GATEWAY_CONFIG_VERSION,
  type EnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { handleAppRelay } from "../../../environment-router/src/app-relay.js";
import { HostedBrowserEgressRegistry } from "../../../environment-router/src/browser-egress.js";
import { EnvironmentGatewayConfigClient } from "../../../environment-router/src/gateway-config.js";
import { handleBrowserViewerControl } from "../../../environment-router/src/browser-viewer.js";
import { handleBrowserUpload } from "../../../environment-router/src/browser-upload.js";
import { handleBrowserDownload } from "../../../environment-router/src/browser-download.js";
import {
  configureHostedBrowserServiceResolver,
  handleHostedBrowserControl,
} from "../../lib/browser/control-route.js";
import { HostedBrowserStore } from "../../lib/browser/store.js";
import { HostedBrowserService } from "../../lib/browser/service.js";
import { HostedBrowserPolicy } from "../../lib/browser/policy.js";
import { createHostedBrowserArtifactAuthority } from "../../lib/browser/artifact-composition.js";
import { HostedBrowserUploadWorkerClient } from "../../lib/browser/upload-worker-client.js";
import { HostedBrowserDownloadWorkerClient } from "../../lib/browser/download-worker-client.js";
import { HostedBrowserViewerWorkerClient } from "../../lib/browser/viewer-worker-client.js";
import { HostedBrowserViewerService } from "../../lib/browser/viewer-service.js";
import { RedisHostedBrowserViewerTicketStore } from "../../lib/browser/viewer-transient-store.js";
import { resolveHostedBrowserViewerPolicyAccess } from "../../lib/browser/viewer-composition-access.js";
import { attachHostedBrowserViewerSocket } from "../../lib/browser/viewer-socket-route.js";
import { parseHostedBrowserViewerClientMessage } from "../../../../src/browser/hostedViewer.js";
import {
  parseHostedBrowserViewerServerMessage,
  type HostedBrowserViewerServerMessageV1,
} from "../../../../src/browser/hostedViewerProtocol.js";
import { createKestrelOneBrowserService } from "../../../../tools/kestrelOne/browserService.js";
import { UnifiedToolRegistry } from "../../../../tools/runtime/UnifiedToolRegistry.js";
import {
  BROWSER_TOOL_NAMES,
  type BrowserSessionV1,
} from "../../../../src/browser/contracts.js";
import { hashCanonical } from "../../../../src/kestrel/contracts/tool-contract.js";
import { ProcessBrowserProvider } from "./process-provider.js";
import { createSite } from "./site.js";
import { seedBrowser } from "./seed.js";
import { resolveTurnAttachments } from "../../lib/files/turn-attachment-resolver.js";
import {
  initializeThreadFile,
  uploadThreadFile,
  linkFilesToMessage,
} from "../../lib/files/service.js";
import type { RunnerTurnAttachment } from "@kestrel-agents/protocol";
import { persistDurableAssistantOutcome } from "../../lib/turns/store.js";
import { getBrowserToolContract } from "../../../../src/browser/browserAppContract.fixture.js";

export async function createHarness() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
  const ids = await seedBrowser(sql);
  const site = await createSite();
  const machines = new ProcessBrowserProvider(site.certificate);
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  assert.match(
    process.env.BROWSER_TEST_IMAGE_ID ?? "",
    /^sha256:[a-f0-9]{64}$/u,
  );
  const imageDigest = `registry.fly.io/kestrel-one-browser-worker@${process.env.BROWSER_TEST_IMAGE_ID}`;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway",
    appName: "browser-test",
    resolve: site.resolve,
    dial: site.dial,
  });
  const workspaceToken = randomUUID();
  const executionTicket = randomUUID();
  const store = new HostedBrowserStore();
  const policy = new HostedBrowserPolicy(store);
  const events: unknown[] = [];
  const outputs: unknown[] = [];
  let service: HostedBrowserService;
  // This is the selected authenticated Browser-service seam, not a substitute
  // implementation of the login route or Vercel runtime hosting.
  const control = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${executionTicket}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await handleHostedBrowserControl({
        request: new Request(`http://control${request.url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks),
        }),
        action: request.url!.split("/").at(-1)!,
        ticket: {
          organizationId: ids.organizationId,
          environmentId: ids.environmentId,
          actorId: ids.userId,
          runId: ids.executionId,
        } as EnvironmentExecutionTicket,
        projectId: ids.projectId,
      });
      if (!result.ok)
        console.error("[browser-test] Web control response", {
          action: request.url!.split("/").at(-1),
          status: result.status,
          error: ((await result.clone().json()) as { error?: unknown }).error,
        });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error("[browser-test] control host", error);
      response.writeHead(500);
      response.end();
    }
  });
  const controlUrl = await listen(control);
  const config = new EnvironmentGatewayConfigClient({
    controlPlaneUrl: controlUrl,
    environmentId: ids.environmentId,
    serviceToken: "test-only",
    fetchImpl: (async (_url: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({
        version: ENVIRONMENT_GATEWAY_CONFIG_VERSION,
        environmentId: ids.environmentId,
        revision: "test",
        workspaces: [
          {
            id: ids.workspaceId,
            machineId: "workspace",
            serviceTokenHash: createHash("sha256")
              .update(workspaceToken)
              .digest("base64url"),
          },
        ],
        previews: [],
        modelGrants: [],
        appGrants: [
          {
            executionId: ids.executionId,
            runId: ids.runId,
            workspaceId: ids.workspaceId,
            executionTicket,
            credentialExpiresAt: new Date(
              Date.now() + 60 * 60_000,
            ).toISOString(),
          },
        ],
      })) as typeof fetch,
  });
  await config.refresh();
  const router = createServer((request, response) => {
    const common = {
      request,
      response,
      publicKey: publicKeyPem,
      environmentId: ids.environmentId,
      expectedAppName: "browser-test",
      fetchImpl: machines.fetch,
    };
    const pathname = new URL(request.url!, "http://router").pathname;
    if (pathname.startsWith("/internal/browser/viewer"))
      return void handleBrowserViewerControl(common);
    if (pathname.startsWith("/internal/browser/upload"))
      return void handleBrowserUpload({
        ...common,
        prepare: pathname.endsWith("/prepare"),
      });
    if (pathname.startsWith("/internal/browser/download"))
      return void handleBrowserDownload(common);
    void handleAppRelay({
      request,
      response,
      config,
      browserEgress: registry,
      browserWorkerFetchImpl: machines.fetch,
    });
  });
  const routerUrl = await listen(router);
  await sql`UPDATE environments SET router_url = ${routerUrl} WHERE id = ${ids.environmentId}`;
  service = new HostedBrowserService({
    store,
    policy,
    machines,
    artifacts: createHostedBrowserArtifactAuthority(privateKeyPem),
    metrics: { emit: (name, metadata) => events.push({ name, ...metadata }) },
    capabilityPrivateKeyPem: privateKeyPem,
    requestAuthority: {
      organizationId: ids.organizationId,
      environmentId: ids.environmentId,
      userId: ids.userId,
      executionId: ids.executionId,
    },
    appName: "browser-test",
    gatewayMachineId: "gateway",
    region: "iad",
    runtimeImageDigest: imageDigest,
    routerUrl,
    uploads: new HostedBrowserUploadWorkerClient({
      environmentPrivateKeyPem: privateKeyPem,
    }),
    downloads: new HostedBrowserDownloadWorkerClient({
      environmentPrivateKeyPem: privateKeyPem,
    }),
    async resolveUploadAttachment(input) {
      assert.equal(input.turnId, ids.turnId);
      const resolved = await resolveTurnAttachments({ turnId: input.turnId });
      const matches = resolved.attachments.filter(
        (attachment) => attachment.attachmentId === input.attachmentId,
      );
      assert.equal(matches.length, 1);
      const attachment = matches[0]!;
      assert.equal(attachment.threadId, ids.threadId);
      assert.equal(
        typeof attachment.data,
        "string",
        "local storage must resolve actual stored bytes",
      );
      return {
        attachmentId: attachment.attachmentId,
        threadId: attachment.threadId!,
        filename: attachment.filename,
        declaredMediaType: attachment.declaredMediaType!,
        detectedMediaType: attachment.detectedMediaType!,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        async openStream() {
          return Readable.from(Buffer.from(attachment.data!, "base64"));
        },
      };
    },
  });
  const uninstall = configureHostedBrowserServiceResolver(async () => service);
  const context = {
    kestrelOne: {
      appRelayUrl: routerUrl,
      appRelayToken: workspaceToken,
      executionRunId: ids.executionId,
    },
  };
  const port = createKestrelOneBrowserService(context);
  const tools = new UnifiedToolRegistry({
    allowlist: [...BROWSER_TOOL_NAMES],
    context: { ...context, browserService: port },
  });
  const redis = createClient({ url: process.env.REDIS_URL! });
  await redis.connect();
  const tickets = new RedisHostedBrowserViewerTicketStore(redis);
  const viewerService = new HostedBrowserViewerService({
    store,
    lifecycle: service,
    tickets,
    worker: new HostedBrowserViewerWorkerClient({
      environmentPrivateKeyPem: privateKeyPem,
      viewerPrivateKeyPem: privateKeyPem,
      viewerPublicKeyPem: publicKeyPem,
    }),
    privateKeyPem,
    publicKeyPem,
    appName: "browser-test",
    routerUrl,
    evidence: { emit: (name, metadata) => events.push({ name, ...metadata }) },
    access: {
      async authorize(input) {
        assert.equal(input.actorId, ids.userId);
        const current = await policy.resolve({
          origin: input.origin,
          operation: "browser.snapshot",
          effectiveInput: {
            sessionId: input.session.sessionId,
            generation: input.session.generation,
          },
        });
        try {
          return resolveHostedBrowserViewerPolicyAccess({
            origin: input.origin,
            session: input.session,
            current: {
              ...current.authority,
              decision: current.resolution.decision,
            },
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED"
          ) {
            events.push({ name: "viewer_adoption_pending" });
          }
          throw error;
        }
      },
    },
  });
  const sockets = new WebSocketServer({ server: control, path: "/viewer" });
  const controllers: ReturnType<typeof attachHostedBrowserViewerSocket>[] = [];
  sockets.on("connection", (socket) =>
    controllers.push(
      attachHostedBrowserViewerSocket({
        socket,
        parseMessage: (data) =>
          parseHostedBrowserViewerClientMessage(JSON.parse(data.toString())),
        connect: (ticket) => viewerService.connect(ticket),
      }),
    ),
  );
  const actor = {
    organizationId: ids.organizationId,
    actorId: ids.userId,
    threadId: ids.threadId,
  };
  let session: BrowserSessionV1 | undefined;
  const runContext = {
    runId: ids.runId,
    sessionId: ids.threadId,
    payload: {
      attachments: [] as RunnerTurnAttachment[],
      metadata: {
        threadId: ids.threadId,
        activeTurnId: ids.turnId,
        turnId: ids.turnId,
      },
      hostedApprovalAuthority: {
        version: "runner_hosted_approval_authority_v1",
        organizationId: ids.organizationId,
        environmentId: ids.environmentId,
        projectId: ids.projectId,
        threadId: ids.threadId,
      },
      actor: {
        actorType: "end_user",
        actorId: ids.userId,
        tenantId: ids.organizationId,
      },
    },
    sessionState: {},
  };
  async function prepare(
    toolName: (typeof BROWSER_TOOL_NAMES)[number],
    rawInput: Record<string, unknown>,
  ) {
    const input =
      toolName === "browser.open"
        ? rawInput
        : {
            sessionId: session!.sessionId,
            generation: session!.generation,
            ...rawInput,
          };
    const surface = await tools.createToolSurfaceSnapshot({
      runContext,
      toolNames: [toolName],
    });
    const resolved = await port.resolvePolicy({
      version: "browser_policy_resolution_v1",
      runId: ids.runId,
      threadId: ids.threadId,
      operation: toolName,
      effectiveInput: input,
      authority: { threadId: ids.threadId, projectId: ids.projectId },
    });
    const callId = `browser-test-${randomUUID()}`;
    const capability = tools
      .getCapabilityManifest()
      .find((item) => item.name === toolName)!;
    const approvalRequired =
      resolved.decision === "approval_required" ||
      getBrowserToolContract(toolName).approval === "always_approval";
    return tools.prepareToolCall(
      {
        runId: ids.runId,
        sessionId: ids.threadId,
        callId,
        activation: surface.tools[0]!,
        origin: {
          kind: "model",
          snapshotId: surface.snapshotId,
          modelToolCallId: callId,
        },
        rawInput: input,
        policy: {
          decision:
            resolved.decision === "deny"
              ? "deny"
              : approvalRequired
                ? "approval_required"
                : "allow",
          policyRevision: resolved.policyRevision,
        },
        ...(approvalRequired
          ? {
              approval: {
                approvalId: `approval-${callId}`,
                authorityRevision: hashCanonical({ callId }),
              },
              approvalCapabilities: capability.approvalCapabilities ?? [],
            }
          : {}),
      },
      { runContext },
    );
  }
  async function execute(
    prepared: Awaited<ReturnType<typeof prepare>>,
    afterAcceptance?: () => Promise<void>,
  ) {
    const output = await port.execute(prepared, {
      authority: { threadId: ids.threadId, projectId: ids.projectId },
      async acknowledgeDispatch() {
        events.push({ name: "dispatch", callId: prepared.callId });
        await afterAcceptance?.();
      },
      async persistCompletedResult(output) {
        outputs.push(output);
        await persistDurableAssistantOutcome({
          turnId: ids.turnId,
          interaction: null,
          messages: [
            {
              id: randomUUID(),
              parts: [
                {
                  type: "dynamic-tool",
                  toolName: prepared.activation.descriptor.toolId,
                  toolCallId: prepared.callId,
                  state: "output-available",
                  input: prepared.effectiveInput,
                  output,
                },
              ],
              model: "kestrel-one",
              source: "web",
              projectContextRevisionId: null,
            },
          ],
        });
      },
    });
    if (prepared.activation.descriptor.toolId === "browser.open")
      session = (output as { session: BrowserSessionV1 }).session;
    return output as Record<string, any>;
  }
  return {
    ids,
    sql,
    store,
    policy,
    service,
    registry,
    machines,
    site,
    tools,
    outputs,
    events,
    tickets,
    viewerService,
    actor,
    imageDigest,
    runContext,
    async attach(bytes: Buffer, filename: string) {
      const scope = {
        threadId: ids.threadId,
        organizationId: ids.organizationId,
        userId: ids.userId,
      };
      const draft = await initializeThreadFile({
        ...scope,
        filename,
        sizeBytes: bytes.length,
        declaredMediaType: "text/plain",
      });
      const file = await uploadThreadFile({
        ...scope,
        fileId: draft.id,
        body: new Response(new Uint8Array(bytes)).body,
        contentLength: bytes.length,
      });
      const references = await linkFilesToMessage({
        ...scope,
        fileIds: [file.id],
        messageId: ids.turnId,
      });
      await sql`UPDATE thread_messages SET parts = ${sql.json(JSON.parse(JSON.stringify(references.map((data) => ({ type: "data-kestrel-file", data })))))} WHERE id = ${ids.turnId}`;
      runContext.payload.attachments = (
        await resolveTurnAttachments({ turnId: ids.turnId })
      ).attachments;
      return file;
    },
    get session() {
      assert.ok(session);
      return session;
    },
    prepare,
    execute,
    async call(
      name: (typeof BROWSER_TOOL_NAMES)[number],
      input: Record<string, unknown> = {},
    ) {
      return execute(await prepare(name, input));
    },
    async viewer() {
      const minted = await viewerService.mintTicket(actor);
      const socket = new WebSocket(
        controlUrl.replace("http:", "ws:") + "/viewer",
      );
      const messages: HostedBrowserViewerServerMessageV1[] = [];
      socket.on("message", (data) =>
        messages.push(
          parseHostedBrowserViewerServerMessage(JSON.parse(data.toString())),
        ),
      );
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          version: "hosted_browser_viewer_route_v1",
          type: "authenticate",
          ticket: minted.ticket,
        }),
      );
      return {
        socket,
        messages,
        send(message: Record<string, unknown>) {
          socket.send(
            JSON.stringify({
              version: "hosted_browser_viewer_route_v1",
              ...message,
            }),
          );
        },
      };
    },
    async close() {
      const errors: unknown[] = [];
      for (const cleanup of [
        ...controllers.map(
          (controller) => () => controller.close(1000, "test complete"),
        ),
        () => {
          for (const socket of sockets.clients) socket.terminate();
          sockets.close();
        },
        () => machines.close(),
        () => registry.closeAll(),
        () => config.stop(),
        () => closeServer(router),
        () => closeServer(control),
        () => redis.quit(),
        () =>
          sql`DELETE FROM browser_session_resources WHERE session_id IN (SELECT session_id FROM browser_sessions WHERE thread_id = ${ids.threadId})`,
        () =>
          sql`DELETE FROM browser_sessions WHERE thread_id = ${ids.threadId}`,
        () => sql`DELETE FROM organization WHERE id = ${ids.organizationId}`,
        () => sql`DELETE FROM "user" WHERE id = ${ids.userId}`,
        () => uninstall(),
        () => tools.close(),
        () => site.close(),
        () => sql.end({ timeout: 0 }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Browser test cleanup failed");
    },
  };
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
