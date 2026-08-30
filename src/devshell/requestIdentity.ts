import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import { DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "./contracts.js";
import type { DevShellStoreBinding } from "./storeBinding.js";

export const DEV_SHELL_REQUEST_PROTOCOL_HEADER = "x-kestrel-dev-shell-protocol";
export const DEV_SHELL_REQUEST_STORE_DRIVER_HEADER =
  "x-kestrel-dev-shell-store-driver";
export const DEV_SHELL_REQUEST_STORE_REVISION_HEADER =
  "x-kestrel-dev-shell-store-revision";

export interface DevShellRequestIdentity {
  serviceProtocolVersion: number;
  storeDriver: DevShellStoreBinding["driver"];
  storeBindingRevision: string;
}

export function buildDevShellRequestIdentityHeaders(
  binding: Pick<DevShellStoreBinding, "driver" | "revision">,
): OutgoingHttpHeaders {
  return {
    [DEV_SHELL_REQUEST_PROTOCOL_HEADER]: String(
      DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    ),
    [DEV_SHELL_REQUEST_STORE_DRIVER_HEADER]: binding.driver,
    [DEV_SHELL_REQUEST_STORE_REVISION_HEADER]: binding.revision,
  };
}

export function readDevShellRequestIdentity(
  headers: IncomingHttpHeaders,
): DevShellRequestIdentity | undefined {
  const protocolValue = readSingleHeader(
    headers[DEV_SHELL_REQUEST_PROTOCOL_HEADER],
  );
  const storeDriver = readSingleHeader(
    headers[DEV_SHELL_REQUEST_STORE_DRIVER_HEADER],
  );
  const storeBindingRevision = readSingleHeader(
    headers[DEV_SHELL_REQUEST_STORE_REVISION_HEADER],
  );
  const serviceProtocolVersion = Number.parseInt(protocolValue ?? "", 10);
  if (
    String(serviceProtocolVersion) !== protocolValue ||
    (storeDriver !== "sqlite" && storeDriver !== "postgres") ||
    storeBindingRevision === undefined ||
    storeBindingRevision.length === 0
  ) {
    return undefined;
  }
  return {
    serviceProtocolVersion,
    storeDriver,
    storeBindingRevision,
  };
}

export function isMatchingDevShellRequestIdentity(
  identity: DevShellRequestIdentity | undefined,
  binding: DevShellStoreBinding,
): boolean {
  return (
    identity !== undefined &&
    identity.serviceProtocolVersion === DEV_SHELL_SERVICE_PROTOCOL_VERSION &&
    identity.storeDriver === binding.driver &&
    identity.storeBindingRevision === binding.revision
  );
}

function readSingleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}
