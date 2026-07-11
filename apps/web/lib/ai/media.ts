import "server-only";

import { and, eq } from "drizzle-orm";
import {
  type GatewayProvider,
  getResolvedGatewayExecutionModel,
} from "@/lib/ai/gateways";
import { generateImageForModel } from "@/lib/ai/providers";
import { saveArtifactDocument } from "@/lib/artifacts/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

type CreateMediaJobInput = {
  organizationId: string;
  userId: string;
  chatId?: string | null;
  kind: "image" | "video";
  prompt: string;
  modelId: string;
};

function getReplicateApiToken(apiKey: string | null) {
  return apiKey || process.env.REPLICATE_API_TOKEN?.trim() || null;
}

function getGatewayApiKey(gateway: {
  apiKey: string | null;
  apiKeyEnvVar: string | null;
  provider: GatewayProvider;
}) {
  if (gateway.apiKey?.trim()) {
    return gateway.apiKey.trim();
  }

  if (gateway.apiKeyEnvVar?.trim()) {
    return process.env[gateway.apiKeyEnvVar.trim()]?.trim() || null;
  }

  return gateway.provider === "replicate"
    ? process.env.REPLICATE_API_TOKEN?.trim() || null
    : null;
}

async function createReplicatePrediction(input: {
  gateway: {
    apiKey: string | null;
    apiKeyEnvVar: string | null;
    baseUrl: string | null;
    provider: GatewayProvider;
  };
  modelId: string;
  prompt: string;
}) {
  const token = getReplicateApiToken(getGatewayApiKey(input.gateway));

  if (!token) {
    throw new Error("Replicate API token is not configured for this gateway.");
  }

  const baseUrl = input.gateway.baseUrl?.trim() || "https://api.replicate.com";
  const response = await fetch(
    `${baseUrl}/v1/models/${input.modelId}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          prompt: input.prompt,
        },
      }),
    }
  );

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (json as { detail?: string }).detail ||
        "Replicate prediction creation failed."
    );
  }

  return json as {
    id: string;
    status: string;
    output?: string[] | string | null;
  };
}

async function pollReplicatePrediction(input: {
  gateway: {
    apiKey: string | null;
    apiKeyEnvVar: string | null;
    baseUrl: string | null;
    provider: GatewayProvider;
  };
  providerJobId: string;
}) {
  const token = getReplicateApiToken(getGatewayApiKey(input.gateway));

  if (!token) {
    throw new Error("Replicate API token is not configured for this gateway.");
  }

  const baseUrl = input.gateway.baseUrl?.trim() || "https://api.replicate.com";
  const response = await fetch(
    `${baseUrl}/v1/predictions/${input.providerJobId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (json as { detail?: string }).detail ||
        "Replicate prediction polling failed."
    );
  }
  return json as {
    id: string;
    status: string;
    output?: string[] | string | null;
    error?: string | null;
  };
}

function getPredictionOutputUrl(output?: string[] | string | null) {
  if (Array.isArray(output)) {
    return output[0] || null;
  }

  return typeof output === "string" ? output : null;
}

async function materializeCompletedJob(
  job: typeof schema.mediaGenerationJobs.$inferSelect
) {
  if (!(job.outputUrl && job.artifactId)) {
    return job;
  }

  const existingArtifact = await knowledgeDb.query.artifactDocuments.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, job.artifactId!),
        operators.eq(table.userId, job.userId),
        operators.eq(table.organizationId, job.organizationId)
      ),
  });

  if (!existingArtifact) {
    await saveArtifactDocument({
      id: job.artifactId,
      title: job.kind === "image" ? "Generated image" : "Generated video",
      kind: job.kind,
      content: job.outputUrl,
      userId: job.userId,
      organizationId: job.organizationId,
      chatId: job.chatId,
    });
  }

  return job;
}

export async function createMediaGenerationJob(input: CreateMediaJobInput) {
  const resolved = await getResolvedGatewayExecutionModel({
    selection: input.modelId,
    modality: input.kind,
  });

  if (!resolved) {
    throw new Error(`No approved ${input.kind} model is configured.`);
  }

  const artifactId = crypto.randomUUID();

  if (resolved.gateway.provider !== "replicate" && input.kind === "image") {
    const generated = await generateImageForModel({
      modelId: input.modelId,
      prompt: input.prompt,
      size: "1024x1024",
    });

    if (!generated) {
      throw new Error("Image generation is not available for this model.");
    }

    const content =
      generated.image.base64?.length > 0
        ? `data:${generated.image.mediaType};base64,${generated.image.base64}`
        : generated.image.uint8Array?.length > 0
          ? `data:${generated.image.mediaType};base64,${Buffer.from(generated.image.uint8Array).toString("base64")}`
          : null;

    if (!content) {
      throw new Error("Image generation returned no usable image payload.");
    }

    await saveArtifactDocument({
      id: artifactId,
      title: "Generated image",
      kind: "image",
      content,
      userId: input.userId,
      organizationId: input.organizationId,
      chatId: input.chatId,
    });

    const [job] = await knowledgeDb
      .insert(schema.mediaGenerationJobs)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        userId: input.userId,
        chatId: input.chatId ?? null,
        artifactId,
        kind: input.kind,
        gatewayId: resolved.gateway.id,
        modelId: resolved.model.id,
        prompt: input.prompt,
        status: "succeeded",
        outputUrl: content,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return job;
  }

  if (resolved.gateway.provider !== "replicate") {
    throw new Error(
      `${resolved.gateway.displayName} does not support ${input.kind} generation in this runtime.`
    );
  }

  const prediction = await createReplicatePrediction({
    gateway: resolved.gateway,
    modelId: resolved.model.rawModelId,
    prompt: input.prompt,
  });

  const outputUrl = getPredictionOutputUrl(prediction.output);
  const terminalStatus =
    prediction.status === "succeeded" ? "succeeded" : "processing";

  const [job] = await knowledgeDb
    .insert(schema.mediaGenerationJobs)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      chatId: input.chatId ?? null,
      artifactId,
      kind: input.kind,
      gatewayId: resolved.gateway.id,
      modelId: resolved.model.id,
      prompt: input.prompt,
      status: terminalStatus,
      providerJobId: prediction.id,
      outputUrl,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  if (job.status === "succeeded") {
    await materializeCompletedJob(job);
  }

  return job;
}

export async function getMediaGenerationJobForUser(input: {
  jobId: string;
  organizationId: string;
  userId: string;
}) {
  const job = await knowledgeDb.query.mediaGenerationJobs.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, input.jobId),
        operators.eq(table.organizationId, input.organizationId),
        operators.eq(table.userId, input.userId)
      ),
  });

  if (!job) {
    return null;
  }

  if (
    job.providerJobId &&
    job.gatewayId &&
    (job.status === "queued" || job.status === "processing")
  ) {
    const gateway = await knowledgeDb.query.aiGateways.findFirst({
      where: (table, operators) => operators.eq(table.id, job.gatewayId!),
    });

    if (gateway?.provider === "replicate") {
      const prediction = await pollReplicatePrediction({
        gateway,
        providerJobId: job.providerJobId,
      });
      const nextStatus =
        prediction.status === "succeeded"
          ? "succeeded"
          : prediction.status === "failed" || prediction.status === "canceled"
            ? "failed"
            : "processing";
      const outputUrl = getPredictionOutputUrl(prediction.output);
      const [updated] = await knowledgeDb
        .update(schema.mediaGenerationJobs)
        .set({
          status: nextStatus,
          outputUrl: outputUrl ?? job.outputUrl,
          error: prediction.error ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.mediaGenerationJobs.id, input.jobId),
            eq(schema.mediaGenerationJobs.organizationId, input.organizationId)
          )
        )
        .returning();

      if (updated?.status === "succeeded") {
        await materializeCompletedJob(updated);
      }

      return updated ?? job;
    }
  }

  return job;
}
