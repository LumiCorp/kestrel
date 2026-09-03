import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  browserFailure,
  parseBrowserSessionV1,
  type BrowserFailureCode,
  type BrowserSessionV1,
} from "../../../../src/browser/contracts.js";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const NONTERMINAL_STATES = [
  "opening",
  "ready",
  "human_control",
  "closing",
] as const;

export interface HostedBrowserOriginAuthority {
  organizationId: string;
  environmentId: string;
  projectId: string;
  threadId: string;
  runId: string;
  turnId: string;
  userId: string;
}

export interface HostedBrowserResourceRecord {
  sessionId: string;
  originatingTurnId: string;
  previewLeaseId: string | null;
  machineId: string;
  machineGeneration: number;
  workerImageDigest: string;
  proxyAuthorityRevision: string;
  cleanupRequestedAt: Date | null;
  cleanupConfirmedAt: Date | null;
}

export class HostedBrowserStore {
  constructor(private readonly database = knowledgeDb) {}

  async resolveOrigin(input: {
    runId: string;
    expectedExecutionId?: string | undefined;
    threadId: string;
    expectedOrganizationId: string;
    expectedEnvironmentId: string;
    expectedProjectId: string;
    expectedUserId: string;
  }): Promise<HostedBrowserOriginAuthority> {
    const execution =
      await this.database.query.environmentRunExecutions.findFirst({
        where: (table, { eq: equals }) => input.expectedExecutionId
          ? equals(table.id, input.expectedExecutionId)
          : equals(table.runtimeRunId, input.runId),
        columns: {
          id: true,
          runtimeRunId: true,
          organizationId: true,
          environmentId: true,
          projectId: true,
          threadId: true,
          actorId: true,
        },
      });
    if (!execution) {
      throw originUnavailable("execution_missing");
    }
    const executionMismatches: string[] = [];
    if (execution.runtimeRunId && execution.runtimeRunId !== input.runId) {
      executionMismatches.push("execution_runtime_run");
    }
    if (execution.threadId !== input.threadId) {
      executionMismatches.push("execution_thread");
    }
    if (execution.organizationId !== input.expectedOrganizationId) {
      executionMismatches.push("execution_organization");
    }
    if (execution.environmentId !== input.expectedEnvironmentId) {
      executionMismatches.push("execution_environment");
    }
    if (execution.projectId !== input.expectedProjectId) {
      executionMismatches.push("execution_project");
    }
    if (execution.actorId !== input.expectedUserId) {
      executionMismatches.push("execution_actor");
    }
    if (executionMismatches.length > 0) {
      throw originUnavailable(...executionMismatches);
    }
    const turn = await this.database.query.threadTurns.findFirst({
      where: (table, { eq: equals }) =>
        equals(table.environmentExecutionId, execution.id),
      columns: {
        id: true,
        threadId: true,
        organizationId: true,
        authorUserId: true,
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    if (!turn) throw originUnavailable("turn_binding_missing");
    const turnMismatches: string[] = [];
    if (turn.threadId !== input.threadId) {
      turnMismatches.push("turn_thread");
    }
    if (turn.organizationId !== input.expectedOrganizationId) {
      turnMismatches.push("turn_organization");
    }
    if (turn.authorUserId !== input.expectedUserId) {
      turnMismatches.push("turn_actor");
    }
    if (turnMismatches.length > 0) {
      throw originUnavailable(...turnMismatches);
    }
    if (!execution.projectId) throw originUnavailable("execution_project");
    return {
      organizationId: execution.organizationId,
      environmentId: execution.environmentId,
      projectId: execution.projectId,
      threadId: execution.threadId,
      runId: execution.id,
      turnId: turn.id,
      userId: execution.actorId,
    };
  }

  async createOpening(input: {
    session: BrowserSessionV1;
    origin: HostedBrowserOriginAuthority;
  }): Promise<void> {
    const session = parseBrowserSessionV1(input.session);
    if (
      session.state !== "opening" ||
      session.threadId !== input.origin.threadId
    ) {
      throw new Error("BROWSER_SERVICE_UNAVAILABLE");
    }
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:browser:${session.threadId}`}, 0))`,
      );
      const active = await transaction.query.browserSessions.findFirst({
        where: and(
          eq(schema.browserSessions.threadId, session.threadId),
          inArray(schema.browserSessions.state, [...NONTERMINAL_STATES]),
        ),
        columns: { sessionId: true },
      });
      if (active) throw new Error("BROWSER_SESSION_CONFLICT");
      await transaction
        .insert(schema.browserSessions)
        .values(toSessionRow(session));
    });
  }

  async attachMachine(input: {
    sessionId: string;
    originTurnId: string;
    machineId: string;
    previewLeaseId?: string | undefined;
    generation: number;
    workerImageDigest: string;
    proxyAuthorityRevision: string;
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [session] = await tx
        .select({
          state: schema.browserSessions.state,
          generation: schema.browserSessions.generation,
        })
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.sessionId, input.sessionId))
        .limit(1)
        .for("update");
      if (
        !session ||
        session.state !== "opening" ||
        session.generation !== input.generation
      ) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      const existing =
        await tx.query.browserSessionResources.findFirst({
          where: (table, { eq: equals }) =>
            equals(table.sessionId, input.sessionId),
        });
      if (existing) {
        if (
          existing.originatingTurnId === input.originTurnId &&
          existing.previewLeaseId === (input.previewLeaseId ?? null) &&
          existing.machineId === input.machineId &&
          existing.machineGeneration === input.generation &&
          existing.workerImageDigest === input.workerImageDigest &&
          existing.proxyAuthorityRevision === input.proxyAuthorityRevision &&
          existing.cleanupRequestedAt === null &&
          existing.cleanupConfirmedAt === null
        ) {
          return;
        }
        throw new Error("BROWSER_SESSION_LOST");
      }
      await tx.insert(schema.browserSessionResources).values({
        sessionId: input.sessionId,
        originatingTurnId: input.originTurnId,
        previewLeaseId: input.previewLeaseId ?? null,
        machineId: input.machineId,
        machineGeneration: input.generation,
        workerImageDigest: input.workerImageDigest,
        proxyAuthorityRevision: input.proxyAuthorityRevision,
      });
    });
  }

  async read(sessionId: string): Promise<{
    session: BrowserSessionV1;
    resource: HostedBrowserResourceRecord | null;
  } | null> {
    const session = await this.database.query.browserSessions.findFirst({
      where: (table, { eq: equals }) => equals(table.sessionId, sessionId),
    });
    if (!session) return null;
    const resource =
      await this.database.query.browserSessionResources.findFirst({
        where: (table, { eq: equals }) => equals(table.sessionId, sessionId),
      });
    return {
      session: parseBrowserSessionV1(fromSessionRow(session)),
      resource: resource
        ? {
            sessionId: resource.sessionId,
            originatingTurnId: resource.originatingTurnId,
            previewLeaseId: resource.previewLeaseId,
            machineId: resource.machineId,
            machineGeneration: resource.machineGeneration,
            workerImageDigest: resource.workerImageDigest,
            proxyAuthorityRevision: resource.proxyAuthorityRevision,
            cleanupRequestedAt: resource.cleanupRequestedAt,
            cleanupConfirmedAt: resource.cleanupConfirmedAt,
          }
        : null,
    };
  }

  async readActiveForThread(threadId: string): Promise<{
    session: BrowserSessionV1;
    resource: HostedBrowserResourceRecord | null;
  } | null> {
    const active = await this.database.query.browserSessions.findFirst({
      where: and(
        eq(schema.browserSessions.threadId, threadId),
        inArray(schema.browserSessions.state, [...NONTERMINAL_STATES]),
      ),
      columns: { sessionId: true },
    });
    return active ? this.read(active.sessionId) : null;
  }

  async resolveCurrentOrigin(
    sessionId: string,
  ): Promise<HostedBrowserOriginAuthority> {
    const resource =
      await this.database.query.browserSessionResources.findFirst({
        where: (table, { eq: equals }) => equals(table.sessionId, sessionId),
        columns: { originatingTurnId: true },
      });
    if (!resource) throw new Error("BROWSER_SESSION_LOST");
    const turn = await this.database.query.threadTurns.findFirst({
      where: (table, { eq: equals }) =>
        equals(table.id, resource.originatingTurnId),
      columns: {
        id: true,
        organizationId: true,
        threadId: true,
        authorUserId: true,
        environmentExecutionId: true,
      },
    });
    if (!turn?.environmentExecutionId) throw new Error("BROWSER_SESSION_LOST");
    return this.resolveOrigin({
      runId: await this.requireExecutionField(
        turn.environmentExecutionId,
        "runtimeRunId",
      ),
      threadId: turn.threadId,
      expectedOrganizationId: turn.organizationId,
      expectedEnvironmentId: await this.requireExecutionField(
        turn.environmentExecutionId,
        "environmentId",
      ),
      expectedProjectId: await this.requireExecutionField(
        turn.environmentExecutionId,
        "projectId",
      ),
      expectedUserId: turn.authorUserId,
    });
  }

  async updateSession(session: BrowserSessionV1): Promise<void> {
    const parsed = parseBrowserSessionV1(session);
    if (parsed.state !== "ready") throw new Error("BROWSER_SESSION_LOST");
    const updated = await this.database
      .update(schema.browserSessions)
      .set(toSessionRow(parsed))
      .where(
        and(
          eq(schema.browserSessions.sessionId, parsed.sessionId),
          eq(schema.browserSessions.generation, parsed.generation),
          eq(
            schema.browserSessions.effectiveAllowlistRevision,
            parsed.effectiveAllowlistRevision,
          ),
          eq(schema.browserSessions.state, "opening"),
        ),
      )
      .returning({ sessionId: schema.browserSessions.sessionId });
    if (updated.length !== 1) throw new Error("BROWSER_SESSION_LOST");
  }

  async touchActivity(
    sessionId: string,
    generation: number,
    now: Date,
  ): Promise<void> {
    const updated = await this.database
      .update(schema.browserSessions)
      .set({
        updatedAt: now,
        lastActivityAt: now,
        idleExpiresAt: sql`least(${schema.browserSessions.hardExpiresAt}, ${now.toISOString()}::timestamptz + interval '30 minutes')`,
      })
      .where(
        and(
          eq(schema.browserSessions.sessionId, sessionId),
          eq(schema.browserSessions.generation, generation),
          eq(schema.browserSessions.state, "ready"),
        ),
      )
      .returning({ sessionId: schema.browserSessions.sessionId });
    if (updated.length !== 1) throw new Error("BROWSER_SESSION_LOST");
  }

  async transitionViewerControl(input: {
    sessionId: string;
    generation: number;
    from: "ready" | "human_control";
    to: "ready" | "human_control";
    now: Date;
  }): Promise<BrowserSessionV1> {
    const [updated] = await this.database
      .update(schema.browserSessions)
      .set({
        state: input.to,
        updatedAt: input.now,
        lastActivityAt: input.now,
        idleExpiresAt: sql`least(${schema.browserSessions.hardExpiresAt}, ${input.now.toISOString()}::timestamptz + interval '30 minutes')`,
      })
      .where(
        and(
          eq(schema.browserSessions.sessionId, input.sessionId),
          eq(schema.browserSessions.generation, input.generation),
          eq(schema.browserSessions.state, input.from),
          sql`${schema.browserSessions.idleExpiresAt} > ${input.now.toISOString()}::timestamptz`,
          sql`${schema.browserSessions.hardExpiresAt} > ${input.now.toISOString()}::timestamptz`,
        ),
      )
      .returning();
    if (!updated) throw new Error("BROWSER_SESSION_LOST");
    return parseBrowserSessionV1(fromSessionRow(updated));
  }

  async adoptRevision(input: {
    sessionId: string;
    expectedRevision: string;
    revision: string;
    now: Date;
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      const updated = await tx
        .update(schema.browserSessions)
        .set({
          effectiveAllowlistRevision: input.revision,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(schema.browserSessions.sessionId, input.sessionId),
            eq(
              schema.browserSessions.effectiveAllowlistRevision,
              input.expectedRevision,
            ),
            inArray(schema.browserSessions.state, [
              "opening",
              "ready",
              "human_control",
            ]),
          ),
        )
        .returning({ sessionId: schema.browserSessions.sessionId });
      if (updated.length !== 1) throw new Error("BROWSER_SESSION_LOST");
      const resource = await tx
        .update(schema.browserSessionResources)
        .set({ proxyAuthorityRevision: input.revision })
        .where(
          and(
            eq(schema.browserSessionResources.sessionId, input.sessionId),
            eq(
              schema.browserSessionResources.proxyAuthorityRevision,
              input.expectedRevision,
            ),
          ),
        )
        .returning({ sessionId: schema.browserSessionResources.sessionId });
      if (resource.length !== 1) throw new Error("BROWSER_SESSION_LOST");
    });
  }

  async markTerminal(input: {
    sessionId: string;
    expectedGeneration?: number | undefined;
    expectedMachineId?: string | undefined;
    expectedState?: "opening" | undefined;
    state: "closed" | "expired" | "lost" | "failed";
    reason: BrowserFailureCode | "closed_by_user";
    now: Date;
  }): Promise<BrowserSessionV1> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.sessionId, input.sessionId))
        .limit(1)
        .for("update");
      if (
        !row ||
        (input.expectedState !== undefined && row.state !== input.expectedState) ||
        (input.expectedGeneration !== undefined &&
          row.generation !== input.expectedGeneration)
      ) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      if (input.expectedMachineId !== undefined) {
        const resource =
          await tx.query.browserSessionResources.findFirst({
            where: (table, { eq: equals }) =>
              equals(table.sessionId, input.sessionId),
            columns: { machineId: true },
          });
        if (resource?.machineId !== input.expectedMachineId) {
          throw new Error("BROWSER_SESSION_LOST");
        }
      }
      const current = parseBrowserSessionV1(fromSessionRow(row));
      if (
        !NONTERMINAL_STATES.includes(
          current.state as (typeof NONTERMINAL_STATES)[number],
        )
      ) {
        return current;
      }
      const terminal = parseBrowserSessionV1({
        ...current,
        state: input.state,
        terminalReason: input.reason,
        updatedAt: input.now.toISOString(),
      });
      const [updated] = await tx
        .update(schema.browserSessions)
        .set({
          state: terminal.state,
          terminalReason: terminal.terminalReason,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(schema.browserSessions.sessionId, input.sessionId),
            eq(schema.browserSessions.generation, current.generation),
            eq(schema.browserSessions.state, current.state),
          ),
        )
        .returning({ sessionId: schema.browserSessions.sessionId });
      if (!updated) throw new Error("BROWSER_SESSION_LOST");
      await tx
        .update(schema.browserSessionResources)
        .set({
          cleanupRequestedAt: sql`coalesce(${schema.browserSessionResources.cleanupRequestedAt}, ${input.now.toISOString()}::timestamptz)`,
          updatedAt: input.now,
        })
        .where(eq(schema.browserSessionResources.sessionId, input.sessionId));
      return terminal;
    });
  }

  async confirmCleanup(sessionId: string, now = new Date()): Promise<void> {
    await this.database
      .update(schema.browserSessionResources)
      .set({ cleanupConfirmedAt: now, updatedAt: now })
      .where(eq(schema.browserSessionResources.sessionId, sessionId));
  }

  async listForReconciliation(input?: {
    organizationId: string;
    environmentId: string;
    now: Date;
  }): Promise<
    Array<{
      session: BrowserSessionV1;
      resource: HostedBrowserResourceRecord | null;
    }>
  > {
    if (!input) throw new Error("BROWSER_RECONCILIATION_SCOPE_REQUIRED");
    const rows = await this.database
      .select({ sessionId: schema.browserSessions.sessionId })
      .from(schema.browserSessions)
      .leftJoin(
        schema.browserSessionResources,
        eq(
          schema.browserSessionResources.sessionId,
          schema.browserSessions.sessionId,
        ),
      )
      .leftJoin(
        schema.threadTurns,
        eq(
          schema.threadTurns.id,
          schema.browserSessionResources.originatingTurnId,
        ),
      )
      .leftJoin(
        schema.environmentRunExecutions,
        eq(
          schema.environmentRunExecutions.id,
          schema.threadTurns.environmentExecutionId,
        ),
      )
      .innerJoin(
        schema.threads,
        eq(schema.threads.id, schema.browserSessions.threadId),
      )
      .leftJoin(
        schema.projects,
        eq(schema.projects.id, schema.threads.projectId),
      )
      .where(
        and(
          or(
            inArray(schema.browserSessions.state, [...NONTERMINAL_STATES]),
            and(
              isNotNull(schema.browserSessionResources.sessionId),
              isNull(schema.browserSessionResources.cleanupConfirmedAt),
            ),
          ),
          or(
            and(
              isNotNull(schema.browserSessionResources.sessionId),
              eq(
                schema.environmentRunExecutions.organizationId,
                input.organizationId,
              ),
              eq(
                schema.environmentRunExecutions.environmentId,
                input.environmentId,
              ),
            ),
            and(
              isNull(schema.browserSessionResources.sessionId),
              eq(schema.threads.organizationId, input.organizationId),
              eq(schema.projects.environmentId, input.environmentId),
            ),
          ),
        ),
      )
      .orderBy(
        sql`case
          when ${schema.browserSessions.state} in ('closed', 'expired', 'lost', 'failed') then 0
          when ${schema.browserSessions.idleExpiresAt} <= ${input.now.toISOString()}::timestamptz
            or ${schema.browserSessions.hardExpiresAt} <= ${input.now.toISOString()}::timestamptz then 1
          when ${schema.browserSessions.state} = 'closing' then 2
          when ${schema.browserSessionResources.sessionId} is null then 3
          else 4
        end`,
        sql`coalesce(${schema.browserSessionResources.updatedAt}, ${schema.browserSessions.updatedAt}) asc`,
        schema.browserSessions.sessionId,
      )
      .limit(100);
    const records = await Promise.all(
      rows.map(async (row) => {
        const record = await this.read(row.sessionId);
        if (!record) throw new Error("BROWSER_SESSION_LOST");
        return record;
      }),
    );
    return records.filter(
      (record) =>
        NONTERMINAL_STATES.includes(
          record.session.state as (typeof NONTERMINAL_STATES)[number],
        ) || record.resource?.cleanupConfirmedAt === null,
    );
  }

  async recordReconciliationAttempt(sessionId: string, now: Date): Promise<void> {
    await this.database
      .update(schema.browserSessionResources)
      .set({ updatedAt: now })
      .where(
        and(
          eq(schema.browserSessionResources.sessionId, sessionId),
          isNull(schema.browserSessionResources.cleanupConfirmedAt),
        ),
      );
  }

  async listForPersonalAuthority(input: {
    organizationId: string;
    environmentId: string;
    userId: string;
  }): Promise<
    Array<{ session: BrowserSessionV1; resource: HostedBrowserResourceRecord }>
  > {
    const rows = await this.database
      .selectDistinct({ sessionId: schema.browserSessions.sessionId })
      .from(schema.browserSessions)
      .innerJoin(
        schema.browserSessionResources,
        eq(
          schema.browserSessionResources.sessionId,
          schema.browserSessions.sessionId,
        ),
      )
      .innerJoin(
        schema.threadTurns,
        eq(
          schema.threadTurns.id,
          schema.browserSessionResources.originatingTurnId,
        ),
      )
      .innerJoin(
        schema.environmentRunExecutions,
        eq(
          schema.environmentRunExecutions.id,
          schema.threadTurns.environmentExecutionId,
        ),
      )
      .where(
        and(
          eq(
            schema.environmentRunExecutions.organizationId,
            input.organizationId,
          ),
          eq(
            schema.environmentRunExecutions.environmentId,
            input.environmentId,
          ),
          eq(schema.environmentRunExecutions.actorId, input.userId),
          or(
            inArray(schema.browserSessions.state, [...NONTERMINAL_STATES]),
            isNull(schema.browserSessionResources.cleanupConfirmedAt),
          ),
        ),
      );
    const records = await Promise.all(
      rows.map(async (row) => {
        const record = await this.read(row.sessionId);
        if (!record?.resource) throw new Error("BROWSER_SESSION_LOST");
        return { session: record.session, resource: record.resource };
      }),
    );
    return records.filter(
      (record) =>
        NONTERMINAL_STATES.includes(
          record.session.state as (typeof NONTERMINAL_STATES)[number],
        ) || record.resource.cleanupConfirmedAt === null,
    );
  }

  async ownsPendingMachine(input: {
    organizationId: string;
    environmentId: string;
    machineId: string;
    browserSessionId?: string | undefined;
    browserGeneration?: number | undefined;
  }): Promise<boolean> {
    const [row] = await this.database
      .select({ sessionId: schema.browserSessionResources.sessionId })
      .from(schema.browserSessionResources)
      .innerJoin(
        schema.threadTurns,
        eq(
          schema.threadTurns.id,
          schema.browserSessionResources.originatingTurnId,
        ),
      )
      .innerJoin(
        schema.environmentRunExecutions,
        eq(
          schema.environmentRunExecutions.id,
          schema.threadTurns.environmentExecutionId,
        ),
      )
      .where(
        and(
          eq(schema.browserSessionResources.machineId, input.machineId),
          isNull(schema.browserSessionResources.cleanupConfirmedAt),
          eq(
            schema.environmentRunExecutions.organizationId,
            input.organizationId,
          ),
          eq(
            schema.environmentRunExecutions.environmentId,
            input.environmentId,
          ),
        ),
      )
      .limit(1);
    if (row) return true;
    if (!(input.browserSessionId && input.browserGeneration)) return false;
    const [opening] = await this.database
      .select({ sessionId: schema.browserSessions.sessionId })
      .from(schema.browserSessions)
      .innerJoin(
        schema.threads,
        eq(schema.threads.id, schema.browserSessions.threadId),
      )
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.threads.projectId),
      )
      .leftJoin(
        schema.browserSessionResources,
        eq(
          schema.browserSessionResources.sessionId,
          schema.browserSessions.sessionId,
        ),
      )
      .where(
        and(
          eq(schema.browserSessions.sessionId, input.browserSessionId),
          eq(schema.browserSessions.generation, input.browserGeneration),
          eq(schema.browserSessions.state, "opening"),
          eq(schema.threads.organizationId, input.organizationId),
          eq(schema.projects.environmentId, input.environmentId),
          isNull(schema.browserSessionResources.sessionId),
        ),
      )
      .limit(1);
    return Boolean(opening);
  }

  private async requireExecutionField(
    runId: string,
    field: "environmentId" | "projectId" | "runtimeRunId",
  ): Promise<string> {
    const execution =
      await this.database.query.environmentRunExecutions.findFirst({
        where: (table, { eq: equals }) => equals(table.id, runId),
        columns: { environmentId: true, projectId: true, runtimeRunId: true },
      });
    const value = execution?.[field];
    if (!value) throw new Error("BROWSER_SESSION_LOST");
    return value;
  }
}

function originUnavailable(...originMismatches: string[]) {
  return browserFailure(
    "BROWSER_SERVICE_UNAVAILABLE",
    "BROWSER_SERVICE_UNAVAILABLE",
    {
      browserOutcomeKnown: true,
      failureStage: "origin.store",
      originMismatches,
    },
  );
}

function toSessionRow(session: BrowserSessionV1) {
  return {
    sessionId: session.sessionId,
    version: session.version,
    threadId: session.threadId,
    mode: session.mode,
    state: session.state,
    engineRevision: session.engineRevision,
    generation: session.generation,
    effectiveAllowlistRevision: session.effectiveAllowlistRevision,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    lastActivityAt: new Date(session.lastActivityAt),
    idleExpiresAt: new Date(session.idleExpiresAt),
    hardExpiresAt: new Date(session.hardExpiresAt),
    terminalReason: session.terminalReason ?? null,
  };
}

function fromSessionRow(
  row: typeof schema.browserSessions.$inferSelect,
): BrowserSessionV1 {
  return {
    version: "browser_session_v1",
    sessionId: row.sessionId,
    threadId: row.threadId,
    mode: row.mode,
    state: row.state,
    engineRevision: row.engineRevision,
    generation: row.generation,
    effectiveAllowlistRevision: row.effectiveAllowlistRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    idleExpiresAt: row.idleExpiresAt.toISOString(),
    hardExpiresAt: row.hardExpiresAt.toISOString(),
    ...(row.terminalReason === null
      ? {}
      : {
          terminalReason:
            row.terminalReason as BrowserSessionV1["terminalReason"],
        }),
  };
}
