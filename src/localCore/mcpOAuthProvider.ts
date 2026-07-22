import { randomBytes } from "node:crypto";

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuthProviderFactory } from "../mcp/McpClientManager.js";
import {
  parseLocalCoreCredentialId,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStore,
} from "./credentialStore.js";

type StoredOAuthPart = "client" | "tokens" | "verifier" | "discovery";

export interface LocalCoreMcpOAuthProviderOptions {
  credentialStore: LocalCoreCredentialStore;
  credentialPrefix: `mcp.${string}`;
  redirectUrl: string;
  clientMetadata: OAuthClientMetadata;
  authorizationState?: string | undefined;
  onAuthorization: (authorizationUrl: URL) => void | Promise<void>;
}

/**
 * Local Core's durable OAuth authority for one remote App connection.
 * Secret-bearing OAuth state is split across Keychain records and never
 * projected into Desktop settings, runtime profiles, or renderer responses.
 */
export class LocalCoreMcpOAuthProvider implements OAuthClientProvider {
  readonly #credentialStore: LocalCoreCredentialStore;
  readonly #credentialPrefix: `mcp.${string}`;
  readonly #redirectUrl: string;
  readonly #clientMetadata: OAuthClientMetadata;
  readonly #authorizationState: string;
  readonly #onAuthorization: (authorizationUrl: URL) => void | Promise<void>;

  constructor(options: LocalCoreMcpOAuthProviderOptions) {
    if (!options.credentialStore.available) {
      throw new Error("The Local Core credential store is unavailable.");
    }
    this.#credentialStore = options.credentialStore;
    this.#credentialPrefix = parseOAuthCredentialPrefix(
      options.credentialPrefix,
    );
    this.#redirectUrl = parseLoopbackRedirectUrl(options.redirectUrl);
    this.#clientMetadata = structuredClone(options.clientMetadata);
    this.#authorizationState =
      options.authorizationState ?? randomBytes(32).toString("base64url");
    this.#onAuthorization = options.onAuthorization;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return structuredClone(this.#clientMetadata);
  }

  state(): string {
    return this.#authorizationState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return await this.#readJsonPart("client", (value) =>
      OAuthClientInformationSchema.parse(value),
    );
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.#writeJsonPart(
      "client",
      OAuthClientInformationSchema.parse(clientInformation),
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return await this.#readJsonPart("tokens", (value) =>
      OAuthTokensSchema.parse(value),
    );
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#writeJsonPart("tokens", OAuthTokensSchema.parse(tokens));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (authorizationUrl.protocol !== "https:") {
      throw new Error("The App authorization URL must use HTTPS.");
    }
    await this.#onAuthorization(new URL(authorizationUrl));
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)) {
      throw new Error("The App authorization verifier is invalid.");
    }
    await this.#credentialStore.set(
      this.#credentialId("verifier"),
      codeVerifier,
    );
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.#credentialStore.get(
      this.#credentialId("verifier"),
    );
    if (
      verifier === undefined ||
      !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
    ) {
      throw new Error("No valid App authorization verifier is available.");
    }
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.#writeJsonPart("discovery", parseDiscoveryState(state));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return await this.#readJsonPart("discovery", parseDiscoveryState);
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const parts: StoredOAuthPart[] =
      scope === "all" ? ["client", "tokens", "verifier", "discovery"] : [scope];
    await Promise.all(
      parts.map(async (part) => {
        await this.#credentialStore.delete(this.#credentialId(part));
      }),
    );
  }

  #credentialId(part: StoredOAuthPart): LocalCoreCredentialId {
    return parseLocalCoreCredentialId(
      `${this.#credentialPrefix}.oauth.${part}`,
    );
  }

  async #readJsonPart<T>(
    part: StoredOAuthPart,
    parse: (value: unknown) => T,
  ): Promise<T | undefined> {
    const stored = await this.#credentialStore.get(this.#credentialId(part));
    if (stored === undefined) return undefined;
    try {
      return parse(JSON.parse(stored));
    } catch {
      throw new Error(`Stored App authorization ${part} is invalid.`);
    }
  }

  async #writeJsonPart(part: StoredOAuthPart, value: unknown): Promise<void> {
    await this.#credentialStore.set(
      this.#credentialId(part),
      JSON.stringify(value),
    );
  }
}

export function parseOAuthCredentialPrefix(value: unknown): `mcp.${string}` {
  const parsed = parseLocalCoreCredentialId(value);
  if (!parsed.startsWith("mcp.") || parsed.includes(".oauth.")) {
    throw new Error("The App authorization credential prefix is invalid.");
  }
  return parsed as `mcp.${string}`;
}

export function listMcpOAuthCredentialIds(
  credentialPrefix: `mcp.${string}`,
): `mcp.${string}`[] {
  const prefix = parseOAuthCredentialPrefix(credentialPrefix);
  return (["client", "tokens", "verifier", "discovery"] as const).map(
    (part) =>
      parseLocalCoreCredentialId(`${prefix}.oauth.${part}`) as `mcp.${string}`,
  );
}

export function createLocalCoreMcpOAuthProviderFactory(
  credentialStore: LocalCoreCredentialStore,
): McpOAuthProviderFactory {
  return (server) => {
    if (server.oauthCredentialPrefix === undefined) return undefined;
    return new LocalCoreMcpOAuthProvider({
      credentialStore,
      credentialPrefix: server.oauthCredentialPrefix,
      redirectUrl: "http://127.0.0.1/oauth/callback",
      clientMetadata: {
        client_name: "Kestrel Desktop",
        redirect_uris: ["http://127.0.0.1/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      onAuthorization() {
        throw new Error(
          "This App connection needs to be reauthorized in Kestrel Desktop.",
        );
      },
    });
  };
}

function parseLoopbackRedirectUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]" &&
      url.hostname !== "localhost") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "The App authorization callback must be a credential-free loopback HTTP URL.",
    );
  }
  return url.toString();
}

function parseDiscoveryState(value: unknown): OAuthDiscoveryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("App authorization discovery state must be an object.");
  }
  const record = value as Record<string, unknown>;
  const authorizationServerUrl = parseHttpsUrl(
    record.authorizationServerUrl,
    "authorization server",
  );
  const authorizationServerMetadata =
    record.authorizationServerMetadata === undefined
      ? undefined
      : parseObject(
          record.authorizationServerMetadata,
          "authorization metadata",
        );
  if (authorizationServerMetadata !== undefined) {
    parseHttpsUrl(authorizationServerMetadata.issuer, "authorization issuer");
    parseHttpsUrl(
      authorizationServerMetadata.authorization_endpoint,
      "authorization endpoint",
    );
    parseHttpsUrl(authorizationServerMetadata.token_endpoint, "token endpoint");
  }
  const resourceMetadata =
    record.resourceMetadata === undefined
      ? undefined
      : parseObject(record.resourceMetadata, "resource metadata");
  if (resourceMetadata !== undefined) {
    parseHttpsUrl(resourceMetadata.resource, "protected resource");
  }
  if (record.resourceMetadataUrl !== undefined) {
    parseHttpsUrl(record.resourceMetadataUrl, "resource metadata URL");
  }
  return {
    authorizationServerUrl,
    ...(authorizationServerMetadata !== undefined
      ? {
          authorizationServerMetadata: structuredClone(
            authorizationServerMetadata,
          ),
        }
      : {}),
    ...(resourceMetadata !== undefined
      ? { resourceMetadata: structuredClone(resourceMetadata) }
      : {}),
    ...(typeof record.resourceMetadataUrl === "string"
      ? { resourceMetadataUrl: record.resourceMetadataUrl }
      : {}),
  } as OAuthDiscoveryState;
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`App ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`App ${label} must be an HTTPS URL.`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(`App ${label} must be an HTTPS URL.`);
  }
  return url.toString();
}
