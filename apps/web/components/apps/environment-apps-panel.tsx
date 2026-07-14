"use client";

import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AppIcon } from "@/components/apps/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  initialConfigurations: EnvironmentAppConfiguration[];
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
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Primary");
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");
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
            name,
            apiKey,
            ...(projectId.trim() ? { projectId } : {}),
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
      setOpen(false);
      toast.success(`${app.displayName} is connected to this Environment.`);
    } catch (error) {
      toast.error(message(error, "Connection could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  if (app.key !== "tavily") return null;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Add connection
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {app.displayName}</DialogTitle>
          <DialogDescription>
            This shared connection can be attached to Projects in this
            Environment. Kestrel encrypts the key before it is stored.
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
            <Label htmlFor={`${app.key}-connection-key`}>Connection key</Label>
            <Input
              autoComplete="off"
              id={`${app.key}-connection-key`}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste the key from Tavily"
              type="password"
              value={apiKey}
            />
          </div>
          <details className="rounded-lg border px-4 py-3">
            <summary className="cursor-pointer font-medium text-sm">
              Advanced
            </summary>
            <div className="mt-4 space-y-2">
              <Label htmlFor={`${app.key}-project-id`}>Tavily Project ID</Label>
              <Input
                id={`${app.key}-project-id`}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="Optional"
                value={projectId}
              />
            </div>
          </details>
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={saving || !name.trim() || !apiKey.trim()}
            onClick={() => void save()}
          >
            {saving ? "Verifying…" : "Verify and connect"}
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

export function EnvironmentAppsPanel({
  environmentId,
  initialConfigurations,
}: Props) {
  const [configurations, setConfigurations] = useState(initialConfigurations);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const configuredCount = useMemo(
    () =>
      configurations.filter(
        (configuration) =>
          configuration.app.connectionModel !== "environment" ||
          configuration.connections.some(
            (connection) => connection.status === "connected"
          )
      ).length,
    [configurations]
  );

  function updateConfiguration(
    appKey: string,
    update: (
      current: EnvironmentAppConfiguration
    ) => EnvironmentAppConfiguration
  ) {
    setConfigurations((current) =>
      current.map((configuration) =>
        configuration.app.key === appKey ? update(configuration) : configuration
      )
    );
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
      updateConfiguration(appKey, (configuration) => ({
        ...configuration,
        connections: configuration.connections.map((connection) =>
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

  if (!configurations.length) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-4 p-6">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted">
            <KeyRound className="size-5" />
          </div>
          <div>
            <p className="font-medium">No shared Apps installed</p>
            <p className="mt-1 text-muted-foreground text-sm">
              Install an App from the gallery, then return here to add shared
              connections and set the Environment access ceiling.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/apps">Browse Apps</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-xl">Environment Apps</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {configuredCount} of {configurations.length} ready for Projects
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/apps">Browse Apps</Link>
        </Button>
      </div>

      {configurations.map((configuration) => (
        <Card key={configuration.app.key}>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div className="flex items-start gap-3">
              <AppIcon
                appKey={configuration.app.key}
                className="size-11"
                icon={configuration.app.icon}
              />
              <div>
                <CardTitle>{configuration.app.displayName}</CardTitle>
                <p className="mt-1 text-muted-foreground text-sm">
                  {configuration.app.description}
                </p>
              </div>
            </div>
            <ConnectionDialog
              app={configuration.app}
              environmentId={environmentId}
              onSaved={(connection) =>
                updateConfiguration(configuration.app.key, (current) => ({
                  ...current,
                  connections: [
                    ...current.connections.filter(
                      (item) => item.id !== connection.id
                    ),
                    connection,
                  ].sort((left, right) => left.name.localeCompare(right.name)),
                }))
              }
            />
          </CardHeader>
          <CardContent className="space-y-6">
            <section>
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-muted-foreground" />
                <h3 className="font-medium text-sm">
                  {configuration.app.connectionModel === "none"
                    ? "Connection"
                    : configuration.app.connectionModel === "personal"
                      ? "Personal connections"
                      : "Connections"}
                </h3>
              </div>
              <div className="mt-3 divide-y rounded-lg border">
                {configuration.app.connectionModel === "none" ? (
                  <p className="px-4 py-3 text-muted-foreground text-sm">
                    No connection required. Kestrel provides this App directly,
                    while the access ceiling below controls what Projects can
                    use.
                  </p>
                ) : configuration.app.connectionModel === "personal" ? (
                  <p className="px-4 py-3 text-muted-foreground text-sm">
                    Members connect their own accounts inside Projects. No
                    shared account or credential is stored in this Environment.
                  </p>
                ) : configuration.connections.length ? (
                  configuration.connections.map((connection) => (
                    <div
                      className="flex items-center justify-between gap-3 px-4 py-3"
                      key={connection.id}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-sm">
                          {connection.name}
                        </p>
                        <p className="mt-1 text-muted-foreground text-xs">
                          Shared with Projects in this Environment
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            connection.status === "connected"
                              ? "default"
                              : "outline"
                          }
                        >
                          {connection.status}
                        </Badge>
                        {connection.ownerType === "environment" &&
                        connection.status !== "disconnected" ? (
                          <Button
                            aria-label={`Disconnect ${connection.name}`}
                            disabled={disconnecting === connection.id}
                            onClick={() =>
                              void disconnect(
                                configuration.app.key,
                                connection.id
                              )
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
                  <p className="px-4 py-3 text-muted-foreground text-sm">
                    Add a connection to make this App available to Projects.
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
                    Projects can narrow these settings, but can never broaden
                    them.
                  </p>
                </div>
              </div>
              <div className="mt-3 divide-y rounded-lg border">
                {configuration.capabilities.map((capability) => (
                  <CapabilityRow
                    appKey={configuration.app.key}
                    capability={capability}
                    environmentId={environmentId}
                    key={capability.key}
                    onSaved={(saved) =>
                      updateConfiguration(configuration.app.key, (current) => ({
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
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
