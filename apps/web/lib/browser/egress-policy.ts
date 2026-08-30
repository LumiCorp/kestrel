import { lookup } from "node:dns/promises";
import { domainToASCII } from "node:url";
import {
  assertPublicResolvedAddresses,
  type McpResolvedAddress,
} from "@kestrel/mcp-security";
import type { BrowserEffectiveDomainAuthorityV1 } from "../../../../src/browser/domainAuthority.js";

export const HOSTED_BROWSER_NETWORK_KINDS = [
  "navigation",
  "redirect",
  "frame",
  "script",
  "style",
  "image",
  "fetch",
  "xhr",
  "websocket",
  "eventsource",
  "worker",
  "beacon",
] as const;

export type HostedBrowserNetworkKind =
  (typeof HOSTED_BROWSER_NETWORK_KINDS)[number];

export interface HostedBrowserEgressDecision {
  normalizedOrigin: string;
  effectiveAllowlistRevision: string;
  resolvedAddresses: McpResolvedAddress[];
}

type Resolver = (hostname: string) => Promise<McpResolvedAddress[]>;

export class HostedBrowserEgressAuthority {
  #authority: BrowserEffectiveDomainAuthorityV1;
  readonly #resolve: Resolver;
  readonly #connections = new Map<
    string,
    { hostname: string; revision: string; close: () => void }
  >();

  constructor(input: {
    authority: BrowserEffectiveDomainAuthorityV1;
    resolve?: Resolver | undefined;
  }) {
    this.#authority = input.authority;
    this.#resolve = input.resolve ?? resolvePublicAddresses;
  }

  async authorize(input: {
    url: string;
    kind: HostedBrowserNetworkKind;
    revision: string;
  }): Promise<HostedBrowserEgressDecision> {
    if (!HOSTED_BROWSER_NETWORK_KINDS.includes(input.kind)) {
      throw new Error("BROWSER_DESTINATION_BLOCKED");
    }
    if (input.revision !== this.#authority.effectiveAllowlistRevision) {
      throw new Error("BROWSER_DESTINATION_BLOCKED");
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error("BROWSER_DESTINATION_BLOCKED");
    }
    if (
      url.protocol !== "https:" ||
      (url.port !== "" && url.port !== "443") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("BROWSER_DESTINATION_BLOCKED");
    }
    const hostname = domainToASCII(url.hostname.toLowerCase().replace(/\.$/u, ""));
    if (!hostname || !this.#isAllowedHostname(hostname)) {
      throw new Error("BROWSER_DESTINATION_BLOCKED");
    }
    const resolvedAddresses = await this.#resolve(hostname);
    assertPublicResolvedAddresses(resolvedAddresses);
    return {
      normalizedOrigin: `https://${hostname}`,
      effectiveAllowlistRevision: input.revision,
      resolvedAddresses,
    };
  }

  registerLongLivedConnection(input: {
    connectionId: string;
    hostname: string;
    revision: string;
    close: () => void;
  }): void {
    this.#connections.set(input.connectionId, input);
  }

  install(authority: BrowserEffectiveDomainAuthorityV1): {
    effectiveAllowlistRevision: string;
    closedUnauthorizedConnections: number;
  } {
    this.#authority = authority;
    let closedUnauthorizedConnections = 0;
    for (const [id, connection] of this.#connections) {
      if (
        connection.revision !== authority.effectiveAllowlistRevision ||
        !this.#isAllowedHostname(connection.hostname)
      ) {
        connection.close();
        this.#connections.delete(id);
        closedUnauthorizedConnections += 1;
      }
    }
    return {
      effectiveAllowlistRevision: authority.effectiveAllowlistRevision,
      closedUnauthorizedConnections,
    };
  }

  #isAllowedHostname(hostname: string): boolean {
    if (
      this.#authority.qaTarget?.scheme === "https" &&
      this.#authority.qaTarget.port === 443 &&
      this.#authority.qaTarget.hostname === hostname
    ) {
      return true;
    }
    return this.#authority.publicDomains.some(
      (domain) =>
        hostname === domain.canonicalDomain ||
        hostname.endsWith(`.${domain.canonicalDomain}`),
    );
  }
}

async function resolvePublicAddresses(hostname: string): Promise<McpResolvedAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({
    address: result.address,
    family: result.family as 4 | 6,
  }));
}
