import {
  isRunnerExpectedResponseEvent,
  parseRunnerCommandV2,
  parseRunnerEventV2,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerProfile,
} from "@kestrel-agents/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueDesktopEnvironmentCommand } from "./desktop";
import {
  composeKestrelOneProfile,
  fingerprintResolvedProfile,
  KESTREL_ONE_POLICY_ID,
  KESTREL_ONE_POLICY_VERSION,
  KESTREL_ONE_ENVIRONMENT_PRESETS,
  type KestrelOneProfileOverlay,
} from "../../../../src/profile/kestrelOnePolicy";

const POLL_INTERVAL_MS = 250;
const DEFAULT_DESKTOP_PROFILE: RunnerProfile = {
  id: "kestrel",
  label: "Kestrel",
  agent: "kestrel",
  sessionPrefix: "kestrel",
  defaultInteractionMode: "build",
};

export function createDesktopEnvironmentRunnerFetch(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  executionId: string;
  actorUserId: string;
}): typeof fetch {
  const resolvedProfiles = new Map<string, RunnerProfile>();
  const runnerFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    let command: RunnerCommand;
    try {
      command = parseRunnerCommandV2(
        JSON.parse(String(init?.body ?? "{}")) as unknown,
      );
      assertCommandAuthority(command, input);
    } catch (error) {
      return jsonResponse(
        runnerErrorEvent({
          commandId: "unknown",
          code: "DESKTOP_COMMAND_INVALID",
          message: errorMessage(error),
        }),
        400,
      );
    }

    if (command.type === "profile.get") {
      const profile = command.payload.profileId === DEFAULT_DESKTOP_PROFILE.id
        ? DEFAULT_DESKTOP_PROFILE
        : resolvedProfiles.get(command.payload.profileId);
      if (profile === undefined) {
        return jsonResponse(
          runnerErrorEvent({
            commandId: command.id,
            code: "PROFILE_NOT_FOUND",
            message: `Profile '${command.payload.profileId}' was not found.`,
          }),
          404,
        );
      }
      return jsonResponse(
        parseRunnerEventV2({
          id: crypto.randomUUID(),
          type: "profile.loaded",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            profile,
          },
        }),
      );
    }
    if (command.type === "profile.list") {
      return jsonResponse(
        parseRunnerEventV2({
          id: crypto.randomUUID(),
          type: "profile.listed",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: { profiles: [DEFAULT_DESKTOP_PROFILE, ...resolvedProfiles.values()] },
        }),
      );
    }
    if (command.type === "execution-profile.resolve") {
      if (
        command.payload.environmentPresetId !== "workspace_hosted" ||
        command.payload.authoringProfileId !== undefined
      ) {
        return jsonResponse(
          runnerErrorEvent({
            commandId: command.id,
            code: "DESKTOP_EXECUTION_PROFILE_INVALID",
            message: "Desktop Environment accepts only server-managed workspace profiles.",
          }),
          400,
        );
      }
      try {
        const composed = composeKestrelOneProfile({
          environmentPresetId: "workspace_hosted",
          overlay: command.payload.managedConfiguration as
            | KestrelOneProfileOverlay
            | undefined,
        });
        const fingerprint = fingerprintResolvedProfile(composed.profile);
        const profile = structuredClone(composed.profile) as RunnerProfile;
        resolvedProfiles.set(profile.id, profile);
        return jsonResponse(
          parseRunnerEventV2({
            id: crypto.randomUUID(),
            type: "execution-profile.resolved",
            ts: new Date().toISOString(),
            commandId: command.id,
            payload: {
              version: 1,
              profileId: profile.id,
              fingerprint,
              policy: {
                id: KESTREL_ONE_POLICY_ID,
                version: KESTREL_ONE_POLICY_VERSION,
              },
              environmentPreset: {
                id: "workspace_hosted",
                version: KESTREL_ONE_ENVIRONMENT_PRESETS.workspace_hosted.version,
              },
              resolvedProfile: profile,
            },
          }),
        );
      } catch (error) {
        return jsonResponse(
          runnerErrorEvent({
            commandId: command.id,
            code: "DESKTOP_EXECUTION_PROFILE_INVALID",
            message: errorMessage(error),
          }),
          400,
        );
      }
    }
    if (command.type === "run.cancel") {
      await requestDesktopExecutionCancellation({
        executionId: input.executionId,
      });
      return jsonResponse(
        parseRunnerEventV2({
          id: crypto.randomUUID(),
          type: "run.cancelled",
          ts: new Date().toISOString(),
          commandId: command.id,
          runId: command.payload.runId,
          sessionId: command.payload.sessionId,
          payload: {
            sessionId: command.payload.sessionId,
            result: {
              assistantText: "",
              finalizedPayload: null,
              output: {
                status: "CANCELLED",
                sessionId: command.payload.sessionId,
                runId: command.payload.runId ?? input.executionId,
                errors: [],
              },
            },
          },
        }),
      );
    }
    if (command.type !== "run.start") {
      return jsonResponse(
        runnerErrorEvent({
          commandId: command.id,
          code: "DESKTOP_COMMAND_UNSUPPORTED",
          message: `Desktop Environment does not support '${command.type}' through this route.`,
        }),
        400,
      );
    }

    let authoritativeCommand: Extract<RunnerCommand, { type: "run.start" }>;
    try {
      authoritativeCommand = materializeDesktopRunStartProfile(
        command,
        resolvedProfiles,
      );
    } catch (error) {
      return jsonResponse(
        runnerErrorEvent({
          commandId: command.id,
          code: "DESKTOP_EXECUTION_PROFILE_INVALID",
          message: errorMessage(error),
        }),
        400,
      );
    }
    const queued = await enqueueDesktopEnvironmentCommand({
      id: command.id,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      payload: authoritativeCommand as unknown as Record<string, unknown>,
    });
    if (!queued) {
      return jsonResponse(
        runnerErrorEvent({
          commandId: command.id,
          code: "DESKTOP_COMMAND_QUEUE_FAILED",
          message: "Desktop Environment command could not be queued.",
        }),
        500,
      );
    }
    return streamDesktopCommand(command, input.executionId);
  };
  return runnerFetch as typeof fetch;
}

export function materializeDesktopRunStartProfile(
  command: Extract<RunnerCommand, { type: "run.start" }>,
  resolvedProfiles: ReadonlyMap<string, RunnerProfile>,
): Extract<RunnerCommand, { type: "run.start" }> {
  if (command.payload.profile !== undefined) {
    throw new Error("Desktop run.start requires a server-resolved profile identity.");
  }
  const profile = resolvedProfiles.get(command.payload.profileId);
  if (profile === undefined) {
    throw new Error(
      `Desktop execution profile '${command.payload.profileId}' was not resolved for this execution.`,
    );
  }
  return parseRunnerCommandV2({
    ...command,
    payload: {
      profile: structuredClone(profile),
      turn: command.payload.turn,
    },
  }) as Extract<RunnerCommand, { type: "run.start" }>;
}

async function requestDesktopExecutionCancellation(input: {
  executionId: string;
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const command =
      await transaction.query.desktopEnvironmentCommands.findFirst({
        where: (table, { eq }) => eq(table.executionId, input.executionId),
      });
    if (!command) return;
    if (command.status === "queued") {
      await transaction
        .update(schema.desktopEnvironmentCommands)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.desktopEnvironmentCommands.id, command.id));
      await transaction
        .update(schema.environmentRunExecutions)
        .set({ status: "cancelled", completedAt: now, updatedAt: now })
        .where(eq(schema.environmentRunExecutions.id, input.executionId));
      return;
    }
    if (command.status === "claimed" || command.status === "running") {
      await transaction
        .update(schema.desktopEnvironmentCommands)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(eq(schema.desktopEnvironmentCommands.id, command.id));
    }
  });
}

function streamDesktopCommand(
  command: Extract<RunnerCommand, { type: "run.start" }>,
  executionId: string,
): Response {
  const encoder = new TextEncoder();
  let cursor = 0;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      while (!closed) {
        const events =
          await knowledgeDb.query.desktopEnvironmentCommandEvents.findMany({
            where: (table, { and, eq, gt }) =>
              and(eq(table.commandId, command.id), gt(table.sequence, cursor)),
            orderBy: (table, { asc }) => [asc(table.sequence)],
          });
        for (const row of events) {
          const event = parseRunnerEventV2(row.event);
          if (!isRunnerExpectedResponseEvent(command.type, event)) {
            controller.error(
              new Error(
                `Desktop runner returned unexpected event '${event.type}'.`,
              ),
            );
            closed = true;
            return;
          }
          cursor = row.sequence;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        const current =
          await knowledgeDb.query.desktopEnvironmentCommands.findFirst({
            where: (table, { eq }) => eq(table.id, command.id),
          });
        if (
          current &&
          ["completed", "failed", "cancelled"].includes(current.status)
        ) {
          if (
            events.length === 0 &&
            (current.status === "failed" || current.status === "cancelled")
          ) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(
                  current.status === "cancelled"
                    ? runnerCancelledEvent(command, executionId)
                    : runnerErrorEvent({
                        commandId: command.id,
                        code: current.failureCode ?? "DESKTOP_RUN_FAILED",
                        message:
                          current.failureMessage ??
                          "Desktop Environment execution failed.",
                      }),
                )}\n\n`,
              ),
            );
          }
          closed = true;
          controller.close();
          return;
        }
        await delay(POLL_INTERVAL_MS);
      }
    },
    cancel() {
      closed = true;
      return requestDesktopExecutionCancellation({
        executionId,
      });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

function runnerCancelledEvent(
  command: Extract<RunnerCommand, { type: "run.start" }>,
  executionId: string,
): RunnerEvent {
  return parseRunnerEventV2({
    id: crypto.randomUUID(),
    type: "run.cancelled",
    ts: new Date().toISOString(),
    commandId: command.id,
    runId: executionId,
    sessionId: command.payload.turn.sessionId,
    payload: {
      sessionId: command.payload.turn.sessionId,
      runId: executionId,
      result: {
        assistantText: "",
        finalizedPayload: null,
        output: {
          status: "CANCELLED",
          sessionId: command.payload.turn.sessionId,
          runId: executionId,
          errors: [],
        },
      },
    },
  });
}

function assertCommandAuthority(
  command: RunnerCommand,
  input: {
    organizationId: string;
    actorUserId: string;
  },
) {
  if (
    command.metadata?.tenantId !== input.organizationId ||
    command.metadata.actor?.tenantId !== input.organizationId ||
    command.metadata.actor.actorId !== input.actorUserId
  ) {
    throw new Error("Desktop command actor or organization does not match.");
  }
}

function runnerErrorEvent(input: {
  commandId: string;
  code: string;
  message: string;
}): RunnerEvent {
  return parseRunnerEventV2({
    id: crypto.randomUUID(),
    type: "runner.error",
    ts: new Date().toISOString(),
    commandId: input.commandId,
    payload: {
      code: input.code,
      message: input.message,
    },
  });
}

function jsonResponse(event: RunnerEvent, status = 200): Response {
  return new Response(JSON.stringify(event), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
