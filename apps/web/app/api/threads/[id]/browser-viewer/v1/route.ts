import { createPublicKey } from "node:crypto";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import type WebSocket from "ws";
import {
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  parseHostedBrowserViewerClientMessage,
  verifyHostedBrowserViewerTicket,
} from "../../../../../../../../src/browser/hostedViewer.js";
import { resolveHostedBrowserViewerService } from "@/lib/browser/viewer-composition";
import type { HostedBrowserViewerConnection } from "@/lib/browser/viewer-service";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = routeIdSchema.transform((threadId) => ({ threadId }));

export const runtime = "nodejs";
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const FRAME_INTERVAL_MS = 750;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { organizationId, session } = await requireActiveOrganization(request);
  const { threadId } = paramsSchema.parse((await context.params).id);
  return experimental_upgradeWebSocket(
    async (socket) => attachHostedBrowserViewer(socket, {
      organizationId,
      actorId: session.user.id,
      threadId,
    }),
    { maxPayload: MAX_CLIENT_MESSAGE_BYTES },
  );
}

async function attachHostedBrowserViewer(
  socket: WebSocket,
  requestAuthority: {
    organizationId: string;
    actorId: string;
    threadId: string;
  },
) {
  let connection: HostedBrowserViewerConnection | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let authorityTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let tail = Promise.resolve();

  const close = async (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    if (frameTimer) clearInterval(frameTimer);
    if (authorityTimer) clearTimeout(authorityTimer);
    const active = connection;
    connection = undefined;
    if (active) await active.disconnect().catch(() => {});
    if (socket.readyState === 1 || socket.readyState === 0) {
      socket.close(code, reason);
    }
  };

  const send = (message: unknown) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };

  const scheduleConnectionExpiry = () => {
    if (authorityTimer) clearTimeout(authorityTimer);
    if (!connection) return;
    const ticketExpiry = Date.parse(connection.claims.expiresAt);
    const leaseExpiry = connection.state.inputLeaseExpiresAt
      ? Date.parse(connection.state.inputLeaseExpiresAt)
      : Number.POSITIVE_INFINITY;
    const delay = Math.max(1, Math.min(ticketExpiry, leaseExpiry) - Date.now());
    authorityTimer = setTimeout(() => void close(1008, "viewer authority expired"), delay);
  };

  const startFrames = () => {
    frameTimer = setInterval(() => {
      tail = tail.then(async () => {
        if (!connection || closed) return;
        try {
          send(await connection.frame());
        } catch {
          await close(1008, "viewer authority unavailable");
        }
      });
    }, FRAME_INTERVAL_MS);
  };

  socket.on("message", (data) => {
    tail = tail.then(async () => {
      if (closed) return;
      try {
        const message = parseHostedBrowserViewerClientMessage(
          JSON.parse(messageText(data)),
        );
        if (!connection) {
          if (message.type !== "authenticate") throw new Error("BROWSER_SESSION_LOST");
          const privateKey = required("KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY");
          const claims = verifyHostedBrowserViewerTicket({
            token: message.ticket,
            publicKeyPem: createPublicKey(privateKey)
              .export({ type: "spki", format: "pem" })
              .toString(),
          });
          if (
            claims.organizationId !== requestAuthority.organizationId ||
            claims.actorId !== requestAuthority.actorId ||
            claims.threadId !== requestAuthority.threadId
          ) {
            throw new Error("BROWSER_SESSION_LOST");
          }
          const service = await resolveHostedBrowserViewerService({
            organizationId: claims.organizationId,
            actorId: claims.actorId,
            threadId: claims.threadId,
          });
          connection = await service.connect(message.ticket);
          send({
            version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
            type: "state",
            state: connection.state,
          });
          scheduleConnectionExpiry();
          startFrames();
          return;
        }
        const response = await connection.dispatch(message);
        send(response);
        if (response.type === "closed") {
          await close(1000, "browser session closed");
          return;
        }
        scheduleConnectionExpiry();
      } catch {
        send({
          version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
          type: "error",
          code: "BROWSER_SESSION_LOST",
        });
        await close(1008, "viewer authorization failed");
      }
    });
  });
  socket.on("close", () => void close(1000, "viewer disconnected"));
  socket.on("error", () => void close(1011, "viewer transport failed"));
}

function messageText(value: WebSocket.RawData) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return Buffer.concat(value).toString("utf8");
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  throw new Error("BROWSER_SESSION_LOST");
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return value;
}
