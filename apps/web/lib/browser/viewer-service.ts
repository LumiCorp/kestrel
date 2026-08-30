import { randomUUID } from "node:crypto";
import {
  HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED,
  HOSTED_BROWSER_VIEWER_AUDIENCE,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  HOSTED_BROWSER_VIEWER_TICKET_TTL_MS,
  HOSTED_BROWSER_VIEWER_TICKET_VERSION,
  issueHostedBrowserViewerTicket,
  parseHostedBrowserViewerClientMessage,
  verifyHostedBrowserViewerTicket,
  type HostedBrowserViewerClientMessageV1,
  type HostedBrowserViewerServerMessageV1,
  type HostedBrowserViewerTicketClaimsV1,
} from "../../../../src/browser/hostedViewer.js";
import type {
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerStateV1,
} from "../../../../src/desktopShell/contracts.js";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import type { HostedBrowserOriginAuthority, HostedBrowserResourceRecord } from "./store";
import type {
  HostedBrowserViewerCleanupPendingV1,
  HostedBrowserViewerCleanupScopeV1,
  HostedBrowserViewerTicketStorePort,
} from "./viewer-transient-store";
import type { HostedBrowserViewerWorkerPort } from "./viewer-worker-client";

export interface HostedBrowserViewerSessionStorePort {
  readActiveForThread(threadId: string): Promise<{
    session: BrowserSessionV1;
    resource: HostedBrowserResourceRecord | null;
  } | null>;
  read(sessionId: string): Promise<{
    session: BrowserSessionV1;
    resource: HostedBrowserResourceRecord | null;
  } | null>;
  resolveCurrentOrigin(sessionId: string): Promise<HostedBrowserOriginAuthority>;
  transitionViewerControl(input: {
    sessionId: string;
    generation: number;
    from: "ready" | "human_control";
    to: "ready" | "human_control";
    now: Date;
  }): Promise<BrowserSessionV1>;
}

export interface HostedBrowserViewerLifecyclePort {
  terminateViewerSession(input: {
    sessionId: string;
    generation: number;
    reason: "closed_by_user" | "BROWSER_SESSION_LOST";
  }): Promise<void>;
}

export interface HostedBrowserViewerAccessPort {
  authorize(input: {
    organizationId: string;
    actorId: string;
    threadId: string;
    origin: HostedBrowserOriginAuthority;
    session: BrowserSessionV1;
  }): Promise<boolean>;
}

export interface HostedBrowserViewerEvidencePort {
  emit(name: string, metadata: {
    sessionId: string;
    generation: number;
    threadId: string;
    actorId: string;
    outcome?: string | undefined;
  }): void;
}

export class HostedBrowserViewerOutcomeUnknownError extends Error {
  readonly code = "BROWSER_ACTION_OUTCOME_UNKNOWN" as const;

  constructor(
    readonly retryCleanup: () => Promise<boolean>,
    options?: ErrorOptions,
  ) {
    super("BROWSER_ACTION_OUTCOME_UNKNOWN", options);
    this.name = "HostedBrowserViewerOutcomeUnknownError";
  }
}

export class HostedBrowserViewerService {
  readonly #publicKeyPem: string;

  constructor(private readonly options: {
    store: HostedBrowserViewerSessionStorePort;
    lifecycle: HostedBrowserViewerLifecyclePort;
    access: HostedBrowserViewerAccessPort;
    tickets: HostedBrowserViewerTicketStorePort;
    worker: HostedBrowserViewerWorkerPort;
    evidence: HostedBrowserViewerEvidencePort;
    privateKeyPem: string;
    publicKeyPem: string;
    appName: string;
    routerUrl: string;
    requestAuthorized?: boolean | undefined;
    now?: (() => Date) | undefined;
  }) {
    this.#publicKeyPem = options.publicKeyPem;
  }

  async status(input: { organizationId: string; actorId: string; threadId: string }) {
    const pending = await this.options.tickets.readCleanupPending(input.threadId);
    const authority = await this.#readAuthorityCandidate(
      input,
      this.options.requestAuthorized !== false,
    );
    if (
      this.options.requestAuthorized === false ||
      (authority && !(await this.#authorizeCandidate(input, authority)))
    ) {
      await this.#reconcileDisconnectedAuthorityLoss(authority, pending);
      throw new Error("BROWSER_SESSION_LOST");
    }
    if (!authority) {
      if (pending && (await this.#pendingIsTerminal(pending.scope))) {
        await this.#clearCleanupPending(pending).catch(() => false);
      }
      return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, available: false };
    }
    const reconciledPending = pending
      ? await this.#reconcilePendingRecord(pending) ? null : pending
      : null;
    if (reconciledPending) {
      return {
        version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
        available: false,
        cleanupPending: true,
      };
    }
    return {
      version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
      available: true,
      sessionId: authority.session.sessionId,
      generation: authority.session.generation,
      sessionState: authority.session.state,
    };
  }

  async mintTicket(input: { organizationId: string; actorId: string; threadId: string }) {
    const pending = await this.options.tickets.readCleanupPending(input.threadId);
    const authority = await this.#readAuthorityCandidate(
      input,
      this.options.requestAuthorized !== false,
    );
    if (
      this.options.requestAuthorized === false ||
      (authority && !(await this.#authorizeCandidate(input, authority)))
    ) {
      await this.#reconcileDisconnectedAuthorityLoss(authority, pending);
      throw new Error("BROWSER_SESSION_LOST");
    }
    if (!authority) {
      if (pending && (await this.#pendingIsTerminal(pending.scope))) {
        await this.#clearCleanupPending(pending).catch(() => false);
      }
      throw new Error("BROWSER_SESSION_LOST");
    }
    if (pending && !(await this.#reconcilePendingRecord(pending))) {
      throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
    }
    const now = this.#now();
    const claims: HostedBrowserViewerTicketClaimsV1 = {
      version: HOSTED_BROWSER_VIEWER_TICKET_VERSION,
      audience: HOSTED_BROWSER_VIEWER_AUDIENCE,
      organizationId: authority.origin.organizationId,
      environmentId: authority.origin.environmentId,
      projectId: authority.origin.projectId,
      threadId: authority.origin.threadId,
      sessionId: authority.session.sessionId,
      generation: authority.session.generation,
      actorId: authority.origin.userId,
      connectionId: randomUUID(),
      nonce: randomUUID(),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOSTED_BROWSER_VIEWER_TICKET_TTL_MS).toISOString(),
    };
    const token = issueHostedBrowserViewerTicket({
      claims,
      privateKeyPem: this.options.privateKeyPem,
      now,
    });
    await this.options.tickets.issue({ nonce: claims.nonce, token, ttlSeconds: 60 });
    this.#evidence("ticket_issued", claims);
    return {
      version: HOSTED_BROWSER_VIEWER_TICKET_VERSION,
      ticket: token,
      expiresAt: claims.expiresAt,
      route: `/api/threads/${encodeURIComponent(claims.threadId)}/browser-viewer/v1`,
    };
  }

  async connect(token: string): Promise<HostedBrowserViewerConnection> {
    const claims = verifyHostedBrowserViewerTicket({
      token,
      publicKeyPem: this.#publicKeyPem,
      now: this.#now(),
    });
    if (!(await this.options.tickets.consume({ nonce: claims.nonce, token }))) {
      throw new Error("BROWSER_SESSION_LOST");
    }
    const authority = await this.#authorize({
      organizationId: claims.organizationId,
      actorId: claims.actorId,
      threadId: claims.threadId,
    });
    if (!(authority && sameTicketAuthority(claims, authority))) {
      await this.#failClosed(claims);
      throw new Error("BROWSER_SESSION_LOST");
    }
    let state: Awaited<ReturnType<HostedBrowserViewerWorkerPort["invoke"]>>;
    try {
      state = await this.#worker(
        authority,
        token,
        "connect",
        claims.connectionId,
      );
    } catch (error) {
      try {
        await this.#resolveUncertainConnect(authority, claims);
      } catch (cleanupError) {
        const scope = cleanupScope(authority, claims, this.options.appName);
        let pending: HostedBrowserViewerCleanupPendingV1;
        try {
          pending = await this.#markCleanupPending(scope, "connect_unknown");
        } catch {
          await this.#failClosed(claims);
          throw error;
        }
        throw new HostedBrowserViewerOutcomeUnknownError(
          () => this.#retryPendingCleanup(pending),
          { cause: cleanupError },
        );
      }
      throw error;
    }
    if (!(isViewerState(state) && sameViewerState(state, claims))) {
      try {
        await this.#resolveInvalidConnect(authority, claims);
      } catch (cleanupError) {
        const scope = cleanupScope(authority, claims, this.options.appName);
        let pending: HostedBrowserViewerCleanupPendingV1;
        try {
          pending = await this.#markCleanupPending(scope, "authority_loss");
        } catch {
          await this.#failClosed(claims);
          throw new Error("BROWSER_SESSION_LOST");
        }
        throw new HostedBrowserViewerOutcomeUnknownError(
          () => this.#retryPendingCleanup(pending),
          { cause: cleanupError },
        );
      }
      throw new Error("BROWSER_SESSION_LOST");
    }
    this.#evidence("connected", claims);
    return new HostedBrowserViewerConnection(
      this,
      token,
      claims,
      state,
      cleanupScope(authority, claims, this.options.appName),
    );
  }

  async dispatch(
    connection: HostedBrowserViewerConnection,
    raw: unknown,
  ): Promise<HostedBrowserViewerServerMessageV1> {
    const message = parseHostedBrowserViewerClientMessage(raw);
    if (message.type === "authenticate") throw new Error("BROWSER_SESSION_LOST");
    const authority = await this.#requireCurrent(connection);
    try {
      return await this.#dispatchCurrent(connection, authority, message);
    } catch (error) {
      if (connection.expiryHandled) throw error;
      if (isViewerAuthorityExpired(error)) {
        await this.#expireConnection(connection, error);
      }
      await this.#revokeAndFailClosed(connection, error);
      throw error;
    }
  }

  async frame(connection: HostedBrowserViewerConnection): Promise<HostedBrowserViewerServerMessageV1> {
    const authority = await this.#requireCurrent(connection);
    let frame: Awaited<ReturnType<HostedBrowserViewerWorkerPort["invoke"]>>;
    try {
      frame = await this.#worker(
        authority,
        connection.ticket,
        "frame",
        connection.state.connectionId,
      );
    } catch (error) {
      if (connection.expiryHandled) throw error;
      if (isViewerAuthorityExpired(error)) {
        await this.#expireConnection(connection, error);
      }
      await this.#revokeAndFailClosed(connection, error);
      throw error;
    }
    if (this.#knownExpiryPassed(connection, true)) {
      await this.#expireConnection(connection);
    }
    if (!(isViewerFrame(frame) && sameViewerFrame(frame, connection.claims))) {
      await this.#revokeAndFailClosed(connection);
      throw new Error("BROWSER_SESSION_LOST");
    }
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "frame", frame };
  }

  async revalidate(connection: HostedBrowserViewerConnection): Promise<void> {
    await this.#requireCurrent(connection);
  }

  async disconnect(connection: HostedBrowserViewerConnection) {
    if (connection.revoked) return;
    try {
      await this.#cleanupExact(connection.cleanupScope);
      connection.revoked = true;
      this.#evidence("disconnected", connection.claims);
    } catch (error) {
      let pending: HostedBrowserViewerCleanupPendingV1;
      try {
        pending = await this.#markCleanupPending(
          connection.cleanupScope,
          "disconnect_unknown",
        );
      } catch {
        await this.#failClosed(connection.claims);
        connection.revoked = true;
        return;
      }
      throw new HostedBrowserViewerOutcomeUnknownError(
        () => this.#retryPendingCleanup(pending),
        { cause: error },
      );
    }
  }

  async #dispatchCurrent(
    connection: HostedBrowserViewerConnection,
    authority: AuthorizedViewer,
    message: Exclude<HostedBrowserViewerClientMessageV1, { type: "authenticate" }>,
  ): Promise<HostedBrowserViewerServerMessageV1> {
    if (message.type === "close_session") {
      await this.#worker(authority, connection.ticket, "close", connection.state.connectionId);
      await this.options.lifecycle.terminateViewerSession({
        sessionId: connection.claims.sessionId,
        generation: connection.claims.generation,
        reason: "closed_by_user",
      });
      connection.revoked = true;
      this.#evidence("closed", connection.claims);
      return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "closed", reason: "closed_by_user" };
    }
    const action = message.type === "accept_takeover"
      ? "accept"
      : message.type === "renew_lease"
        ? "renew"
        : message.type === "return_control"
          ? "return"
          : "input";
    const state = await this.#worker(
      authority,
      connection.ticket,
      action,
      connection.state.connectionId,
      "leaseId" in message ? message.leaseId : undefined,
      message.type === "input" ? message.input : undefined,
    );
    if (!(isViewerState(state) && sameViewerState(state, connection.claims))) {
      throw new Error("BROWSER_SESSION_LOST");
    }
    if (message.type === "accept_takeover" && authority.session.state === "ready") {
      await this.options.store.transitionViewerControl({
        sessionId: authority.session.sessionId,
        generation: authority.session.generation,
        from: "ready",
        to: "human_control",
        now: this.#now(),
      });
    }
    if (message.type === "return_control" && authority.session.state === "human_control") {
      await this.options.store.transitionViewerControl({
        sessionId: authority.session.sessionId,
        generation: authority.session.generation,
        from: "human_control",
        to: "ready",
        now: this.#now(),
      });
      connection.revoked = true;
      this.#evidence(message.type, connection.claims);
      return {
        version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
        type: "closed",
        reason: "returned_to_agent",
      };
    }
    connection.state = state;
    this.#evidence(message.type, connection.claims);
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "state", state };
  }

  async #authorize(input: { organizationId: string; actorId: string; threadId: string }): Promise<AuthorizedViewer | null> {
    const authority = await this.#readAuthorityCandidate(input, true);
    if (!(authority && (await this.#authorizeCandidate(input, authority)))) {
      return null;
    }
    return authority;
  }

  async #readAuthorityCandidate(
    input: { organizationId: string; actorId: string; threadId: string },
    requireActorMatch: boolean,
  ): Promise<AuthorizedViewer | null> {
    const record = await this.options.store.readActiveForThread(input.threadId);
    if (
      !record?.resource ||
      (record.session.state !== "ready" && record.session.state !== "human_control")
    ) return null;
    const origin = await this.options.store.resolveCurrentOrigin(record.session.sessionId);
    if (
      origin.organizationId !== input.organizationId ||
      (requireActorMatch && origin.userId !== input.actorId) ||
      origin.threadId !== input.threadId ||
      record.resource.machineGeneration !== record.session.generation
    ) return null;
    return {
      session: record.session,
      resource: record.resource,
      origin,
      routerUrl: this.options.routerUrl,
    };
  }

  async #authorizeCandidate(
    input: { organizationId: string; actorId: string; threadId: string },
    authority: AuthorizedViewer,
  ): Promise<boolean> {
    return await this.options.access.authorize({
      organizationId: input.organizationId,
      actorId: input.actorId,
      threadId: input.threadId,
      origin: authority.origin,
      session: authority.session,
    });
  }

  async #requireCurrent(connection: HostedBrowserViewerConnection) {
    const claims = connection.claims;
    const authority = await this.#authorize({
      organizationId: claims.organizationId,
      actorId: claims.actorId,
      threadId: claims.threadId,
    });
    if (!(authority && sameTicketAuthority(claims, authority))) {
      await this.#revokeAndFailClosed(connection);
      throw new Error("BROWSER_SESSION_LOST");
    }
    return authority;
  }

  async #worker(
    authority: AuthorizedViewer,
    ticket: string,
    action: Parameters<HostedBrowserViewerWorkerPort["invoke"]>[0]["action"],
    connectionId?: string,
    leaseId?: string,
    viewerInput?: Parameters<HostedBrowserViewerWorkerPort["invoke"]>[0]["viewerInput"],
  ) {
    return this.options.worker.invoke({
      routerUrl: authority.routerUrl,
      organizationId: authority.origin.organizationId,
      environmentId: authority.origin.environmentId,
      projectId: authority.origin.projectId,
      threadId: authority.origin.threadId,
      runId: authority.origin.runId,
      actorId: authority.origin.userId,
      sessionId: authority.session.sessionId,
      generation: authority.session.generation,
      appName: this.options.appName,
      machineId: authority.resource.machineId,
      ticket,
      action,
      ...(connectionId ? { connectionId } : {}),
      ...(leaseId ? { leaseId } : {}),
      ...(viewerInput ? { viewerInput } : {}),
    });
  }

  async #cleanupExact(
    scope: HostedBrowserViewerCleanupScopeV1,
    purpose: "disconnect" | "authority_loss" = "disconnect",
  ): Promise<void> {
    await this.#dispatchCleanup(scope, purpose);
  }

  async #dispatchCleanup(
    scope: HostedBrowserViewerCleanupScopeV1,
    purpose: "disconnect" | "authority_loss",
  ): Promise<void> {
    await this.options.worker.cleanup({
      ...scope,
      routerUrl: this.options.routerUrl,
      purpose,
    });
  }

  async #markCleanupPending(
    scope: HostedBrowserViewerCleanupScopeV1,
    reason: HostedBrowserViewerCleanupPendingV1["reason"],
  ): Promise<HostedBrowserViewerCleanupPendingV1> {
    return await this.options.tickets.markCleanupPending({
      version: "hosted_browser_viewer_cleanup_pending_v1",
      scope,
      reason,
      requestedAt: this.#now().toISOString(),
    });
  }

  async #clearCleanupPending(
    expected: HostedBrowserViewerCleanupPendingV1,
  ): Promise<boolean> {
    return await this.options.tickets.clearCleanupPending(expected);
  }

  async #reconcileDisconnectedAuthorityLoss(
    authority: AuthorizedViewer | null,
    existing: HostedBrowserViewerCleanupPendingV1 | null,
  ): Promise<void> {
    const scope = existing?.scope ?? (authority
      ? {
          version: "hosted_browser_viewer_cleanup_scope_v1" as const,
          organizationId: authority.origin.organizationId,
          environmentId: authority.origin.environmentId,
          projectId: authority.origin.projectId,
          threadId: authority.origin.threadId,
          runId: authority.origin.runId,
          actorId: authority.origin.userId,
          sessionId: authority.session.sessionId,
          generation: authority.session.generation,
          connectionId:
            `authority-loss-${authority.session.sessionId}-${authority.session.generation}`,
          appName: this.options.appName,
          machineId: authority.resource.machineId,
        }
      : null);
    if (!scope) return;
    let pending: HostedBrowserViewerCleanupPendingV1 | undefined;
    try {
      pending = await this.#markCleanupPending(scope, "authority_loss");
    } catch {
      // Worker and durable lifecycle remain independent fail-close owners.
    }
    if (pending) {
      await this.#reconcilePendingRecord(pending);
      return;
    }
    let workerProven = false;
    try {
      await this.#dispatchCleanup(scope, "authority_loss");
      workerProven = true;
    } catch {
      // The durable lifecycle remains the independent fail-close owner.
    }
    try {
      await this.#failClosed(scope);
    } catch (error) {
      if (!workerProven) throw error;
    }
  }

  async #retryPendingCleanup(
    expected: HostedBrowserViewerCleanupPendingV1,
  ): Promise<boolean> {
    try {
      const current = await this.options.tickets.readCleanupPending(
        expected.scope.threadId,
      );
      if (!current) return await this.#pendingIsTerminal(expected.scope);
      if (!sameCleanupScope(current.scope, expected.scope)) return false;
      return await this.#reconcilePendingRecord(current);
    } catch {
      return false;
    }
  }

  async #reconcilePendingRecord(
    pending: HostedBrowserViewerCleanupPendingV1,
  ): Promise<boolean> {
    if (await this.#pendingIsTerminal(pending.scope)) {
      return await this.#clearCleanupPending(pending).catch(() => false);
    }
    let cleanupProven = false;
    try {
      await this.#dispatchCleanup(
        pending.scope,
        pending.reason === "authority_loss" ? "authority_loss" : "disconnect",
      );
      cleanupProven = true;
    } catch {
      // A durable terminal Session is also sufficient cleanup proof.
    }
    if (pending.reason === "authority_loss") {
      try {
        await this.#failClosed(pending.scope);
      } catch {
        return false;
      }
    } else if (!cleanupProven) {
      try {
        await this.#failClosed(pending.scope);
      } catch {
        return false;
      }
    }
    const converged = cleanupProven || await this.#pendingIsTerminal(pending.scope);
    if (!converged) return false;
    const cleared = await this.#clearCleanupPending(pending).catch(() => false);
    if (cleared) this.#evidence("disconnected", pending.scope);
    return cleared;
  }

  async #pendingIsTerminal(scope: HostedBrowserViewerCleanupScopeV1) {
    const record = await this.options.store.read(scope.sessionId).catch(() => null);
    return Boolean(
      record &&
      record.session.sessionId === scope.sessionId &&
      record.session.generation === scope.generation &&
      isTerminalSession(record.session) &&
      record.resource?.cleanupRequestedAt !== null,
    );
  }

  async #revokeAndFailClosed(
    connection: HostedBrowserViewerConnection,
    cause?: unknown,
  ): Promise<void> {
    let pending: HostedBrowserViewerCleanupPendingV1 | undefined;
    try {
      pending = await this.#markCleanupPending(
        connection.cleanupScope,
        "authority_loss",
      );
    } catch {
      // Durable Session fail-close below is the fallback proof when the
      // transient cleanup marker is unavailable.
    }
    let workerProven = false;
    try {
      await this.#cleanupExact(connection.cleanupScope, "authority_loss");
      workerProven = true;
      connection.revoked = true;
    } catch {
      // The authority-loss marker, when available, retains exact cleanup.
    }
    try {
      await this.#failClosed(connection.claims);
      connection.revoked = true;
      if (pending) await this.#clearCleanupPending(pending).catch(() => false);
    } catch (error) {
      if (workerProven) {
        connection.revoked = true;
        return;
      }
      throw new HostedBrowserViewerOutcomeUnknownError(
        pending
          ? () => this.#retryPendingCleanup(pending)
          : () => this.#retryFailClosed(connection.claims),
        { cause: cause ?? error },
      );
    }
  }

  async #expireConnection(
    connection: HostedBrowserViewerConnection,
    cause?: unknown,
  ): Promise<never> {
    connection.expiryHandled = true;
    try {
      await this.#cleanupExact(connection.cleanupScope);
      connection.revoked = true;
      this.#evidence("expired", connection.claims);
    } catch (error) {
      let pending: HostedBrowserViewerCleanupPendingV1;
      try {
        pending = await this.#markCleanupPending(
          connection.cleanupScope,
          "disconnect_unknown",
        );
      } catch {
        await this.#failClosed(connection.claims);
        connection.revoked = true;
        throw new Error("BROWSER_SESSION_LOST");
      }
      throw new HostedBrowserViewerOutcomeUnknownError(
        () => this.#retryPendingCleanup(pending),
        { cause: cause ?? error },
      );
    }
    throw new Error("BROWSER_SESSION_LOST");
  }

  #knownExpiryPassed(
    connection: HostedBrowserViewerConnection,
    leaseBound: boolean,
  ): boolean {
    const expiries = [Date.parse(connection.claims.expiresAt)];
    if (leaseBound && connection.state.inputLeaseExpiresAt) {
      expiries.push(Date.parse(connection.state.inputLeaseExpiresAt));
    }
    return Math.min(...expiries) <= this.#now().getTime();
  }

  async #failClosed(
    claims: Pick<
      HostedBrowserViewerTicketClaimsV1,
      "sessionId" | "generation" | "threadId" | "actorId"
    > & { nonce?: string | undefined },
  ) {
    if (claims.nonce) await this.options.tickets.revoke(claims.nonce).catch(() => {});
    try {
      await this.options.lifecycle.terminateViewerSession({
        sessionId: claims.sessionId,
        generation: claims.generation,
        reason: "BROWSER_SESSION_LOST",
      });
      this.#evidence("authority_lost", claims);
      return;
    } catch (error) {
      const terminal = await this.#readExactDurableTerminal(claims);
      if (!terminal) {
        throw new HostedBrowserViewerOutcomeUnknownError(
          () => this.#retryFailClosed(claims),
          { cause: error },
        );
      }
      if (
        terminal.session.state === "lost" &&
        terminal.session.terminalReason === "BROWSER_SESSION_LOST"
      ) {
        this.#evidence("authority_lost", claims);
      }
    }
  }

  async #readExactDurableTerminal(
    claims: Pick<HostedBrowserViewerTicketClaimsV1, "sessionId" | "generation">,
  ) {
    const record = await this.options.store.read(claims.sessionId).catch(() => null);
    if (
      !record?.resource ||
      record.session.sessionId !== claims.sessionId ||
      record.session.generation !== claims.generation ||
      record.resource.machineGeneration !== claims.generation ||
      record.resource.cleanupRequestedAt === null ||
      !isTerminalSession(record.session)
    ) return null;
    return record;
  }

  async #resolveUncertainConnect(
    authority: AuthorizedViewer,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<void> {
    if (await this.#releaseUncertainConnect(authority, claims)) return;
    await this.#failClosed(claims);
  }

  async #resolveInvalidConnect(
    authority: AuthorizedViewer,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<void> {
    await this.#releaseUncertainConnect(authority, claims);
    await this.#failClosed(claims);
  }

  async #retryFailClosed(
    claims: Pick<
      HostedBrowserViewerTicketClaimsV1,
      "sessionId" | "generation" | "threadId" | "actorId"
    >,
  ): Promise<boolean> {
    try {
      await this.#failClosed(claims);
      return true;
    } catch {
      return false;
    }
  }

  async #releaseUncertainConnect(
    authority: AuthorizedViewer,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<boolean> {
    try {
      await this.#cleanupExact(
        cleanupScope(authority, claims, this.options.appName),
      );
      this.#evidence("uncertain_connect_released", claims);
      return true;
    } catch {
      return false;
    }
  }

  #evidence(name: string, claims: Pick<HostedBrowserViewerTicketClaimsV1, "sessionId" | "generation" | "threadId" | "actorId">) {
    this.options.evidence.emit(`browser_viewer_${name}`, {
      sessionId: claims.sessionId,
      generation: claims.generation,
      threadId: claims.threadId,
      actorId: claims.actorId,
    });
  }

  #now() { return this.options.now?.() ?? new Date(); }
}

export class HostedBrowserViewerConnection {
  constructor(
    private readonly service: HostedBrowserViewerService,
    readonly ticket: string,
    readonly claims: HostedBrowserViewerTicketClaimsV1,
    public state: DesktopBrowserViewerStateV1,
    readonly cleanupScope: HostedBrowserViewerCleanupScopeV1,
  ) {}
  revoked = false;
  expiryHandled = false;
  dispatch(message: unknown) { return this.service.dispatch(this, message); }
  frame() { return this.service.frame(this); }
  revalidate() { return this.service.revalidate(this); }
  disconnect() { return this.service.disconnect(this); }
}

type AuthorizedViewer = {
  session: BrowserSessionV1;
  resource: HostedBrowserResourceRecord;
  origin: HostedBrowserOriginAuthority;
  routerUrl: string;
};

function sameTicketAuthority(claims: HostedBrowserViewerTicketClaimsV1, authority: AuthorizedViewer) {
  return claims.organizationId === authority.origin.organizationId &&
    claims.environmentId === authority.origin.environmentId &&
    claims.projectId === authority.origin.projectId &&
    claims.threadId === authority.origin.threadId &&
    claims.actorId === authority.origin.userId &&
    claims.sessionId === authority.session.sessionId &&
    claims.generation === authority.session.generation;
}

function cleanupScope(
  authority: AuthorizedViewer,
  claims: HostedBrowserViewerTicketClaimsV1,
  appName: string,
): HostedBrowserViewerCleanupScopeV1 {
  return {
    version: "hosted_browser_viewer_cleanup_scope_v1",
    organizationId: claims.organizationId,
    environmentId: claims.environmentId,
    projectId: claims.projectId,
    threadId: claims.threadId,
    runId: authority.origin.runId,
    actorId: claims.actorId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    connectionId: claims.connectionId,
    appName,
    machineId: authority.resource.machineId,
  };
}

function sameCleanupScope(
  left: HostedBrowserViewerCleanupScopeV1,
  right: HostedBrowserViewerCleanupScopeV1,
): boolean {
  return left.organizationId === right.organizationId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.actorId === right.actorId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.connectionId === right.connectionId &&
    left.appName === right.appName &&
    left.machineId === right.machineId;
}

function isViewerAuthorityExpired(error: unknown): boolean {
  return error instanceof Error &&
    error.message === HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED;
}
function isViewerState(value: unknown): value is DesktopBrowserViewerStateV1 {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === "desktop_browser_viewer_state_v1");
}
function isViewerFrame(value: unknown): value is DesktopBrowserViewerFrameV1 {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === "desktop_browser_viewer_frame_v1");
}
function sameViewerState(state: DesktopBrowserViewerStateV1, claims: HostedBrowserViewerTicketClaimsV1) {
  return state.available === true && state.threadId === claims.threadId && state.projectId === claims.projectId && state.sessionId === claims.sessionId && state.generation === claims.generation && state.connectionId === claims.connectionId;
}
function sameViewerFrame(frame: DesktopBrowserViewerFrameV1, claims: HostedBrowserViewerTicketClaimsV1) {
  return frame.sessionId === claims.sessionId && frame.generation === claims.generation && frame.mediaType === "image/png";
}
function isTerminalSession(session: BrowserSessionV1) {
  return session.state === "closed" ||
    session.state === "expired" ||
    session.state === "lost" ||
    session.state === "failed";
}
