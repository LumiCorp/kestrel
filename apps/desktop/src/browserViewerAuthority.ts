import type { DesktopBrowserViewerAuthorityJournal } from "./browserViewerAuthorityJournal.js";

export interface DesktopBrowserViewerPrincipal {
  senderId: number;
  principalId: string;
  threadId: string;
  projectId: string;
  sessionId: string;
  generation: number;
  connectionId: string;
}

export type DesktopBrowserViewerAuthorityLossReason =
  | "app_disabled"
  | "desktop_stopped"
  | "principal_replaced"
  | "renderer_crashed"
  | "renderer_restarted"
  | "thread_unavailable"
  | "window_closed";

interface PendingDesktopBrowserViewerAuthorityLoss {
  principal: DesktopBrowserViewerPrincipal;
  reason: DesktopBrowserViewerAuthorityLossReason;
}

export interface DesktopBrowserViewerAuthoritySnapshot {
  current: DesktopBrowserViewerPrincipal | undefined;
  pending: PendingDesktopBrowserViewerAuthorityLoss | undefined;
}

export class DesktopBrowserViewerAuthorityCoordinator {
  readonly #loseAuthority: (
    principal: DesktopBrowserViewerPrincipal,
    reason: DesktopBrowserViewerAuthorityLossReason,
  ) => Promise<void>;
  readonly #journal: DesktopBrowserViewerAuthorityJournal | undefined;
  readonly #initialization: Promise<void>;
  #current: DesktopBrowserViewerPrincipal | undefined;
  #pending: PendingDesktopBrowserViewerAuthorityLoss | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: {
    loseAuthority(
      principal: DesktopBrowserViewerPrincipal,
      reason: DesktopBrowserViewerAuthorityLossReason,
    ): Promise<void>;
    journal?: DesktopBrowserViewerAuthorityJournal | undefined;
  }) {
    this.#loseAuthority = input.loseAuthority;
    this.#journal = input.journal;
    this.#initialization = this.#restore();
    void this.#initialization.catch(() => undefined);
  }

  current(): DesktopBrowserViewerPrincipal | undefined {
    return this.#current;
  }

  snapshot(): DesktopBrowserViewerAuthoritySnapshot {
    return {
      current: this.#current === undefined ? undefined : { ...this.#current },
      pending:
        this.#pending === undefined
          ? undefined
          : {
              principal: { ...this.#pending.principal },
              reason: this.#pending.reason,
            },
    };
  }

  async connect<T>(input: {
    senderId: number;
    principalId: string;
    threadId: string;
    projectId: string;
    connect(expected: DesktopBrowserViewerPrincipal | undefined): Promise<{
      value: T;
      principal?: DesktopBrowserViewerPrincipal | undefined;
      previousSessionTerminal?: boolean | undefined;
    }>;
  }): Promise<T> {
    return await this.#serialize(async () => {
      await this.#flushPending();
      const current = this.#current;
      if (
        current !== undefined &&
        (current.senderId !== input.senderId ||
          current.principalId !== input.principalId ||
          current.threadId !== input.threadId ||
          current.projectId !== input.projectId)
      ) {
        await this.#stageLoss(current, "principal_replaced");
        await this.#flushPending();
      }

      const connected = await input.connect(this.#current);
      if (connected.principal === undefined) {
        if (connected.previousSessionTerminal === true) {
          if (this.#current !== undefined) {
            await this.#journal?.clear(this.#current);
          }
          this.#current = undefined;
        }
        return connected.value;
      }
      const retained = this.#current;
      if (
        retained !== undefined &&
        !sameDesktopBrowserViewerPrincipal(retained, connected.principal)
      ) {
        throw new Error(
          "Desktop Browser viewer connection identity changed while the prior principal remained authoritative.",
        );
      }
      try {
        await this.#journal?.recordCurrent(connected.principal);
      } catch (persistenceError) {
        try {
          await this.#loseAuthority(connected.principal, "desktop_stopped");
        } catch (cleanupError) {
          throw new AggregateError(
            [persistenceError, cleanupError],
            "Desktop Browser viewer authority could not be retained or revoked.",
          );
        }
        throw persistenceError;
      }
      this.#current = connected.principal;
      return connected.value;
    });
  }

  async loseCurrent(input: {
    expectedSenderId?: number | undefined;
    reason: DesktopBrowserViewerAuthorityLossReason;
    bestEffort?: boolean | undefined;
  }): Promise<void> {
    await this.#serialize(async () => {
      const current = this.#current;
      if (
        current !== undefined &&
        (input.expectedSenderId === undefined ||
          current.senderId === input.expectedSenderId)
      ) {
        await this.#stageLoss(current, input.reason);
      }
      try {
        await this.#flushPending();
      } catch (error) {
        if (input.bestEffort !== true) throw error;
      }
    });
  }

  async retryPending(): Promise<void> {
    await this.#serialize(async () => await this.#flushPending());
  }

  async releaseCurrent(
    expected: DesktopBrowserViewerPrincipal,
    release: () => Promise<void>,
  ): Promise<void> {
    await this.#serialize(async () => {
      await this.#flushPending();
      const current = this.#current;
      if (
        current === undefined ||
        !sameDesktopBrowserViewerPrincipal(current, expected)
      ) {
        throw new Error(
          "Desktop Browser viewer authority changed before it could be released.",
        );
      }
      await release();
      if (sameDesktopBrowserViewerPrincipal(this.#current, expected)) {
        await this.#journal?.clear(expected);
        this.#current = undefined;
      }
    });
  }

  async #stageLoss(
    principal: DesktopBrowserViewerPrincipal,
    reason: DesktopBrowserViewerAuthorityLossReason,
  ): Promise<void> {
    if (this.#pending !== undefined) {
      if (
        !sameDesktopBrowserViewerPrincipal(this.#pending.principal, principal)
      ) {
        throw new Error(
          "Desktop Browser viewer authority loss cannot drift to another principal.",
        );
      }
      return;
    }
    await this.#journal?.recordPending(principal, reason);
    this.#pending = { principal, reason };
  }

  async #flushPending(): Promise<void> {
    const pending = this.#pending;
    if (pending === undefined) return;
    await this.#loseAuthority(pending.principal, pending.reason);
    await this.#journal?.clear(pending.principal);
    if (this.#pending === pending) this.#pending = undefined;
    if (sameDesktopBrowserViewerPrincipal(this.#current, pending.principal)) {
      this.#current = undefined;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.#initialization;
      return await operation();
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #restore(): Promise<void> {
    const retained = await this.#journal?.load();
    if (retained === undefined) return;
    const reason = retained.pendingReason ?? "desktop_stopped";
    if (retained.pendingReason === undefined) {
      await this.#journal?.recordPending(retained.current, reason);
    }
    this.#current = retained.current;
    this.#pending = { principal: retained.current, reason };
  }
}

export function sameDesktopBrowserViewerPrincipal(
  left: DesktopBrowserViewerPrincipal | undefined,
  right: DesktopBrowserViewerPrincipal | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.senderId === right.senderId &&
    left.principalId === right.principalId &&
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.connectionId === right.connectionId
  );
}
