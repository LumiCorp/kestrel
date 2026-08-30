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
  #current: DesktopBrowserViewerPrincipal | undefined;
  #pending: PendingDesktopBrowserViewerAuthorityLoss | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: {
    loseAuthority(
      principal: DesktopBrowserViewerPrincipal,
      reason: DesktopBrowserViewerAuthorityLossReason,
    ): Promise<void>;
  }) {
    this.#loseAuthority = input.loseAuthority;
  }

  current(): DesktopBrowserViewerPrincipal | undefined {
    return this.#current;
  }

  snapshot(): DesktopBrowserViewerAuthoritySnapshot {
    return {
      current:
        this.#current === undefined ? undefined : { ...this.#current },
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
    connect(
      expected: DesktopBrowserViewerPrincipal | undefined,
    ): Promise<{
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
        this.#stageLoss(current, "principal_replaced");
        await this.#flushPending();
      }

      const connected = await input.connect(this.#current);
      if (connected.principal === undefined) {
        if (connected.previousSessionTerminal === true) {
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
        this.#stageLoss(current, input.reason);
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
        this.#current = undefined;
      }
    });
  }

  #stageLoss(
    principal: DesktopBrowserViewerPrincipal,
    reason: DesktopBrowserViewerAuthorityLossReason,
  ): void {
    if (this.#pending !== undefined) {
      if (!sameDesktopBrowserViewerPrincipal(this.#pending.principal, principal)) {
        throw new Error(
          "Desktop Browser viewer authority loss cannot drift to another principal.",
        );
      }
      return;
    }
    this.#pending = { principal, reason };
  }

  async #flushPending(): Promise<void> {
    const pending = this.#pending;
    if (pending === undefined) return;
    await this.#loseAuthority(pending.principal, pending.reason);
    if (this.#pending === pending) this.#pending = undefined;
    if (sameDesktopBrowserViewerPrincipal(this.#current, pending.principal)) {
      this.#current = undefined;
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

function sameDesktopBrowserViewerPrincipal(
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
