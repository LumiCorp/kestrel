"use client";

import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppSettingsHeader } from "@/components/apps/app-settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  AppConnectionSummary,
  EnvironmentAppCapability,
  EnvironmentAppConfiguration,
} from "@/lib/apps/types";

type Props = {
  environmentId: string;
  initialConfiguration: EnvironmentAppConfiguration;
};

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function ConnectionDialog({
  environmentId,
  app,
  onSaved,
}: {
  environmentId: string;
  app: EnvironmentAppConfiguration["app"];
  onSaved: (connection: AppConnectionSummary) => void;
}) {
  const isWeather = app.key === "built_in.weather";
  const isNgrok = app.key === "ngrok";
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(
    isWeather ? "Visual Crossing fallback" : "Primary"
  );
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [wildcardDomain, setWildcardDomain] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch(
        `/api/environments/${environmentId}/apps/${encodeURIComponent(app.key)}/connections`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: isNgrok ? "ngrok_agent" : "api_key",
            name,
            ...(isNgrok
              ? { authtoken: apiKey, wildcardDomain }
              : {
                  apiKey,
                  ...(projectId.trim() ? { projectId } : {}),
                }),
          }),
        }
      );
      const body = await readJson<{
        connection?: AppConnectionSummary;
        error?: string;
      }>(response);
      if (!(response.ok && body.connection)) {
        throw new Error(body.error ?? "Connection could not be saved.");
      }
      onSaved(body.connection);
      setApiKey("");
      setProjectId("");
      setWildcardDomain("");
      setOpen(false);
      toast.success(
        isWeather
          ? "Visual Crossing fallback is ready for this Environment."
          : isNgrok
            ? "ngrok validation has been sent to the Environment gateway."
          : `${app.displayName} is connected to this Environment.`,
        {
          description:
            "Projects can now attach this connection from Project → Apps.",
        }
      );
    } catch (error) {
      toast.error(message(error, "Connection could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  if (
    (!app.authMethods.includes("api_key") &&
      !app.authMethods.includes("agent_token")) ||
    (app.connectionModel !== "environment" && app.connectionModel !== "hybrid")
  ) {
    return null;
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Add connection
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isWeather
              ? "Add Visual Crossing fallback"
              : `Connect ${app.displayName}`}
          </DialogTitle>
          <DialogDescription>
            {isWeather
              ? "Open-Meteo remains the free primary provider. Kestrel verifies and encrypts this key, then makes the fallback available to Projects in this Environment."
              : isNgrok
                ? "Kestrel encrypts this Environment's ngrok agent token. Only the trusted Environment gateway can use it; Workspaces never receive it."
                : "This shared connection can be attached to Projects in this Environment. Kestrel encrypts the key before it is stored."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor={`${app.key}-connection-name`}>
              Connection name
            </Label>
            <Input
              id={`${app.key}-connection-name`}
              onChange={(event) => setName(event.target.value)}
              placeholder="Primary"
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${app.key}-connection-key`}>
              {isWeather
                ? "Visual Crossing API key"
                : isNgrok
                  ? "ngrok agent authtoken"
                  : "Connection key"}
            </Label>
            <Input
              autoComplete="off"
              id={`${app.key}-connection-key`}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                isWeather
                  ? "Paste your Visual Crossing API key"
                  : isNgrok
                    ? "Paste a wildcard-scoped ngrok authtoken"
                  : `Paste the key from ${app.displayName}`
              }
              type="password"
              value={apiKey}
            />
          </div>
          {isNgrok ? (
            <div className="space-y-2">
              <Label htmlFor={`${app.key}-wildcard-domain`}>
                Reserved wildcard domain
              </Label>
              <Input
                autoCapitalize="none"
                autoComplete="off"
                id={`${app.key}-wildcard-domain`}
                onChange={(event) => setWildcardDomain(event.target.value)}
                placeholder="*.previews.example.com"
                spellCheck={false}
                value={wildcardDomain}
              />
            </div>
          ) : null}
          {app.key === "tavily" ? (
            <details className="rounded-lg border px-4 py-3">
              <summary className="cursor-pointer font-medium text-sm">
                Advanced
              </summary>
              <div className="mt-4 space-y-2">
                <Label htmlFor={`${app.key}-project-id`}>
                  Tavily Project ID
                </Label>
                <Input
                  id={`${app.key}-project-id`}
                  onChange={(event) => setProjectId(event.target.value)}
                  placeholder="Optional"
                  value={projectId}
                />
              </div>
            </details>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              saving ||
              !name.trim() ||
              !apiKey.trim() ||
              (isNgrok && !wildcardDomain.trim())
            }
            onClick={() => void save()}
          >
            {saving
              ? "Verifying…"
              : isWeather
                ? "Verify and add fallback"
                : isNgrok
                  ? "Save and validate"
                  : "Verify and connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CapabilityRow({
  environmentId,
  appKey,
  capability,
  onSaved,
}: {
  environmentId: string;
  appKey: string;
  capability: EnvironmentAppCapability;
  onSaved: (capability: EnvironmentAppCapability) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function save(
    patch: Partial<Pick<EnvironmentAppCapability, "enabled" | "approvalMode">>
  ) {
    const next = { ...capability, ...patch };
    setSaving(true);
    try {
      const response = await fetch(
        `/api/environments/${environmentId}/apps/${encodeURIComponent(appKey)}/capabilities/${encodeURIComponent(capability.key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: next.enabled,
            approvalMode: next.enabled ? next.approvalMode : "deny",
            loggingMode: next.loggingMode,
            rateLimitMode: next.rateLimitMode,
          }),
        }
      );
      const body = await readJson<{
        grant?: {
          enabled: boolean;
          approvalMode: EnvironmentAppCapability["approvalMode"];
        };
        error?: string;
      }>(response);
      if (!(response.ok && body.grant)) {
        throw new Error(body.error ?? "Capability could not be updated.");
      }
      onSaved({
        ...next,
        enabled: body.grant.enabled,
        approvalMode: body.grant.approvalMode,
        inheritedDefault: false,
      });
    } catch (error) {
      toast.error(message(error, "Capability could not be updated."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_3rem] md:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm">{capability.displayName}</p>
          {capability.inheritedDefault ? (
            <Badge variant="outline">Recommended</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-muted-foreground text-sm">
          {capability.description}
        </p>
      </div>
      <Select
        disabled={saving || !capability.enabled}
        onValueChange={(value) =>
          void save({
            enabled: value !== "deny",
            approvalMode: value as EnvironmentAppCapability["approvalMode"],
          })
        }
        value={capability.enabled ? capability.approvalMode : "deny"}
      >
        <SelectTrigger aria-label={`${capability.displayName} approval`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Automatic</SelectItem>
          <SelectItem value="ask">Ask first</SelectItem>
          <SelectItem value="deny">Blocked</SelectItem>
        </SelectContent>
      </Select>
      <Switch
        aria-label={`Enable ${capability.displayName}`}
        checked={capability.enabled}
        disabled={saving}
        onCheckedChange={(enabled) =>
          void save({
            enabled,
            approvalMode: enabled ? capability.defaultApprovalMode : "deny",
          })
        }
      />
    </div>
  );
}

export function EnvironmentAppSettings({
  environmentId,
  initialConfiguration,
}: Props) {
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  function updateConfiguration(
    update: (current: EnvironmentAppConfiguration) => EnvironmentAppConfiguration
  ) {
    setConfiguration(update);
  }

  async function disconnect(appKey: string, connectionId: string) {
    setDisconnecting(connectionId);
    try {
      const response = await fetch(
        `/api/environments/${environmentId}/apps/${encodeURIComponent(appKey)}/connections/${connectionId}`,
        { method: "DELETE" }
      );
      const body = await readJson<{
        connection?: AppConnectionSummary;
        error?: string;
      }>(response);
      if (!(response.ok && body.connection)) {
        throw new Error(body.error ?? "Connection could not be disconnected.");
      }
      updateConfiguration((current) => ({
        ...current,
        connections: current.connections.map((connection) =>
          connection.id === body.connection!.id ? body.connection! : connection
        ),
      }));
      toast.success(
        "Connection disconnected. Encrypted configuration was retained for recovery."
      );
    } catch (error) {
      toast.error(message(error, "Connection could not be disconnected."));
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <div className="space-y-8">
      <AppSettingsHeader
        action={<ConnectionDialog
          app={configuration.app}
          environmentId={environmentId}
          onSaved={(connection) =>
            updateConfiguration((current) => ({
              ...current,
              connections: [
                ...current.connections.filter((item) => item.id !== connection.id),
                connection,
              ].sort((left, right) => left.name.localeCompare(right.name)),
            }))
          }
        />}
        appKey={configuration.app.key}
        backHref={`/settings/organization/environments/${environmentId}/apps`}
        backLabel="Environment Apps"
        description={configuration.app.description}
        icon={configuration.app.icon}
        name={configuration.app.displayName}
        status={
          configuration.app.readiness === "ready"
            ? "Ready"
            : configuration.app.readiness.replaceAll("_", " ")
        }
      />

      {configuration.app.key === "built_in.weather" ? (
        <section>
          <h3 className="font-medium text-sm">Providers</h3>
          <div className="mt-3 divide-y border-y">
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <p className="font-medium text-sm">Open-Meteo</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  Free primary provider. No Environment credential is required.
                </p>
              </div>
              <Badge variant="outline">Primary · ready</Badge>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <p className="font-medium text-sm">Visual Crossing</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  Optional fallback used only when the primary provider fails.
                </p>
              </div>
              <Badge variant="outline">
                {configuration.connections.some(
                  (connection) => connection.status === "connected"
                )
                  ? "Fallback · ready"
                  : "Fallback · optional"}
              </Badge>
            </div>
          </div>
        </section>
      ) : null}

      <section>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">
            {configuration.app.connectionModel === "none"
              ? "Connection"
              : configuration.app.connectionModel === "personal"
                ? "Personal connections"
                : configuration.app.connectionModel === "hybrid"
                  ? "Shared and personal connections"
                  : "Connections"}
          </h3>
        </div>
        <div className="mt-3 divide-y border-y">
          {configuration.app.connectionModel === "none" ? (
            <p className="py-3 text-muted-foreground text-sm">
              No connection required. Kestrel provides this App directly.
            </p>
          ) : configuration.app.connectionModel === "personal" ? (
            <p className="py-3 text-muted-foreground text-sm">
              Members connect their own accounts inside Projects. No shared
              credential is stored in this Environment.
            </p>
          ) : configuration.connections.length ? (
            configuration.connections.map((connection) => (
              <div
                className="flex items-center justify-between gap-3 py-3"
                key={connection.id}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{connection.name}</p>
                  <p className="mt-1 text-muted-foreground text-xs">
                    Shared with Projects in this Environment
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={connection.status === "connected" ? "default" : "outline"}
                  >
                    {connection.status}
                  </Badge>
                  {connection.ownerType === "environment" &&
                  connection.status !== "disconnected" ? (
                    <Button
                      aria-label={`Disconnect ${connection.name}`}
                      disabled={disconnecting === connection.id}
                      onClick={() =>
                        void disconnect(configuration.app.key, connection.id)
                      }
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <p className="py-3 text-muted-foreground text-sm">
              {configuration.app.connectionRequirement === "optional"
                ? "No shared connection is required. Add one to enable the optional provider path."
                : configuration.app.connectionModel === "hybrid"
                  ? "Add a shared connection, or let members attach personal connections inside Projects."
                  : "Add a connection to make this App available to Projects."}
            </p>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <div>
            <h3 className="font-medium text-sm">Access ceiling</h3>
            <p className="mt-1 text-muted-foreground text-xs">
              Projects can narrow these settings, but can never broaden them.
            </p>
          </div>
        </div>
        <div className="mt-3 divide-y border-y">
          {configuration.capabilities.map((capability) => (
            <CapabilityRow
              appKey={configuration.app.key}
              capability={capability}
              environmentId={environmentId}
              key={capability.key}
              onSaved={(saved) =>
                updateConfiguration((current) => ({
                  ...current,
                  capabilities: current.capabilities.map((item) =>
                    item.key === saved.key ? saved : item
                  ),
                }))
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}
