import type { SessionStore } from "../kestrel/contracts/store.js";
import type { RunnerHost } from "../../cli/runner/RunnerHost.js";
import {
  KestrelChatRuntime,
  createRuntimeFactoryWithStore,
  type KestrelRuntimeEnvironment,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { LocalCoreRuntimeEnvironmentResolver } from "./runtimeEnvironment.js";
import { DesktopAttachmentStore } from "./desktopAttachments.js";
import type { LocalCoreCredentialStore } from "./credentialStore.js";
import { randomUUID } from "node:crypto";
import { createLocalCoreMcpOAuthProviderFactory } from "./mcpOAuthProvider.js";
import { LocalCoreMicrosoft365Service } from "./microsoft365Service.js";
import { LocalCoreGoogleWorkspaceService } from "./googleWorkspaceService.js";

const sandboxCredentialRevisions = new WeakMap<LocalCoreCredentialStore, { secret: string; revision: string }>();

type RunnerRuntimeFactory = NonNullable<
  ConstructorParameters<typeof RunnerHost>[1]
>;

export interface LocalCoreRunnerRuntimeFactoryOptions {
  runtimeEnvironmentResolver?: LocalCoreRuntimeEnvironmentResolver | undefined;
  homePath?: string | undefined;
  credentialStore?: LocalCoreCredentialStore | undefined;
  sandboxCapabilityFetchImpl?: typeof fetch | undefined;
}

/**
 * Binds every profile runtime in one Local Core host to the same Core-owned
 * persistence handle. The host may create and retire profile runtimes, but it
 * cannot close the shared store; Local Core closes that resource at shutdown.
 */
export function createLocalCoreRunnerRuntimeFactory(
  store: SessionStore,
  options: LocalCoreRunnerRuntimeFactoryOptions = {},
): RunnerRuntimeFactory {
  const runtimeEnvironmentResolver = options.runtimeEnvironmentResolver;
  const runtimeFactory = createRuntimeFactoryWithStore(store, {
    enableUserTerminals: true,
    enableWorkspaceChanges: true,
    enableManagedWorktrees: true,
    ...(options.homePath !== undefined
      ? {
          managedWorktreeHomeDir: options.homePath,
          resolveAttachments: async (threadId, attachmentIds) =>
            await new DesktopAttachmentStore(options.homePath!).resolve(
              threadId,
              attachmentIds,
            ),
        }
      : {}),
    ...(runtimeEnvironmentResolver !== undefined
      ? {
          resolveEnvironment: (profile) =>
            resolveLocalCoreSandboxCapabilityEnvironment(
              runtimeEnvironmentResolver.resolve({
                modelProvider: profile.modelProvider ?? "openrouter",
                model: profile.model ?? "",
              }),
              options.credentialStore,
              options.sandboxCapabilityFetchImpl,
            ),
        }
      : {}),
  });
  return (
    profile,
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
  ) =>
    new KestrelChatRuntime(profile, runtimeFactory, {
      onRunLog,
      onProgress,
      onConsole,
      onReasoning,
      onTaskUpdate,
      onRunEvent,
    });
}

export function resolveLocalCoreSandboxCapabilityEnvironment(
  snapshot: ReturnType<LocalCoreRuntimeEnvironmentResolver["resolve"]>,
  credentialStore?: LocalCoreCredentialStore | undefined,
  sandboxCapabilityFetchImpl?: typeof fetch | undefined,
): KestrelRuntimeEnvironment {
  const tenantId = snapshot.runtimeEnv.KESTREL_TENANT_ID?.trim();
  const environmentId = snapshot.runtimeEnv.KESTREL_ENVIRONMENT_ID?.trim();
  const brokerAuthorityId = snapshot.runtimeEnv.KESTREL_SANDBOX_BROKER_AUTHORITY_ID?.trim();
  const brokerAuthorityRevision = snapshot.runtimeEnv.KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION?.trim();
  const environmentTavilyCredential = snapshot.internetEnv.TAVILY_API_KEY?.trim();
  return {
    modelEnv: snapshot.modelEnv as NodeJS.ProcessEnv,
    internetEnv: snapshot.internetEnv as NodeJS.ProcessEnv,
    runtimeEnv: snapshot.runtimeEnv as NodeJS.ProcessEnv,
    mcpEnv: snapshot.mcpEnv as NodeJS.ProcessEnv,
    ...(tenantId && environmentId
      ? { sandboxCapabilityAudience: { tenantId, environmentId } }
      : {}),
    ...(brokerAuthorityId && brokerAuthorityRevision
      ? { sandboxCapabilityBrokerAuthority: { authorityId: brokerAuthorityId, revision: brokerAuthorityRevision } }
      : {}),
    ...(credentialStore?.available === true ? {
      sandboxCapabilityCredentialResolver: async () => {
        const secret = await credentialStore.get("tool.tavily.default");
        if (secret === undefined) throw new Error("Authoritative Local Core Tavily credential is missing.");
        const revision = await resolveLocalCredentialRevision(credentialStore, secret);
        return { credentialId: "tool.tavily.default" as const, revision, secret };
      },
    } : environmentTavilyCredential === undefined || environmentTavilyCredential.length === 0 ? {} : {
      sandboxCapabilityCredentialResolver: (() => {
        const revision = `local-core:opaque:${randomUUID()}`;
        return async () => ({
          credentialId: "tool.tavily.default" as const,
          revision,
          secret: environmentTavilyCredential,
        });
      })(),
    }),
    ...(sandboxCapabilityFetchImpl === undefined ? {} : { sandboxCapabilityFetchImpl }),
    ...(credentialStore !== undefined
      ? {
          mcpOAuthProviderFactory:
            createLocalCoreMcpOAuthProviderFactory(credentialStore),
          ...(credentialStore.available
            ? {
                microsoft365Service: new LocalCoreMicrosoft365Service({
                  credentialStore,
                }),
                googleWorkspaceService: new LocalCoreGoogleWorkspaceService({
                  credentialStore,
                }),
              }
            : {}),
        }
      : {}),
  };
}

async function resolveLocalCredentialRevision(
  credentialStore: LocalCoreCredentialStore,
  secret: string,
): Promise<string> {
  const revisionProvider = credentialStore as LocalCoreCredentialStore & {
    getRevision?: ((id: "tool.tavily.default") => Promise<string | undefined>) | undefined;
  };
  const ownedRevision = await revisionProvider.getRevision?.("tool.tavily.default");
  if (ownedRevision !== undefined && ownedRevision.trim().length > 0) {
    return `local-core:store:${ownedRevision.trim()}`;
  }
  const prior = sandboxCredentialRevisions.get(credentialStore);
  if (prior?.secret === secret) return prior.revision;
  const revision = `local-core:opaque:${randomUUID()}`;
  sandboxCredentialRevisions.set(credentialStore, { secret, revision });
  return revision;
}
