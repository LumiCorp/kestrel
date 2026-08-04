export const ARTIFACT_KINDS = [
  "text",
  "code",
  "sheet",
  "image",
  "video",
] as const;

const ARTIFACT_RESULT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: [...ARTIFACT_KINDS] },
        content: { type: "string" },
      },
      required: ["id", "title", "kind", "content"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
      additionalProperties: false,
    },
  ],
};

const SUGGESTION_RESULT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: [...ARTIFACT_KINDS] },
        message: { type: "string" },
      },
      required: ["id", "title", "kind", "message"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
      additionalProperties: false,
    },
  ],
};

function createArtifactDescriptor(input: {
  toolId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  executionClass: "read_only" | "external_side_effect";
}) {
  return Object.freeze({
    version: "v1" as const,
    toolId: input.toolId,
    source: {
      kind: "builtin",
      sourceId: "kestrel-one.web.artifacts",
      protocolKind: "handler",
      protocolTarget: input.toolId,
    },
    description: input.description,
    inputSchema: input.inputSchema,
    runtimeOutput: { schema: input.outputSchema },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: input.executionClass,
      allowedInteractionModes: ["chat", "build"],
      capabilityClasses: ["artifact.document"],
      ...(input.executionClass === "external_side_effect"
        ? { approvalCapabilities: ["external.confirm" as const] }
        : {}),
    },
    presentation: {
      displayName: input.toolId,
      aliases: [input.toolId],
      keywords: ["artifact", "document"],
      provider: "kestrel-one",
      toolFamily: "artifact",
    },
    execution: {
      handlerId: `kestrel-one.web:${input.toolId}:v1`,
      resultNormalizerId: "kestrel-one.web:artifact-result:v1",
    },
  });
}

export const WEB_ARTIFACT_TOOL_DESCRIPTORS = Object.freeze([
  createArtifactDescriptor({
    toolId: "createDocument",
    description:
      "Create a document for a writing or content creation activities. This tool will call other functions that will generate the contents of the document based on the title and kind.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: [...ARTIFACT_KINDS] },
      },
      required: ["title", "kind"],
      additionalProperties: false,
    },
    outputSchema: ARTIFACT_RESULT_SCHEMA,
    executionClass: "external_side_effect",
  }),
  createArtifactDescriptor({
    toolId: "updateDocument",
    description: "Update a document with the given description.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ID of the document to update" },
        description: {
          type: "string",
          description: "The description of changes that need to be made",
        },
      },
      required: ["id", "description"],
      additionalProperties: false,
    },
    outputSchema: ARTIFACT_RESULT_SCHEMA,
    executionClass: "external_side_effect",
  }),
  createArtifactDescriptor({
    toolId: "requestSuggestions",
    description:
      "Request writing suggestions for an existing document artifact. Only use this when the user explicitly asks to improve or get suggestions for a document they have already created. Never use for general questions.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description:
            "The UUID of an existing document artifact that was previously created with createDocument",
        },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
    outputSchema: SUGGESTION_RESULT_SCHEMA,
    executionClass: "external_side_effect",
  }),
] as const);

const descriptorsByName = new Map(
  WEB_ARTIFACT_TOOL_DESCRIPTORS.map((descriptor) => [
    descriptor.toolId,
    descriptor,
  ]),
);

export const webArtifactToolDescriptorCatalog = Object.freeze({
  getDescriptor(toolId: string) {
    return descriptorsByName.get(toolId);
  },
});
