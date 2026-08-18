import type { LocalCoreClient } from "./client.js";
import type { LocalCoreStatus } from "./contracts.js";

export interface LocalCoreClientConnection {
  status: LocalCoreStatus;
  client: LocalCoreClient;
}

export type LocalCoreConnectionState =
  | "connected"
  | "connecting"
  | "disconnected";

export interface LocalCoreConnectionManagerOptions {
  initialConnection?: LocalCoreClientConnection | undefined;
  connect(): Promise<LocalCoreClientConnection>;
  onConnected?(connection: LocalCoreClientConnection): void;
  onStateChanged?(state: LocalCoreConnectionState): void;
}

/**
 * Owns the cached Local Core client across daemon lifetimes. Callers opt into
 * retry only for operations whose contract is safe to invoke a second time.
 */
export class LocalCoreConnectionManager {
  private connection: LocalCoreClientConnection | undefined;
  private connecting: Promise<LocalCoreClientConnection> | undefined;
  private readonly connectToCore: () => Promise<LocalCoreClientConnection>;
  private readonly onConnected: ((connection: LocalCoreClientConnection) => void) | undefined;
  private readonly onStateChanged:
    | ((state: LocalCoreConnectionState) => void)
    | undefined;
  private state: LocalCoreConnectionState;

  constructor(options: LocalCoreConnectionManagerOptions) {
    this.connection = options.initialConnection;
    this.connectToCore = options.connect;
    this.onConnected = options.onConnected;
    this.onStateChanged = options.onStateChanged;
    this.state = options.initialConnection === undefined
      ? "disconnected"
      : "connected";
  }

  current(): LocalCoreClientConnection | undefined {
    return this.connection;
  }

  async ensureConnected(): Promise<LocalCoreClientConnection> {
    if (this.connection !== undefined) {
      return this.connection;
    }
    if (this.connecting !== undefined) {
      return await this.connecting;
    }

    this.setState("connecting");
    const connecting = this.connectToCore()
      .then((connection) => {
        this.connection = connection;
        this.setState("connected");
        this.onConnected?.(connection);
        return connection;
      })
      .catch((error: unknown) => {
        this.setState("disconnected");
        throw error;
      });
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) {
        this.connecting = undefined;
      }
    }
  }

  async executeIdempotent<T>(operation: (client: LocalCoreClient) => Promise<T>): Promise<T> {
    const connection = await this.ensureConnected();
    try {
      return await operation(connection.client);
    } catch (error) {
      if (isStaleLocalCoreConnectionError(error) === false) {
        throw error;
      }
      this.invalidate(connection.client);
      const recovered = await this.ensureConnected();
      try {
        return await operation(recovered.client);
      } catch (recoveredError) {
        if (isStaleLocalCoreConnectionError(recoveredError)) {
          this.invalidate(recovered.client);
        }
        throw recoveredError;
      }
    }
  }

  /**
   * Verifies or recovers the connection before invoking an operation exactly
   * once. A failure after invocation is surfaced because the daemon may have
   * accepted a non-idempotent request before the socket failed.
   */
  async executeOnce<T>(operation: (client: LocalCoreClient) => Promise<T>): Promise<T> {
    await this.executeIdempotent(async (client) => await client.health());
    return await this.executeConnectedOnce(operation);
  }

  /**
   * Invokes an operation once on the current connection without a separate
   * health request. Use when the operation itself is the liveness check and a
   * preflight request would incorrectly gate or delay it.
   */
  async executeConnectedOnce<T>(operation: (client: LocalCoreClient) => Promise<T>): Promise<T> {
    const connection = await this.ensureConnected();
    try {
      return await operation(connection.client);
    } catch (error) {
      if (isStaleLocalCoreConnectionError(error)) {
        this.invalidate(connection.client);
      }
      throw error;
    }
  }

  invalidate(client?: LocalCoreClient): void {
    if (client === undefined || this.connection?.client === client) {
      this.connection = undefined;
      this.setState("disconnected");
    }
  }

  private setState(state: LocalCoreConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChanged?.(state);
  }
}

export function isStaleLocalCoreConnectionError(error: unknown): boolean {
  return hasConnectionErrorCode(error, new Set<unknown>());
}

function hasConnectionErrorCode(error: unknown, seen: Set<unknown>): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const record = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (
    record.code === "ENOENT"
    || record.code === "ECONNREFUSED"
    || record.code === "ECONNRESET"
    || record.code === "EPIPE"
  ) {
    return true;
  }
  if (hasConnectionErrorCode(record.cause, seen)) {
    return true;
  }
  return Array.isArray(record.errors)
    && record.errors.some((nested) => hasConnectionErrorCode(nested, seen));
}
