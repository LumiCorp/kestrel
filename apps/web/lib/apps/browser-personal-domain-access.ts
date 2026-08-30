import type {
  listHostedBrowserPersonalDomains,
  revokeHostedBrowserPersonalDomain,
  HostedBrowserPersonalDomainMutationResult,
  HostedBrowserPersonalDomainSummary,
} from "./browser-domain-service";

export interface HostedBrowserAllowlistAdoptionCoordinator {
  /**
   * Resolves only after every active Browser Session in this exact personal
   * scope has installed the effective allowlist derived from personalRevision.
   * Session discovery and revision calculation remain owned by the hosted
   * Browser service that implements this interface.
   */
  adoptPersonalDomainRevision(input: {
    organizationId: string;
    environmentId: string;
    userId: string;
    personalRevision: number;
  }): Promise<{
    personalRevision: number;
    adoptedSessions: readonly {
      sessionId: string;
      effectiveRevision: string;
      closedUnauthorizedConnections: number;
    }[];
  }>;
}

export class HostedBrowserPersonalDomainAccessError extends Error {
  constructor(
    readonly code:
      | "BROWSER_PERSONAL_DOMAIN_SCOPE_NOT_FOUND"
      | "BROWSER_ALLOWLIST_ADOPTION_UNAVAILABLE"
      | "BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED",
    message: string,
  ) {
    super(message);
    this.name = "HostedBrowserPersonalDomainAccessError";
  }
}

type PersonalDomainScope = {
  organizationId: string;
  environmentId: string;
  userId: string;
};

export interface PersonalDomainAccessDependencies {
  findEnvironment(input: {
    organizationId: string;
    environmentId: string;
  }): Promise<unknown | null | undefined>;
  listDomains: typeof listHostedBrowserPersonalDomains;
  revokeDomain: typeof revokeHostedBrowserPersonalDomain;
  adoptionCoordinator: HostedBrowserAllowlistAdoptionCoordinator | null;
}

/**
 * Issue 03 supplies the separate Desktop adoption path. Issue 05 replaces this
 * adapter when hosted Kestrel One Browser Sessions can first become active.
 */
export const noActiveHostedBrowserSessionsAllowlistAdoptionCoordinator:
  HostedBrowserAllowlistAdoptionCoordinator = {
  async adoptPersonalDomainRevision(input) {
    return {
      personalRevision: input.personalRevision,
      adoptedSessions: [],
    };
  },
};

export const hostedBrowserAllowlistAdoptionCoordinator:
  | HostedBrowserAllowlistAdoptionCoordinator
  | null = noActiveHostedBrowserSessionsAllowlistAdoptionCoordinator;

export async function listPersonalBrowserDomainsForSignedInUser(
  input: PersonalDomainScope,
  dependencies: PersonalDomainAccessDependencies,
): Promise<readonly HostedBrowserPersonalDomainSummary[]> {
  await requireEnvironmentInOrganization(input, dependencies);
  return dependencies.listDomains(input);
}

export async function revokePersonalBrowserDomainForSignedInUser(
  input: PersonalDomainScope & { destination: string },
  dependencies: PersonalDomainAccessDependencies,
): Promise<HostedBrowserPersonalDomainMutationResult> {
  await requireEnvironmentInOrganization(input, dependencies);
  const coordinator = dependencies.adoptionCoordinator;
  if (!coordinator) {
    throw new HostedBrowserPersonalDomainAccessError(
      "BROWSER_ALLOWLIST_ADOPTION_UNAVAILABLE",
      "Browser allowlist adoption is temporarily unavailable.",
    );
  }

  const mutation = await dependencies.revokeDomain(input);
  const confirmation = await coordinator.adoptPersonalDomainRevision({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    userId: input.userId,
    personalRevision: mutation.personalRevision,
  });
  if (
    confirmation.personalRevision !== mutation.personalRevision ||
    confirmation.adoptedSessions.some(
      (session) =>
        typeof session.sessionId !== "string" ||
        session.sessionId.trim().length === 0 ||
        typeof session.effectiveRevision !== "string" ||
        session.effectiveRevision.trim().length === 0 ||
        typeof session.closedUnauthorizedConnections !== "number" ||
        !Number.isSafeInteger(session.closedUnauthorizedConnections) ||
        session.closedUnauthorizedConnections < 0,
    )
  ) {
    throw new HostedBrowserPersonalDomainAccessError(
      "BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED",
      "Browser allowlist adoption could not be confirmed.",
    );
  }
  return mutation;
}

async function requireEnvironmentInOrganization(
  input: PersonalDomainScope,
  dependencies: Pick<PersonalDomainAccessDependencies, "findEnvironment">,
) {
  const environment = await dependencies.findEnvironment({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!environment) {
    throw new HostedBrowserPersonalDomainAccessError(
      "BROWSER_PERSONAL_DOMAIN_SCOPE_NOT_FOUND",
      "Environment not found.",
    );
  }
  return environment;
}
