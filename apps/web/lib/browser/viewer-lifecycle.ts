import type { HostedBrowserViewerLifecyclePort } from "./viewer-service";
import type { HostedBrowserStore } from "./store";

export async function composeHostedBrowserViewerLifecycle(input: {
  environmentReady: boolean;
  createReady(): Promise<HostedBrowserViewerLifecyclePort>;
  createCleanupSafe(): HostedBrowserViewerLifecyclePort;
}): Promise<HostedBrowserViewerLifecyclePort> {
  return input.environmentReady
    ? await input.createReady()
    : input.createCleanupSafe();
}

export function createCleanupSafeHostedBrowserViewerLifecycle(input: {
  store: Pick<HostedBrowserStore, "markTerminal" | "read" | "resolveCurrentOrigin">;
  authority: { organizationId: string; environmentId: string; userId: string };
  now?: (() => Date) | undefined;
}): HostedBrowserViewerLifecyclePort {
  return {
    async terminateViewerSession(termination) {
      const record = await input.store.read(termination.sessionId);
      if (
        !record?.resource ||
        record.session.generation !== termination.generation ||
        (record.session.state !== "ready" &&
          record.session.state !== "human_control")
      ) throw new Error("BROWSER_SESSION_LOST");
      const origin = await input.store.resolveCurrentOrigin(
        termination.sessionId,
      );
      if (
        origin.organizationId !== input.authority.organizationId ||
        origin.environmentId !== input.authority.environmentId ||
        origin.userId !== input.authority.userId
      ) throw new Error("BROWSER_SESSION_LOST");
      await input.store.markTerminal({
        sessionId: record.session.sessionId,
        expectedGeneration: termination.generation,
        expectedMachineId: record.resource.machineId,
        state: termination.reason === "closed_by_user" ? "closed" : "lost",
        reason: termination.reason,
        now: (input.now ?? (() => new Date()))(),
      });
    },
  };
}
