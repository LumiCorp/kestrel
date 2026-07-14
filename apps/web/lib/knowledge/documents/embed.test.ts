import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "./constants";
import { embedKnowledgeTexts } from "./embed";

function openRouterEnv() {
  return {
    AI_PROVIDER: "openrouter",
    AI_AGENT_BASE_URL: "https://openrouter.ai/api/v1",
    AI_AGENT_API_KEY: "openrouter-key",
    AI_AGENT_SITE_URL: "https://kestrel.example.test",
    AI_AGENT_SITE_NAME: "Kestrel One",
  } as unknown as NodeJS.ProcessEnv;
}

function embeddingVector() {
  return Array.from({ length: KNOWLEDGE_EMBEDDING_DIMENSIONS }, (_, index) =>
    index === 0 ? 3 : index === 1 ? 4 : 0
  );
}

test("embedKnowledgeTexts uses the inherited OpenRouter credential and strict dimensions", async () => {
  let requestURL = "";
  let requestInit: RequestInit | undefined;
  const fetchEmbedding = async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    requestURL = String(input);
    requestInit = init;
    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: embeddingVector() }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const [embedding] = await embedKnowledgeTexts(["incident response steps"], {
    env: openRouterEnv(),
    fetch: fetchEmbedding,
  });

  assert.equal(requestURL, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(
    (requestInit?.headers as Record<string, string>).Authorization,
    "Bearer openrouter-key"
  );
  assert.equal(
    (requestInit?.headers as Record<string, string>)["HTTP-Referer"],
    "https://kestrel.example.test"
  );
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: "openai/text-embedding-3-small",
    input: ["incident response steps"],
    dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
    encoding_format: "float",
  });
  assert.equal(embedding?.length, KNOWLEDGE_EMBEDDING_DIMENSIONS);
  assert.equal(embedding?.[0], 0.6);
  assert.equal(embedding?.[1], 0.8);
});

test("embedKnowledgeTexts rejects malformed live vectors instead of padding them", async () => {
  const fetchEmbedding = async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            index: 0,
            embedding: Array.from(
              { length: KNOWLEDGE_EMBEDDING_DIMENSIONS - 1 },
              () => 0
            ),
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  await assert.rejects(
    embedKnowledgeTexts(["malformed"], {
      env: openRouterEnv(),
      fetch: fetchEmbedding,
    }),
    /must contain exactly 1536 dimensions/
  );
});

test("embedKnowledgeTexts exposes live provider failures", async () => {
  const fetchEmbedding = async () =>
    new Response("insufficient credits", { status: 402 });

  await assert.rejects(
    embedKnowledgeTexts(["provider failure"], {
      env: openRouterEnv(),
      fetch: fetchEmbedding,
    }),
    /Knowledge embedding request failed: insufficient credits/
  );
});
