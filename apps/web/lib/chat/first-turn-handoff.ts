"use client";

import type { ChatFirstTurnHandoff } from "@/lib/types";
import { isKestrelOneInteractionMode } from "@/lib/turns/interaction-mode";

const HANDOFF_KEY_PREFIX = "chat:first-turn:";
const HANDOFF_TTL_MS = 60_000;

function getStorageKey(threadId: string) {
  return `${HANDOFF_KEY_PREFIX}${threadId}`;
}

function isValidRecord(value: unknown): value is ChatFirstTurnHandoff {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.threadId === "string" &&
    (candidate.projectId === undefined ||
      typeof candidate.projectId === "string") &&
    typeof candidate.messageId === "string" &&
    Array.isArray(candidate.messageParts) &&
    candidate.messageParts.every(
      (part) =>
        part && typeof part === "object" && typeof part.type === "string"
    ) &&
    typeof candidate.modelId === "string" &&
    isKestrelOneInteractionMode(candidate.interactionMode) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.pendingAssistant === "boolean"
  );
}

export function writeChatFirstTurnHandoff(record: ChatFirstTurnHandoff) {
  if (typeof window === "undefined") {
    return;
  }

  sessionStorage.setItem(
    getStorageKey(record.threadId),
    JSON.stringify(record)
  );
}

export function readChatFirstTurnHandoff(threadId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = sessionStorage.getItem(getStorageKey(threadId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidRecord(parsed)) {
      sessionStorage.removeItem(getStorageKey(threadId));
      return null;
    }

    if (Date.now() - parsed.createdAt > HANDOFF_TTL_MS) {
      sessionStorage.removeItem(getStorageKey(threadId));
      return null;
    }

    return parsed;
  } catch {
    sessionStorage.removeItem(getStorageKey(threadId));
    return null;
  }
}

export function clearChatFirstTurnHandoff(threadId: string) {
  if (typeof window === "undefined") {
    return;
  }

  sessionStorage.removeItem(getStorageKey(threadId));
}
