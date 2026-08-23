import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  signTurnAttachmentResolutionTicket,
  type TurnAttachmentResolutionTicket,
} from "@lumi/kestrel-environment-auth";
import type { RunTurnAttachment } from "../../kestrel/contracts/orchestration.js";
import {
  cleanupMaterializedRunTurnAttachments,
  materializeRunTurnAttachments,
} from "./materialize.js";
import {
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILENAME,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_MEDIA_TYPE,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID,
} from "@kestrel-agents/protocol";

type DeploymentCanaryDependencies = {
  fetchImpl: typeof fetch;
  materialize: typeof materializeRunTurnAttachments;
  cleanup: typeof cleanupMaterializedRunTurnAttachments;
};

const defaultDependencies: DeploymentCanaryDependencies = {
  fetchImpl: fetch,
  materialize: materializeRunTurnAttachments,
  cleanup: cleanupMaterializedRunTurnAttachments,
};

export async function runTurnAttachmentDeploymentCanary(
  input: { appUrl: string; privateKey: string },
  dependencies: DeploymentCanaryDependencies = defaultDependencies,
) {
  const now = Math.floor(Date.now() / 1000);
  const ticket: TurnAttachmentResolutionTicket = {
    version: 1,
    audience: "kestrel-turn-attachment-resolver",
    turnId: TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: randomUUID(),
  };
  const token = signTurnAttachmentResolutionTicket({
    ticket,
    privateKey: input.privateKey,
  });
  const response = await dependencies.fetchImpl(
    new URL(
      `/internal/turn-worker/${TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID}/attachments/resolve`,
      input.appUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "cache-control": "no-store",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => null) as {
    version?: unknown;
    turnId?: unknown;
    attachments?: unknown;
    error?: { code?: unknown };
  } | null;
  if (!response.ok) {
    const code = typeof body?.error?.code === "string"
      ? body.error.code
      : `HTTP_${response.status}`;
    throw new Error(`Attachment deployment canary resolver failed: ${code}.`);
  }
  const attachments = Array.isArray(body?.attachments) ? body.attachments : null;
  const attachment = attachments?.[0] as Record<string, unknown> | undefined;
  if (
    body?.version !== 1 ||
    body.turnId !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID ||
    attachments?.length !== 1 ||
    !attachment ||
    attachment.fileId !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID ||
    attachment.attachmentId !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID ||
    attachment.filename !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILENAME ||
    attachment.mimeType !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_MEDIA_TYPE ||
    attachment.sha256 !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256 ||
    typeof attachment.sizeBytes !== "number" ||
    typeof attachment.sourceUrl !== "string" ||
    typeof attachment.sourceUrlExpiresAt !== "string" ||
    Date.parse(attachment.sourceUrlExpiresAt) <= Date.now()
  ) {
    throw new Error("Attachment deployment canary resolver returned an invalid contract.");
  }

  let materialized: RunTurnAttachment[] | undefined;
  try {
    materialized = await dependencies.materialize([
      attachment as unknown as RunTurnAttachment,
    ]);
    const file = materialized?.[0];
    if (
      !file?.path ||
      file.sourceUrl !== undefined ||
      file.sourceUrlExpiresAt !== undefined
    ) {
      throw new Error("Attachment deployment canary did not materialize safely.");
    }
    const info = await stat(file.path);
    if (
      info.size !== attachment.sizeBytes ||
      (info.mode & 0o777) !== 0o400 ||
      file.sha256 !== TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256
    ) {
      throw new Error("Attachment deployment canary file evidence is invalid.");
    }
    return {
      ok: true as const,
      resolver: true as const,
      r2Download: true as const,
      materialized: true as const,
      readOnly: true as const,
      turnId: TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID,
      fileId: TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID,
      sizeBytes: info.size,
      sha256: file.sha256,
      buildId: process.env.KESTREL_BUILD_ID?.trim() || "unknown",
    };
  } finally {
    await dependencies.cleanup(materialized);
  }
}
