import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { buildMobilePushMessage } from "@/lib/mobile/push-payload";
import { syncDurableTurnInteractionState } from "@/lib/turns/store";

const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_EXPO_BATCH_SIZE = 100;

type ExpoPushTicket = {
  status?: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

function pushEnabled() {
  return process.env.KESTREL_ONE_EXPO_PUSH_ENABLED === "true";
}

function pushHeaders() {
  const accessToken = process.env.KESTREL_ONE_EXPO_ACCESS_TOKEN?.trim();
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function disableUnregisteredDevice(deviceId: string) {
  await knowledgeDb
    .update(schema.mobileDeviceRegistrations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(schema.mobileDeviceRegistrations.id, deviceId));
}

export async function dispatchPendingMobilePushNotifications() {
  if (!pushEnabled()) {
    return { dispatched: 0, skipped: true };
  }
  const pending = await knowledgeDb
    .select({
      delivery: schema.mobilePushDeliveries,
      token: schema.mobileDeviceRegistrations.expoPushToken,
      deviceEnabled: schema.mobileDeviceRegistrations.enabled,
    })
    .from(schema.mobilePushDeliveries)
    .innerJoin(
      schema.mobileDeviceRegistrations,
      eq(
        schema.mobileDeviceRegistrations.id,
        schema.mobilePushDeliveries.deviceRegistrationId
      )
    )
    .where(eq(schema.mobilePushDeliveries.status, "pending"))
    .limit(MAX_EXPO_BATCH_SIZE);
  const deliverable = pending.filter((row) => row.deviceEnabled);
  if (deliverable.length === 0) {
    return { dispatched: 0, skipped: false };
  }
  const response = await fetch(EXPO_PUSH_SEND_URL, {
    method: "POST",
    headers: pushHeaders(),
    body: JSON.stringify(
      deliverable.map(({ delivery, token }) =>
        buildMobilePushMessage({
          token,
          kind: delivery.kind,
          organizationId: delivery.organizationId,
          threadId: delivery.threadId,
          turnId: delivery.turnId,
        })
      )
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Expo Push Service returned HTTP ${response.status}.`);
  }
  const result = (await response.json()) as {
    data?: ExpoPushTicket[] | ExpoPushTicket;
  };
  const tickets = Array.isArray(result.data)
    ? result.data
    : result.data
      ? [result.data]
      : [];
  for (const [index, row] of deliverable.entries()) {
    const ticket = tickets[index];
    const deviceUnregistered = ticket?.details?.error === "DeviceNotRegistered";
    await knowledgeDb
      .update(schema.mobilePushDeliveries)
      .set({
        status:
          ticket?.status === "ok"
            ? "accepted"
            : deviceUnregistered
              ? "device_unregistered"
              : "failed",
        expoTicketId: ticket?.id ?? null,
        errorCode: ticket?.details?.error ?? null,
        errorMessage: ticket?.message?.slice(0, 1000) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mobilePushDeliveries.id, row.delivery.id));
    if (deviceUnregistered) {
      await disableUnregisteredDevice(row.delivery.deviceRegistrationId);
    }
  }
  return { dispatched: deliverable.length, skipped: false };
}

export async function reconcileMobilePushReceipts() {
  if (!pushEnabled()) {
    return { reconciled: 0, skipped: true };
  }
  const accepted = await knowledgeDb
    .select()
    .from(schema.mobilePushDeliveries)
    .where(
      and(
        eq(schema.mobilePushDeliveries.status, "accepted"),
        isNotNull(schema.mobilePushDeliveries.expoTicketId)
      )
    )
    .limit(MAX_EXPO_BATCH_SIZE);
  const withTickets = accepted.filter(
    (delivery): delivery is typeof delivery & { expoTicketId: string } =>
      Boolean(delivery.expoTicketId)
  );
  if (withTickets.length === 0) {
    return { reconciled: 0, skipped: false };
  }
  const response = await fetch(EXPO_PUSH_RECEIPTS_URL, {
    method: "POST",
    headers: pushHeaders(),
    body: JSON.stringify({ ids: withTickets.map((row) => row.expoTicketId) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Expo Push receipts returned HTTP ${response.status}.`);
  }
  const result = (await response.json()) as {
    data?: Record<string, ExpoPushTicket>;
  };
  for (const delivery of withTickets) {
    const receipt = result.data?.[delivery.expoTicketId];
    if (!receipt) {
      continue;
    }
    const deviceUnregistered = receipt.details?.error === "DeviceNotRegistered";
    await knowledgeDb
      .update(schema.mobilePushDeliveries)
      .set({
        status:
          receipt.status === "ok"
            ? "delivered"
            : deviceUnregistered
              ? "device_unregistered"
              : "failed",
        errorCode: receipt.details?.error ?? null,
        errorMessage: receipt.message?.slice(0, 1000) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mobilePushDeliveries.id, delivery.id));
    if (deviceUnregistered) {
      await disableUnregisteredDevice(delivery.deviceRegistrationId);
    }
  }
  return { reconciled: withTickets.length, skipped: false };
}

export async function syncPendingMobileInteractions() {
  const activeTurns = await knowledgeDb
    .select({
      id: schema.threadTurns.id,
      executionId: schema.threadTurns.environmentExecutionId,
      status: schema.threadTurns.status,
    })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId)
    )
    .where(
      inArray(schema.threadTurns.status, ["running", "waiting_for_input"])
    );
  const executionIds = activeTurns
    .map((turn) => turn.executionId)
    .filter((id): id is string => Boolean(id));
  const pendingExecutions =
    executionIds.length > 0
      ? await knowledgeDb
          .select({ executionId: schema.mcpRunGrants.runExecutionId })
          .from(schema.mcpInteractionCheckpoints)
          .innerJoin(
            schema.mcpInvocations,
            eq(
              schema.mcpInvocations.id,
              schema.mcpInteractionCheckpoints.invocationId
            )
          )
          .innerJoin(
            schema.mcpRunGrants,
            eq(schema.mcpRunGrants.id, schema.mcpInvocations.grantId)
          )
          .where(
            and(
              inArray(schema.mcpRunGrants.runExecutionId, executionIds),
              inArray(schema.mcpInteractionCheckpoints.status, [
                "requested",
                "processing",
              ])
            )
          )
      : [];
  const waitingExecutionIds = new Set(
    pendingExecutions.map((row) => row.executionId)
  );
  for (const turn of activeTurns) {
    await syncDurableTurnInteractionState({
      turnId: turn.id,
      waiting:
        turn.executionId !== null && waitingExecutionIds.has(turn.executionId),
    });
  }
  return { synced: activeTurns.length };
}
