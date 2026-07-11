"use client";

import type { ChatFirstTurnHandoff } from "@/lib/types";

const HANDOFF_KEY_PREFIX = "chat:first-turn:";
const HANDOFF_TTL_MS = 60_000;

function getStorageKey(chatId: string) {
  return `${HANDOFF_KEY_PREFIX}${chatId}`;
}

function isValidRecord(value: unknown): value is ChatFirstTurnHandoff {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.chatId === "string" &&
    typeof candidate.messageId === "string" &&
    Array.isArray(candidate.messageParts) &&
    candidate.messageParts.every(
      (part) =>
        part && typeof part === "object" && typeof part.type === "string"
    ) &&
    typeof candidate.modelId === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.pendingAssistant === "boolean"
  );
}

export function writeChatFirstTurnHandoff(record: ChatFirstTurnHandoff) {
  if (typeof window === "undefined") {
    return;
  }

  sessionStorage.setItem(getStorageKey(record.chatId), JSON.stringify(record));
}

export function readChatFirstTurnHandoff(chatId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = sessionStorage.getItem(getStorageKey(chatId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidRecord(parsed)) {
      sessionStorage.removeItem(getStorageKey(chatId));
      return null;
    }

    if (Date.now() - parsed.createdAt > HANDOFF_TTL_MS) {
      sessionStorage.removeItem(getStorageKey(chatId));
      return null;
    }

    return parsed;
  } catch {
    sessionStorage.removeItem(getStorageKey(chatId));
    return null;
  }
}

export function clearChatFirstTurnHandoff(chatId: string) {
  if (typeof window === "undefined") {
    return;
  }

  sessionStorage.removeItem(getStorageKey(chatId));
}
