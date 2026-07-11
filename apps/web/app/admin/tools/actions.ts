"use server";

import type { ActionResult } from "@/lib/actions";
import {
  runAdminToolProviderTest,
  saveAdminDiscordBinding,
  saveAdminToolCapability,
  saveAdminToolProvider,
} from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { getRequestOrigin } from "@/lib/server/request";
import type { ToolCapabilityPolicy } from "@/lib/tools/types";

export async function patchAdminToolProviderAction(input: {
  enabled: boolean;
  providerKey: string;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const origin = await getRequestOrigin();

    await saveAdminToolProvider({
      actorUserId: session.user.id,
      enabled: input.enabled,
      organizationId,
      origin,
      providerKey: input.providerKey,
    });

    return {
      ok: true,
      message: "Tool provider saved.",
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to update tool provider",
    };
  }
}

export async function patchAdminToolCapabilityAction(input: {
  capabilityKey: string;
  policy: ToolCapabilityPolicy;
  providerKey: string;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const origin = await getRequestOrigin();

    await saveAdminToolCapability({
      actorUserId: session.user.id,
      capabilityKey: input.capabilityKey,
      organizationId,
      origin,
      patch: input.policy,
      providerKey: input.providerKey,
    });

    return {
      ok: true,
      message: "Tool capability saved.",
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to update capability",
    };
  }
}

export async function testAdminToolProviderAction(input: {
  providerKey: string;
}): Promise<ActionResult<{ testedAt: string }>> {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const origin = await getRequestOrigin();
    const result = await runAdminToolProviderTest({
      actorUserId: session.user.id,
      organizationId,
      origin,
      providerKey: input.providerKey,
    });

    return {
      ok: true,
      data: {
        testedAt: result.testedAt,
      },
      message: "Tool provider tested.",
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to test tool provider",
    };
  }
}

export async function saveAdminDiscordBindingAction(input: {
  enabled: boolean;
  guildId: string;
  guildName?: string | null;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireAdminOrganization();

    await saveAdminDiscordBinding({
      actorUserId: session.user.id,
      enabled: input.enabled,
      guildId: input.guildId,
      guildName: input.guildName ?? null,
      organizationId,
    });

    return {
      ok: true,
      message: "Discord binding saved.",
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to save Discord binding",
    };
  }
}
