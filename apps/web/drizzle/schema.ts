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
  bigint,
  boolean,
  check,
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
 *  organization feature flags
 *  ========================= */
export const organizationFeatureFlags = pgTable(
  "organization_feature_flags",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "organization_feature_flags_pk",
      columns: [table.organizationId, table.key],
    }),
    index("organization_feature_flags_enabled_idx").on(
      table.key,
      table.enabled
    ),
  ]
);

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
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
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
    index("projects_environment_id_idx").on(table.environmentId),
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "projects_organization_environment_fk",
    }).onDelete("restrict"),
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
    parentThreadId: text("parent_thread_id"),
    branchAnchorMessageId: text("branch_anchor_message_id"),
    origin: text("origin", {
      enum: ["web", "mobile", "github", "discord", "api"],
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
    index("threads_parent_thread_id_idx").on(table.parentThreadId),
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
    turnId: text("turn_id"),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    projectContextRevisionId: text("project_context_revision_id").references(
      () => projectContextRevisions.id,
      { onDelete: "restrict" }
    ),
    parts: jsonb("parts"),
    searchText: text("search_text").notNull().default(""),
    feedback: text("feedback", { enum: ["positive", "negative"] }),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    externalMessageId: text("external_message_id"),
    source: text("source", {
      enum: ["web", "mobile", "api", "github", "discord"],
    })
      .notNull()
      .default("web"),
    sourceMessageId: text("source_message_id"),
    ...knowledgeTimestamps,
  },
  (table) => [
    index("thread_messages_thread_id_idx").on(table.threadId),
    index("thread_messages_turn_id_idx").on(table.turnId),
    index("thread_messages_author_user_id_idx").on(table.authorUserId),
    index("thread_messages_context_revision_idx").on(
      table.projectContextRevisionId
    ),
    index("thread_messages_created_at_idx").on(table.createdAt),
    index("thread_messages_thread_created_id_idx").on(
      table.threadId,
      table.createdAt,
      table.id
    ),
    uniqueIndex("thread_messages_external_message_idx").on(
      table.threadId,
      table.externalMessageId
    ),
  ]
);

/** =========================
 *  Durable Thread Turns
 *  ========================= */

export const threadTurns = pgTable(
  "thread_turns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    inputMessageId: text("input_message_id").references(
      () => threadMessages.id,
      { onDelete: "restrict" }
    ),
    approvalId: text("approval_id"),
    approvalApproved: boolean("approval_approved"),
    approvalReason: text("approval_reason"),
    projectContextRevisionId: text("project_context_revision_id").references(
      () => projectContextRevisions.id,
      { onDelete: "restrict" }
    ),
    environmentExecutionId: text("environment_execution_id").references(
      () => environmentRunExecutions.id,
      { onDelete: "set null" }
    ),
    requestedEnvironmentId: text("requested_environment_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    sequence: integer("sequence").notNull(),
    queueOrdinal: integer("queue_ordinal").notNull(),
    source: text("source", { enum: ["web", "mobile", "api"] })
      .notNull()
      .default("web"),
    requestedModelId: text("requested_model_id"),
    requestedInteractionMode: text("requested_interaction_mode", {
      enum: ["chat", "plan", "build"],
    })
      .notNull()
      .default("chat"),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "waiting_for_input",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    outputMessageId: text("output_message_id"),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("thread_turns_thread_sequence_idx").on(
      table.threadId,
      table.sequence
    ),
    uniqueIndex("thread_turns_thread_idempotency_idx").on(
      table.threadId,
      table.idempotencyKey
    ),
    uniqueIndex("thread_turns_input_message_idx").on(table.inputMessageId),
    index("thread_turns_org_status_idx").on(table.organizationId, table.status),
    index("thread_turns_thread_status_idx").on(table.threadId, table.status),
    index("thread_turns_thread_queue_ordinal_idx").on(
      table.threadId,
      table.queueOrdinal
    ),
    index("thread_turns_author_idx").on(table.authorUserId),
    index("thread_turns_context_revision_idx").on(
      table.projectContextRevisionId
    ),
    index("thread_turns_execution_idx").on(table.environmentExecutionId),
    index("thread_turns_environment_idx").on(table.requestedEnvironmentId),
    foreignKey({
      columns: [table.organizationId, table.requestedEnvironmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "thread_turns_organization_environment_fk",
    }).onDelete("restrict"),
    check(
      "thread_turns_input_contract_check",
      sql`(
        (${table.inputMessageId} IS NOT NULL AND ${table.approvalId} IS NULL AND ${table.approvalApproved} IS NULL AND ${table.approvalReason} IS NULL)
        OR
        (${table.inputMessageId} IS NULL AND ${table.approvalId} IS NOT NULL AND ${table.approvalApproved} IS NOT NULL)
      )`
    ),
  ]
);

export const threadTurnEvents = pgTable(
  "thread_turn_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    turnId: text("turn_id")
      .notNull()
      .references(() => threadTurns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
  },
  (table) => [
    uniqueIndex("thread_turn_events_turn_sequence_idx").on(
      table.turnId,
      table.sequence
    ),
    index("thread_turn_events_expiry_idx").on(table.expiresAt),
  ]
);

export const threadTurnQueueState = pgTable("thread_turn_queue_state", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  activeTurnId: text("active_turn_id").references(() => threadTurns.id, {
    onDelete: "set null",
  }),
  nextSequence: integer("next_sequence").notNull().default(1),
  state: text("state", { enum: ["running", "paused"] })
    .notNull()
    .default("running"),
  pauseReason: text("pause_reason"),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const threadTurnPresentations = pgTable(
  "thread_turn_presentations",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => threadTurns.id, { onDelete: "cascade" }),
    stage: text("stage", {
      enum: [
        "queued",
        "preparing",
        "reading_context",
        "working",
        "using_capability",
        "finalizing",
        "waiting",
        "retrying",
      ],
    }).notNull(),
    milestones: jsonb("milestones").notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("thread_turn_presentations_stage_idx").on(table.stage)]
);

export const threadReadStates = pgTable(
  "thread_read_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    lastReadMessageId: text("last_read_message_id").references(
      () => threadMessages.id,
      { onDelete: "set null" }
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.threadId] }),
    index("thread_read_states_org_user_idx").on(
      table.organizationId,
      table.userId
    ),
  ]
);

export const mobileDeviceRegistrations = pgTable(
  "mobile_device_registrations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    platform: text("platform", { enum: ["ios", "android"] }).notNull(),
    expoPushToken: text("expo_push_token").notNull(),
    appVersion: text("app_version"),
    locale: text("locale"),
    timezone: text("timezone"),
    enabled: boolean("enabled").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mobile_device_registrations_push_token_idx").on(
      table.expoPushToken
    ),
    index("mobile_device_registrations_user_idx").on(table.userId),
    index("mobile_device_registrations_org_idx").on(table.organizationId),
  ]
);

export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: text("status", {
      enum: [
        "requested",
        "confirmed",
        "processing",
        "completed",
        "rejected",
        "cancelled",
      ],
    })
      .notNull()
      .default("requested"),
    confirmationTokenHash: text("confirmation_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("account_deletion_requests_token_idx").on(
      table.confirmationTokenHash
    ),
    index("account_deletion_requests_user_status_idx").on(
      table.userId,
      table.status
    ),
    index("account_deletion_requests_status_created_idx").on(
      table.status,
      table.createdAt
    ),
  ]
);

export const mobilePushDeliveries = pgTable(
  "mobile_push_deliveries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    deviceRegistrationId: text("device_registration_id")
      .notNull()
      .references(() => mobileDeviceRegistrations.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => threadTurns.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["completed", "failed", "attention"],
    }).notNull(),
    status: text("status", {
      enum: [
        "pending",
        "accepted",
        "delivered",
        "failed",
        "device_unregistered",
      ],
    })
      .notNull()
      .default("pending"),
    expoTicketId: text("expo_ticket_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mobile_push_deliveries_turn_device_kind_idx").on(
      table.turnId,
      table.deviceRegistrationId,
      table.kind
    ),
    index("mobile_push_deliveries_status_idx").on(table.status),
    index("mobile_push_deliveries_ticket_idx").on(table.expoTicketId),
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

/** =========================
 *  Hosted execution environments
 *  ========================= */

export const environments = pgTable(
  "environments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    region: text("region").notNull(),
    status: text("status", {
      enum: [
        "requested",
        "provisioning",
        "ready",
        "degraded",
        "deleting",
        "deleted",
        "failed",
      ],
    })
      .notNull()
      .default("requested"),
    isDefault: boolean("is_default").notNull().default(false),
    flyAppName: text("fly_app_name"),
    flyNetworkName: text("fly_network_name"),
    flyGatewayMachineId: text("fly_gateway_machine_id"),
    routerUrl: text("router_url"),
    routerImage: text("router_image"),
    runtimeTemplate: text("runtime_template")
      .notNull()
      .default("kestrel-standard-v1"),
    runtimeImage: text("runtime_image"),
    idleTimeoutMinutes: integer("idle_timeout_minutes").notNull().default(15),
    reasoningRequestMode: text("reasoning_request_mode", {
      enum: ["off", "summary", "provider_visible"],
    }).notNull().default("provider_visible"),
    reasoningEffort: text("reasoning_effort", {
      enum: ["low", "medium", "high"],
    }),
    reasoningRetentionMode: text("reasoning_retention_mode", {
      enum: ["live_only", "provider_visible"],
    }).notNull().default("live_only"),
    reasoningRetentionDays: integer("reasoning_retention_days").notNull().default(7),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("environments_org_slug_idx").on(
      table.organizationId,
      table.slug
    ),
    uniqueIndex("environments_org_id_idx").on(table.organizationId, table.id),
    uniqueIndex("environments_org_default_idx")
      .on(table.organizationId)
      .where(sql`${table.isDefault} = true and ${table.archivedAt} is null`),
    uniqueIndex("environments_fly_app_name_idx")
      .on(table.flyAppName)
      .where(sql`${table.flyAppName} is not null`),
    index("environments_org_status_idx").on(table.organizationId, table.status),
    check(
      "environments_idle_timeout_check",
      sql`${table.idleTimeoutMinutes} > 0`
    ),
    check(
      "environments_reasoning_retention_days_check",
      sql`${table.reasoningRetentionDays} between 1 and 30`
    ),
  ]
);

export const environmentWorkspaces = pgTable(
  "environment_workspaces",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    standaloneThreadId: text("standalone_thread_id").references(
      () => threads.id,
      { onDelete: "cascade" }
    ),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["project", "scratch"] }).notNull(),
    sourceType: text("source_type", { enum: ["blank", "github"] })
      .notNull()
      .default("blank"),
    sourceResourceId: text("source_resource_id").references(
      () => appConnectionResources.id,
      { onDelete: "restrict" }
    ),
    sourceRepository: text("source_repository"),
    sourceDefaultBranch: text("source_default_branch"),
    status: text("status", {
      enum: [
        "requested",
        "provisioning",
        "stopped",
        "starting",
        "ready",
        "stopping",
        "degraded",
        "deleting",
        "deleted",
        "failed",
      ],
    })
      .notNull()
      .default("requested"),
    flyMachineId: text("fly_machine_id"),
    flyVolumeId: text("fly_volume_id"),
    runtimeImage: text("runtime_image"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("environment_workspaces_project_idx")
      .on(table.environmentId, table.projectId)
      .where(
        sql`${table.projectId} is not null and ${table.deletedAt} is null`
      ),
    uniqueIndex("environment_workspaces_thread_idx")
      .on(table.environmentId, table.standaloneThreadId)
      .where(
        sql`${table.standaloneThreadId} is not null and ${table.deletedAt} is null`
      ),
    uniqueIndex("environment_workspaces_machine_idx")
      .on(table.flyMachineId)
      .where(sql`${table.flyMachineId} is not null`),
    uniqueIndex("environment_workspaces_volume_idx")
      .on(table.flyVolumeId)
      .where(sql`${table.flyVolumeId} is not null`),
    index("environment_workspaces_org_status_idx").on(
      table.organizationId,
      table.status
    ),
    index("environment_workspaces_environment_idx").on(table.environmentId),
    check(
      "environment_workspaces_owner_check",
      sql`(
        (${table.kind} = 'project' and ${table.projectId} is not null and ${table.standaloneThreadId} is null)
        or
        (${table.kind} = 'scratch' and ${table.projectId} is null and ${table.standaloneThreadId} is not null)
      )`
    ),
    check(
      "environment_workspaces_source_check",
      sql`(
        (${table.sourceType} = 'blank' and ${table.sourceResourceId} is null and ${table.sourceRepository} is null)
        or
        (${table.sourceType} = 'github' and ${table.sourceResourceId} is not null and ${table.sourceRepository} is not null)
      )`
    ),
  ]
);

export const projectEnvironmentBindings = pgTable(
  "project_environment_bindings",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
    boundByUserId: text("bound_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("project_environment_bindings_org_idx").on(table.organizationId),
    index("project_environment_bindings_environment_idx").on(
      table.environmentId
    ),
  ]
);

export const threadExecutionBindings = pgTable(
  "thread_execution_bindings",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => environmentWorkspaces.id, { onDelete: "restrict" }),
    source: text("source", {
      enum: ["thread", "project", "organization"],
    }).notNull(),
    boundByUserId: text("bound_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("thread_execution_bindings_org_idx").on(table.organizationId),
    index("thread_execution_bindings_environment_idx").on(table.environmentId),
    index("thread_execution_bindings_workspace_idx").on(table.workspaceId),
  ]
);

export const environmentRunExecutions = pgTable(
  "environment_run_executions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => environmentWorkspaces.id, { onDelete: "restrict" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    projectContextRevisionId: text("project_context_revision_id").references(
      () => projectContextRevisions.id,
      { onDelete: "set null" }
    ),
    actorId: text("actor_id").notNull(),
    runtimeImage: text("runtime_image").notNull(),
    effectiveCapabilities: jsonb("effective_capabilities")
      .$type<string[]>()
      .notNull(),
    runtimeRunId: text("runtime_run_id"),
    reasoningPolicySnapshot: jsonb("reasoning_policy_snapshot").$type<{
      request: { mode: "off" | "summary" | "provider_visible"; effort?: "low" | "medium" | "high" };
      retention: { mode: "live_only" | "provider_visible"; days: number };
    }>(),
    reasoningKeyReady: boolean("reasoning_key_ready").notNull().default(false),
    status: text("status", {
      enum: ["routed", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("routed"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("environment_run_executions_thread_created_idx").on(
      table.threadId,
      table.createdAt
    ),
    index("environment_run_executions_workspace_status_idx").on(
      table.workspaceId,
      table.status
    ),
    index("environment_run_executions_org_created_idx").on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export const githubActionApprovals = pgTable(
  "github_action_approvals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => environmentWorkspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    requestedExecutionId: text("requested_execution_id")
      .notNull()
      .references(() => environmentRunExecutions.id, { onDelete: "cascade" }),
    consumedExecutionId: text("consumed_execution_id").references(
      () => environmentRunExecutions.id,
      { onDelete: "restrict" }
    ),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: text("agent_id").notNull(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => toolConnectionResources.id, { onDelete: "restrict" }),
    repository: text("repository").notNull(),
    operation: text("operation", {
      enum: [
        "issue.create",
        "pull_request.create",
        "pull_request.merge",
        "release.create",
        "workflow.dispatch",
      ],
    }).notNull(),
    runtimeApprovalId: text("runtime_approval_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "consumed", "expired"],
    })
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("github_action_approvals_runtime_idx").on(
      table.organizationId,
      table.runtimeApprovalId
    ),
    index("github_action_approvals_thread_status_idx").on(
      table.organizationId,
      table.threadId,
      table.status
    ),
    index("github_action_approvals_expiry_idx").on(
      table.status,
      table.expiresAt
    ),
    index("github_action_approvals_execution_idx").on(
      table.requestedExecutionId
    ),
    check(
      "github_action_approvals_operation_check",
      sql`${table.operation} in ('issue.create', 'pull_request.create', 'pull_request.merge', 'release.create', 'workflow.dispatch')`
    ),
    check(
      "github_action_approvals_status_check",
      sql`${table.status} in ('pending', 'approved', 'denied', 'consumed', 'expired')`
    ),
    check(
      "github_action_approvals_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_action_approvals_lifecycle_check",
      sql`(
        (${table.status} = 'pending' and ${table.decidedAt} is null and ${table.decidedByUserId} is null and ${table.consumedAt} is null and ${table.consumedExecutionId} is null)
        or
        (${table.status} in ('approved', 'denied') and ${table.decidedAt} is not null and ${table.decidedByUserId} is not null and ${table.consumedAt} is null and ${table.consumedExecutionId} is null)
        or
        (${table.status} = 'consumed' and ${table.decidedAt} is not null and ${table.decidedByUserId} is not null and ${table.consumedAt} is not null and ${table.consumedExecutionId} is not null)
        or
        (${table.status} = 'expired' and ${table.consumedAt} is null and ${table.consumedExecutionId} is null)
      )`
    ),
  ]
);

export const environmentOperations = pgTable(
  "environment_operations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(
      () => environmentWorkspaces.id,
      { onDelete: "cascade" }
    ),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type", {
      enum: [
        "environment.provision",
        "environment.update",
        "environment.delete",
        "workspace.provision",
        "workspace.start",
        "workspace.stop",
        "workspace.rebuild",
        "workspace.delete",
        "workspace.backup",
        "workspace.restore",
        "workspace.reconcile",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    stage: text("stage").notNull().default("requested"),
    idempotencyKey: text("idempotency_key").notNull(),
    providerRequestId: text("provider_request_id"),
    attempt: integer("attempt").notNull().default(0),
    input: jsonb("input").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("environment_operations_idempotency_idx").on(
      table.organizationId,
      table.idempotencyKey
    ),
    index("environment_operations_environment_status_idx").on(
      table.environmentId,
      table.status
    ),
    index("environment_operations_workspace_idx").on(table.workspaceId),
  ]
);

export const environmentApplications = pgTable(
  "environment_applications",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => environmentWorkspaces.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    workingDirectory: text("working_directory").notNull(),
    startCommand: text("start_command").notNull(),
    port: integer("port").notNull(),
    healthPath: text("health_path"),
    audience: text("audience", { enum: ["workspace"] })
      .notNull()
      .default("workspace"),
    desiredState: text("desired_state", { enum: ["running", "stopped"] })
      .notNull()
      .default("running"),
    status: text("status", {
      enum: ["registered", "starting", "running", "stopped", "failed"],
    })
      .notNull()
      .default("registered"),
    processId: text("process_id"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("environment_applications_workspace_slug_idx").on(
      table.workspaceId,
      table.slug
    ),
    index("environment_applications_environment_idx").on(table.environmentId),
    index("environment_applications_workspace_status_idx").on(
      table.workspaceId,
      table.status
    ),
    check(
      "environment_applications_port_check",
      sql`${table.port} >= 1024 and ${table.port} <= 65535`
    ),
  ]
);

export const workspaceBackups = pgTable(
  "workspace_backups",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => environmentWorkspaces.id, { onDelete: "cascade" }),
    operationId: text("operation_id").references(
      () => environmentOperations.id,
      {
        onDelete: "set null",
      }
    ),
    reason: text("reason", {
      enum: ["checkpoint", "daily", "pre_destructive", "pre_promotion"],
    }).notNull(),
    status: text("status", {
      enum: ["queued", "creating", "available", "failed", "expired"],
    })
      .notNull()
      .default("queued"),
    objectKey: text("object_key"),
    encryptionKeyId: text("encryption_key_id"),
    checksumSha256: text("checksum_sha256"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sourceRevision: text("source_revision"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("workspace_backups_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    index("workspace_backups_expiry_idx").on(table.status, table.expiresAt),
  ]
);

export const toolConnectionResources = pgTable(
  "tool_connection_resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    resourceType: text("resource_type").notNull(),
    label: text("label").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tool_connection_resources_external_idx").on(
      table.organizationId,
      table.providerKey,
      table.externalId
    ),
    uniqueIndex("tool_connection_resources_installation_idx")
      .on(table.providerKey, table.externalId)
      .where(sql`${table.resourceType} = 'installation'`),
    index("tool_connection_resources_provider_idx").on(
      table.organizationId,
      table.providerKey
    ),
  ]
);

export const userToolConnections = pgTable(
  "user_tool_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authAccountId: text("auth_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["connected", "degraded", "disconnected"],
    })
      .notNull()
      .default("connected"),
    providerAccountId: text("provider_account_id").notNull(),
    providerLogin: text("provider_login").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    failureCode: text("failure_code"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("user_tool_connections_org_provider_user_idx").on(
      table.organizationId,
      table.providerKey,
      table.userId
    ),
    uniqueIndex("user_tool_connections_org_provider_account_idx").on(
      table.organizationId,
      table.providerKey,
      table.authAccountId
    ),
    index("user_tool_connections_status_idx").on(
      table.organizationId,
      table.providerKey,
      table.status
    ),
  ]
);

export const userToolConnectionResources = pgTable(
  "user_tool_connection_resources",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => userToolConnections.id, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => toolConnectionResources.id, { onDelete: "cascade" }),
    canPull: boolean("can_pull").notNull().default(true),
    canPush: boolean("can_push").notNull().default(false),
    canAdmin: boolean("can_admin").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.resourceId] }),
    index("user_tool_connection_resources_resource_idx").on(table.resourceId),
  ]
);

export const projectAppUserCapabilities = pgTable(
  "project_app_user_capabilities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => appConnections.id, { onDelete: "cascade" }),
    appKey: text("app_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    audience: text("audience", { enum: ["self", "project"] }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_app_user_capabilities_scope_idx").on(
      table.projectId,
      table.connectionId,
      table.appKey,
      table.capabilityKey,
      table.audience
    ),
    foreignKey({
      columns: [table.appKey, table.capabilityKey],
      foreignColumns: [appCapabilities.appKey, appCapabilities.key],
      name: "project_app_user_capabilities_capability_fk",
    }).onDelete("cascade"),
    index("project_app_user_capabilities_project_idx").on(table.projectId),
    index("project_app_user_capabilities_connection_idx").on(
      table.connectionId
    ),
    index("project_app_user_capabilities_subject_idx").on(
      table.projectId,
      table.appKey,
      table.capabilityKey,
      table.audience,
      table.enabled
    ),
  ]
);

/** =========================
 *  Apps capability platform
 *  ========================= */

export const appDefinitions = pgTable(
  "app_definitions",
  {
    key: text("key").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    category: text("category", {
      enum: [
        "kestrel",
        "search_research",
        "productivity",
        "engineering",
        "knowledge_sources",
        "communication",
        "custom",
      ],
    }).notNull(),
    kind: text("kind", {
      enum: ["built_in", "external", "custom"],
    }).notNull(),
    connectionModel: text("connection_model", {
      enum: ["none", "personal", "environment", "hybrid"],
    }).notNull(),
    connectionRequirement: text("connection_requirement", {
      enum: ["none", "optional", "required"],
    })
      .notNull()
      .default("required"),
    delivery: text("delivery", {
      enum: ["native", "oauth", "api_key", "mcp", "webhook", "source"],
    }).notNull(),
    installMode: text("install_mode", {
      enum: ["inherited", "explicit"],
    }).notNull(),
    icon: text("icon"),
    published: boolean("published").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_definitions_slug_idx").on(table.slug),
    index("app_definitions_category_idx").on(table.category),
    index("app_definitions_published_idx").on(table.published),
    check(
      "app_definitions_connection_model_check",
      sql`${table.connectionModel} in ('none', 'personal', 'environment', 'hybrid')`
    ),
    check(
      "app_definitions_connection_requirement_check",
      sql`${table.connectionRequirement} in ('none', 'optional', 'required')`
    ),
    check(
      "app_definitions_connection_contract_check",
      sql`(${table.connectionModel} = 'none') = (${table.connectionRequirement} = 'none')`
    ),
  ]
);

export const appCapabilities = pgTable(
  "app_capabilities",
  {
    appKey: text("app_key")
      .notNull()
      .references(() => appDefinitions.key, { onDelete: "cascade" }),
    key: text("key").notNull(),
    runtimeName: text("runtime_name"),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    groupKey: text("group_key").notNull().default("general"),
    accessMode: text("access_mode", {
      enum: ["read", "write", "status", "internal"],
    }).notNull(),
    audience: text("audience", {
      enum: ["self", "project", "both"],
    })
      .notNull()
      .default("project"),
    defaultEnabled: boolean("default_enabled").notNull().default(true),
    defaultApprovalMode: text("default_approval_mode", {
      enum: ["auto", "ask", "deny"],
    })
      .notNull()
      .default("auto"),
    defaultRateLimitMode: text("default_rate_limit_mode", {
      enum: ["default", "strict", "off"],
    })
      .notNull()
      .default("default"),
    defaultLoggingMode: text("default_logging_mode", {
      enum: ["full", "metadata_only", "minimal"],
    })
      .notNull()
      .default("metadata_only"),
    defaultSettings: jsonb("default_settings").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.appKey, table.key] }),
    index("app_capabilities_runtime_name_idx").on(table.runtimeName),
    index("app_capabilities_group_idx").on(table.appKey, table.groupKey),
  ]
);

export const appInstallations = pgTable(
  "app_installations",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appKey: text("app_key")
      .notNull()
      .references(() => appDefinitions.key, { onDelete: "cascade" }),
    status: text("status", { enum: ["installed", "disabled"] })
      .notNull()
      .default("installed"),
    installedByUserId: text("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    installedAt: timestamp("installed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.appKey] }),
    index("app_installations_status_idx").on(table.organizationId, table.status),
  ]
);

export const appCredentials = pgTable(
  "app_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").notNull(),
    appKey: text("app_key")
      .notNull()
      .references(() => appDefinitions.key, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["api_key", "oauth", "secret_headers"],
    }).notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    envelopeVersion: text("envelope_version").notNull().default("kapp:v1"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "app_credentials_organization_environment_fk",
    }).onDelete("cascade"),
    uniqueIndex("app_credentials_environment_app_name_idx")
      .on(table.environmentId, table.appKey, table.name)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("app_credentials_environment_id_idx").on(
      table.environmentId,
      table.id
    ),
    index("app_credentials_app_status_idx").on(table.appKey, table.status),
    check(
      "app_credentials_encrypted_payload_check",
      sql`${table.encryptedPayload} like 'kapp:v1:%' or ${table.encryptedPayload} like 'kmcp:v1:%'`
    ),
  ]
);

export const appConnections = pgTable(
  "app_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appKey: text("app_key")
      .notNull()
      .references(() => appDefinitions.key, { onDelete: "cascade" }),
    ownerType: text("owner_type", {
      enum: ["system", "personal", "environment", "deployment_managed"],
    }).notNull(),
    environmentId: text("environment_id"),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    authAccountId: text("auth_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    credentialId: text("credential_id"),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["connected", "degraded", "disconnected"],
    })
      .notNull()
      .default("connected"),
    externalAccountId: text("external_account_id"),
    externalAccountLabel: text("external_account_label"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    deliveryConfig: jsonb("delivery_config").$type<Record<string, unknown>>(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "app_connections_organization_environment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.environmentId, table.credentialId],
      foreignColumns: [appCredentials.environmentId, appCredentials.id],
      name: "app_connections_environment_credential_fk",
    }).onDelete("restrict"),
    uniqueIndex("app_connections_personal_name_idx")
      .on(table.organizationId, table.appKey, table.userId, table.name)
      .where(sql`${table.ownerType} = 'personal'`),
    uniqueIndex("app_connections_environment_name_idx")
      .on(table.environmentId, table.appKey, table.name)
      .where(sql`${table.ownerType} in ('environment', 'deployment_managed')`),
    index("app_connections_org_app_status_idx").on(
      table.organizationId,
      table.appKey,
      table.status
    ),
    index("app_connections_user_idx").on(table.userId, table.status),
    check(
      "app_connections_owner_scope_check",
      sql`(
        (${table.ownerType} = 'system' and ${table.environmentId} is null and ${table.userId} is null and ${table.credentialId} is null)
        or
        (${table.ownerType} = 'personal' and ${table.userId} is not null and ${table.environmentId} is null and ${table.credentialId} is null)
        or
        (${table.ownerType} in ('environment', 'deployment_managed') and ${table.environmentId} is not null and ${table.userId} is null)
      )`
    ),
  ]
);

export const appConnectionResources = pgTable(
  "app_connection_resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    connectionId: text("connection_id")
      .notNull()
      .references(() => appConnections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    resourceType: text("resource_type").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    permissions: jsonb("permissions").$type<Record<string, boolean>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_connection_resources_external_idx").on(
      table.connectionId,
      table.resourceType,
      table.externalId
    ),
    index("app_connection_resources_connection_idx").on(table.connectionId),
  ]
);

export const appOperationApprovals = pgTable(
  "app_operation_approvals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => environmentWorkspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    requestedExecutionId: text("requested_execution_id")
      .notNull()
      .references(() => environmentRunExecutions.id, { onDelete: "cascade" }),
    consumedExecutionId: text("consumed_execution_id").references(
      () => environmentRunExecutions.id,
      { onDelete: "restrict" }
    ),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: text("agent_id").notNull(),
    appKey: text("app_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => appConnections.id, { onDelete: "restrict" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => appConnectionResources.id, { onDelete: "restrict" }),
    resourceType: text("resource_type").notNull(),
    operationKey: text("operation_key").notNull(),
    runtimeApprovalId: text("runtime_approval_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "consumed", "expired"],
    })
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.appKey, table.capabilityKey],
      foreignColumns: [appCapabilities.appKey, appCapabilities.key],
      name: "app_operation_approvals_capability_fk",
    }).onDelete("restrict"),
    uniqueIndex("app_operation_approvals_runtime_idx").on(
      table.organizationId,
      table.runtimeApprovalId
    ),
    index("app_operation_approvals_thread_status_idx").on(
      table.organizationId,
      table.threadId,
      table.status
    ),
    index("app_operation_approvals_expiry_idx").on(
      table.status,
      table.expiresAt
    ),
    index("app_operation_approvals_execution_idx").on(
      table.requestedExecutionId
    ),
    check(
      "app_operation_approvals_payload_hash_check",
      sql`length(${table.payloadHash}) = 64`
    ),
    check(
      "app_operation_approvals_status_check",
      sql`${table.status} in ('pending', 'approved', 'denied', 'consumed', 'expired')`
    ),
    check(
      "app_operation_approvals_lifecycle_check",
      sql`(
        (${table.status} = 'pending' and ${table.decidedByUserId} is null and ${table.decidedAt} is null and ${table.consumedExecutionId} is null and ${table.consumedAt} is null)
        or (${table.status} in ('approved', 'denied') and ${table.decidedByUserId} is not null and ${table.decidedAt} is not null and ${table.consumedExecutionId} is null and ${table.consumedAt} is null)
        or (${table.status} = 'consumed' and ${table.decidedByUserId} is not null and ${table.decidedAt} is not null and ${table.consumedExecutionId} is not null and ${table.consumedAt} is not null)
        or (${table.status} = 'expired' and ${table.consumedExecutionId} is null and ${table.consumedAt} is null)
      )`
    ),
  ]
);

export const environmentAppCapabilityGrants = pgTable(
  "environment_app_capability_grants",
  {
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    appKey: text("app_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    loggingMode: text("logging_mode", {
      enum: ["full", "metadata_only", "minimal"],
    })
      .notNull()
      .default("metadata_only"),
    rateLimitMode: text("rate_limit_mode", {
      enum: ["default", "strict", "off"],
    })
      .notNull()
      .default("default"),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.appKey, table.capabilityKey] }),
    foreignKey({
      columns: [table.appKey, table.capabilityKey],
      foreignColumns: [appCapabilities.appKey, appCapabilities.key],
      name: "environment_app_capability_grants_capability_fk",
    }).onDelete("cascade"),
    index("environment_app_capability_grants_app_idx").on(
      table.environmentId,
      table.appKey
    ),
  ]
);

export const projectApps = pgTable(
  "project_apps",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    appKey: text("app_key")
      .notNull()
      .references(() => appDefinitions.key, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.appKey] }),
    index("project_apps_app_enabled_idx").on(table.appKey, table.enabled),
  ]
);

export const projectAppConnections = pgTable(
  "project_app_connections",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    appKey: text("app_key").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => appConnections.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["shared", "personal"] }).notNull(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    isDefault: boolean("is_default").notNull().default(false),
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.appKey, table.connectionId] }),
    foreignKey({
      columns: [table.projectId, table.appKey],
      foreignColumns: [projectApps.projectId, projectApps.appKey],
      name: "project_app_connections_project_app_fk",
    }).onDelete("cascade"),
    uniqueIndex("project_app_connections_shared_default_idx")
      .on(table.projectId, table.appKey)
      .where(sql`${table.scope} = 'shared' and ${table.isDefault} = true`),
    uniqueIndex("project_app_connections_personal_default_idx")
      .on(table.projectId, table.appKey, table.userId)
      .where(sql`${table.scope} = 'personal' and ${table.isDefault} = true`),
    index("project_app_connections_connection_idx").on(table.connectionId),
    check(
      "project_app_connections_scope_check",
      sql`(
        (${table.scope} = 'shared' and ${table.userId} is null)
        or
        (${table.scope} = 'personal' and ${table.userId} is not null)
      )`
    ),
  ]
);

export const projectAppCapabilityPolicies = pgTable(
  "project_app_capability_policies",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    appKey: text("app_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    loggingMode: text("logging_mode", {
      enum: ["full", "metadata_only", "minimal"],
    })
      .notNull()
      .default("metadata_only"),
    rateLimitMode: text("rate_limit_mode", {
      enum: ["default", "strict", "off"],
    })
      .notNull()
      .default("default"),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.appKey, table.capabilityKey] }),
    foreignKey({
      columns: [table.projectId, table.appKey],
      foreignColumns: [projectApps.projectId, projectApps.appKey],
      name: "project_app_capability_policies_project_app_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.appKey, table.capabilityKey],
      foreignColumns: [appCapabilities.appKey, appCapabilities.key],
      name: "project_app_capability_policies_capability_fk",
    }).onDelete("cascade"),
    index("project_app_capability_policies_app_idx").on(
      table.projectId,
      table.appKey
    ),
  ]
);

export const environmentCapabilityGrants = pgTable(
  "environment_capability_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    resourceId: text("resource_id").references(
      () => toolConnectionResources.id,
      {
        onDelete: "cascade",
      }
    ),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    loggingMode: text("logging_mode", {
      enum: ["full", "metadata_only", "minimal"],
    })
      .notNull()
      .default("full"),
    rateLimitMode: text("rate_limit_mode", {
      enum: ["default", "strict", "off"],
    })
      .notNull()
      .default("default"),
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("environment_capability_grants_resource_idx")
      .on(
        table.environmentId,
        table.providerKey,
        table.capabilityKey,
        table.resourceId
      )
      .where(sql`${table.resourceId} is not null`),
    uniqueIndex("environment_capability_grants_unscoped_idx")
      .on(table.environmentId, table.providerKey, table.capabilityKey)
      .where(sql`${table.resourceId} is null`),
    foreignKey({
      columns: [table.providerKey, table.capabilityKey],
      foreignColumns: [toolCapabilities.providerKey, toolCapabilities.key],
      name: "environment_capability_grants_capability_fk",
    }).onDelete("cascade"),
    index("environment_capability_grants_environment_idx").on(
      table.environmentId
    ),
  ]
);

export const projectCapabilityRestrictions = pgTable(
  "project_capability_restrictions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    resourceId: text("resource_id").references(
      () => toolConnectionResources.id,
      {
        onDelete: "cascade",
      }
    ),
    enabled: boolean("enabled").notNull().default(false),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_capability_restrictions_resource_idx")
      .on(
        table.projectId,
        table.providerKey,
        table.capabilityKey,
        table.resourceId
      )
      .where(sql`${table.resourceId} is not null`),
    uniqueIndex("project_capability_restrictions_unscoped_idx")
      .on(table.projectId, table.providerKey, table.capabilityKey)
      .where(sql`${table.resourceId} is null`),
    foreignKey({
      columns: [table.providerKey, table.capabilityKey],
      foreignColumns: [toolCapabilities.providerKey, toolCapabilities.key],
      name: "project_capability_restrictions_capability_fk",
    }).onDelete("cascade"),
    index("project_capability_restrictions_project_idx").on(table.projectId),
  ]
);

/** =========================
 *  Hosted MCP control plane
 *  ========================= */

export const mcpCredentials = pgTable(
  "mcp_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["oauth", "secret_headers"] }).notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    status: text("status", {
      enum: ["active", "refresh_required", "revoked"],
    })
      .notNull()
      .default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "mcp_credentials_organization_environment_fk",
    }).onDelete("cascade"),
    uniqueIndex("mcp_credentials_environment_id_idx").on(
      table.environmentId,
      table.id
    ),
    uniqueIndex("mcp_credentials_environment_name_idx").on(
      table.environmentId,
      table.name
    ),
    index("mcp_credentials_environment_status_idx").on(
      table.environmentId,
      table.status
    ),
    check(
      "mcp_credentials_encrypted_payload_check",
      sql`${table.encryptedPayload} like 'kmcp:v1:%'`
    ),
  ]
);

export const mcpOauthAuthorizations = pgTable(
  "mcp_oauth_authorizations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    credentialName: text("credential_name").notNull(),
    stateDigest: text("state_digest").notNull(),
    encryptedSession: text("encrypted_session").notNull(),
    authorizationEndpoint: text("authorization_endpoint").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    clientId: text("client_id").notNull(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method", {
      enum: ["none", "client_secret_basic", "client_secret_post"],
    })
      .notNull()
      .default("none"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    resource: text("resource"),
    redirectUri: text("redirect_uri").notNull(),
    status: text("status", {
      enum: ["pending", "completed", "failed", "expired"],
    })
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "mcp_oauth_authorizations_organization_environment_fk",
    }).onDelete("cascade"),
    uniqueIndex("mcp_oauth_authorizations_state_digest_idx").on(
      table.stateDigest
    ),
    uniqueIndex("mcp_oauth_authorizations_credential_id_idx").on(
      table.credentialId
    ),
    index("mcp_oauth_authorizations_expiry_status_idx").on(
      table.expiresAt,
      table.status
    ),
    check(
      "mcp_oauth_authorizations_encrypted_session_check",
      sql`${table.encryptedSession} like 'kmcp:v1:%'`
    ),
  ]
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "restrict" }),
    credentialId: text("credential_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    sourceType: text("source_type", { enum: ["remote", "oci"] }).notNull(),
    transport: text("transport", {
      enum: ["streamable_http", "stdio"],
    }).notNull(),
    remoteUrl: text("remote_url"),
    ociImageReference: text("oci_image_reference"),
    ociDigest: text("oci_digest"),
    authMode: text("auth_mode", {
      enum: ["none", "oauth", "secret_headers"],
    })
      .notNull()
      .default("none"),
    launchArguments: jsonb("launch_arguments")
      .$type<string[]>()
      .notNull()
      .default([]),
    egressAllowlist: jsonb("egress_allowlist")
      .$type<string[]>()
      .notNull()
      .default([]),
    cpuMillicores: integer("cpu_millicores").notNull().default(500),
    memoryMib: integer("memory_mib").notNull().default(512),
    pidsLimit: integer("pids_limit").notNull().default(128),
    status: text("status", {
      enum: ["draft", "discovering", "ready", "degraded", "disabled"],
    })
      .notNull()
      .default("draft"),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "mcp_servers_organization_environment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.environmentId, table.credentialId],
      foreignColumns: [mcpCredentials.environmentId, mcpCredentials.id],
      name: "mcp_servers_environment_credential_fk",
    }).onDelete("restrict"),
    uniqueIndex("mcp_servers_environment_slug_idx").on(
      table.environmentId,
      table.slug
    ),
    uniqueIndex("mcp_servers_provider_key_idx").on(table.providerKey),
    index("mcp_servers_environment_status_idx").on(
      table.environmentId,
      table.status
    ),
    check(
      "mcp_servers_source_check",
      sql`(
        (${table.sourceType} = 'remote' and ${table.transport} = 'streamable_http' and ${table.remoteUrl} is not null and ${table.ociImageReference} is null and ${table.ociDigest} is null)
        or
        (${table.sourceType} = 'oci' and ${table.remoteUrl} is null and ${table.ociImageReference} is not null and ${table.ociDigest} ~ '^sha256:[0-9a-f]{64}$' and ${table.ociImageReference} like '%@sha256:%')
      )`
    ),
    check(
      "mcp_servers_auth_check",
      sql`(
        (${table.authMode} = 'none' and ${table.credentialId} is null)
        or
        (${table.authMode} <> 'none' and ${table.credentialId} is not null)
      )`
    ),
    check(
      "mcp_servers_resource_limits_check",
      sql`${table.cpuMillicores} > 0 and ${table.memoryMib} > 0 and ${table.pidsLimit} > 0`
    ),
  ]
);

export const mcpCapabilitySnapshots = pgTable(
  "mcp_capability_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    protocolVersion: text("protocol_version").notNull(),
    capabilityDigest: text("capability_digest").notNull(),
    serverInfo: jsonb("server_info").$type<Record<string, unknown>>(),
    status: text("status", {
      enum: ["pending_review", "approved", "rejected", "superseded"],
    })
      .notNull()
      .default("pending_review"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_capability_snapshots_server_digest_idx").on(
      table.serverId,
      table.capabilityDigest
    ),
    index("mcp_capability_snapshots_server_status_idx").on(
      table.serverId,
      table.status
    ),
    uniqueIndex("mcp_capability_snapshots_approved_server_idx")
      .on(table.serverId)
      .where(sql`${table.status} = 'approved'`),
  ]
);

export const mcpDiscoveryJobs = pgTable(
  "mcp_discovery_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed"],
    })
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "mcp_discovery_jobs_organization_environment_fk",
    }).onDelete("cascade"),
    uniqueIndex("mcp_discovery_jobs_active_server_idx")
      .on(table.serverId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("mcp_discovery_jobs_status_created_idx").on(
      table.status,
      table.createdAt
    ),
  ]
);

export const mcpCapabilities = pgTable(
  "mcp_capabilities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => mcpCapabilitySnapshots.id, { onDelete: "cascade" }),
    providerKey: text("provider_key")
      .notNull()
      .references(() => toolProviders.key, { onDelete: "cascade" }),
    toolCapabilityKey: text("tool_capability_key"),
    kind: text("kind", {
      enum: [
        "tool",
        "resource",
        "resource_template",
        "prompt",
        "root",
        "sampling",
        "elicitation",
        "completion",
        "logging",
        "task",
      ],
    }).notNull(),
    capabilityKey: text("capability_key").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    environmentEnabled: boolean("environment_enabled").notNull().default(false),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_capabilities_snapshot_kind_key_idx").on(
      table.snapshotId,
      table.kind,
      table.capabilityKey
    ),
    foreignKey({
      columns: [table.providerKey, table.toolCapabilityKey],
      foreignColumns: [toolCapabilities.providerKey, toolCapabilities.key],
      name: "mcp_capabilities_tool_capability_fk",
    }).onDelete("cascade"),
    index("mcp_capabilities_provider_enabled_idx").on(
      table.providerKey,
      table.environmentEnabled
    ),
    check(
      "mcp_capabilities_tool_projection_check",
      sql`(
        (${table.kind} = 'tool' and ${table.toolCapabilityKey} is not null)
        or
        (${table.kind} <> 'tool' and ${table.toolCapabilityKey} is null)
      )`
    ),
  ]
);

export const mcpProjectCapabilityRestrictions = pgTable(
  "mcp_project_capability_restrictions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    capabilityId: text("capability_id")
      .notNull()
      .references(() => mcpCapabilities.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.capabilityId] }),
    index("mcp_project_capability_restrictions_capability_idx").on(
      table.capabilityId
    ),
  ]
);

export const mcpProjectResourceReferences = pgTable(
  "mcp_project_resource_references",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    resourceUri: text("resource_uri").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_project_resource_references_uri_idx").on(
      table.projectId,
      table.serverId,
      table.resourceUri
    ),
    index("mcp_project_resource_references_server_idx").on(table.serverId),
  ]
);

export const mcpRunGrants = pgTable(
  "mcp_run_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runExecutionId: text("run_execution_id")
      .notNull()
      .references(() => environmentRunExecutions.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    policyDigest: text("policy_digest").notNull(),
    effectiveCapabilities: jsonb("effective_capabilities")
      .$type<string[]>()
      .notNull(),
    effectivePolicy: jsonb("effective_policy")
      .$type<
        Array<{
          capabilityId: string;
          approvalMode: "auto" | "ask";
        }>
      >()
      .notNull(),
    status: text("status", {
      enum: ["issued", "active", "revoked", "expired"],
    })
      .notNull()
      .default("issued"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_run_grants_run_execution_idx").on(table.runExecutionId),
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "mcp_run_grants_organization_environment_fk",
    }).onDelete("cascade"),
    index("mcp_run_grants_expiry_status_idx").on(table.expiresAt, table.status),
    check(
      "mcp_run_grants_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
  ]
);

export const mcpInvocations = pgTable(
  "mcp_invocations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    grantId: text("grant_id")
      .notNull()
      .references(() => mcpRunGrants.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "restrict" }),
    capabilityId: text("capability_id").references(() => mcpCapabilities.id, {
      onDelete: "restrict",
    }),
    requestId: text("request_id").notNull(),
    method: text("method").notNull(),
    requestDigest: text("request_digest").notNull(),
    responseDigest: text("response_digest"),
    status: text("status", {
      enum: [
        "requested",
        "waiting_approval",
        "waiting_sampling",
        "waiting_elicitation",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("requested"),
    replayEvidence: jsonb("replay_evidence").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_invocations_grant_request_idx").on(
      table.grantId,
      table.requestId
    ),
    index("mcp_invocations_server_created_idx").on(
      table.serverId,
      table.createdAt
    ),
    index("mcp_invocations_status_created_idx").on(
      table.status,
      table.createdAt
    ),
  ]
);

export const mcpInteractionCheckpoints = pgTable(
  "mcp_interaction_checkpoints",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => mcpInvocations.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sampling", "elicitation"] }).notNull(),
    status: text("status", {
      enum: [
        "requested",
        "approved",
        "processing",
        "denied",
        "completed",
        "failed",
      ],
    })
      .notNull()
      .default("requested"),
    requestEnvelope: jsonb("request_envelope")
      .$type<Record<string, unknown>>()
      .notNull(),
    responseEnvelope:
      jsonb("response_envelope").$type<Record<string, unknown>>(),
    replayCursor: jsonb("replay_cursor")
      .$type<Record<string, unknown>>()
      .notNull(),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    processingExpiresAt: timestamp("processing_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_interaction_checkpoints_invocation_idx").on(
      table.invocationId
    ),
    index("mcp_interaction_checkpoints_thread_status_idx").on(
      table.threadId,
      table.status
    ),
    index("mcp_interaction_checkpoints_processing_expiry_idx")
      .on(table.processingExpiresAt)
      .where(sql`${table.status} = 'processing'`),
  ]
);

/**
 * User-visible interaction ledger shared by runtime waits and hosted MCP.
 * Source-specific checkpoints remain the execution authority; this table is
 * the durable Thread presentation and response contract keyed by request ID.
 */
export const threadInteractions = pgTable(
  "thread_interactions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    requestId: text("request_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => threadTurns.id, {
      onDelete: "cascade",
    }),
    assistantMessageId: text("assistant_message_id").references(
      () => threadMessages.id,
      { onDelete: "set null" }
    ),
    source: text("source", { enum: ["runtime", "mcp"] }).notNull(),
    sourceCheckpointId: text("source_checkpoint_id").references(
      () => mcpInteractionCheckpoints.id,
      { onDelete: "cascade" }
    ),
    kind: text("kind", {
      enum: [
        "user_input",
        "approval",
        "mcp_sampling",
        "mcp_elicitation",
      ],
    }).notNull(),
    eventType: text("event_type").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: ["pending", "processing", "resolved", "cancelled", "failed"],
    })
      .notNull()
      .default("pending"),
    requestEnvelope: jsonb("request_envelope")
      .$type<Record<string, unknown>>()
      .notNull(),
    responseEnvelope: jsonb("response_envelope").$type<
      Record<string, unknown>
    >(),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("thread_interactions_request_idx").on(table.requestId),
    uniqueIndex("thread_interactions_source_checkpoint_idx").on(
      table.sourceCheckpointId
    ),
    index("thread_interactions_thread_status_idx").on(
      table.threadId,
      table.status
    ),
    index("thread_interactions_turn_idx").on(table.turnId),
    check(
      "thread_interactions_source_contract_check",
      sql`(
        (${table.source} = 'runtime' AND ${table.turnId} IS NOT NULL AND ${table.sourceCheckpointId} IS NULL)
        OR
        (${table.source} = 'mcp' AND ${table.sourceCheckpointId} IS NOT NULL)
      )`
    ),
  ]
);

export const environmentCapabilitySubjectRestrictions = pgTable(
  "environment_capability_subject_restrictions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: ["actor", "agent"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    providerKey: text("provider_key").notNull(),
    capabilityKey: text("capability_key").notNull(),
    resourceId: text("resource_id").references(
      () => toolConnectionResources.id,
      { onDelete: "cascade" }
    ),
    enabled: boolean("enabled").notNull().default(false),
    approvalMode: text("approval_mode", { enum: ["auto", "ask", "deny"] })
      .notNull()
      .default("deny"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("environment_capability_subject_resource_idx")
      .on(
        table.environmentId,
        table.subjectType,
        table.subjectId,
        table.providerKey,
        table.capabilityKey,
        table.resourceId
      )
      .where(sql`${table.resourceId} is not null`),
    uniqueIndex("environment_capability_subject_unscoped_idx")
      .on(
        table.environmentId,
        table.subjectType,
        table.subjectId,
        table.providerKey,
        table.capabilityKey
      )
      .where(sql`${table.resourceId} is null`),
    foreignKey({
      columns: [table.providerKey, table.capabilityKey],
      foreignColumns: [toolCapabilities.providerKey, toolCapabilities.key],
      name: "environment_capability_subject_capability_fk",
    }).onDelete("cascade"),
    index("environment_capability_subject_lookup_idx").on(
      table.organizationId,
      table.environmentId,
      table.subjectType,
      table.subjectId
    ),
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
    environmentId: text("environment_id"),
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
    uniqueIndex("ai_gateways_org_shared_provider_display_name_idx")
      .on(table.organizationId, table.provider, table.displayName)
      .where(
        sql`${table.organizationId} IS NOT NULL AND ${table.environmentId} IS NULL`
      ),
    uniqueIndex("ai_gateways_environment_provider_display_name_idx")
      .on(table.environmentId, table.provider, table.displayName)
      .where(sql`${table.environmentId} IS NOT NULL`),
    index("ai_gateways_org_id_idx").on(table.organizationId),
    index("ai_gateways_environment_id_idx").on(table.environmentId),
    index("ai_gateways_enabled_idx").on(table.enabled),
    index("ai_gateways_provider_idx").on(table.provider),
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "ai_gateways_organization_environment_fk",
    }).onDelete("restrict"),
    check(
      "ai_gateways_environment_scope_check",
      sql`${table.environmentId} IS NULL OR ${table.organizationId} IS NOT NULL`
    ),
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

export const environmentAiModelDefaults = pgTable(
  "environment_ai_model_defaults",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").notNull(),
    modality: text("modality", {
      enum: ["language", "image", "speech", "video", "embedding"],
    }).notNull(),
    modelId: text("model_id")
      .notNull()
      .references(() => aiGatewayModels.id, { onDelete: "cascade" }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...knowledgeTimestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.modality] }),
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "environment_ai_model_defaults_organization_environment_fk",
    }).onDelete("cascade"),
    index("environment_ai_model_defaults_model_idx").on(table.modelId),
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
    environmentId: text("environment_id").notNull(),
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
    uniqueIndex("ai_deployments_active_environment_profile_idx")
      .on(table.environmentId, table.profileId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("ai_deployments_provider_endpoint_idx").on(
      table.providerEndpointId
    ),
    index("ai_deployments_org_id_idx").on(table.organizationId),
    index("ai_deployments_environment_id_idx").on(table.environmentId),
    index("ai_deployments_status_idx").on(table.status),
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [environments.organizationId, environments.id],
      name: "ai_deployments_organization_environment_fk",
    }).onDelete("restrict"),
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
export type OrganizationFeatureFlag = InferSelectModel<
  typeof organizationFeatureFlags
>;
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
export type ThreadTurn = InferSelectModel<typeof threadTurns>;
export type ThreadTurnEvent = InferSelectModel<typeof threadTurnEvents>;
export type ThreadTurnQueueState = InferSelectModel<
  typeof threadTurnQueueState
>;
export type MobileDeviceRegistration = InferSelectModel<
  typeof mobileDeviceRegistrations
>;
export type MobilePushDelivery = InferSelectModel<typeof mobilePushDeliveries>;
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
export type Environment = InferSelectModel<typeof environments>;
export type EnvironmentWorkspace = InferSelectModel<
  typeof environmentWorkspaces
>;
export type ProjectEnvironmentBinding = InferSelectModel<
  typeof projectEnvironmentBindings
>;
export type ThreadExecutionBinding = InferSelectModel<
  typeof threadExecutionBindings
>;
export type EnvironmentOperation = InferSelectModel<
  typeof environmentOperations
>;
export type EnvironmentApplication = InferSelectModel<
  typeof environmentApplications
>;
export type WorkspaceBackup = InferSelectModel<typeof workspaceBackups>;
export type ToolConnectionResource = InferSelectModel<
  typeof toolConnectionResources
>;
export type UserToolConnection = InferSelectModel<typeof userToolConnections>;
export type UserToolConnectionResource = InferSelectModel<
  typeof userToolConnectionResources
>;
export type AppDefinition = InferSelectModel<typeof appDefinitions>;
export type AppCapability = InferSelectModel<typeof appCapabilities>;
export type AppInstallation = InferSelectModel<typeof appInstallations>;
export type AppCredential = InferSelectModel<typeof appCredentials>;
export type AppConnection = InferSelectModel<typeof appConnections>;
export type AppConnectionResource = InferSelectModel<
  typeof appConnectionResources
>;
export type EnvironmentAppCapabilityGrant = InferSelectModel<
  typeof environmentAppCapabilityGrants
>;
export type ProjectApp = InferSelectModel<typeof projectApps>;
export type ProjectAppConnection = InferSelectModel<
  typeof projectAppConnections
>;
export type ProjectAppCapabilityPolicy = InferSelectModel<
  typeof projectAppCapabilityPolicies
>;
export type EnvironmentCapabilityGrant = InferSelectModel<
  typeof environmentCapabilityGrants
>;
export type ProjectCapabilityRestriction = InferSelectModel<
  typeof projectCapabilityRestrictions
>;
export type McpCredential = InferSelectModel<typeof mcpCredentials>;
export type McpOauthAuthorization = InferSelectModel<
  typeof mcpOauthAuthorizations
>;
export type McpServer = InferSelectModel<typeof mcpServers>;
export type McpCapabilitySnapshot = InferSelectModel<
  typeof mcpCapabilitySnapshots
>;
export type McpCapability = InferSelectModel<typeof mcpCapabilities>;
export type McpProjectCapabilityRestriction = InferSelectModel<
  typeof mcpProjectCapabilityRestrictions
>;
export type McpProjectResourceReference = InferSelectModel<
  typeof mcpProjectResourceReferences
>;
export type McpRunGrant = InferSelectModel<typeof mcpRunGrants>;
export type McpInvocation = InferSelectModel<typeof mcpInvocations>;
export type McpInteractionCheckpoint = InferSelectModel<
  typeof mcpInteractionCheckpoints
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
