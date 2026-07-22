"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  McpCapability,
  McpCapabilitySnapshot,
  McpCredential,
  McpServer,
} from "@/drizzle/schema";

type CredentialMetadata = Pick<
  McpCredential,
  "id" | "name" | "kind" | "status" | "expiresAt" | "lastUsedAt"
>;

type SnapshotWithCapabilities = McpCapabilitySnapshot & {
  capabilities: McpCapability[];
};

type ServerDetail = {
  server: McpServer;
  snapshots: SnapshotWithCapabilities[];
};

type McpEnvironmentPanelProps = {
  environmentId: string;
};

type SourceType = "remote" | "oci";

type OperationalSnapshot = {
  summary: {
    servers: number;
    readyServers: number;
    degradedServers: number;
    activeDiscoveryJobs: number;
    pendingInteractions: number;
    failedInvocations: number;
  };
  discoveryJobs: Array<{
    id: string;
    serverId: string;
    status: string;
    failureCode: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  invocations: Array<{
    id: string;
    serverId: string;
    capabilityId: string | null;
    method: string;
    status: string;
    requestDigest: string;
    responseDigest: string | null;
    errorCode: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  interactions: Array<{
    id: string;
    invocationId: string;
    threadId: string;
    kind: string;
    status: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
};

export function McpEnvironmentPanel({
  environmentId,
}: McpEnvironmentPanelProps) {
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [operations, setOperations] = useState<OperationalSnapshot | null>(
    null
  );
  const [details, setDetails] = useState<Record<string, ServerDetail>>({});
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<SourceType>("remote");
  const [serverName, setServerName] = useState("");
  const [serverSlug, setServerSlug] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [imageReference, setImageReference] = useState("");
  const [launchArguments, setLaunchArguments] = useState("");
  const [egressOrigins, setEgressOrigins] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [credentialName, setCredentialName] = useState("");
  const [secretHeaders, setSecretHeaders] = useState(
    '{\n  "Authorization": "Bearer …"\n}'
  );
  const [oauthResource, setOauthResource] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void loadEnvironmentMcp(environmentId, controller.signal)
      .then(
        ({
          credentials: nextCredentials,
          servers: nextServers,
          operations: nextOperations,
        }) => {
          setCredentials(nextCredentials);
          setServers(nextServers);
          setOperations(nextOperations);
        }
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          toast.error(
            errorMessage(error, "Custom App configuration failed to load.")
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [environmentId]);

  async function createCredential() {
    setBusyAction("credential:create");
    try {
      const headers = JSON.parse(secretHeaders) as unknown;
      if (
        !(headers && typeof headers === "object" && !Array.isArray(headers))
      ) {
        throw new Error("Secret headers must be a JSON object.");
      }
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/credentials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: credentialName,
            payload: { kind: "secret_headers", headers },
          }),
        }
      );
      const payload = await readJson<{
        credential?: CredentialMetadata;
        error?: string;
      }>(response);
      if (!(response.ok && payload.credential)) {
        throw new Error(payload.error ?? "Credential creation failed.");
      }
      setCredentials((current) => [payload.credential!, ...current]);
      setCredentialId(payload.credential.id);
      setCredentialName("");
      toast.success("Encrypted credential created.");
    } catch (error) {
      toast.error(errorMessage(error, "Credential creation failed."));
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshOperations() {
    setBusyAction("operations:refresh");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/health`
      );
      const payload = await readJson<OperationalSnapshot & { error?: string }>(
        response
      );
      if (!response.ok) {
        throw new Error(payload.error ?? "Custom App activity failed to load.");
      }
      setOperations(payload);
    } catch (error) {
      toast.error(errorMessage(error, "Custom App activity failed to load."));
    } finally {
      setBusyAction(null);
    }
  }

  async function startOauth() {
    setBusyAction("credential:oauth");
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/oauth/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            credentialName,
            resource: oauthResource,
            clientId: oauthClientId,
            tokenEndpointAuthMethod: "none",
          }),
        }
      );
      const payload = await readJson<{
        authorizationUrl?: string;
        error?: string;
      }>(response);
      if (!(response.ok && payload.authorizationUrl)) {
        throw new Error(payload.error ?? "App sign-in could not be started.");
      }
      window.location.assign(payload.authorizationUrl);
    } catch (error) {
      toast.error(errorMessage(error, "App sign-in could not be started."));
      setBusyAction(null);
    }
  }

  async function revokeCredential(id: string) {
    setBusyAction(`credential:${id}`);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/credentials/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "revoked" }),
        }
      );
      const payload = await readJson<{
        credential?: CredentialMetadata;
        error?: string;
      }>(response);
      if (!(response.ok && payload.credential)) {
        throw new Error(payload.error ?? "Credential revocation failed.");
      }
      setCredentials((current) =>
        current.map((credential) =>
          credential.id === id
            ? { ...credential, status: "revoked" }
            : credential
        )
      );
      setServers((current) =>
        current.map((server) =>
          server.credentialId === id
            ? { ...server, status: "degraded" }
            : server
        )
      );
      toast.success("Credential revoked.");
    } catch (error) {
      toast.error(errorMessage(error, "Credential revocation failed."));
    } finally {
      setBusyAction(null);
    }
  }

  async function installServer() {
    setBusyAction("server:install");
    try {
      const auth = credentialId
        ? {
            mode: credentials.find(
              (credential) => credential.id === credentialId
            )?.kind,
            credentialId,
          }
        : { mode: "none" };
      const common = {
        name: serverName,
        slug: serverSlug,
        auth,
        launchArguments: splitLines(launchArguments),
        resources: { cpuMillicores: 500, memoryMib: 512, pidsLimit: 128 },
      };
      const body =
        sourceType === "remote"
          ? {
              ...common,
              sourceType: "remote",
              transport: "streamable_http",
              remoteUrl,
              egressAllowlist: [
                ...new Set([
                  new URL(remoteUrl).origin,
                  ...splitLines(egressOrigins),
                ]),
              ],
            }
          : {
              ...common,
              auth: { mode: "none" },
              sourceType: "oci",
              transport: "stdio",
              imageReference,
              digest: imageReference.split("@").at(-1),
              egressAllowlist: splitLines(egressOrigins),
            };
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/servers`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const payload = await readJson<{ server?: McpServer; error?: string }>(
        response
      );
      if (!(response.ok && payload.server)) {
        throw new Error(payload.error ?? "Custom App could not be added.");
      }
      setServers((current) => [payload.server!, ...current]);
      setServerName("");
      setServerSlug("");
      setRemoteUrl("");
      setImageReference("");
      setLaunchArguments("");
      setEgressOrigins("");
      toast.success(
        "Custom App added. Check its capabilities before enabling access."
      );
    } catch (error) {
      toast.error(errorMessage(error, "Custom App could not be added."));
    } finally {
      setBusyAction(null);
    }
  }

  async function loadServer(serverId: string) {
    setBusyAction(`server:${serverId}:load`);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/servers/${serverId}`
      );
      const payload = await readJson<ServerDetail & { error?: string }>(
        response
      );
      if (!response.ok) {
        throw new Error(payload.error ?? "Custom App details failed to load.");
      }
      setDetails((current) => ({ ...current, [serverId]: payload }));
    } catch (error) {
      toast.error(errorMessage(error, "Custom App details failed to load."));
    } finally {
      setBusyAction(null);
    }
  }

  async function discoverServer(serverId: string) {
    setBusyAction(`server:${serverId}:discover`);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/servers/${serverId}/discover`,
        { method: "POST" }
      );
      const payload = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(
          payload.error ?? "Capability check could not be queued."
        );
      }
      setServers((current) =>
        current.map((server) =>
          server.id === serverId && server.status === "draft"
            ? { ...server, status: "discovering" }
            : server
        )
      );
      toast.success("Capability check queued.");
    } catch (error) {
      toast.error(errorMessage(error, "Capability check could not be queued."));
    } finally {
      setBusyAction(null);
    }
  }

  async function reviewSnapshot(
    serverId: string,
    snapshotId: string,
    decision: "approve" | "reject"
  ) {
    setBusyAction(`snapshot:${snapshotId}`);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/servers/${serverId}/snapshots/${snapshotId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      );
      const payload = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "Snapshot review failed.");
      }
      await loadServer(serverId);
      toast.success(
        `App capabilities ${decision === "approve" ? "approved" : "rejected"}.`
      );
    } catch (error) {
      toast.error(errorMessage(error, "Snapshot review failed."));
    } finally {
      setBusyAction(null);
    }
  }

  async function setCapabilityPolicy(
    serverId: string,
    capability: McpCapability,
    approvalMode: "auto" | "ask" | "deny"
  ) {
    setBusyAction(`capability:${capability.id}`);
    try {
      const response = await fetch(
        `/api/organization/environments/${environmentId}/mcp/capabilities/${capability.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: approvalMode !== "deny",
            approvalMode,
          }),
        }
      );
      const payload = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "Custom App access update failed.");
      }
      await loadServer(serverId);
      toast.success("Environment App access updated.");
    } catch (error) {
      toast.error(errorMessage(error, "Custom App access update failed."));
    } finally {
      setBusyAction(null);
    }
  }

  if (loading) {
    return (
      <p className="text-muted-foreground text-sm">Loading Custom Apps…</p>
    );
  }

  const activeCredentials = credentials.filter(
    (credential) => credential.status === "active"
  );

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-start gap-2">
          <div className="mr-auto">
            <h3 className="font-medium text-sm">Custom Apps</h3>
            <p className="text-muted-foreground text-xs">
              Connect a private App and review what it can do before making it
              available to Projects.
            </p>
          </div>
          <Button
            disabled={busyAction !== null}
            onClick={() => void refreshOperations()}
            size="sm"
            type="button"
            variant="outline"
          >
            Refresh health
          </Button>
        </div>
      </div>

      {operations ? <OperationalSurface snapshot={operations} /> : null}

      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-medium text-sm">
          Advanced: add a private credential
        </summary>
        <div className="mt-3 grid gap-3">
          <div className="space-y-2">
            <Label htmlFor={`mcp-credential-name-${environmentId}`}>Name</Label>
            <Input
              id={`mcp-credential-name-${environmentId}`}
              onChange={(event) => setCredentialName(event.target.value)}
              placeholder="Production API token"
              value={credentialName}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`mcp-secret-headers-${environmentId}`}>
              Secret headers (JSON)
            </Label>
            <Textarea
              id={`mcp-secret-headers-${environmentId}`}
              onChange={(event) => setSecretHeaders(event.target.value)}
              rows={4}
              value={secretHeaders}
            />
          </div>
          <Button
            disabled={busyAction !== null || !credentialName.trim()}
            onClick={() => void createCredential()}
            size="sm"
            type="button"
            variant="outline"
          >
            Save credential
          </Button>
          {credentials.length > 0 ? (
            <div className="grid gap-2">
              {credentials.map((credential) => (
                <div
                  className="flex items-center gap-2 text-xs"
                  key={credential.id}
                >
                  <span className="mr-auto">
                    {credential.name} · {credential.kind}
                  </span>
                  <Badge variant="outline">{credential.status}</Badge>
                  {credential.status === "revoked" ? null : (
                    <Button
                      disabled={busyAction !== null}
                      onClick={() => void revokeCredential(credential.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>

      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-medium text-sm">
          Advanced: connect a sign-in account
        </summary>
        <div className="mt-3 grid gap-3">
          <div className="space-y-2">
            <Label htmlFor={`mcp-oauth-name-${environmentId}`}>
              Credential name
            </Label>
            <Input
              id={`mcp-oauth-name-${environmentId}`}
              onChange={(event) => setCredentialName(event.target.value)}
              placeholder="Production account"
              value={credentialName}
            />
          </div>
          <Input
            aria-label="App resource URL"
            onChange={(event) => setOauthResource(event.target.value)}
            placeholder="https://apps.example.com/connect"
            type="url"
            value={oauthResource}
          />
          <Input
            aria-label="OAuth client ID"
            onChange={(event) => setOauthClientId(event.target.value)}
            placeholder="Client ID"
            value={oauthClientId}
          />
          <p className="text-muted-foreground text-xs">
            Kestrel discovers protected-resource and authorization-server
            metadata, verifies PKCE S256, and requests the server-advertised
            scopes and resource audience.
          </p>
          <Button
            disabled={
              busyAction !== null ||
              !credentialName.trim() ||
              !oauthResource.trim() ||
              !oauthClientId.trim()
            }
            onClick={() => void startOauth()}
            size="sm"
            type="button"
            variant="outline"
          >
            Continue to sign in
          </Button>
        </div>
      </details>

      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-medium text-sm">
          Add Custom App
        </summary>
        <div className="mt-3 grid gap-3">
          <div className="flex gap-2">
            {(["remote", "oci"] as const).map((candidate) => (
              <Button
                key={candidate}
                onClick={() => setSourceType(candidate)}
                size="sm"
                type="button"
                variant={sourceType === candidate ? "default" : "outline"}
              >
                {candidate === "remote"
                  ? "Connection URL"
                  : "Private container"}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`mcp-server-name-${environmentId}`}>Name</Label>
              <Input
                id={`mcp-server-name-${environmentId}`}
                onChange={(event) => setServerName(event.target.value)}
                placeholder="Team knowledge App"
                value={serverName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`mcp-server-slug-${environmentId}`}>Slug</Label>
              <Input
                id={`mcp-server-slug-${environmentId}`}
                onChange={(event) => setServerSlug(event.target.value)}
                placeholder="github"
                value={serverSlug}
              />
            </div>
          </div>
          {sourceType === "remote" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor={`mcp-remote-url-${environmentId}`}>
                  App connection URL
                </Label>
                <Input
                  id={`mcp-remote-url-${environmentId}`}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                  placeholder="https://apps.example.com/connect"
                  type="url"
                  value={remoteUrl}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`mcp-credential-${environmentId}`}>
                  Credential
                </Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  id={`mcp-credential-${environmentId}`}
                  onChange={(event) => setCredentialId(event.target.value)}
                  value={credentialId}
                >
                  <option value="">No authentication</option>
                  {activeCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.name} ({credential.kind})
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`mcp-image-${environmentId}`}>
                Digest-pinned OCI image
              </Label>
              <Input
                id={`mcp-image-${environmentId}`}
                onChange={(event) => setImageReference(event.target.value)}
                placeholder="ghcr.io/acme/server@sha256:…"
                value={imageReference}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor={`mcp-arguments-${environmentId}`}>
              Launch arguments (one per line)
            </Label>
            <Textarea
              id={`mcp-arguments-${environmentId}`}
              onChange={(event) => setLaunchArguments(event.target.value)}
              rows={3}
              value={launchArguments}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`mcp-egress-${environmentId}`}>
              Allowed HTTPS origins (one per line)
            </Label>
            <Textarea
              id={`mcp-egress-${environmentId}`}
              onChange={(event) => setEgressOrigins(event.target.value)}
              placeholder="https://api.example.com"
              rows={3}
              value={egressOrigins}
            />
            <p className="text-muted-foreground text-xs">
              Private container Apps remain on an internal network and can reach
              only these origins through the isolated egress broker.
            </p>
          </div>
          <Button
            disabled={
              busyAction !== null ||
              !serverName.trim() ||
              !serverSlug.trim() ||
              (sourceType === "remote"
                ? !remoteUrl.trim()
                : !imageReference.trim())
            }
            onClick={() => void installServer()}
            size="sm"
            type="button"
          >
            Add App
          </Button>
        </div>
      </details>

      {servers.length === 0 ? (
        <p className="text-muted-foreground text-sm">No Custom Apps added.</p>
      ) : (
        <div className="grid gap-3">
          {servers.map((server) => {
            const detail = details[server.id];
            return (
              <div className="space-y-3 rounded-md border p-3" key={server.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto font-medium text-sm">
                    {server.name}
                  </span>
                  <Badge variant="outline">{server.status}</Badge>
                  <Button
                    disabled={
                      busyAction !== null || server.status === "disabled"
                    }
                    onClick={() => void discoverServer(server.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Check capabilities
                  </Button>
                  <Button
                    disabled={busyAction !== null}
                    onClick={() => void loadServer(server.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {detail ? "Refresh" : "Review access"}
                  </Button>
                </div>
                {server.failureMessage ? (
                  <p className="text-destructive text-xs">
                    {server.failureMessage}
                  </p>
                ) : null}
                {detail?.snapshots.map((snapshot) => (
                  <div className="space-y-2 border-t pt-3" key={snapshot.id}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="mr-auto font-mono">
                        {snapshot.capabilityDigest.slice(0, 16)}…
                      </span>
                      <Badge variant="outline">{snapshot.status}</Badge>
                      {snapshot.status === "pending_review" ? (
                        <>
                          <Button
                            disabled={busyAction !== null}
                            onClick={() =>
                              void reviewSnapshot(
                                server.id,
                                snapshot.id,
                                "approve"
                              )
                            }
                            size="sm"
                            type="button"
                          >
                            Approve capabilities
                          </Button>
                          <Button
                            disabled={busyAction !== null}
                            onClick={() =>
                              void reviewSnapshot(
                                server.id,
                                snapshot.id,
                                "reject"
                              )
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                    </div>
                    {snapshot.status === "approved"
                      ? snapshot.capabilities.map((capability) => (
                          <div
                            className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs"
                            key={capability.id}
                          >
                            <span className="mr-auto">
                              {capability.displayName ??
                                capability.capabilityKey}
                              <span className="ml-2 text-muted-foreground">
                                {capability.kind}
                              </span>
                            </span>
                            {(["auto", "ask", "deny"] as const).map((mode) => (
                              <Button
                                disabled={busyAction !== null}
                                key={mode}
                                onClick={() =>
                                  void setCapabilityPolicy(
                                    server.id,
                                    capability,
                                    mode
                                  )
                                }
                                size="sm"
                                type="button"
                                variant={
                                  capability.approvalMode === mode
                                    ? "default"
                                    : "outline"
                                }
                              >
                                {mode}
                              </Button>
                            ))}
                          </div>
                        ))
                      : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

async function loadEnvironmentMcp(environmentId: string, signal: AbortSignal) {
  const [credentialsResponse, serversResponse, operationsResponse] =
    await Promise.all([
      fetch(`/api/organization/environments/${environmentId}/mcp/credentials`, {
        signal,
      }),
      fetch(`/api/organization/environments/${environmentId}/mcp/servers`, { signal }),
      fetch(`/api/organization/environments/${environmentId}/mcp/health`, { signal }),
    ]);
  const credentialsPayload = await readJson<{
    credentials?: CredentialMetadata[];
    error?: string;
  }>(credentialsResponse);
  const serversPayload = await readJson<{
    servers?: McpServer[];
    error?: string;
  }>(serversResponse);
  const operationsPayload = await readJson<
    OperationalSnapshot & { error?: string }
  >(operationsResponse);
  if (!credentialsResponse.ok) {
    throw new Error(
      credentialsPayload.error ?? "Custom App credentials failed to load."
    );
  }
  if (!serversResponse.ok) {
    throw new Error(serversPayload.error ?? "Custom Apps failed to load.");
  }
  if (!operationsResponse.ok) {
    throw new Error(
      operationsPayload.error ?? "Custom App activity failed to load."
    );
  }
  return {
    credentials: credentialsPayload.credentials ?? [],
    servers: serversPayload.servers ?? [],
    operations: operationsPayload,
  };
}

function OperationalSurface({ snapshot }: { snapshot: OperationalSnapshot }) {
  const metrics = [
    ["Apps", snapshot.summary.servers],
    ["Ready", snapshot.summary.readyServers],
    ["Degraded", snapshot.summary.degradedServers],
    ["Checks active", snapshot.summary.activeDiscoveryJobs],
    ["Requests pending", snapshot.summary.pendingInteractions],
    ["Calls failed", snapshot.summary.failedInvocations],
  ] as const;
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer font-medium text-sm">
        Advanced health and recent activity
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {metrics.map(([label, value]) => (
            <div className="rounded border p-2" key={label}>
              <p className="text-muted-foreground text-xs">{label}</p>
              <p className="font-medium text-sm">{value}</p>
            </div>
          ))}
        </div>
        <RecentActivity
          emptyMessage="No capability discovery activity."
          items={snapshot.discoveryJobs.map((job) => ({
            id: job.id,
            primary: `Discovery ${job.status}`,
            secondary: job.failureCode ?? shortId(job.serverId),
            timestamp: job.completedAt ?? job.createdAt,
          }))}
          title="Capability checks"
        />
        <RecentActivity
          emptyMessage="No Custom App calls."
          items={snapshot.invocations.map((invocation) => ({
            id: invocation.id,
            primary: `${invocation.method} · ${invocation.status}`,
            secondary:
              invocation.errorCode ??
              `request ${invocation.requestDigest.slice(0, 12)}…${
                invocation.responseDigest
                  ? ` · response ${invocation.responseDigest.slice(0, 12)}…`
                  : ""
              }`,
            timestamp: invocation.completedAt ?? invocation.createdAt,
          }))}
          title="App calls"
        />
        <RecentActivity
          emptyMessage="No App requests need attention."
          items={snapshot.interactions.map((interaction) => ({
            id: interaction.id,
            primary: `${interaction.kind} · ${interaction.status}`,
            secondary: `thread ${shortId(interaction.threadId)}`,
            timestamp: interaction.resolvedAt ?? interaction.createdAt,
          }))}
          title="App requests"
        />
        <p className="text-muted-foreground text-xs">
          This surface exposes status, identifiers, error codes, and replay
          digests only. Request bodies, responses, and credentials are omitted.
        </p>
      </div>
    </details>
  );
}

function RecentActivity({
  title,
  items,
  emptyMessage,
}: {
  title: string;
  items: Array<{
    id: string;
    primary: string;
    secondary: string;
    timestamp: string;
  }>;
  emptyMessage: string;
}) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-xs">{title}</p>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyMessage}</p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <div
              className="grid gap-0 rounded border px-2 py-1 text-xs sm:grid-cols-[1fr_auto]"
              key={item.id}
            >
              <span>{item.primary}</span>
              <time className="text-muted-foreground sm:text-right">
                {new Date(item.timestamp).toLocaleString()}
              </time>
              <span className="truncate font-mono text-muted-foreground sm:col-span-2">
                {item.secondary}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
