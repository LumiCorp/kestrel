import type {
  DesktopBrowserPersonalDomainProjectionV1,
  DesktopSettings,
} from "./contracts.js";
import type { KestrelOneAccountStatus } from "../../../src/localCore/kestrelOneAccount.js";
import {
  projectDesktopBrowserPersonalDomains,
  revokeDesktopBrowserPersonalDomain,
  type DesktopBrowserPersonalDomainMutationResult,
} from "./settingsStore.js";

export interface DesktopBrowserPersonalDomainServiceDependencies {
  resolveAccount(): Promise<KestrelOneAccountStatus>;
  readSettings(): Promise<DesktopSettings>;
  persistSettings(settings: DesktopSettings): Promise<void>;
  adoptionCoordinator: DesktopBrowserPersonalRevisionAdoptionCoordinator;
}

export interface DesktopBrowserPersonalRevisionAdoptionCoordinator {
  /**
   * Resolves only after every active Desktop Browser Session in the exact
   * personal scope has installed personalRevision and closed connections that
   * the revision no longer authorizes.
   */
  adoptPersonalRevision(input: {
    accountId: string;
    environmentId: string;
    personalRevision: number;
    threadId?: string | undefined;
    sessionId?: string | undefined;
  }): Promise<{
    personalRevision: number;
    closedUnauthorizedConnections: number;
  }>;
}

/**
 * Main-process authority boundary for personal Browser domains. Account IDs are
 * always resolved from the live signed-in account and never accepted from IPC.
 */
export class DesktopBrowserPersonalDomainService {
  readonly #dependencies: DesktopBrowserPersonalDomainServiceDependencies;
  #tail: Promise<void> = Promise.resolve();

  constructor(dependencies: DesktopBrowserPersonalDomainServiceDependencies) {
    this.#dependencies = dependencies;
  }

  list(
    environmentId: string,
  ): Promise<DesktopBrowserPersonalDomainProjectionV1> {
    return this.#serialize(async () => {
      const scope = await this.#resolveScope(environmentId);
      return projectDesktopBrowserPersonalDomains(
        await this.#dependencies.readSettings(),
        scope,
      );
    });
  }

  revoke(input: {
    environmentId: string;
    canonicalDomain: string;
    revokedAt?: string | undefined;
  }): Promise<DesktopBrowserPersonalDomainProjectionV1> {
    return this.#serialize(async () => {
      const scope = await this.#resolveScope(input.environmentId);
      const current = await this.#dependencies.readSettings();
      const mutation = revokeDesktopBrowserPersonalDomain(current, {
        ...scope,
        canonicalDomain: input.canonicalDomain,
        revokedAt: input.revokedAt ?? new Date().toISOString(),
      });
      return await this.#persistAndAdopt(scope, mutation);
    });
  }

  /** Orders sign-out after prior mutations and before any later Browser read. */
  signOut(
    action: () => Promise<KestrelOneAccountStatus>,
  ): Promise<KestrelOneAccountStatus> {
    return this.#serialize(action);
  }

  async #resolveScope(environmentIdInput: string): Promise<{
    accountId: string;
    environmentId: string;
  }> {
    const environmentId = canonicalText(environmentIdInput, "Environment ID");
    const account = await this.#dependencies.resolveAccount();
    if (account.status !== "signed_in") {
      throw new Error(
        "Kestrel One sign-in is required for personal Browser domains.",
      );
    }
    if (
      !account.projection.projects.some(
        (project) => project.environmentId === environmentId,
      )
    ) {
      throw new Error(
        "The selected Environment is not available to the signed-in account.",
      );
    }
    return {
      accountId: canonicalText(
        account.projection.account.id,
        "Kestrel One account ID",
      ),
      environmentId,
    };
  }

  async #assertScopeUnchanged(scope: {
    accountId: string;
    environmentId: string;
  }): Promise<void> {
    const current = await this.#resolveScope(scope.environmentId);
    if (current.accountId !== scope.accountId) {
      throw new Error(
        "The signed-in Kestrel One account changed before Browser settings were saved.",
      );
    }
  }

  async #persistAndAdopt(
    scope: { accountId: string; environmentId: string },
    mutation: DesktopBrowserPersonalDomainMutationResult,
  ): Promise<DesktopBrowserPersonalDomainProjectionV1> {
    if (mutation.disposition !== "unchanged") {
      await this.#assertScopeUnchanged(scope);
      await this.#dependencies.persistSettings(mutation.settings);
    }
    await this.#assertScopeUnchanged(scope);
    const confirmation =
      await this.#dependencies.adoptionCoordinator.adoptPersonalRevision({
        ...scope,
        personalRevision: mutation.projection.revision,
      });
    if (
      confirmation.personalRevision !== mutation.projection.revision ||
      !Number.isSafeInteger(confirmation.closedUnauthorizedConnections) ||
      confirmation.closedUnauthorizedConnections < 0
    ) {
      throw new Error(
        "Desktop Browser Sessions did not confirm the exact personal-domain revision.",
      );
    }
    await this.#assertScopeUnchanged(scope);
    const projection = projectDesktopBrowserPersonalDomains(
      await this.#dependencies.readSettings(),
      scope,
    );
    if (projection.revision !== mutation.projection.revision) {
      throw new Error(
        "Desktop Browser personal-domain settings changed during revision adoption.",
      );
    }
    return projection;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function canonicalText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
