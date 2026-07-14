import { createHash } from "node:crypto";
import {
  getDirectRuntimeConfig,
  warnIfPlaceholderRuntimeConfig,
} from "@/lib/ai/surface-policy";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "./constants";
import type { SemanticEmbeddingProvenance } from "./embedding-provenance";

const TRAILING_SLASHES_REGEX = /\/+$/;

type KnowledgeEmbeddingFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export function getKnowledgeEmbeddingRuntime(
  env: NodeJS.ProcessEnv = process.env
) {
  const config = getDirectRuntimeConfig("embedding", env);
  const retrievalStrategy =
    config.mode === "live" ? ("semantic-first" as const) : ("lexical" as const);
  const provenance: SemanticEmbeddingProvenance | null =
    retrievalStrategy === "semantic-first"
      ? {
          mode: "semantic",
          provider: config.provider,
          model: config.model,
          dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        }
      : null;

  return {
    ...config,
    provenance,
    retrievalStrategy,
  };
}

export function getKnowledgeEmbeddingMode(
  env: NodeJS.ProcessEnv = process.env
) {
  return getKnowledgeEmbeddingRuntime(env).mode;
}

function normalizeVector(values: number[]) {
  const magnitude =
    Math.hypot(
      ...values.map((value) => (Number.isFinite(value) ? value : 0))
    ) || 1;

  return values.map((value) => value / magnitude);
}

function validateEmbeddingVector(value: unknown, index: number) {
  if (
    !Array.isArray(value) ||
    value.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Knowledge embedding ${index} must contain exactly ${KNOWLEDGE_EMBEDDING_DIMENSIONS} dimensions`
    );
  }

  if (
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new Error(`Knowledge embedding ${index} contains a non-finite value`);
  }

  return normalizeVector(value);
}

function deterministicEmbedding(text: string) {
  const values: number[] = [];

  for (let index = 0; index < KNOWLEDGE_EMBEDDING_DIMENSIONS; index += 1) {
    const hash = createHash("sha256").update(`${index}:${text}`).digest();
    const signed = hash.readInt32BE(0) / 0x7f_ff_ff_ff;
    values.push(signed);
  }

  return normalizeVector(values);
}

export async function embedKnowledgeTexts(
  texts: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: KnowledgeEmbeddingFetch;
  } = {}
) {
  if (texts.length === 0) {
    return [];
  }

  const config = getKnowledgeEmbeddingRuntime(options.env);
  const fetchEmbedding = options.fetch ?? fetch;
  warnIfPlaceholderRuntimeConfig(config);

  if (config.mode === "fallback") {
    return texts.map(deterministicEmbedding);
  }

  const response = await fetchEmbedding(
    `${config.baseURL.replace(TRAILING_SLASHES_REGEX, "")}/embeddings`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Knowledge embedding request failed: ${await response
        .text()
        .catch(() => response.statusText)}`
    );
  }

  const json = (await response.json()) as {
    data?: Array<{ embedding?: unknown; index?: number }>;
  };

  const data = json.data ?? [];
  if (data.length !== texts.length) {
    throw new Error("Knowledge embedding response size mismatch");
  }

  const orderedData = data.every((entry) => Number.isInteger(entry.index))
    ? [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    : data;

  for (const [index, entry] of orderedData.entries()) {
    if (entry.index !== undefined && entry.index !== index) {
      throw new Error("Knowledge embedding response indices are invalid");
    }
  }

  return orderedData.map((entry, index) =>
    validateEmbeddingVector(entry.embedding, index)
  );
}
