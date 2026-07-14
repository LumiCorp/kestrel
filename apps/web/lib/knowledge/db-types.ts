import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type {
  agentConfig,
  aiGatewayModels,
  aiGateways,
  apiUsage,
  artifactDocuments,
  artifactSuggestions,
  discordGuildBindings,
  knowledgeDocumentChunks,
  knowledgeDocuments,
  knowledgeIngestionRuns,
  knowledgeSnapshots,
  knowledgeSyncRuns,
  mediaGenerationJobs,
  messageSpeechAssets,
  organizationToolCapabilities,
  organizationToolConnections,
  organizationToolProviders,
  projectContextRevisions,
  projectMembers,
  projects,
  sources,
  threadMessages,
  threadTurnEvents,
  threadTurnQueueState,
  threadTurns,
  threads,
  toolCapabilities,
  toolProviders,
  usageStats,
} from "@/drizzle/schema";

export type DbThread = InferSelectModel<typeof threads>;
export type NewDbThread = InferInsertModel<typeof threads>;

export type DbThreadMessage = InferSelectModel<typeof threadMessages>;
export type NewDbThreadMessage = InferInsertModel<typeof threadMessages>;

export type DbThreadTurn = InferSelectModel<typeof threadTurns>;
export type NewDbThreadTurn = InferInsertModel<typeof threadTurns>;
export type DbThreadTurnEvent = InferSelectModel<typeof threadTurnEvents>;
export type NewDbThreadTurnEvent = InferInsertModel<typeof threadTurnEvents>;
export type DbThreadTurnQueueState = InferSelectModel<
  typeof threadTurnQueueState
>;

export type DbProject = InferSelectModel<typeof projects>;
export type NewDbProject = InferInsertModel<typeof projects>;
export type DbProjectMember = InferSelectModel<typeof projectMembers>;
export type DbProjectContextRevision = InferSelectModel<
  typeof projectContextRevisions
>;

export type DbKnowledgeDocument = InferSelectModel<typeof knowledgeDocuments>;
export type NewDbKnowledgeDocument = InferInsertModel<
  typeof knowledgeDocuments
>;

export type DbKnowledgeIngestionRun = InferSelectModel<
  typeof knowledgeIngestionRuns
>;
export type NewDbKnowledgeIngestionRun = InferInsertModel<
  typeof knowledgeIngestionRuns
>;

export type DbKnowledgeDocumentChunk = InferSelectModel<
  typeof knowledgeDocumentChunks
>;
export type NewDbKnowledgeDocumentChunk = InferInsertModel<
  typeof knowledgeDocumentChunks
>;

export type DbSnapshot = InferSelectModel<typeof knowledgeSnapshots>;
export type NewDbSnapshot = InferInsertModel<typeof knowledgeSnapshots>;

export type DbSyncRun = InferSelectModel<typeof knowledgeSyncRuns>;
export type NewDbSyncRun = InferInsertModel<typeof knowledgeSyncRuns>;

export type DbSource = InferSelectModel<typeof sources>;
export type NewDbSource = InferInsertModel<typeof sources>;

export type DbToolProvider = InferSelectModel<typeof toolProviders>;
export type NewDbToolProvider = InferInsertModel<typeof toolProviders>;

export type DbToolCapability = InferSelectModel<typeof toolCapabilities>;
export type NewDbToolCapability = InferInsertModel<typeof toolCapabilities>;

export type DbOrganizationToolProvider = InferSelectModel<
  typeof organizationToolProviders
>;
export type NewDbOrganizationToolProvider = InferInsertModel<
  typeof organizationToolProviders
>;

export type DbOrganizationToolCapability = InferSelectModel<
  typeof organizationToolCapabilities
>;
export type NewDbOrganizationToolCapability = InferInsertModel<
  typeof organizationToolCapabilities
>;

export type DbOrganizationToolConnection = InferSelectModel<
  typeof organizationToolConnections
>;
export type NewDbOrganizationToolConnection = InferInsertModel<
  typeof organizationToolConnections
>;

export type DbDiscordGuildBinding = InferSelectModel<
  typeof discordGuildBindings
>;
export type NewDbDiscordGuildBinding = InferInsertModel<
  typeof discordGuildBindings
>;

export type DbAgentConfig = InferSelectModel<typeof agentConfig>;
export type NewDbAgentConfig = InferInsertModel<typeof agentConfig>;

export type DbAIGateway = InferSelectModel<typeof aiGateways>;
export type NewDbAIGateway = InferInsertModel<typeof aiGateways>;

export type DbAIGatewayModel = InferSelectModel<typeof aiGatewayModels>;
export type NewDbAIGatewayModel = InferInsertModel<typeof aiGatewayModels>;

export type DbApiUsage = InferSelectModel<typeof apiUsage>;
export type NewDbApiUsage = InferInsertModel<typeof apiUsage>;

export type DbUsageStat = InferSelectModel<typeof usageStats>;
export type NewDbUsageStat = InferInsertModel<typeof usageStats>;

export type DbArtifactDocument = InferSelectModel<typeof artifactDocuments>;
export type NewDbArtifactDocument = InferInsertModel<typeof artifactDocuments>;

export type DbArtifactSuggestion = InferSelectModel<typeof artifactSuggestions>;
export type NewDbArtifactSuggestion = InferInsertModel<
  typeof artifactSuggestions
>;

export type DbMessageSpeechAsset = InferSelectModel<typeof messageSpeechAssets>;
export type NewDbMessageSpeechAsset = InferInsertModel<
  typeof messageSpeechAssets
>;

export type DbMediaGenerationJob = InferSelectModel<typeof mediaGenerationJobs>;
export type NewDbMediaGenerationJob = InferInsertModel<
  typeof mediaGenerationJobs
>;
