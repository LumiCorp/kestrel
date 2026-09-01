import {
  BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  resolveEffectiveBrowserDomainAuthority,
  resolveBrowserPublicGrantDecision,
  type BrowserEffectiveDomainAuthorityV1,
  type BrowserEnvironmentDomainAuthorityV1,
  type BrowserProjectDomainAuthorityV1,
} from "../browser/domainAuthority.js";
import {
  DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
  type DesktopBrowserPersonalDomainProjectionV1,
  type DesktopBrowserPersonalDomainsV1,
} from "../desktopShell/contracts.js";
import {
  projectDesktopBrowserPersonalDomainAuthority,
  rememberDesktopBrowserPersonalDomainAuthority,
} from "../desktopShell/browserPersonalDomains.js";
import type {
  DesktopBrowserAuthorityResolutionInput,
  DesktopBrowserAuthorityResolver,
} from "./desktopBrowserService.js";
import type { LocalCoreDesktopEnvironmentManager } from "./desktopEnvironmentConnector.js";
import type { LocalCoreKestrelOneAccountManager } from "./kestrelOneAccount.js";
import {
  mutateLocalCoreLocalSettings,
  readLocalCoreLocalSettings,
} from "./localSettings.js";

const DESKTOP_OPERATOR_QA_AUTHORITY = {
  version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  revision: "desktop-operator-no-qa",
  target: null,
} as const;

interface ResolvedDesktopBrowserAuthority {
  authority: BrowserEffectiveDomainAuthorityV1;
  personalRevision: number;
  environment: BrowserEnvironmentDomainAuthorityV1;
  project: BrowserProjectDomainAuthorityV1;
  personal: DesktopBrowserPersonalDomainProjectionV1;
  personalDomains: DesktopBrowserPersonalDomainsV1;
}

export class LocalCoreDesktopBrowserAuthorityResolver
  implements DesktopBrowserAuthorityResolver {
  constructor(
    private readonly dependencies: {
      homePath: string;
      account: Pick<LocalCoreKestrelOneAccountManager, "account">;
      environments: Pick<LocalCoreDesktopEnvironmentManager, "snapshot">;
    },
  ) {}

  async resolve(
    input: DesktopBrowserAuthorityResolutionInput,
  ): Promise<BrowserEffectiveDomainAuthorityV1> {
    return (await this.#resolveWithPersonalRevision(input)).authority;
  }

  async resolveForPersonalRevision(
    input: DesktopBrowserAuthorityResolutionInput & {
      accountId: string;
      environmentId: string;
    },
  ): Promise<{
    authority: BrowserEffectiveDomainAuthorityV1;
    personalRevision: number;
  }> {
    const resolved = await this.#resolveWithPersonalRevision(input);
    if (
      resolved.authority.userId !== input.accountId ||
      resolved.authority.environmentId !== input.environmentId
    ) {
      throw new Error("Desktop Browser personal revision belongs to another identity.");
    }
    return {
      authority: resolved.authority,
      personalRevision: resolved.personalRevision,
    };
  }

  async rememberPersonalDomain(
    input: DesktopBrowserAuthorityResolutionInput & {
      destination: string;
      approvalId: string;
    },
  ): Promise<BrowserEffectiveDomainAuthorityV1> {
    return await mutateLocalCoreLocalSettings(
      this.dependencies.homePath,
      async (settings) => {
        // Resolve identity and policy after entering the settings mutation
        // boundary. A grant is therefore evaluated against the latest account,
        // Environment, Project, and personal-domain state immediately before it
        // is persisted.
        const current = await this.#resolveWithPersonalRevision(input, settings);
        const personalDomains = (settings.browserPersonalDomains ?? {
          version: DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
          partitions: [],
        }) as DesktopBrowserPersonalDomainsV1;
        const personal = projectDesktopBrowserPersonalDomainAuthority(
          personalDomains,
          {
            accountId: current.authority.userId,
            environmentId: current.authority.environmentId,
          },
        );
        const decision = resolveBrowserPublicGrantDecision(
          {
            environment: current.environment,
            project: current.project,
            personal: personal.authority,
            qa: DESKTOP_OPERATOR_QA_AUTHORITY,
          },
          input.destination,
          input.mode,
        );
        if (decision.decision === "already_allowed") {
          return {
            settings,
            result: resolveEffectiveBrowserDomainAuthority({
              environment: current.environment,
              project: current.project,
              personal: personal.authority,
              qa: DESKTOP_OPERATOR_QA_AUTHORITY,
            }),
          };
        }
        if (decision.decision !== "approval_required") {
          throw new Error(
            "BROWSER_GRANT_DENIED: Browser domain grant is blocked by current policy.",
          );
        }
        const mutation = rememberDesktopBrowserPersonalDomainAuthority(
          personalDomains,
          {
            accountId: current.authority.userId,
            environmentId: current.authority.environmentId,
            destination: input.destination,
            approvalId: input.approvalId,
            approvedAt: new Date().toISOString(),
          },
        );
        return {
          settings:
            mutation.disposition === "unchanged"
              ? settings
              : {
                  ...settings,
                  browserPersonalDomains: mutation.value,
                },
          result: resolveEffectiveBrowserDomainAuthority({
            environment: current.environment,
            project: current.project,
            personal: mutation.projection.authority,
            qa: DESKTOP_OPERATOR_QA_AUTHORITY,
          }),
        };
      },
    );
  }

  async #resolveWithPersonalRevision(
    input: DesktopBrowserAuthorityResolutionInput,
    settingsOverride?: Record<string, unknown> | undefined,
  ): Promise<ResolvedDesktopBrowserAuthority> {
    if (input.projectId === undefined) {
      throw new Error("Desktop Browser operator authority requires an exact Project.");
    }
    const [account, environments, settings] = await Promise.all([
      this.dependencies.account.account(),
      this.dependencies.environments.snapshot(),
      settingsOverride === undefined
        ? readLocalCoreLocalSettings(this.dependencies.homePath)
        : Promise.resolve(settingsOverride),
    ]);
    if (account.status !== "signed_in") {
      throw new Error("Desktop Browser operator authority requires Kestrel One sign-in.");
    }
    const workspaceMatches = environments.environments.flatMap((environment) =>
      environment.workspaces
        .filter((workspace) => workspace.available && workspace.projectId === input.projectId)
        .map((workspace) => ({ environment, workspace })),
    );
    if (workspaceMatches.length !== 1) {
      throw new Error("Desktop Browser Project has no unique trusted Environment mapping.");
    }
    const mapping = workspaceMatches[0]!;
    const projectMatches = account.projection.projects.filter(
      (project) =>
        project.id === input.projectId &&
        project.organizationId === mapping.environment.organizationId &&
        project.environmentId === mapping.environment.environmentId &&
        project.desktopWorkspaceRef === mapping.workspace.workspaceRef &&
        account.projection.organizations.some(
          (organization) => organization.organizationId === project.organizationId,
        ),
    );
    if (projectMatches.length !== 1 || projectMatches[0]?.browserAuthority === undefined) {
      throw new Error("Desktop Browser Project policy is unavailable for the signed-in account.");
    }
    const accountProject = projectMatches[0]!;
    const browserAuthority = accountProject.browserAuthority;
    if (browserAuthority === undefined) {
      throw new Error("Desktop Browser Project policy is unavailable for the signed-in account.");
    }
    if (
      browserAuthority.environment.environmentId !==
        mapping.environment.environmentId ||
      browserAuthority.project.projectId !== accountProject.id
    ) {
      throw new Error("Desktop Browser policy projection does not match its trusted Project mapping.");
    }
    const personalDomains = (settings.browserPersonalDomains ?? {
        version: DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
        partitions: [],
      }) as DesktopBrowserPersonalDomainsV1;
    const personalProjection = projectDesktopBrowserPersonalDomainAuthority(
      personalDomains,
      {
        accountId: account.projection.account.id,
        environmentId: mapping.environment.environmentId,
      },
    );
    return {
      authority: resolveEffectiveBrowserDomainAuthority({
        environment: browserAuthority.environment,
        project: browserAuthority.project,
        personal: personalProjection.authority,
        qa: DESKTOP_OPERATOR_QA_AUTHORITY,
      }),
      personalRevision: personalProjection.revision,
      environment: browserAuthority.environment,
      project: browserAuthority.project,
      personal: personalProjection,
      personalDomains,
    };
  }
}
