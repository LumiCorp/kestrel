import { createPublicKey } from "node:crypto";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import type WebSocket from "ws";
import {
  parseHostedBrowserViewerClientMessage,
  verifyHostedBrowserViewerTicket,
} from "../../../../../../../../src/browser/hostedViewer.js";
import { resolveHostedBrowserViewerService } from "@/lib/browser/viewer-composition";
import { attachHostedBrowserViewerSocket } from "@/lib/browser/viewer-socket-route";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = routeIdSchema.transform((threadId) => ({ threadId }));

export const runtime = "nodejs";
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

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
  attachHostedBrowserViewerSocket({
    socket,
    parseMessage(data) {
      return parseHostedBrowserViewerClientMessage(JSON.parse(messageText(data)));
    },
    async connect(ticket) {
      const privateKey = required("KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY");
      const claims = verifyHostedBrowserViewerTicket({
        token: ticket,
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
      return service.connect(ticket);
    },
  });
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
