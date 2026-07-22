"use client";

import { CheckCircle2, Circle, Loader2, Server, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Model = {
  id: string;
  gatewayId: string;
  rawModelId: string;
  alias: string | null;
  modality: string;
  approved: boolean;
  gatewayEnabled: boolean;
};
type Gateway = {
  id: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  metadata: Record<string, unknown> | null;
};
type Profile = { id: string; displayName: string; description: string | null };
type Deployment = {
  deployment: {
    id: string;
    displayName: string;
    status: string;
    failureMessage: string | null;
    gatewayId: string | null;
  };
  profile: Profile;
};
type State = {
  environment: { id: string; name: string };
  managed: {
    available: boolean;
    policy: { enabled: boolean; maxActiveDeployments: number };
    profiles: Profile[];
    deployments: Deployment[];
  };
  connected: Gateway[];
  models: Model[];
  defaults: Array<{ modality: string; modelId: string }>;
};

const activeStatuses = new Set([
  "requested",
  "provisioning_template",
  "provisioning_endpoint",
  "waiting_for_capacity",
  "validating",
  "deleting",
]);

const deploymentStage: Record<string, number> = {
  requested: 0,
  provisioning_template: 0,
  provisioning_endpoint: 1,
  waiting_for_capacity: 1,
  validating: 2,
  ready: 3,
};

async function readPayload(response: Response) {
  const payload = (await response.json()) as State & { error?: string };
  if (!response.ok)
    throw new Error(payload.error ?? "Private inference request failed.");
  return payload;
}

export function EnvironmentInferenceClient({
  initialState,
}: {
  initialState: State;
}) {
  const [state, setState] = useState(initialState);
  const [mode, setMode] = useState<"managed" | "connected">("managed");
  const [profileId, setProfileId] = useState(
    initialState.managed.profiles[0]?.id ?? ""
  );
  const [managedName, setManagedName] = useState(
    `${initialState.environment.name} inference`
  );
  const [endpointName, setEndpointName] = useState("Private RunPod endpoint");
  const [endpointId, setEndpointId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [servedModelId, setServedModelId] = useState("");
  const [gatewayModelIds, setGatewayModelIds] = useState<
    Record<string, string>
  >({});
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/organization/environments/${state.environment.id}/inference`;

  const refresh = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    setState(await readPayload(response));
  }, [endpoint]);

  const isProvisioning = state.managed.deployments.some(({ deployment }) =>
    activeStatuses.has(deployment.status)
  );
  useEffect(() => {
    if (!isProvisioning) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [isProvisioning, refresh]);

  const defaultModelId = state.defaults.find(
    (item) => item.modality === "language"
  )?.modelId;
  const availableModels = useMemo(
    () =>
      state.models.filter(
        (model) =>
          model.modality === "language" &&
          model.approved &&
          model.gatewayEnabled
      ),
    [state.models]
  );

  async function request(
    body: Record<string, unknown>,
    options?: { method?: string; path?: string }
  ) {
    setBusy(true);
    const priorGatewayIds = new Set(
      state.connected.map((gateway) => gateway.id)
    );
    try {
      const response = await fetch(options?.path ?? endpoint, {
        method: options?.method ?? "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readPayload(response);
      if ("environment" in payload) setState(payload);
      else await refresh();
      const connectedWarning =
        body.kind === "connected" && "connected" in payload
          ? payload.connected.find(
              (gateway) =>
                !priorGatewayIds.has(gateway.id) &&
                ["model_id_required", "validation_failed"].includes(
                  String(gateway.metadata?.validationStatus)
                )
            )
          : null;
      const warningMessage =
        typeof connectedWarning?.metadata?.validationMessage === "string"
          ? connectedWarning.metadata.validationMessage
          : null;
      if (connectedWarning) {
        toast.warning(
          warningMessage ?? "The endpoint needs a served model ID."
        );
      } else {
        toast.success("Private inference updated.");
      }
    } catch (error) {
      try {
        await refresh();
      } catch {
        // Preserve the action error as the message the administrator sees.
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Private inference request failed."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Private inference</CardTitle>
          <p className="text-muted-foreground text-sm">
            Models configured here are inherited by every Project and standalone
            Thread in this Environment.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button
              onClick={() => setMode("managed")}
              variant={mode === "managed" ? "default" : "outline"}
            >
              <Server className="mr-2 size-4" />
              Launch managed
            </Button>
            <Button
              onClick={() => setMode("connected")}
              variant={mode === "connected" ? "default" : "outline"}
            >
              <Unplug className="mr-2 size-4" />
              Connect existing
            </Button>
          </div>
          {mode === "managed" ? (
            state.managed.available ? (
              <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <div className="space-y-2">
                  <Label htmlFor="profile">Qualified profile</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    id="profile"
                    onChange={(event) => setProfileId(event.target.value)}
                    value={profileId}
                  >
                    {state.managed.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="managed-name">Deployment name</Label>
                  <Input
                    id="managed-name"
                    onChange={(event) => setManagedName(event.target.value)}
                    value={managedName}
                  />
                </div>
                <Button
                  disabled={busy || !profileId || !managedName.trim()}
                  onClick={() =>
                    void request({
                      kind: "managed",
                      profileId,
                      displayName: managedName,
                    })
                  }
                >
                  {busy ? "Launching…" : "Launch"}
                </Button>
              </div>
            ) : (
              <div className="rounded-md border p-4 text-sm">
                Managed inference is not enabled for this organization. You can
                still connect an existing endpoint.
              </div>
            )
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="endpoint-name">Name</Label>
                <Input
                  id="endpoint-name"
                  onChange={(event) => setEndpointName(event.target.value)}
                  value={endpointName}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endpoint-id">RunPod endpoint ID</Label>
                <Input
                  id="endpoint-id"
                  onChange={(event) => setEndpointId(event.target.value)}
                  placeholder="abc123"
                  value={endpointId}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="api-key">RunPod API key</Label>
                <Input
                  autoComplete="off"
                  id="api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  value={apiKey}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="served-model-id">Served model ID</Label>
                <Input
                  autoComplete="off"
                  id="served-model-id"
                  onChange={(event) => setServedModelId(event.target.value)}
                  placeholder="Qwen/Qwen3-8B"
                  value={servedModelId}
                />
                <p className="text-muted-foreground text-xs">
                  Optional when the endpoint supports model discovery; required
                  otherwise. Use the exact model ID accepted by its chat
                  completions API.
                </p>
              </div>
              <Button
                className="md:col-span-2"
                disabled={
                  busy ||
                  !endpointName.trim() ||
                  !endpointId.trim() ||
                  !apiKey.trim()
                }
                onClick={() =>
                  void request({
                    kind: "connected",
                    displayName: endpointName,
                    endpointId,
                    apiKey,
                    ...(servedModelId.trim()
                      ? { servedModelId: servedModelId.trim() }
                      : {}),
                  })
                }
              >
                {busy ? "Validating…" : "Connect and validate"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {state.managed.deployments.map(({ deployment, profile }) => (
        <Card key={deployment.id}>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>{deployment.displayName}</CardTitle>
              <p className="text-muted-foreground text-sm">
                Managed · {profile.displayName}
              </p>
            </div>
            <Badge variant="outline">{deployment.status}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-4">
              {["Requested", "Capacity", "Validation", "Ready"].map(
                (label, index) => {
                  const currentStage = deploymentStage[deployment.status] ?? 0;
                  const complete =
                    deployment.status === "ready" || index < currentStage;
                  const active =
                    activeStatuses.has(deployment.status) &&
                    index === currentStage;
                  return (
                    <div className="flex items-center gap-2" key={label}>
                      {active ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : complete ? (
                        <CheckCircle2 className="size-4 text-emerald-600" />
                      ) : (
                        <Circle className="size-4" />
                      )}
                      {label}
                    </div>
                  );
                }
              )}
            </div>
            {deployment.failureMessage ? (
              <p className="text-destructive text-sm">
                {deployment.failureMessage}
              </p>
            ) : null}
            <div className="flex gap-2">
              {deployment.status === "failed" ||
              deployment.status === "delete_failed" ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void request(
                      { action: "retry" },
                      { path: `${endpoint}/deployments/${deployment.id}` }
                    )
                  }
                  variant="outline"
                >
                  Retry
                </Button>
              ) : null}
              <Button
                disabled={busy || deployment.status === "deleting"}
                onClick={() =>
                  void request(
                    {},
                    {
                      method: "DELETE",
                      path: `${endpoint}/deployments/${deployment.id}`,
                    }
                  )
                }
                variant="destructive"
              >
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {state.connected.map((gateway) => {
        const models = state.models.filter(
          (model) =>
            model.gatewayId === gateway.id && model.modality === "language"
        );
        const validationMessage =
          typeof gateway.metadata?.validationMessage === "string"
            ? gateway.metadata.validationMessage
            : null;
        const manualModelId = gatewayModelIds[gateway.id] ?? "";
        return (
          <Card key={gateway.id}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>{gateway.displayName}</CardTitle>
                <p className="text-muted-foreground text-sm">
                  Connected RunPod endpoint
                </p>
              </div>
              <Badge variant={gateway.enabled ? "default" : "outline"}>
                {gateway.enabled ? "Ready" : "Validation required"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {gateway.metadata?.validationStatus === "model_id_required" ? (
                <p className="text-destructive text-sm">
                  {validationMessage ??
                    "Model discovery is unavailable for this endpoint. Enter the served model ID to validate it directly."}
                </p>
              ) : null}
              {gateway.metadata?.validationStatus === "validation_failed" ? (
                <p className="text-destructive text-sm">
                  {validationMessage ??
                    "The served model could not be validated."}
                </p>
              ) : null}
              {models.length === 0 ? (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="space-y-2">
                    <Label htmlFor={`gateway-model-${gateway.id}`}>
                      Served model ID
                    </Label>
                    <Input
                      id={`gateway-model-${gateway.id}`}
                      onChange={(event) =>
                        setGatewayModelIds((current) => ({
                          ...current,
                          [gateway.id]: event.target.value,
                        }))
                      }
                      placeholder="Qwen/Qwen3-8B"
                      value={manualModelId}
                    />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Kestrel validates streaming OpenAI-compatible chat
                    completions with tool calling. Queue-only /run and /runsync
                    handlers are not supported yet.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || !manualModelId.trim()}
                      onClick={() =>
                        void request(
                          {
                            action: "validate_served_model",
                            servedModelId: manualModelId.trim(),
                          },
                          { path: `${endpoint}/gateways/${gateway.id}` }
                        )
                      }
                      size="sm"
                    >
                      Validate model
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void request(
                          { action: "sync" },
                          { path: `${endpoint}/gateways/${gateway.id}` }
                        )
                      }
                      size="sm"
                      variant="outline"
                    >
                      Retry discovery
                    </Button>
                  </div>
                </div>
              ) : null}
              {models.map((model) => (
                <div
                  className="flex items-center justify-between rounded-md border p-3"
                  key={model.id}
                >
                  <div>
                    <div className="font-medium text-sm">
                      {model.alias || model.rawModelId}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {model.approved ? "Approved" : "Discovered"}
                    </div>
                  </div>
                  {model.approved ? null : (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void request(
                          { action: "validate", modelId: model.id },
                          { path: `${endpoint}/gateways/${gateway.id}` }
                        )
                      }
                      size="sm"
                    >
                      Validate
                    </Button>
                  )}
                </div>
              ))}
              <Button
                disabled={busy}
                onClick={() =>
                  void request(
                    {},
                    {
                      method: "DELETE",
                      path: `${endpoint}/gateways/${gateway.id}`,
                    }
                  )
                }
                variant="destructive"
              >
                Remove endpoint
              </Button>
            </CardContent>
          </Card>
        );
      })}

      {availableModels.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Environment default</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <select
              className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
              onChange={(event) =>
                void request(
                  { modelId: event.target.value },
                  { method: "PUT", path: `${endpoint}/default` }
                )
              }
              value={defaultModelId ?? ""}
            >
              <option disabled value="">
                Select a default model
              </option>
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.alias || model.rawModelId}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
