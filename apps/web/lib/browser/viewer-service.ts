import { randomUUID } from "node:crypto";
import {
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
import type { HostedBrowserViewerTicketStorePort } from "./viewer-transient-store";
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
    now?: (() => Date) | undefined;
  }) {
    this.#publicKeyPem = options.publicKeyPem;
  }

  async status(input: { organizationId: string; actorId: string; threadId: string }) {
    const authority = await this.#authorize(input);
    return authority
      ? {
          version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
          available: true,
          sessionId: authority.session.sessionId,
          generation: authority.session.generation,
          sessionState: authority.session.state,
        }
      : { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, available: false };
  }

  async mintTicket(input: { organizationId: string; actorId: string; threadId: string }) {
    const authority = await this.#authorize(input);
    if (!authority) throw new Error("BROWSER_SESSION_LOST");
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
        await this.#resolveUncertainConnect(authority, token, claims);
      } catch (cleanupError) {
        throw new HostedBrowserViewerOutcomeUnknownError(
          () => this.#retryUncertainConnectCleanup(authority, token, claims),
          { cause: cleanupError },
        );
      }
      throw error;
    }
    if (!(isViewerState(state) && sameViewerState(state, claims))) {
      try {
        await this.#resolveInvalidConnect(authority, token, claims);
      } catch (cleanupError) {
        throw new HostedBrowserViewerOutcomeUnknownError(
          () => this.#retryInvalidConnectCleanup(authority, token, claims),
          { cause: cleanupError },
        );
      }
      throw new Error("BROWSER_SESSION_LOST");
    }
    this.#evidence("connected", claims);
    return new HostedBrowserViewerConnection(this, token, claims, state);
  }

  async dispatch(
    connection: HostedBrowserViewerConnection,
    raw: unknown,
  ): Promise<HostedBrowserViewerServerMessageV1> {
    const message = parseHostedBrowserViewerClientMessage(raw);
    if (message.type === "authenticate") throw new Error("BROWSER_SESSION_LOST");
    const authority = await this.#requireCurrent(connection.claims);
    try {
      return await this.#dispatchCurrent(connection, authority, message);
    } catch (error) {
      await this.#failClosed(connection.claims);
      throw error;
    }
  }

  async frame(connection: HostedBrowserViewerConnection): Promise<HostedBrowserViewerServerMessageV1> {
    const authority = await this.#requireCurrent(connection.claims);
    let frame: Awaited<ReturnType<HostedBrowserViewerWorkerPort["invoke"]>>;
    try {
      frame = await this.#worker(
        authority,
        connection.ticket,
        "frame",
        connection.state.connectionId,
      );
    } catch (error) {
      await this.#failClosed(connection.claims);
      throw error;
    }
    if (!(isViewerFrame(frame) && sameViewerFrame(frame, connection.claims))) {
      await this.#failClosed(connection.claims);
      throw new Error("BROWSER_SESSION_LOST");
    }
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "frame", frame };
  }

  async disconnect(connection: HostedBrowserViewerConnection) {
    const authority = await this.#authorize({
      organizationId: connection.claims.organizationId,
      actorId: connection.claims.actorId,
      threadId: connection.claims.threadId,
    });
    if (authority) {
      await this.#worker(
        authority,
        connection.ticket,
        "disconnect",
        connection.state.connectionId,
      ).catch(() => {});
    }
    this.#evidence("disconnected", connection.claims);
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
    }
    connection.state = state;
    this.#evidence(message.type, connection.claims);
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "state", state };
  }

  async #authorize(input: { organizationId: string; actorId: string; threadId: string }): Promise<AuthorizedViewer | null> {
    const record = await this.options.store.readActiveForThread(input.threadId);
    if (
      !record?.resource ||
      (record.session.state !== "ready" && record.session.state !== "human_control")
    ) return null;
    const origin = await this.options.store.resolveCurrentOrigin(record.session.sessionId);
    if (
      origin.organizationId !== input.organizationId ||
      origin.userId !== input.actorId ||
      origin.threadId !== input.threadId ||
      record.resource.machineGeneration !== record.session.generation ||
      !(await this.options.access.authorize({
        organizationId: input.organizationId,
        actorId: input.actorId,
        threadId: input.threadId,
        origin,
        session: record.session,
      }))
    ) return null;
    return {
      session: record.session,
      resource: record.resource,
      origin,
      routerUrl: this.options.routerUrl,
    };
  }

  async #requireCurrent(claims: HostedBrowserViewerTicketClaimsV1) {
    if (Date.parse(claims.expiresAt) <= this.#now().getTime()) {
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

  async #failClosed(claims: HostedBrowserViewerTicketClaimsV1) {
    await this.options.tickets.revoke(claims.nonce).catch(() => {});
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
    claims: HostedBrowserViewerTicketClaimsV1,
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
    ticket: string,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<void> {
    if (await this.#releaseUncertainConnect(authority, ticket, claims)) return;
    await this.#failClosed(claims);
  }

  async #resolveInvalidConnect(
    authority: AuthorizedViewer,
    ticket: string,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<void> {
    await this.#releaseUncertainConnect(authority, ticket, claims);
    await this.#failClosed(claims);
  }

  async #retryInvalidConnectCleanup(
    authority: AuthorizedViewer,
    ticket: string,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<boolean> {
    try {
      await this.#resolveInvalidConnect(authority, ticket, claims);
      return true;
    } catch {
      return false;
    }
  }

  async #retryFailClosed(
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<boolean> {
    try {
      await this.#failClosed(claims);
      return true;
    } catch {
      return false;
    }
  }

  async #retryUncertainConnectCleanup(
    authority: AuthorizedViewer,
    ticket: string,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<boolean> {
    try {
      await this.#resolveUncertainConnect(authority, ticket, claims);
      return true;
    } catch {
      return false;
    }
  }

  async #releaseUncertainConnect(
    authority: AuthorizedViewer,
    ticket: string,
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<boolean> {
    try {
      const result = await this.#worker(
        authority,
        ticket,
        "disconnect",
        claims.connectionId,
      );
      if (result !== null) return false;
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
  ) {}
  dispatch(message: unknown) { return this.service.dispatch(this, message); }
  frame() { return this.service.frame(this); }
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
