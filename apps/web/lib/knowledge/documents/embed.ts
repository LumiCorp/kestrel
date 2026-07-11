import { createHash } from "node:crypto";
import {
  getDirectRuntimeConfig,
  warnIfPlaceholderRuntimeConfig,
} from "@/lib/ai/surface-policy";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "./constants";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const TRAILING_SLASHES_REGEX = /\/+$/;

export function getKnowledgeEmbeddingRuntime(
  env: NodeJS.ProcessEnv = process.env
) {
  const config = getDirectRuntimeConfig("embedding", env);
  const supportsVectorSearch = config.provider !== "openrouter";

  return {
    ...config,
    retrievalStrategy:
      config.mode === "live" && supportsVectorSearch ? "vector" : "lexical",
    model: config.model || DEFAULT_EMBEDDING_MODEL,
  };
}

export function getKnowledgeEmbeddingMode(
  env: NodeJS.ProcessEnv = process.env
) {
  return getKnowledgeEmbeddingRuntime(env).mode;
}

function normalizeVectorDimensions(values: number[]) {
  const next = values.slice(0, KNOWLEDGE_EMBEDDING_DIMENSIONS);
  while (next.length < KNOWLEDGE_EMBEDDING_DIMENSIONS) {
    next.push(0);
  }

  const magnitude =
    Math.hypot(...next.map((value) => (Number.isFinite(value) ? value : 0))) ||
    1;

  return next.map((value) => value / magnitude);
}

function deterministicEmbedding(text: string) {
  const values: number[] = [];

  for (let index = 0; index < KNOWLEDGE_EMBEDDING_DIMENSIONS; index += 1) {
    const hash = createHash("sha256").update(`${index}:${text}`).digest();
    const signed = hash.readInt32BE(0) / 0x7f_ff_ff_ff;
    values.push(signed);
  }

  return normalizeVectorDimensions(values);
}

export async function embedKnowledgeTexts(texts: string[]) {
  if (texts.length === 0) {
    return [];
  }

  const config = getKnowledgeEmbeddingRuntime();
  warnIfPlaceholderRuntimeConfig(config);

  if (config.mode === "fallback") {
    return texts.map(deterministicEmbedding);
  }

  try {
    const response = await fetch(
      `${config.baseURL.replace(TRAILING_SLASHES_REGEX, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          ...config.headers,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_EMBEDDING_MODEL,
          input: texts,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(await response.text().catch(() => response.statusText));
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error("Knowledge embedding response size mismatch");
    }

    return data.map((entry) =>
      normalizeVectorDimensions(entry.embedding ?? [])
    );
  } catch {
    return texts.map(deterministicEmbedding);
  }
}
