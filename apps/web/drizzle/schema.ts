// Better Auth schema definitions for Drizzle ORM
// These tables are managed by Better Auth, but defining them here gives us:
// - Better TypeScript type inference
// - Type-safe queries with Drizzle query builder
// - Better IDE autocomplete
//
// Note: These tables are filtered out in drizzle.config.ts so migrations
// won't be generated for them. They're managed by Better Auth itself.

import { type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "@/lib/knowledge/documents/constants";

/** =========================
 *  Better Auth Tables
 *  ========================= */

/** =========================
 *  user
 *  ========================= */
export const users = pgTable("user", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  twoFactorEnabled: boolean("twoFactorEnabled"),
  role: text("role"),
  banned: boolean("banned"),
  banReason: text("banReason"),
  banExpires: timestamp("banExpires", { withTimezone: true }),
  stripeCustomerId: text("stripeCustomerId"),
});

/** =========================
 *  session
 *  ========================= */
export const sessions = pgTable("session", {
  id: text("id").primaryKey().notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  activeOrganizationId: text("activeOrganizationId"),
  impersonatedBy: text("impersonatedBy"),
});

/** =========================
 *  apikey
 *  ========================= */
export const apiKeys = pgTable(
  "apikey",
  {
    id: text("id").primaryKey().notNull(),
    configId: text("configId").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("referenceId").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    userId: text("userId").references(() => users.id, { onDelete: "cascade" }),
    refillInterval: integer("refillInterval"),
    refillAmount: integer("refillAmount"),
    lastRefillAt: timestamp("lastRefillAt", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rateLimitEnabled").default(true),
    rateLimitTimeWindow: integer("rateLimitTimeWindow"),
    rateLimitMax: integer("rateLimitMax"),
    requestCount: integer("requestCount"),
    remaining: integer("remaining"),
    lastRequest: timestamp("lastRequest", { withTimezone: true }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    permissions: text("permissions"),
    metadata: text("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_user_id_idx").on(table.userId),
    index("apikey_key_idx").on(table.key),
  ]
);

/** =========================
 *  account
 *  ========================= */
export const accounts = pgTable("account", {
  id: text("id").primaryKey().notNull(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

/** =========================
 *  verification
 *  ========================= */
export const verifications = pgTable("verification", {
  id: text("id").primaryKey().notNull(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** =========================
 *  organization
 *  ========================= */
export const organizations = pgTable("organization", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  metadata: text("metadata"),
  stripeCustomerId: text("stripeCustomerId"),
});

/** =========================
 *  member
 *  ========================= */
export const members = pgTable("member", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

/** =========================
 *  Hosted Projects
 *  ========================= */

export const projects = pgTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    currentContextRevision: integer("current_context_revision")
      .notNull()
      .default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("projects_org_id_idx").on(table.organizationId),
    index("projects_created_by_user_id_idx").on(table.createdByUserId),
    index("projects_updated_at_idx").on(table.updatedAt),
    index("projects_archived_at_idx").on(table.archivedAt),
  ]
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationMemberId: text("organization_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "editor", "member"] })
      .notNull()
      .default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.organizationMemberId] }),
    index("project_members_member_id_idx").on(table.organizationMemberId),
    index("project_members_role_idx").on(table.projectId, table.role),
  ]
);

export const projectContextRevisions = pgTable(
  "project_context_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    projectName: text("project_name").notNull(),
    instructions: text("instructions").notNull().default(""),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_context_revisions_project_revision_idx").on(
      table.projectId,
      table.revision
    ),
    index("project_context_revisions_created_by_idx").on(table.createdByUserId),
  ]
);

export const projectAuditEvents = pgTable(
  "project_audit_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("project_audit_events_project_created_at_idx").on(
      table.projectId,
      table.createdAt
    ),
    index("project_audit_events_actor_idx").on(table.actorUserId),
  ]
);

/** =========================
 *  invitation
 *  ========================= */
export const invitations = pgTable("invitation", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  inviterId: text("inviterId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

/** =========================
 *  twoFactor
 *  ========================= */
export const twoFactors = pgTable("twoFactor", {
  id: text("id").primaryKey().notNull(),
  secret: text("secret").notNull(),
  backupCodes: text("backupCodes").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

/** =========================
 *  passkey
 *  ========================= */
export const passkeys = pgTable("passkey", {
  id: text("id").primaryKey().notNull(),
  name: text("name"),
  publicKey: text("publicKey").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialID: text("credentialID").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("deviceType").notNull(),
  backedUp: boolean("backedUp").notNull(),
  transports: text("transports"),
  createdAt: timestamp("createdAt", { withTimezone: true }),
  aaguid: text("aaguid"),
});

/** =========================
 *  subscription
 *  ========================= */
export const subscriptions = pgTable("subscription", {
  id: text("id").primaryKey().notNull(),
  plan: text("plan").notNull(),
  referenceId: text("referenceId").notNull(),
  stripeCustomerId: text("stripeCustomerId"),
  stripeSubscriptionId: text("stripeSubscriptionId"),
  status: text("status").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .defaultNow()
    .notNull(),
  periodStart: timestamp("periodStart", { withTimezone: true }),
  periodEnd: timestamp("periodEnd", { withTimezone: true }),
  trialStart: timestamp("trialStart", { withTimezone: true }),
  trialEnd: timestamp("trialEnd", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd"),
  cancelAt: timestamp("cancelAt", { withTimezone: true }),
  canceledAt: timestamp("canceledAt", { withTimezone: true }),
  endedAt: timestamp("endedAt", { withTimezone: true }),
  seats: integer("seats"),
  billingInterval: text("billingInterval"),
  stripeScheduleId: text("stripeScheduleId"),
  limits: jsonb("limits"),
});

/** =========================
 *  Knowledge/Agent Tables
 *  ========================= */

const knowledgeTimestamps = {
  createdAt: timestamp("created_at").notNull().defaultNow(),
};

const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    if (!config) {
      throw new Error("vector dimensions config is required");
    }
    return `vector(${config.dimensions})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    const trimmed = value.trim();
    if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      return [];
    }

    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
  },
});

export const threads = pgTable(
  "threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    origin: text("origin", {
      enum: ["web", "github", "discord", "api"],
    })
      .notNull()
      .default("web"),
    externalThreadId: text("external_thread_id"),
    mode: text("mode", { enum: ["chat", "admin"] })
      .notNull()
      .default("chat"),
    activeStreamId: text("active_stream_id"),
    isPublic: boolean("is_public").notNull().default(false),
    shareToken: text("share_token"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("threads_created_by_user_id_idx").on(table.createdByUserId),
    index("threads_org_id_idx").on(table.organizationId),
    index("threads_project_id_idx").on(table.projectId),
    index("threads_origin_idx").on(table.origin),
    index("threads_external_thread_id_idx").on(table.externalThreadId),
    index("threads_updated_at_idx").on(table.updatedAt),
    index("threads_archived_at_idx").on(table.archivedAt),
    uniqueIndex("threads_share_token_idx").on(table.shareToken),
  ]
);

export const threadMessages = pgTable(
  "thread_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    projectContextRevisionId: text("project_context_revision_id").references(
      () => projectContextRevisions.id,
      { onDelete: "set null" }
    ),
    parts: jsonb("parts"),
    searchText: text("search_text").notNull().default(""),
    feedback: text("feedback", { enum: ["positive", "negative"] }),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    externalMessageId: text("external_message_id"),
    source: text("source", { enum: ["web", "api", "github", "discord"] })
      .notNull()
      .default("web"),
    ...knowledgeTimestamps,
  },
  (table) => [
    index("thread_messages_thread_id_idx").on(table.threadId),
    index("thread_messages_author_user_id_idx").on(table.authorUserId),
    index("thread_messages_context_revision_idx").on(
      table.projectContextRevisionId
    ),
    index("thread_messages_created_at_idx").on(table.createdAt),
    uniqueIndex("thread_messages_external_message_idx").on(
      table.threadId,
      table.externalMessageId
    ),
  ]
);

export const sources = pgTable(
  "sources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["github", "youtube"] }).notNull(),
    label: text("label").notNull(),
    basePath: text("base_path").default("/docs"),
    repo: text("repo"),
    branch: text("branch"),
    contentPath: text("content_path"),
    outputPath: text("output_path"),
    readmeOnly: boolean("readme_only").default(false),
    channelId: text("channel_id"),
    handle: text("handle"),
    maxVideos: integer("max_videos").default(50),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("knowledge_sources_type_idx").on(table.type),
    index("knowledge_sources_org_id_idx").on(table.organizationId),
  ]
);

export const discordGuildBindings = pgTable(
  "discord_guild_bindings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    guildId: text("guild_id").notNull(),
    guildName: text("guild_name"),
    enabled: boolean("enabled").notNull().default(true),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
    lastGatewayStartedAt: timestamp("last_gateway_started_at", {
      withTimezone: true,
    }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("discord_guild_bindings_guild_id_idx").on(table.guildId),
    index("discord_guild_bindings_enabled_idx").on(table.enabled),
  ]
);

export const toolProviders = pgTable(
  "tool_providers",
  {
    key: text("key").primaryKey(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    type: text("type", {
      enum: [
        "built_in",
        "oauth",
        "api_key",
        "inbound_adapter",
        "source_connector",
        "custom_imported",
      ],
    }).notNull(),
    authType: text("auth_type", {
      enum: ["system", "oauth", "api_key", "env", "none"],
    })
      .notNull()
      .default("none"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tool_providers_type_idx").on(table.type),
    index("tool_providers_auth_type_idx").on(table.authType),
  ]
);

export const toolCapabilities = pgTable(
  "tool_capabilities",
  {
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "cascade" }),
    key: text("key").notNull(),
    runtimeName: text("runtime_name"),
    displayName: text("display_name").notNull(),
    description: text("description"),
    accessMode: text("access_mode", {
      enum: ["read", "write", "status", "internal"],
    }).notNull(),
    defaultEnabled: boolean("default_enabled").notNull().default(true),
    defaultApprovalMode: text("default_approval_mode", {
      enum: ["auto", "ask", "deny"],
    })
      .notNull()
      .default("auto"),
    defaultSurfaceAccess: jsonb("default_surface_access")
      .$type<{ chat: boolean; admin: boolean }>()
      .notNull()
      .default({ chat: true, admin: false }),
    defaultRateLimitMode: text("default_rate_limit_mode", {
      enum: ["default", "strict", "off"],
    })
      .notNull()
      .default("default"),
    defaultLoggingMode: text("default_logging_mode", {
      enum: ["full", "metadata_only", "minimal"],
    })
      .notNull()
      .default("full"),
    defaultSettings: jsonb("default_settings").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.providerKey, table.key] }),
    index("tool_capabilities_provider_idx").on(table.providerKey),
    index("tool_capabilities_runtime_name_idx").on(table.runtimeName),
    index("tool_capabilities_access_mode_idx").on(table.accessMode),
  ]
);

export const organizationToolProviders = pgTable(
  "organization_tool_providers",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.providerKey] }),
    index("organization_tool_providers_provider_idx").on(table.providerKey),
  ]
);

export const organizationToolCapabilities = pgTable(
  "organization_tool_capabilities",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    approvalMode: text("approval_mode", {
      enum: ["auto", "ask", "deny"],
    })
      .notNull()
      .default("auto"),
    surfaceAccess: jsonb("surface_access")
      .$type<{ chat: boolean; admin: boolean }>()
      .notNull()
      .default({ chat: true, admin: false }),
    rateLimitMode: text("rate_limit_mode", {
      enum: ["default", "strict", "off"],
    })
      .notNull()
      .default("default"),
    loggingMode: text("logging_mode", {
      enum: ["full", "metadata_only", "minimal"],
    })
      .notNull()
      .default("full"),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.providerKey, table.capabilityKey],
    }),
    foreignKey({
      columns: [table.providerKey, table.capabilityKey],
      foreignColumns: [toolCapabilities.providerKey, toolCapabilities.key],
      name: "organization_tool_capabilities_capability_fk",
    }).onDelete("cascade"),
    index("organization_tool_capabilities_provider_idx").on(table.providerKey),
  ]
);

export const organizationToolConnections = pgTable(
  "organization_tool_connections",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "cascade" }),
    authSource: text("auth_source", {
      enum: ["system", "oauth", "api_key", "env", "none"],
    }).notNull(),
    status: text("status", {
      enum: ["connected", "not_configured", "env_backed", "degraded"],
    })
      .notNull()
      .default("not_configured"),
    accountId: text("account_id"),
    credentialRef: text("credential_ref"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.providerKey] }),
    index("organization_tool_connections_status_idx").on(table.status),
  ]
);

export const agentConfig = pgTable("agent_config", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("default"),
  additionalPrompt: text("additional_prompt"),
  responseStyle: text("response_style", {
    enum: ["concise", "detailed", "technical", "friendly"],
  }).default("concise"),
  language: text("language").default("en"),
  defaultModel: text("default_model"),
  maxStepsMultiplier: real("max_steps_multiplier").default(1.0),
  temperature: real("temperature").default(0.7),
  searchInstructions: text("search_instructions"),
  citationFormat: text("citation_format", {
    enum: ["inline", "footnote", "none"],
  }).default("inline"),
  isActive: boolean("is_active").notNull().default(true),
  ...knowledgeTimestamps,
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const aiProviderConnections = pgTable(
  "ai_provider_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    provider: text("provider", { enum: ["runpod"] }).notNull(),
    scope: text("scope", { enum: ["platform"] })
      .notNull()
      .default("platform"),
    displayName: text("display_name").notNull(),
    apiKeyEnvVar: text("api_key_env_var"),
    apiKey: text("api_key"),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status", {
      enum: ["not_configured", "ready", "degraded"],
    })
      .notNull()
      .default("not_configured"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_provider_connections_provider_scope_idx").on(
      table.provider,
      table.scope
    ),
  ]
);

export const aiDeploymentProfiles = pgTable(
  "ai_deployment_profiles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    profileKey: text("profile_key").notNull(),
    version: integer("version").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    provider: text("provider", { enum: ["runpod"] }).notNull(),
    status: text("status", {
      enum: ["draft", "qualifying", "active", "deprecated"],
    })
      .notNull()
      .default("draft"),
    imageRef: text("image_ref").notNull(),
    expectedModelId: text("expected_model_id").notNull(),
    specHash: text("spec_hash").notNull(),
    templateSpec: jsonb("template_spec").notNull(),
    endpointSpec: jsonb("endpoint_spec").notNull(),
    costLimitUsdPerHour: real("cost_limit_usd_per_hour").notNull(),
    qualificationEvidence: jsonb("qualification_evidence"),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    activatedByUserId: text("activated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_deployment_profiles_key_version_idx").on(
      table.profileKey,
      table.version
    ),
    uniqueIndex("ai_deployment_profiles_spec_hash_idx").on(table.specHash),
    index("ai_deployment_profiles_status_idx").on(table.status),
  ]
);

export const organizationAiDeploymentPolicies = pgTable(
  "organization_ai_deployment_policies",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    maxActiveDeployments: integer("max_active_deployments")
      .notNull()
      .default(0),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  }
);

export const organizationAiDeploymentEntitlements = pgTable(
  "organization_ai_deployment_entitlements",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_ai_deployment_entitlements_user_idx").on(table.userId),
  ]
);

export const aiGateways = pgTable(
  "ai_gateways",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    deploymentId: text("deployment_id"),
    providerConnectionId: text("provider_connection_id").references(
      () => aiProviderConnections.id,
      { onDelete: "restrict" }
    ),
    provider: text("provider", {
      enum: [
        "anthropic",
        "lumi",
        "openai",
        "openrouter",
        "ollama",
        "runpod",
        "replicate",
      ],
    }).notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url"),
    apiKeyEnvVar: text("api_key_env_var"),
    apiKey: text("api_key"),
    enabled: boolean("enabled").notNull().default(true),
    supportedModalities: jsonb("supported_modalities")
      .$type<Array<"language" | "image" | "speech" | "video" | "embedding">>()
      .notNull()
      .default(["language"] as Array<
        "language" | "image" | "speech" | "video" | "embedding"
      >),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_gateways_deployment_id_idx").on(table.deploymentId),
    uniqueIndex("ai_gateways_global_provider_display_name_idx")
      .on(table.provider, table.displayName)
      .where(sql`${table.organizationId} IS NULL`),
    uniqueIndex("ai_gateways_org_provider_display_name_idx")
      .on(table.organizationId, table.provider, table.displayName)
      .where(sql`${table.organizationId} IS NOT NULL`),
    index("ai_gateways_org_id_idx").on(table.organizationId),
    index("ai_gateways_enabled_idx").on(table.enabled),
    index("ai_gateways_provider_idx").on(table.provider),
  ]
);

export const aiGatewayModels = pgTable(
  "ai_gateway_models",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => aiGateways.id, { onDelete: "cascade" }),
    rawModelId: text("raw_model_id").notNull(),
    alias: text("alias"),
    modality: text("modality", {
      enum: ["language", "image", "speech", "video", "embedding"],
    }).notNull(),
    approved: boolean("approved").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    description: text("description"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_gateway_models_gateway_id_idx").on(table.gatewayId),
    index("ai_gateway_models_modality_idx").on(table.modality),
    index("ai_gateway_models_approved_idx").on(table.approved),
    uniqueIndex("ai_gateway_models_gateway_raw_model_idx").on(
      table.gatewayId,
      table.rawModelId
    ),
    uniqueIndex("ai_gateway_models_alias_idx").on(table.alias),
  ]
);

export const aiDeployments = pgTable(
  "ai_deployments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => aiDeploymentProfiles.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    status: text("status", {
      enum: [
        "requested",
        "provisioning_template",
        "provisioning_endpoint",
        "waiting_for_capacity",
        "validating",
        "ready",
        "failed",
        "deleting",
        "delete_failed",
        "deleted",
      ],
    })
      .notNull()
      .default("requested"),
    providerTemplateId: text("provider_template_id"),
    providerEndpointId: text("provider_endpoint_id"),
    gatewayId: text("gateway_id").references(() => aiGateways.id, {
      onDelete: "set null",
    }),
    specSnapshot: jsonb("spec_snapshot").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    reconciliationDeadline: timestamp("reconciliation_deadline", {
      withTimezone: true,
    }),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_deployments_active_org_profile_idx")
      .on(table.organizationId, table.profileId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("ai_deployments_provider_endpoint_idx").on(
      table.providerEndpointId
    ),
    index("ai_deployments_org_id_idx").on(table.organizationId),
    index("ai_deployments_status_idx").on(table.status),
  ]
);

export const aiDeploymentRuns = pgTable(
  "ai_deployment_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: text("kind", {
      enum: ["qualification", "provision", "reconcile", "delete", "usage"],
    }).notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => aiDeploymentProfiles.id, { onDelete: "restrict" }),
    deploymentId: text("deployment_id").references(() => aiDeployments.id, {
      onDelete: "cascade",
    }),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed"],
    })
      .notNull()
      .default("queued"),
    providerTemplateId: text("provider_template_id"),
    providerEndpointId: text("provider_endpoint_id"),
    attempt: integer("attempt").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_deployment_runs_deployment_idx").on(table.deploymentId),
    index("ai_deployment_runs_profile_idx").on(table.profileId),
    index("ai_deployment_runs_status_idx").on(table.status),
  ]
);

export const aiDeploymentUsage = pgTable(
  "ai_deployment_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => aiDeployments.id, { onDelete: "cascade" }),
    providerEndpointId: text("provider_endpoint_id").notNull(),
    bucketStartedAt: timestamp("bucket_started_at", {
      withTimezone: true,
    }).notNull(),
    amountUsd: real("amount_usd").notNull(),
    timeBilledMs: integer("time_billed_ms").notNull().default(0),
    diskSpaceBilledGb: integer("disk_space_billed_gb").notNull().default(0),
    gpuTypeId: text("gpu_type_id"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("ai_deployment_usage_bucket_idx")
      .on(table.deploymentId, table.bucketStartedAt, table.gpuTypeId)
      .nullsNotDistinct(),
    index("ai_deployment_usage_endpoint_idx").on(table.providerEndpointId),
  ]
);

export const apiUsage = pgTable(
  "api_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceId: text("source_id"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
  },
  (table) => [
    index("knowledge_api_usage_user_id_idx").on(table.userId),
    index("knowledge_api_usage_org_id_idx").on(table.organizationId),
    index("knowledge_api_usage_source_idx").on(table.source),
    index("knowledge_api_usage_created_at_idx").on(table.createdAt),
  ]
);

export const usageStats = pgTable(
  "usage_stats",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: text("date").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("web"),
    model: text("model").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    ...knowledgeTimestamps,
  },
  (table) => [
    index("knowledge_usage_stats_date_idx").on(table.date),
    index("knowledge_usage_stats_org_id_idx").on(table.organizationId),
    uniqueIndex("knowledge_usage_stats_unique_idx").on(
      table.date,
      table.organizationId,
      table.userId,
      table.source,
      table.model
    ),
  ]
);

export const knowledgeKv = pgTable(
  "knowledge_kv",
  {
    key: text("key").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("knowledge_kv_updated_idx").on(table.updatedAt),
    index("knowledge_kv_org_id_idx").on(table.organizationId),
  ]
);

export const knowledgeSnapshots = pgTable(
  "knowledge_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["building", "ready", "failed", "stale"],
    })
      .notNull()
      .default("building"),
    filesystemPath: text("filesystem_path").notNull(),
    sourceCount: integer("source_count").notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    isActive: boolean("is_active").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    error: text("error"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_snapshots_org_id_idx").on(table.organizationId),
    index("knowledge_snapshots_status_idx").on(table.status),
    index("knowledge_snapshots_active_idx").on(table.isActive),
    index("knowledge_snapshots_updated_at_idx").on(table.updatedAt),
  ]
);

export const knowledgeSyncRuns = pgTable(
  "knowledge_sync_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceFilter: text("source_filter"),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed"],
    })
      .notNull()
      .default("queued"),
    snapshotId: text("snapshot_id").references(() => knowledgeSnapshots.id, {
      onDelete: "set null",
    }),
    sourceCount: integer("source_count").notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_sync_runs_org_id_idx").on(table.organizationId),
    index("knowledge_sync_runs_status_idx").on(table.status),
    index("knowledge_sync_runs_snapshot_id_idx").on(table.snapshotId),
    index("knowledge_sync_runs_requested_by_user_id_idx").on(
      table.requestedByUserId
    ),
    index("knowledge_sync_runs_updated_at_idx").on(table.updatedAt),
  ]
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["organization", "project"] })
      .notNull()
      .default("organization"),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    uploaderUserId: text("uploader_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    filename: text("filename").notNull(),
    originalFilename: text("original_filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    checksumSha256: text("checksum_sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    status: text("status", {
      enum: ["uploaded", "processing", "ready", "partial", "failed"],
    })
      .notNull()
      .default("uploaded"),
    pageCount: integer("page_count"),
    chunkCount: integer("chunk_count").notNull().default(0),
    extractionMetadata: jsonb("extraction_metadata"),
    error: text("error"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_documents_org_id_idx").on(table.organizationId),
    index("knowledge_documents_project_id_idx").on(table.projectId),
    index("knowledge_documents_scope_idx").on(table.scope),
    index("knowledge_documents_uploader_user_id_idx").on(table.uploaderUserId),
    index("knowledge_documents_status_idx").on(table.status),
    index("knowledge_documents_created_at_idx").on(table.createdAt),
    uniqueIndex("knowledge_documents_org_checksum_idx")
      .on(table.organizationId, table.checksumSha256)
      .where(sql`${table.projectId} is null`),
    uniqueIndex("knowledge_documents_project_checksum_idx")
      .on(table.projectId, table.checksumSha256)
      .where(sql`${table.projectId} is not null`),
    uniqueIndex("knowledge_documents_storage_key_idx").on(table.storageKey),
  ]
);

export const projectContextDocuments = pgTable(
  "project_context_documents",
  {
    contextRevisionId: text("context_revision_id")
      .notNull()
      .references(() => projectContextRevisions.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.contextRevisionId, table.documentId] }),
    index("project_context_documents_document_id_idx").on(table.documentId),
  ]
);

export const knowledgeIngestionRuns = pgTable(
  "knowledge_ingestion_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    stage: text("stage", {
      enum: ["upload", "extract", "chunk", "embed", "complete"],
    })
      .notNull()
      .default("upload"),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed"],
    })
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    diagnostics: jsonb("diagnostics"),
    error: text("error"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_ingestion_runs_org_id_idx").on(table.organizationId),
    index("knowledge_ingestion_runs_document_id_idx").on(table.documentId),
    index("knowledge_ingestion_runs_status_idx").on(table.status),
    index("knowledge_ingestion_runs_stage_idx").on(table.stage),
    index("knowledge_ingestion_runs_updated_at_idx").on(table.updatedAt),
  ]
);

export const knowledgeDocumentChunks = pgTable(
  "knowledge_document_chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    contentLength: integer("content_length").notNull().default(0),
    tokenCount: integer("token_count").notNull().default(0),
    pageNumber: integer("page_number"),
    sectionTitle: text("section_title"),
    metadata: jsonb("metadata"),
    embedding: vector("embedding", {
      dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
    }).notNull(),
    ...knowledgeTimestamps,
  },
  (table) => [
    index("knowledge_document_chunks_org_id_idx").on(table.organizationId),
    index("knowledge_document_chunks_document_id_idx").on(table.documentId),
    uniqueIndex("knowledge_document_chunks_document_chunk_idx").on(
      table.documentId,
      table.chunkIndex
    ),
  ]
);

export const artifactDocuments = pgTable(
  "artifact_documents",
  {
    id: text("id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    title: text("title").notNull(),
    content: text("content"),
    kind: text("kind", { enum: ["text", "code", "image", "sheet", "video"] })
      .notNull()
      .default("text"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    index("knowledge_artifact_documents_id_idx").on(table.id),
    index("knowledge_artifact_documents_user_id_idx").on(table.userId),
    index("knowledge_artifact_documents_org_id_idx").on(table.organizationId),
    index("artifact_documents_thread_id_idx").on(table.threadId),
  ]
);

export const messageSpeechAssets = pgTable(
  "message_speech_assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    messageId: text("message_id")
      .notNull()
      .references(() => threadMessages.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    voice: text("voice").notNull().default("alloy"),
    textHash: text("text_hash").notNull(),
    storageKey: text("storage_key").notNull(),
    mediaType: text("media_type").notNull().default("audio/mpeg"),
    status: text("status", {
      enum: ["queued", "ready", "failed"],
    })
      .notNull()
      .default("queued"),
    error: text("error"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("message_speech_assets_message_id_idx").on(table.messageId),
    uniqueIndex("message_speech_assets_cache_idx").on(
      table.messageId,
      table.modelId,
      table.voice,
      table.textHash
    ),
    uniqueIndex("message_speech_assets_storage_key_idx").on(table.storageKey),
  ]
);

export const mediaGenerationJobs = pgTable(
  "media_generation_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    artifactId: text("artifact_id"),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    gatewayId: text("gateway_id").references(() => aiGateways.id, {
      onDelete: "set null",
    }),
    modelId: text("model_id").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: ["queued", "processing", "succeeded", "failed"],
    })
      .notNull()
      .default("queued"),
    providerJobId: text("provider_job_id"),
    outputUrl: text("output_url"),
    outputStorageKey: text("output_storage_key"),
    error: text("error"),
    metadata: jsonb("metadata"),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("media_generation_jobs_org_id_idx").on(table.organizationId),
    index("media_generation_jobs_thread_id_idx").on(table.threadId),
    index("media_generation_jobs_status_idx").on(table.status),
    index("media_generation_jobs_kind_idx").on(table.kind),
    index("media_generation_jobs_gateway_id_idx").on(table.gatewayId),
  ]
);

export const artifactSuggestions = pgTable(
  "artifact_suggestions",
  {
    id: text("id").primaryKey().notNull(),
    documentId: text("document_id").notNull(),
    documentCreatedAt: timestamp("document_created_at", {
      withTimezone: true,
    }).notNull(),
    originalText: text("original_text").notNull(),
    suggestedText: text("suggested_text").notNull(),
    description: text("description"),
    isResolved: boolean("is_resolved").notNull().default(false),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [artifactDocuments.id, artifactDocuments.createdAt],
      name: "knowledge_artifact_suggestions_document_fk",
    }),
    index("knowledge_artifact_suggestions_document_id_idx").on(
      table.documentId
    ),
    index("knowledge_artifact_suggestions_user_id_idx").on(table.userId),
    index("knowledge_artifact_suggestions_org_id_idx").on(table.organizationId),
  ]
);

export const adminEventLogs = pgTable(
  "admin_event_logs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    level: text("level", {
      enum: ["info", "warn", "error", "debug"],
    })
      .notNull()
      .default("info"),
    category: text("category").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_event_logs_org_id_idx").on(table.organizationId),
    index("admin_event_logs_actor_user_id_idx").on(table.actorUserId),
    index("admin_event_logs_level_idx").on(table.level),
    index("admin_event_logs_created_at_idx").on(table.createdAt),
  ]
);

export const platformEmailConfig = pgTable("platform_email_config", {
  id: text("id").primaryKey().notNull(),
  provider: text("provider", { enum: ["resend"] })
    .notNull()
    .default("resend"),
  enabled: boolean("enabled").notNull().default(false),
  credentialSource: text("credential_source", {
    enum: ["stored", "environment"],
  })
    .notNull()
    .default("environment"),
  encryptedApiKey: text("encrypted_api_key"),
  fromName: text("from_name").notNull().default("Kestrel One"),
  fromEmail: text("from_email").notNull(),
  replyTo: text("reply_to"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestMessageId: text("last_test_message_id"),
  lastTestConfigFingerprint: text("last_test_config_fingerprint"),
  lastErrorCode: text("last_error_code"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const adminApiKeys = pgTable(
  "admin_api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull().default("sk"),
    start: text("start").notNull(),
    hashedSecret: text("hashed_secret").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedMetadata: jsonb("last_used_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_api_keys_org_id_idx").on(table.organizationId),
    index("admin_api_keys_creator_user_id_idx").on(table.creatorUserId),
    index("admin_api_keys_enabled_idx").on(table.enabled),
    index("admin_api_keys_created_at_idx").on(table.createdAt),
  ]
);

// Export types for use throughout the application
export type User = InferSelectModel<typeof users>;
export type Session = InferSelectModel<typeof sessions>;
export type Organization = InferSelectModel<typeof organizations>;
export type Member = InferSelectModel<typeof members>;
export type Invitation = InferSelectModel<typeof invitations>;
export type Subscription = InferSelectModel<typeof subscriptions>;
export type Project = InferSelectModel<typeof projects>;
export type ProjectMember = InferSelectModel<typeof projectMembers>;
export type ProjectContextRevision = InferSelectModel<
  typeof projectContextRevisions
>;
export type Thread = InferSelectModel<typeof threads>;
export type ThreadMessage = InferSelectModel<typeof threadMessages>;
export type Source = InferSelectModel<typeof sources>;
export type ToolProvider = InferSelectModel<typeof toolProviders>;
export type ToolCapability = InferSelectModel<typeof toolCapabilities>;
export type OrganizationToolProvider = InferSelectModel<
  typeof organizationToolProviders
>;
export type OrganizationToolCapability = InferSelectModel<
  typeof organizationToolCapabilities
>;
export type OrganizationToolConnection = InferSelectModel<
  typeof organizationToolConnections
>;
export type AgentConfig = InferSelectModel<typeof agentConfig>;
export type ApiUsage = InferSelectModel<typeof apiUsage>;
export type UsageStat = InferSelectModel<typeof usageStats>;
export type ArtifactDocument = InferSelectModel<typeof artifactDocuments>;
export type ArtifactSuggestion = InferSelectModel<typeof artifactSuggestions>;
export type AdminEventLog = InferSelectModel<typeof adminEventLogs>;
export type PlatformEmailConfig = InferSelectModel<typeof platformEmailConfig>;
export type AdminApiKey = InferSelectModel<typeof adminApiKeys>;
export type KnowledgeSnapshot = InferSelectModel<typeof knowledgeSnapshots>;
export type KnowledgeSyncRun = InferSelectModel<typeof knowledgeSyncRuns>;
export type KnowledgeDocument = InferSelectModel<typeof knowledgeDocuments>;
export type KnowledgeIngestionRun = InferSelectModel<
  typeof knowledgeIngestionRuns
>;
export type KnowledgeDocumentChunk = InferSelectModel<
  typeof knowledgeDocumentChunks
>;
