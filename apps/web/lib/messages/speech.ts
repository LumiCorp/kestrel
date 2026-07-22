import "server-only";

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { generateSpeechForModel } from "@/lib/ai/providers";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";
import { getThreadAccessForUser } from "@/lib/threads/store";

function sanitizeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function buildSpeechStorageKey(input: {
  userId: string;
  messageId: string;
  modelId: string;
  voice: string;
}) {
  const storage = getStorageAdapter();
  return storage.buildObjectKey(
    "message-speech",
    sanitizeSegment(input.userId),
    sanitizeSegment(input.messageId),
    `${sanitizeSegment(input.modelId)}-${sanitizeSegment(input.voice)}.mp3`
  );
}

export async function getPlayableAssistantMessage(input: {
  messageId: string;
  userId: string;
  organizationId: string;
}) {
  const [message] = await knowledgeDb
    .select({
      message: schema.threadMessages,
    })
    .from(schema.threadMessages)
    .where(eq(schema.threadMessages.id, input.messageId))
    .limit(1);

  const access = message
    ? await getThreadAccessForUser(
        message.message.threadId,
        input.userId,
        input.organizationId,
        true
      )
    : null;

  if (!(message && access) || message.message.role !== "assistant") {
    return null;
  }

  const parts = Array.isArray(message.message.parts)
    ? (message.message.parts as Array<Record<string, unknown>>)
    : [];

  const text = parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");

  if (!text) {
    return null;
  }

  return {
    message: message.message,
    text,
  };
}

export async function getOrCreateMessageSpeechAsset(input: {
  messageId: string;
  userId: string;
  organizationId: string;
  modelId?: string | null;
  voice?: string | null;
}) {
  const playable = await getPlayableAssistantMessage(input);

  if (!playable) {
    return null;
  }

  const voice = input.voice?.trim() || "alloy";
  const textHash = createHash("sha256").update(playable.text).digest("hex");

  const existing = await knowledgeDb.query.messageSpeechAssets.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.messageId, input.messageId),
        operators.eq(table.voice, voice),
        operators.eq(table.textHash, textHash),
        operators.eq(table.status, "ready")
      ),
    orderBy: (table, operators) => [operators.desc(table.updatedAt)],
  });

  if (existing) {
    return existing;
  }

  const speech = await generateSpeechForModel({
    organizationId: input.organizationId,
    modelId: input.modelId,
    text: playable.text,
    voice,
  });

  if (!speech) {
    return null;
  }

  const storageKey = buildSpeechStorageKey({
    userId: input.userId,
    messageId: input.messageId,
    modelId: speech.resolvedModelId,
    voice,
  });
  const storage = getStorageAdapter();

  await storage.putObject({
    key: storageKey,
    body: Buffer.from(speech.audio.uint8Array),
    contentType: speech.audio.mediaType,
  });

  const [asset] = await knowledgeDb
    .insert(schema.messageSpeechAssets)
    .values({
      id: crypto.randomUUID(),
      messageId: input.messageId,
      modelId: speech.resolvedModelId,
      voice,
      textHash,
      storageKey,
      mediaType: speech.audio.mediaType,
      status: "ready",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.messageSpeechAssets.messageId,
        schema.messageSpeechAssets.modelId,
        schema.messageSpeechAssets.voice,
        schema.messageSpeechAssets.textHash,
      ],
      set: {
        storageKey,
        mediaType: speech.audio.mediaType,
        status: "ready",
        error: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return asset;
}

export async function getMessageSpeechAssetForUser(input: {
  assetId: string;
  messageId: string;
  userId: string;
  organizationId: string;
}) {
  const asset = await knowledgeDb.query.messageSpeechAssets.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, input.assetId),
        operators.eq(table.messageId, input.messageId)
      ),
  });

  if (!asset) {
    return null;
  }

  const playable = await getPlayableAssistantMessage(input);

  if (!playable) {
    return null;
  }

  return asset;
}
