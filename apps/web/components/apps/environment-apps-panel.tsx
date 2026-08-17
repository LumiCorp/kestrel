"use client";

import Link from "next/link";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppSettingsHeader } from "@/components/apps/app-settings-layout";
import {
  SettingsDisclosure,
  SettingsSection,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import type { RuntimeApprovalReturnContext } from "@/lib/apps/runtime-approval-policy";

type Props = {
  environmentId: string;
  initialConfiguration: EnvironmentAppConfiguration;
  approvalReturnContext?: RuntimeApprovalReturnContext | undefined;
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
  const isDiscoveredApp = app.delivery === "mcp";
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(
    isWeather ? "Visual Crossing fallback" : "Primary",
  );
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
            kind: "api_key",
            name,
            apiKey,
            ...(projectId.trim() ? { projectId } : {}),
          }),
        },
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
      toast.success(
        isWeather
          ? "Visual Crossing fallback is ready for this Environment."
          : isDiscoveredApp
            ? `${app.displayName} connection saved. Kestrel is checking its capabilities.`
            : `${app.displayName} is connected to this Environment.`,
        {
          description: isDiscoveredApp
            ? "The App will become available after its capabilities are reviewed."
            : "Projects can now attach this connection from Project → Apps.",
        },
      );
    } catch (error) {
      toast.error(message(error, "Connection could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  if (
    !app.authMethods.includes("api_key") ||
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
                : app.key === "linear"
                  ? "Linear API key"
                  : app.key === "atlassian"
                    ? "Atlassian service account API key"
                    : app.key === "vercel"
                      ? "Vercel access token"
                      : "Connection key"}
            </Label>
            <Input
              autoComplete="off"
              id={`${app.key}-connection-key`}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                isWeather
                  ? "Paste your Visual Crossing API key"
                  : `Paste the key from ${app.displayName}`
              }
              type="password"
              value={apiKey}
            />
          </div>
          {app.key === "tavily" || app.key === "vercel" ? (
            <details className="rounded-lg border px-4 py-3">
              <summary className="cursor-pointer font-medium text-sm">
                Advanced
              </summary>
              <div className="mt-4 space-y-2">
                <Label htmlFor={`${app.key}-project-id`}>
                  {app.key === "vercel"
                    ? "Vercel Team ID"
                    : "Tavily Project ID"}
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
            disabled={saving || !name.trim() || !apiKey.trim()}
            onClick={() => void save()}
          >
            {saving
              ? "Verifying…"
              : isWeather
                ? "Verify and add fallback"
                : "Verify and connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OauthConnectionButton({
  environmentId,
  app,
}: {
  environmentId: string;
  app: EnvironmentAppConfiguration["app"];
}) {
  const [connecting, setConnecting] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedPacks, setSelectedPacks] = useState<string[]>([]);
  if (
    !app.authMethods.includes("oauth_environment") ||
    (app.connectionModel !== "environment" && app.connectionModel !== "hybrid")
  ) {
    return null;
  }

  async function connect() {
    setConnecting(true);
    try {
      const response = await fetch(
        `/api/environments/${environmentId}/apps/${encodeURIComponent(app.key)}/oauth/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(app.connectionCapabilityPacks.length
              ? { capabilityPacks: selectedPacks }
              : {}),
          }),
        },
      );
      const body = await readJson<{
        authorizationUrl?: string;
        error?: string;
      }>(response);
      if (!(response.ok && body.authorizationUrl)) {
        throw new Error(
          body.error ?? `${app.displayName} could not be connected.`,
        );
      }
      window.location.assign(body.authorizationUrl);
    } catch (error) {
      toast.error(message(error, `${app.displayName} could not be connected.`));
      setConnecting(false);
    }
  }

  if (app.connectionCapabilityPacks.length) {
    return (
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="size-4" /> Connect {app.displayName}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose {app.displayName} capabilities</DialogTitle>
            <DialogDescription>
              Kestrel requests only the permissions needed for the capabilities
              you select. You can add more later by reconnecting this App.
            </DialogDescription>
          </DialogHeader>
          <div className="divide-y border-y">
            {app.connectionCapabilityPacks.map((pack) => (
              <div
                className="flex items-center justify-between gap-4 py-4"
                key={pack.key}
              >
                <div>
                  <Label htmlFor={`${app.key}-${pack.key}`}>{pack.name}</Label>
                  <p className="mt-1 text-muted-foreground text-sm">
                    {pack.description}
                  </p>
                </div>
                <Switch
                  checked={selectedPacks.includes(pack.key)}
                  id={`${app.key}-${pack.key}`}
                  onCheckedChange={(checked) =>
                    setSelectedPacks((current) =>
                      checked
                        ? [...new Set([...current, pack.key])]
                        : current.filter((key) => key !== pack.key),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={connecting || selectedPacks.length === 0}
              onClick={() => void connect()}
            >
              {connecting ? "Opening…" : `Continue to ${app.displayName}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Button disabled={connecting} onClick={() => void connect()} size="sm">
      <Plus className="size-4" />
      {connecting ? "Opening…" : `Connect ${app.displayName}`}
    </Button>
  );
}

function CapabilityRow({
  environmentId,
  appKey,
  capability,
  onSaved,
  approvalReturnContext,
}: {
  environmentId: string;
  appKey: string;
  capability: EnvironmentAppCapability;
  onSaved: (capability: EnvironmentAppCapability) => void;
  approvalReturnContext?: RuntimeApprovalReturnContext | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [approvingRequest, setApprovingRequest] = useState(false);
  const [projectApprovalMode, setProjectApprovalMode] = useState(
    approvalReturnContext?.projectApprovalMode,
  );

  async function save(
    patch: Partial<Pick<EnvironmentAppCapability, "enabled" | "approvalMode">>,
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
        },
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

  async function saveAndApproveRequest() {
    if (
      !approvalReturnContext ||
      capability.minimumApprovalMode === "ask" ||
      approvalReturnContext.reasonCode === "runtime_strict" ||
      approvalReturnContext.reasonCode === "subject_restriction"
    )
      return;
    if (
      !(capability.enabled && capability.approvalMode === "auto") ||
      projectApprovalMode !== "auto"
    ) {
      toast.error(
        "The effective capability must be Automatic before this request can be approved.",
      );
      return;
    }
    setApprovingRequest(true);
    try {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(approvalReturnContext.threadId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            interactionResponse: {
              requestId: approvalReturnContext.requestId,
              eventType: "user.approval",
              turnId: approvalReturnContext.turnId,
              message: "Approved",
              approved: true,
            },
          }),
        },
      );
      if (!response.ok) {
        const body = await readJson<{ error?: string }>(response);
        throw new Error(
          body.error ?? "The pending request could not be approved.",
        );
      }
      toast.success("Policy saved and this request was approved once.");
    } catch (error) {
      toast.error(
        message(error, "The policy could not be saved and approved."),
      );
    } finally {
      setApprovingRequest(false);
    }
  }

  async function makeProjectAutomatic() {
    if (!approvalReturnContext?.canEditProject) return;
    setSavingProject(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(approvalReturnContext.projectId)}/apps/${encodeURIComponent(appKey)}/capabilities/${encodeURIComponent(capability.key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, approvalMode: "auto" }),
        },
      );
      const body = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(
          body.error ?? "The Project restriction could not be changed.",
        );
      }
      setProjectApprovalMode("auto");
      toast.success("Project policy set to Automatic.");
    } catch (error) {
      toast.error(
        message(error, "The Project restriction could not be changed."),
      );
    } finally {
      setSavingProject(false);
    }
  }

  return (
    <div
      className={`grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_auto] md:items-center ${approvalReturnContext ? "bg-primary/5 ring-1 ring-primary/30 ring-inset" : ""}`}
      id={`capability-${capability.key}`}
    >
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
        {capability.minimumApprovalMode === "ask" ? (
          <p className="mt-1 text-muted-foreground text-xs">
            This capability requires approval for every invocation and cannot be
            set to Automatic.
          </p>
        ) : null}
        {approvalReturnContext ? (
          <div className="mt-3 space-y-2 rounded-md border bg-background p-3 text-xs">
            <p>
              Changing this setting affects every Project in this Environment.
              Projects may still narrow it.
            </p>
            {approvalReturnContext.reasonCode === "runtime_strict" ? (
              <p>
                The current runtime requires approval for every call.
                Environment Apps cannot make this request Automatic.
              </p>
            ) : null}
            {approvalReturnContext.reasonCode === "subject_restriction" ? (
              <p>
                A user or agent restriction still requires approval. Environment
                Apps cannot make this request Automatic.
              </p>
            ) : null}
            {projectApprovalMode !== "auto" ? (
              <p>
                This Project is still set to{" "}
                {projectApprovalMode === "ask" ? "Ask first" : "Blocked"}.
                {approvalReturnContext.canEditProject
                  ? " Change the Project policy to Automatic before approving the request."
                  : " A Project editor must change that restriction before the effective result can be Automatic."}
              </p>
            ) : null}
            {projectApprovalMode !== "auto" &&
            approvalReturnContext.canEditProject &&
            capability.minimumApprovalMode !== "ask" ? (
              <Button
                disabled={savingProject}
                onClick={() => void makeProjectAutomatic()}
                size="sm"
                variant="outline"
              >
                {savingProject ? "Saving…" : "Set Project to Automatic"}
              </Button>
            ) : null}
            {capability.minimumApprovalMode !== "ask" &&
            approvalReturnContext.reasonCode !== "runtime_strict" &&
            approvalReturnContext.reasonCode !== "subject_restriction" ? (
              <Button
                disabled={
                  approvingRequest ||
                  saving ||
                  savingProject ||
                  !capability.enabled ||
                  capability.approvalMode !== "auto" ||
                  projectApprovalMode !== "auto"
                }
                onClick={() => void saveAndApproveRequest()}
                size="sm"
              >
                {approvingRequest
                  ? "Approving…"
                  : "Save and approve this request"}
              </Button>
            ) : null}
          </div>
        ) : null}
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
          <SelectItem
            disabled={capability.minimumApprovalMode === "ask"}
            value="auto"
          >
            Automatic
          </SelectItem>
          <SelectItem value="ask">Ask first</SelectItem>
          <SelectItem value="deny">Blocked</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center justify-end gap-2">
        <span className="min-w-5 text-right text-muted-foreground text-xs">
          {capability.enabled ? "On" : "Off"}
        </span>
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
    </div>
  );
}

export function EnvironmentAppSettings({
  environmentId,
  initialConfiguration,
  approvalReturnContext,
}: Props) {
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] =
    useState<AppConnectionSummary | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function updateConfiguration(
    update: (
      current: EnvironmentAppConfiguration,
    ) => EnvironmentAppConfiguration,
  ) {
    setConfiguration(update);
  }

  async function refreshConfiguration() {
    setRefreshing(true);
    try {
      const response = await fetch(
        `/api/environments/${environmentId}/apps/${encodeURIComponent(configuration.app.key)}`,
      );
      const body = await readJson<{
        configuration?: EnvironmentAppConfiguration;
        error?: string;
      }>(response);
      if (!(response.ok && body.configuration)) {
        throw new Error(body.error ?? "App status could not be refreshed.");
      }
      setConfiguration(body.configuration);
    } catch (error) {
      toast.error(message(error, "App status could not be refreshed."));
    } finally {
      setRefreshing(false);
    }
  }

  async function reviewCapabilities(
    connectionId: string,
    snapshotId: string,
    decision: "approve" | "reject",
  ) {
    setReviewing(snapshotId);
    try {
      const response = await fetch(
        `/api/admin/environments/${environmentId}/mcp/servers/${connectionId}/snapshots/${snapshotId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      const body = await readJson<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(body.error ?? "Capabilities could not be reviewed.");
      }
      await refreshConfiguration();
      toast.success(
        decision === "approve"
          ? "Capabilities approved. Choose which ones Projects may use."
          : "Capabilities rejected. This connection remains unavailable to Projects.",
      );
    } catch (error) {
      toast.error(message(error, "Capabilities could not be reviewed."));
    } finally {
      setReviewing(null);
    }
  }

  async function disconnect(appKey: string, connectionId: string) {
    setDisconnecting(connectionId);
    try {
      const response = await fetch(
        `/api/environments/${environmentId}/apps/${encodeURIComponent(appKey)}/connections/${connectionId}`,
        { method: "DELETE" },
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
          connection.id === body.connection!.id ? body.connection! : connection,
        ),
      }));
      setPendingDisconnect(null);
      toast.success(
        "Connection disconnected. Encrypted configuration was retained for recovery.",
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
        action={
          <div className="flex gap-2">
            {configuration.app.connectionModel === "organization" &&
            configuration.app.configurationPath ? (
              <Button asChild size="sm">
                <Link href={configuration.app.configurationPath}>
                  Configure {configuration.app.displayName}
                </Link>
              </Button>
            ) : null}
            <ConnectionDialog
              app={configuration.app}
              environmentId={environmentId}
              onSaved={(connection) =>
                updateConfiguration((current) => ({
                  ...current,
                  connections: [
                    ...current.connections.filter(
                      (item) => item.id !== connection.id,
                    ),
                    connection,
                  ].sort((left, right) => left.name.localeCompare(right.name)),
                }))
              }
            />
            <OauthConnectionButton
              app={configuration.app}
              environmentId={environmentId}
            />
          </div>
        }
        appKey={configuration.app.key}
        backHref={`/organization/environments/${environmentId}/apps`}
        backLabel="Environment Apps"
        description={configuration.app.description}
        icon={configuration.app.icon}
        headingLevel={2}
        name={configuration.app.displayName}
        status={
          configuration.app.readiness === "ready"
            ? "Ready"
            : configuration.app.readiness.replaceAll("_", " ")
        }
      />

      <SettingsStatusNotice
        description={
          configuration.app.readiness === "ready"
            ? "Connections and access are ready for Projects in this Environment."
            : configuration.capabilityReviews.length > 0
              ? "Review the discovered capabilities before this App can be enabled."
              : configuration.app.readiness === "setup_required"
                ? "Add or repair a connection to continue setup."
                : "Complete the next setup item below."
        }
        title={
          configuration.app.readiness === "ready"
            ? "Ready for Projects"
            : configuration.app.readiness.replaceAll("_", " ")
        }
        tone={configuration.app.readiness === "ready" ? "success" : "warning"}
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
                  (connection) => connection.status === "connected",
                )
                  ? "Fallback · ready"
                  : "Fallback · optional"}
              </Badge>
            </div>
          </div>
        </section>
      ) : null}

      {configuration.capabilityReviews.map((review) => (
        <section className="border-y py-4" key={review.snapshotId}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-medium text-sm">Review App capabilities</h3>
              <p className="mt-1 text-muted-foreground text-xs">
                {review.connectionName} found {review.capabilities.length}{" "}
                capabilities. Approving adds them to this App; they remain
                blocked until you enable them below.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={reviewing === review.snapshotId}
                onClick={() =>
                  void reviewCapabilities(
                    review.connectionId,
                    review.snapshotId,
                    "reject",
                  )
                }
                size="sm"
                variant="outline"
              >
                Reject
              </Button>
              <Button
                disabled={reviewing === review.snapshotId}
                onClick={() =>
                  void reviewCapabilities(
                    review.connectionId,
                    review.snapshotId,
                    "approve",
                  )
                }
                size="sm"
              >
                Approve
              </Button>
            </div>
          </div>
          <div className="mt-4 divide-y border-y">
            {review.capabilities.map((capability) => (
              <div className="py-3" key={capability.key}>
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm">
                    {capability.displayName}
                  </p>
                  <Badge variant="outline">{capability.group}</Badge>
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  {capability.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}

      {configuration.app.delivery === "mcp" &&
      configuration.connections.some(
        (connection) => connection.status === "connected",
      ) &&
      configuration.capabilityReviews.length === 0 &&
      configuration.capabilities.length === 0 ? (
        <section className="flex flex-wrap items-center justify-between gap-4 border-y py-4">
          <div>
            <h3 className="font-medium text-sm">Checking capabilities</h3>
            <p className="mt-1 text-muted-foreground text-xs">
              Kestrel is asking {configuration.app.displayName} which actions
              are available to review.
            </p>
          </div>
          <Button
            disabled={refreshing}
            onClick={() => void refreshConfiguration()}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              className={refreshing ? "size-4 animate-spin" : "size-4"}
            />
            Refresh status
          </Button>
        </section>
      ) : null}

      <SettingsSection
        description="The credential or account path this Environment makes available to Projects."
        title={
          configuration.app.connectionModel === "personal"
            ? "Personal connections"
            : configuration.app.connectionModel === "hybrid"
              ? "Shared and personal connections"
              : "Connection"
        }
      >
        <div className="divide-y border-y">
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
                  <p className="truncate font-medium text-sm">
                    {connection.name}
                  </p>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {connection.ownerType === "organization"
                      ? "Configured for Projects in this Organization"
                      : "Shared with Projects in this Environment"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      connection.status === "connected" ? "default" : "outline"
                    }
                  >
                    {connection.status}
                  </Badge>
                  {connection.ownerType === "environment" &&
                  connection.status !== "disconnected" ? (
                    <Button
                      aria-label={`Disconnect ${connection.name}`}
                      disabled={disconnecting === connection.id}
                      onClick={() => setPendingDisconnect(connection)}
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
              {configuration.app.connectionModel === "organization" &&
              configuration.app.configurationPath
                ? "This App is configured once in Organization settings and shared with Projects."
                : configuration.app.connectionRequirement === "optional"
                  ? "No shared connection is required. Add one to enable the optional provider path."
                  : configuration.app.connectionModel === "hybrid"
                    ? "Add a shared connection, or let members attach personal connections inside Projects."
                    : "Add a connection to make this App available to Projects."}
            </p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        description="Projects can narrow these settings, but can never broaden them."
        title="Access"
      >
        <SettingsDisclosure
          defaultOpen={approvalReturnContext !== undefined}
          description={`${configuration.capabilities.length} capabilit${configuration.capabilities.length === 1 ? "y" : "ies"} available.`}
          title="Capability ceiling"
        >
          <div className="divide-y border-y">
            {configuration.capabilities.length === 0 ? (
              <p className="py-3 text-muted-foreground text-sm">
                No capabilities are available yet.
              </p>
            ) : null}
            {configuration.capabilities.map((capability) => (
              <CapabilityRow
                appKey={configuration.app.key}
                capability={capability}
                environmentId={environmentId}
                key={capability.key}
                approvalReturnContext={
                  approvalReturnContext?.capability === capability.key
                    ? approvalReturnContext
                    : undefined
                }
                onSaved={(saved) =>
                  updateConfiguration((current) => ({
                    ...current,
                    capabilities: current.capabilities.map((item) =>
                      item.key === saved.key ? saved : item,
                    ),
                  }))
                }
              />
            ))}
          </div>
        </SettingsDisclosure>
      </SettingsSection>

      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || disconnecting)) setPendingDisconnect(null);
        }}
        open={Boolean(pendingDisconnect)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDisconnect?.name || "This connection"} will stop being
              available to Projects. Encrypted configuration is retained for
              recovery.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(disconnecting)}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={Boolean(disconnecting)}
              onClick={() =>
                pendingDisconnect
                  ? void disconnect(configuration.app.key, pendingDisconnect.id)
                  : undefined
              }
              variant="destructive"
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
