/**
 * Trusted local connection material for the Local Core Unix socket.
 * Keep this descriptor in memory and never persist or log `authToken`.
 */
export interface LocalCoreConnectionDescriptor {
  readonly socketPath: string;
  readonly authToken: string;
}

/**
 * Creates the trusted, in-memory connection handle used by local clients.
 *
 * The bearer token is deliberately non-enumerable so routine object logging,
 * inspection, spreading, and JSON serialization cannot copy it accidentally.
 * Callers must still treat an explicit `authToken` read as sensitive.
 */
export function createLocalCoreConnectionDescriptor(
  input: LocalCoreConnectionDescriptor,
): LocalCoreConnectionDescriptor {
  const socketPath = requireNonEmpty(input.socketPath, "Local Core socket path");
  const authToken = requireNonEmpty(input.authToken, "Local Core auth token");
  const connection = { socketPath } as {
    readonly socketPath: string;
    readonly authToken: string;
  };
  Object.defineProperty(connection, "authToken", {
    value: authToken,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(connection);
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
  return normalized;
}
