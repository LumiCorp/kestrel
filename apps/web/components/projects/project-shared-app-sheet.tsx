"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Check, Loader2, ShieldCheck, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AppIcon } from "@/components/apps/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  ProjectAppCapability,
  ProjectAppConfiguration,
} from "@/lib/apps/project-service";
import type { AppConnectionSummary } from "@/lib/apps/types";
import { cn } from "@/lib/utils";

type Props = {
  projectId: string;
  configuration: ProjectAppConfiguration | null;
  canEdit: boolean;
  canAttachPersonal: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<unknown>;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

function approvalLabel(mode: ProjectAppCapability["approvalMode"]) {
  if (mode === "auto") return "Automatic";
  if (mode === "ask") return "Ask first";
  return "Blocked";
}

function allowedApprovalModes(
  environmentMode: ProjectAppCapability["environmentApprovalMode"]
) {
  if (environmentMode === "deny") return ["deny"] as const;
  if (environmentMode === "ask") return ["ask", "deny"] as const;
  return ["auto", "ask", "deny"] as const;
}

export function ProjectSharedAppSheet({
  projectId,
  configuration,
  canEdit,
  canAttachPersonal,
  open,
  onOpenChange,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const appKey = configuration?.app.key ?? "custom-app";
  const appName = configuration?.app.displayName ?? "App";
  const isPersonalOnly = configuration?.app.connectionModel === "personal";
  const isHybrid = configuration?.app.connectionModel === "hybrid";
  const supportsConnection = configuration?.app.connectionModel !== "none";
  const isWeather = appKey === "built_in.weather";
  const needsConnection =
    configuration?.app.connectionRequirement === "required";

  async function updateApp(enabled: boolean) {
    setBusy("app");
    try {
      await requestJson(`/api/projects/${projectId}/apps/${appKey}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await onChanged();
      toast.success(enabled ? "App enabled for this Project" : "App disabled", {
        description: enabled
          ? isPersonalOnly
            ? "Choose your account and review the Project access settings."
            : needsConnection
              ? "Choose a shared connection and review the Project access settings."
              : "No connection is required. Review the Project access settings."
          : "Connections and access settings were retained for recovery.",
      });
    } catch (error) {
      toast.error(errorMessage(error, "App could not be updated."));
    } finally {
      setBusy(null);
    }
  }

  async function selectConnection(connection: AppConnectionSummary) {
    const scope = connection.ownerType === "personal" ? "personal" : "shared";
    setBusy(`connection:${connection.id}`);
    try {
      await requestJson(
        `/api/projects/${projectId}/apps/${appKey}/connections/${connection.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope,
            isDefault: true,
          }),
        }
      );
      await onChanged();
      toast.success(
        scope === "personal"
          ? "Your Project default connection was updated"
          : "Project default connection updated"
      );
    } catch (error) {
      toast.error(errorMessage(error, "Connection could not be attached."));
    } finally {
      setBusy(null);
    }
  }

  async function removeConnection(connectionId: string) {
    setBusy(`connection:${connectionId}`);
    try {
      await requestJson(
        `/api/projects/${projectId}/apps/${appKey}/connections/${connectionId}`,
        { method: "DELETE" }
      );
      await onChanged();
      toast.success("Connection removed from this Project");
    } catch (error) {
      toast.error(errorMessage(error, "Connection could not be removed."));
    } finally {
      setBusy(null);
    }
  }

  async function updateCapability(
    capability: ProjectAppCapability,
    input: {
      enabled: boolean;
      approvalMode: ProjectAppCapability["approvalMode"];
    }
  ) {
    setBusy(`capability:${capability.key}`);
    try {
      await requestJson(
        `/api/projects/${projectId}/apps/${appKey}/capabilities/${encodeURIComponent(capability.key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error, "Capability could not be updated."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-transparent" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-[-14px_0_40px_rgba(17,17,17,0.05)] outline-none sm:w-[39rem]">
          <div className="relative flex items-center gap-4 border-b px-6 py-7 pr-16 sm:px-8">
            <AppIcon
              appKey={appKey}
              className="size-12"
              icon={configuration?.app.icon ?? null}
            />
            <div>
              <Dialog.Title className="font-semibold text-xl tracking-tight">
                {appName}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-muted-foreground text-sm">
                {supportsConnection
                  ? "Choose what this Project can use and which connection applies."
                  : "Choose which capabilities this Project can use."}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                aria-label="Close App settings"
                className="absolute top-5 right-5"
                size="icon"
                variant="ghost"
              >
                <X className="size-5" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 sm:px-8">
            {configuration ? (
              <>
                <section className="py-7">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-base">
                        Project access
                      </h3>
                      <p className="mt-1 max-w-md text-muted-foreground text-sm">
                        Turning this off immediately removes {appName} from this
                        Project without deleting its setup.
                      </p>
                    </div>
                    <Switch
                      aria-label={`Enable ${appName} for this Project`}
                      checked={configuration.enabled}
                      disabled={!canEdit || busy === "app"}
                      onCheckedChange={(enabled) => void updateApp(enabled)}
                    />
                  </div>
                </section>

                <section className="border-t py-7">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-base">
                        {supportsConnection
                          ? isWeather
                            ? "Optional Weather fallback"
                            : isPersonalOnly
                              ? "Your connection"
                              : isHybrid
                                ? "Personal and shared connections"
                                : configuration.app.connectionRequirement ===
                                    "optional"
                                  ? "Optional shared connection"
                                  : "Shared connection"
                          : "Connection"}
                      </h3>
                      <p className="mt-1 text-muted-foreground text-sm">
                        {supportsConnection
                          ? isWeather
                            ? "Weather always uses Open-Meteo first. Attach the Environment's Visual Crossing connection to enable the verified fallback for this Project."
                            : isPersonalOnly
                              ? "Your agents use your Project default. Teammates connect their own accounts."
                              : isHybrid
                                ? "Your personal default is used first. The Project shared default is used when you have none."
                                : configuration.app.connectionRequirement ===
                                    "optional"
                                  ? "The App works without this connection; attaching one enables its optional provider path."
                                  : "Agents use the Project default. They never choose or see credentials."
                          : "No connection is required. Kestrel provides this App directly."}
                      </p>
                    </div>
                    {supportsConnection ? (
                      <Badge variant="outline">
                        {configuration.attachedConnections.length} attached
                      </Badge>
                    ) : (
                      <Badge variant="outline">Built in</Badge>
                    )}
                  </div>
                  <div className="mt-5 divide-y overflow-hidden rounded-xl border">
                    {supportsConnection ? (
                      configuration.availableConnections.length ? (
                        configuration.availableConnections.map((connection) => {
                          const connectionIsPersonal =
                            connection.ownerType === "personal";
                          const canManageConnection = connectionIsPersonal
                            ? canAttachPersonal
                            : canEdit;
                          const attachment =
                            configuration.attachedConnections.find(
                              (item) => item.id === connection.id
                            );
                          return (
                            <div
                              className="flex min-h-16 items-center gap-3 px-4 py-3"
                              key={connection.id}
                            >
                              <span
                                className={cn(
                                  "flex size-8 shrink-0 items-center justify-center rounded-full border",
                                  attachment?.isDefault &&
                                    "border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                                )}
                              >
                                {attachment?.isDefault ? (
                                  <Check className="size-4" />
                                ) : null}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium text-sm">
                                  {connection.name}
                                </p>
                                <p className="mt-1 text-muted-foreground text-xs">
                                  {attachment?.isDefault
                                    ? "Project default"
                                    : attachment
                                      ? "Attached"
                                      : connectionIsPersonal
                                        ? "Available to you"
                                        : "Available in this Environment"}
                                </p>
                              </div>
                              {attachment && canManageConnection ? (
                                <Button
                                  aria-label={`Remove ${connection.name} from this Project`}
                                  disabled={
                                    busy === `connection:${connection.id}`
                                  }
                                  onClick={() =>
                                    void removeConnection(connection.id)
                                  }
                                  size="icon"
                                  variant="ghost"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              ) : null}
                              <Button
                                disabled={
                                  !canManageConnection ||
                                  attachment?.isDefault ||
                                  busy === `connection:${connection.id}`
                                }
                                onClick={() =>
                                  void selectConnection(connection)
                                }
                                size="sm"
                                variant={
                                  attachment?.isDefault
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {busy === `connection:${connection.id}` ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : attachment?.isDefault ? (
                                  "Default"
                                ) : (
                                  "Use"
                                )}
                              </Button>
                            </div>
                          );
                        })
                      ) : (
                        <div className="px-4 py-5">
                          <p className="font-medium text-sm">
                            {isPersonalOnly
                              ? "No personal connection"
                              : isHybrid
                                ? "No personal or shared connection"
                                : configuration.app.connectionRequirement ===
                                    "optional"
                                  ? "No optional connection"
                                  : "No shared connection"}
                          </p>
                          <p className="mt-1 text-muted-foreground text-sm">
                            {isPersonalOnly
                              ? "Connect this App from Apps before adding it to this Project."
                              : isHybrid
                                ? "Connect a personal account from Apps, or ask an organization admin to add a shared Environment connection."
                                : isWeather
                                  ? "Weather remains ready with Open-Meteo. Ask an organization admin to add a Visual Crossing fallback in Environment Apps if this Project needs failover."
                                  : configuration.app.connectionRequirement ===
                                      "optional"
                                    ? "The App remains available without this optional provider connection."
                                    : "An organization admin must add a connection for this App in the Project's Environment."}
                          </p>
                          <Button
                            asChild
                            className="mt-4"
                            size="sm"
                            variant="outline"
                          >
                            <Link
                              href={
                                isPersonalOnly
                                  ? `/apps/${encodeURIComponent(appKey)}`
                                  : `/settings/environments/${configuration.environmentId}/apps`
                              }
                            >
                              {isPersonalOnly
                                ? "Open App"
                                : "Open Environment Apps"}
                            </Link>
                          </Button>
                        </div>
                      )
                    ) : (
                      <div className="px-4 py-5">
                        <p className="font-medium text-sm">Ready to use</p>
                        <p className="mt-1 text-muted-foreground text-sm">
                          Access is controlled entirely by the Environment
                          ceiling and Project capabilities below.
                        </p>
                      </div>
                    )}
                  </div>
                </section>

                <section className="border-t py-7">
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <ShieldCheck className="size-4" />
                    </span>
                    <div>
                      <h3 className="font-semibold text-base">
                        Agent capabilities
                      </h3>
                      <p className="mt-1 text-muted-foreground text-sm">
                        This Project can only keep or narrow the Environment
                        ceiling.
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 divide-y overflow-hidden rounded-xl border">
                    {configuration.capabilities.map((capability) => {
                      const capabilityBusy =
                        busy === `capability:${capability.key}`;
                      const modes = allowedApprovalModes(
                        capability.environmentApprovalMode
                      );
                      return (
                        <div className="px-4 py-4" key={capability.key}>
                          <div className="flex items-start gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-sm">
                                  {capability.displayName}
                                </p>
                                {capability.environmentEnabled ? (
                                  capability.inherited ? (
                                    <Badge variant="outline">Inherited</Badge>
                                  ) : null
                                ) : (
                                  <Badge variant="outline">Unavailable</Badge>
                                )}
                              </div>
                              <p className="mt-1 text-muted-foreground text-sm leading-5">
                                {capability.description}
                              </p>
                              <p className="mt-2 text-muted-foreground text-xs">
                                Environment:{" "}
                                {approvalLabel(
                                  capability.environmentApprovalMode
                                )}
                              </p>
                            </div>
                            <Switch
                              aria-label={`Enable ${capability.displayName}`}
                              checked={capability.enabled}
                              disabled={
                                !(
                                  canEdit &&
                                  configuration.enabled &&
                                  capability.environmentEnabled
                                ) || capabilityBusy
                              }
                              onCheckedChange={(enabled) =>
                                void updateCapability(capability, {
                                  enabled,
                                  approvalMode: enabled
                                    ? capability.environmentApprovalMode
                                    : "deny",
                                })
                              }
                            />
                          </div>
                          <Select
                            disabled={
                              !(
                                canEdit &&
                                configuration.enabled &&
                                capability.enabled
                              ) || capabilityBusy
                            }
                            onValueChange={(approvalMode) =>
                              void updateCapability(capability, {
                                enabled: approvalMode !== "deny",
                                approvalMode:
                                  approvalMode as ProjectAppCapability["approvalMode"],
                              })
                            }
                            value={
                              capability.enabled
                                ? capability.approvalMode
                                : "deny"
                            }
                          >
                            <SelectTrigger className="mt-3 h-9 w-full sm:w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {modes.map((mode) => (
                                <SelectItem key={mode} value={mode}>
                                  {approvalLabel(mode)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </>
            ) : (
              <section className="py-8">
                <h3 className="font-semibold">App unavailable</h3>
                <p className="mt-2 max-w-md text-muted-foreground text-sm leading-6">
                  An organization admin must install this App before it can be
                  connected to this Project.
                </p>
                <Button asChild className="mt-5" variant="outline">
                  <Link href="/apps">Open Apps</Link>
                </Button>
              </section>
            )}
          </div>

          <div className="border-t px-6 py-6 sm:px-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              {configuration?.enabled && canEdit ? (
                <Button
                  disabled={busy === "app"}
                  onClick={() => void updateApp(false)}
                  variant="outline"
                >
                  Disable for Project
                </Button>
              ) : null}
              <Dialog.Close asChild>
                <Button variant="outline">Close</Button>
              </Dialog.Close>
            </div>
            {!canEdit && configuration ? (
              <p className="mt-4 text-center text-muted-foreground text-xs">
                Project editors manage capability access. Each member manages
                their own personal connections.
              </p>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
