import { isLocalCoreModelRoleReady } from "../../../../src/localCore/modelReadiness";
import {
  parseLocalCoreModelReadiness,
  type LocalCoreModelReadiness,
} from "../../../../src/localCore/contracts";

export type LegacyDesktopAdvertisedModel = {
  provider: string;
  model: string;
  health: "ready" | "unavailable";
};

export type DesktopAdvertisedModel =
  | LegacyDesktopAdvertisedModel
  | LocalCoreModelReadiness;

/**
 * Legacy advertisements remain inspectable, but a health flag was never
 * capability proof. Only a parsed Local Core V2 projection can grant a role.
 */
export function isDesktopModelRoleReady(input: {
  model: unknown;
  provider: string;
  modelId: string;
  role?: string | undefined;
}): boolean {
  try {
    const readiness = parseLocalCoreModelReadiness(input.model);
    if (
      readiness.registration.providerId !== input.provider ||
      readiness.registration.modelId !== input.modelId
    ) {
      return false;
    }
    return isLocalCoreModelRoleReady(readiness, input.role);
  } catch {
    return false;
  }
}

export function readDesktopModelIdentity(
  value: unknown,
): { provider: string; model: string } | undefined {
  try {
    const readiness = parseLocalCoreModelReadiness(value);
    return {
      provider: readiness.registration.providerId,
      model: readiness.registration.modelId,
    };
  } catch {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as LegacyDesktopAdvertisedModel).provider === "string" &&
      typeof (value as LegacyDesktopAdvertisedModel).model === "string"
    ) {
      return {
        provider: (value as LegacyDesktopAdvertisedModel).provider,
        model: (value as LegacyDesktopAdvertisedModel).model,
      };
    }
    return;
  }
}
