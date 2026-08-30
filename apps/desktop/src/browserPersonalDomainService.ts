import type {
  DesktopBrowserPersonalDomainProjectionV1,
  DesktopSettings,
} from "./contracts.js";
import type { KestrelOneAccountStatus } from "../../../src/localCore/kestrelOneAccount.js";
import {
  projectDesktopBrowserPersonalDomains,
  rememberDesktopBrowserPersonalDomain,
  revokeDesktopBrowserPersonalDomain,
} from "./settingsStore.js";

export interface DesktopBrowserPersonalDomainServiceDependencies {
  resolveAccount(): Promise<KestrelOneAccountStatus>;
  readSettings(): DesktopSettings;
  persistSettings(settings: DesktopSettings): Promise<void>;
}

export interface DesktopBrowserPersonalDomainRememberRequest {
  environmentId: string;
  destination: string;
  approvalId: string;
  approvedAt: string;
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

  list(environmentId: string): Promise<DesktopBrowserPersonalDomainProjectionV1> {
    return this.#serialize(async () => {
      const scope = await this.#resolveScope(environmentId);
      return projectDesktopBrowserPersonalDomains(
        this.#dependencies.readSettings(),
        scope,
      );
    });
  }

  remember(
    input: DesktopBrowserPersonalDomainRememberRequest,
  ): Promise<DesktopBrowserPersonalDomainProjectionV1> {
    return this.#serialize(async () => {
      const scope = await this.#resolveScope(input.environmentId);
      const current = this.#dependencies.readSettings();
      const mutation = rememberDesktopBrowserPersonalDomain(current, {
        ...scope,
        destination: input.destination,
        approvalId: input.approvalId,
        approvedAt: input.approvedAt,
      });
      if (mutation.disposition === "unchanged") return mutation.projection;
      await this.#assertScopeUnchanged(scope);
      await this.#dependencies.persistSettings(mutation.settings);
      await this.#assertScopeUnchanged(scope);
      return projectDesktopBrowserPersonalDomains(
        this.#dependencies.readSettings(),
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
      const current = this.#dependencies.readSettings();
      const mutation = revokeDesktopBrowserPersonalDomain(current, {
        ...scope,
        canonicalDomain: input.canonicalDomain,
        revokedAt: input.revokedAt ?? new Date().toISOString(),
      });
      if (mutation.disposition === "unchanged") return mutation.projection;
      await this.#assertScopeUnchanged(scope);
      await this.#dependencies.persistSettings(mutation.settings);
      await this.#assertScopeUnchanged(scope);
      return projectDesktopBrowserPersonalDomains(
        this.#dependencies.readSettings(),
        scope,
      );
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
      throw new Error("Kestrel One sign-in is required for personal Browser domains.");
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
      accountId: canonicalText(account.projection.account.id, "Kestrel One account ID"),
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
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
