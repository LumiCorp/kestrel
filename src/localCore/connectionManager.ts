import type { LocalCoreClient } from "./client.js";
import type { LocalCoreStatus } from "./contracts.js";

export interface LocalCoreClientConnection {
  status: LocalCoreStatus;
  client: LocalCoreClient;
}

export interface LocalCoreConnectionManagerOptions {
  initialConnection?: LocalCoreClientConnection | undefined;
  connect(): Promise<LocalCoreClientConnection>;
  onConnected?(connection: LocalCoreClientConnection): void;
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

  constructor(options: LocalCoreConnectionManagerOptions) {
    this.connection = options.initialConnection;
    this.connectToCore = options.connect;
    this.onConnected = options.onConnected;
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

    const connecting = this.connectToCore().then((connection) => {
      this.connection = connection;
      this.onConnected?.(connection);
      return connection;
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
      return await operation(recovered.client);
    }
  }

  /**
   * Verifies or recovers the connection before invoking an operation exactly
   * once. A failure after invocation is surfaced because the daemon may have
   * accepted a non-idempotent request before the socket failed.
   */
  async executeOnce<T>(operation: (client: LocalCoreClient) => Promise<T>): Promise<T> {
    await this.executeIdempotent(async (client) => await client.health());
    const connection = await this.ensureConnected();
    return await operation(connection.client);
  }

  invalidate(client?: LocalCoreClient): void {
    if (client === undefined || this.connection?.client === client) {
      this.connection = undefined;
    }
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
