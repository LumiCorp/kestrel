import "server-only";

import { after } from "next/server";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";

let resumableStreamContext: ResumableStreamContext | null = null;

export function isChatResumableStreamConfigured() {
  return Boolean(process.env.REDIS_URL || process.env.KV_URL);
}

export function getChatResumableStreamContext() {
  if (!isChatResumableStreamConfigured()) {
    return null;
  }

  if (!resumableStreamContext) {
    resumableStreamContext = createResumableStreamContext({
      keyPrefix: "chat-ui-stream",
      waitUntil: after,
    });
  }

  return resumableStreamContext;
}

export async function ensureChatResumableStreamAvailable() {
  const context = getChatResumableStreamContext();
  if (!context) {
    return false;
  }

  try {
    await context.hasExistingStream("__chat-resume-healthcheck__");
    return true;
  } catch {
    return false;
  }
}
