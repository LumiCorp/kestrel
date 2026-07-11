"use client";

import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { readJson } from "@/components/admin/admin-client-utils";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { AppPage } from "@/components/app-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TimeText } from "@/components/ui/time-text";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  ResolvedToolProvider,
  ToolCapabilityPolicy,
  ToolProviderType,
  ToolScanStatus,
  ToolsOverview,
} from "@/lib/tools/types";
import {
  patchAdminToolCapabilityAction,
  patchAdminToolProviderAction,
  saveAdminDiscordBindingAction,
  testAdminToolProviderAction,
} from "./actions";

type ToolProvider = ResolvedToolProvider;
type ToolView = "capabilities" | "providers";
type ToolTypeFilter = "all" | ToolProviderType;
type ToolStatusFilter = "all" | ToolScanStatus;
type EnabledFilter = "all" | "enabled" | "disabled";

type ProviderDraft = {
  enabled: boolean;
  capabilityDrafts: Record<string, ToolCapabilityPolicy>;
};

type BannerState = {
  title: string;
  variant: "info" | "success" | "warning" | "error";
} | null;

const VIEW_STORAGE_KEY = "admin-tools-view";

const TYPE_LABELS: Record<ToolProviderType, string> = {
  built_in: "Built-in",
  oauth: "OAuth",
  api_key: "API Key",
  inbound_adapter: "Inbound",
  source_connector: "Source",
  custom_imported: "Imported",
};

const STATUS_LABELS: Record<ToolScanStatus, string> = {
  available: "Available",
  setup_required: "Setup Required",
  unavailable: "Unavailable",
};

function createDraft(provider: ToolProvider): ProviderDraft {
  return {
    enabled: provider.enabled,
    capabilityDrafts: Object.fromEntries(
      provider.capabilities.map((capability) => [
        capability.key,
        capability.policy,
      ])
    ),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback = false
) {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function getStatusBadgeClasses(status: ToolScanStatus) {
  if (status === "available") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "setup_required") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-border bg-muted/40 text-muted-foreground";
}

function summarizeVisibleRows<
  T extends { enabled: boolean; status: ToolScanStatus },
>(rows: T[]) {
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.enabled).length,
    available: rows.filter((row) => row.status === "available").length,
    setupRequired: rows.filter((row) => row.status === "setup_required").length,
  };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-md border border-border/70 p-5">
      <div className="space-y-1">
        <h3 className="font-medium text-sm">{title}</h3>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: ToolScanStatus }) {
  return (
    <Badge className={getStatusBadgeClasses(status)} variant="outline">
      {STATUS_LABELS[status]}
    </Badge>
  );
}

function TypeBadge({ type }: { type: ToolProviderType }) {
  return <Badge variant="outline">{TYPE_LABELS[type]}</Badge>;
}

export function ToolsAdminClient({
  initialOverview,
}: {
  initialOverview: ToolsOverview;
}) {
  const [overview, setOverview] = useState<ToolsOverview | null>(
    initialOverview
  );
  const [banner, setBanner] = useState<BannerState>(null);
  const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<ToolView>("capabilities");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<ToolTypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<ToolStatusFilter>("all");
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [setupOnly, setSetupOnly] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeProviderKey, setActiveProviderKey] = useState<string | null>(
    null
  );
  const [focusCapabilityKey, setFocusCapabilityKey] = useState<string | null>(
    null
  );
  const [selectedProvider, setSelectedProvider] = useState<ToolProvider | null>(
    null
  );
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const capabilityRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const latestDetailRequestRef = useRef(0);

  async function loadOverview() {
    const response = await fetch("/api/admin/tools", { cache: "no-store" });
    const json = await readJson<ToolsOverview & { error?: string }>(response);

    if (!response.ok) {
      setBanner({
        title: json.error || "Failed to load tools",
        variant: "error",
      });
      return;
    }

    setOverview(json);
  }

  async function loadProvider(
    providerKey: string,
    capabilityKey?: string | null
  ) {
    const requestId = latestDetailRequestRef.current + 1;
    latestDetailRequestRef.current = requestId;
    setModalOpen(true);
    setActiveProviderKey(providerKey);
    setFocusCapabilityKey(capabilityKey ?? null);
    if (selectedProvider?.key !== providerKey) {
      setSelectedProvider(null);
      setDraft(null);
    }
    setDetailLoading(true);

    const response = await fetch(
      `/api/admin/tools/${encodeURIComponent(providerKey)}`,
      {
        cache: "no-store",
      }
    );
    const json = await readJson<ToolProvider & { error?: string }>(response);

    if (latestDetailRequestRef.current !== requestId) {
      return;
    }

    setDetailLoading(false);

    if (!response.ok) {
      setBanner({
        title: json.error || "Failed to load tool provider",
        variant: "error",
      });
      return;
    }

    setSelectedProvider(json);
    setDraft(createDraft(json));
  }

  useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "capabilities" || stored === "providers") {
      setView(stored);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  useEffect(() => {
    setOverview(initialOverview);
  }, [initialOverview]);

  useEffect(() => {
    if (!(selectedProvider && focusCapabilityKey && !detailLoading)) {
      return;
    }

    capabilityRefs.current[focusCapabilityKey]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [detailLoading, focusCapabilityKey, selectedProvider]);

  const providerRows = overview?.providerRows ?? [];
  const capabilityRows = overview?.capabilityRows ?? [];

  const providerRowMap = useMemo(
    () => new Map(providerRows.map((row) => [row.key, row])),
    [providerRows]
  );

  const activeProviderRow = activeProviderKey
    ? (providerRowMap.get(activeProviderKey) ?? null)
    : null;

  const filteredProviderRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return providerRows.filter((row) => {
      if (
        normalizedSearch &&
        ![
          row.displayName,
          row.description,
          TYPE_LABELS[row.type],
          STATUS_LABELS[row.status],
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch)
      ) {
        return false;
      }

      if (typeFilter !== "all" && row.type !== typeFilter) {
        return false;
      }

      if (enabledFilter === "enabled" && !row.enabled) {
        return false;
      }

      if (enabledFilter === "disabled" && row.enabled) {
        return false;
      }

      if (setupOnly && row.status !== "setup_required") {
        return false;
      }

      if (statusFilter !== "all" && row.status !== statusFilter) {
        return false;
      }

      return true;
    });
  }, [
    enabledFilter,
    providerRows,
    search,
    setupOnly,
    statusFilter,
    typeFilter,
  ]);

  const filteredCapabilityRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return capabilityRows.filter((row) => {
      if (
        normalizedSearch &&
        ![
          row.displayName,
          row.description,
          row.providerDisplayName,
          TYPE_LABELS[row.providerType],
          STATUS_LABELS[row.status],
          row.accessMode,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch)
      ) {
        return false;
      }

      if (typeFilter !== "all" && row.providerType !== typeFilter) {
        return false;
      }

      if (enabledFilter === "enabled" && !row.enabled) {
        return false;
      }

      if (enabledFilter === "disabled" && row.enabled) {
        return false;
      }

      if (setupOnly && row.status !== "setup_required") {
        return false;
      }

      if (statusFilter !== "all" && row.status !== statusFilter) {
        return false;
      }

      return true;
    });
  }, [
    capabilityRows,
    enabledFilter,
    search,
    setupOnly,
    statusFilter,
    typeFilter,
  ]);

  const activeRowCount =
    view === "capabilities"
      ? filteredCapabilityRows.length
      : filteredProviderRows.length;
  const visibleSummary =
    view === "capabilities"
      ? summarizeVisibleRows(filteredCapabilityRows)
      : summarizeVisibleRows(filteredProviderRows);

  const typeOptions =
    overview?.filters.providerTypes.length &&
    overview.filters.providerTypes.length > 0
      ? overview.filters.providerTypes
      : ([
          "built_in",
          "oauth",
          "api_key",
          "inbound_adapter",
          "source_connector",
        ] as ToolProviderType[]);

  async function refreshSelectedProvider() {
    if (!activeProviderKey) {
      return;
    }

    await loadProvider(activeProviderKey, focusCapabilityKey);
  }

  async function patchProvider(payload: { enabled: boolean }) {
    if (!selectedProvider) {
      return;
    }

    setBusy(true);
    const result = await patchAdminToolProviderAction({
      enabled: payload.enabled,
      providerKey: selectedProvider.key,
    });
    setBusy(false);

    if (!result.ok) {
      const message = result.error || "Failed to update tool provider";
      setBanner({ title: message, variant: "error" });
      toast.error(message);
      return;
    }

    await loadOverview();
    await refreshSelectedProvider();
    setBanner({
      title: result.message || "Tool provider saved.",
      variant: "success",
    });
    toast.success(result.message || "Tool provider saved.");
  }

  async function patchCapability(capabilityKey: string) {
    if (!(selectedProvider && draft)) {
      return;
    }

    const capabilityDraft = draft.capabilityDrafts[capabilityKey];
    if (!capabilityDraft) {
      return;
    }

    setBusy(true);
    const result = await patchAdminToolCapabilityAction({
      capabilityKey,
      policy: capabilityDraft,
      providerKey: selectedProvider.key,
    });
    setBusy(false);

    if (!result.ok) {
      const message = result.error || "Failed to update capability";
      setBanner({ title: message, variant: "error" });
      toast.error(message);
      return;
    }

    await loadOverview();
    await refreshSelectedProvider();
    setBanner({
      title: result.message || "Tool capability saved.",
      variant: "success",
    });
    toast.success(result.message || "Tool capability saved.");
  }

  async function testProvider() {
    if (!selectedProvider) {
      return;
    }

    setBusy(true);
    const result = await testAdminToolProviderAction({
      providerKey: selectedProvider.key,
    });
    setBusy(false);

    if (!result.ok) {
      const message = result.error || "Failed to test tool provider";
      setBanner({ title: message, variant: "error" });
      toast.error(message);
      return;
    }

    const testedAtLabel = result.data?.testedAt
      ? formatDistanceToNow(new Date(result.data.testedAt), {
          addSuffix: true,
        })
      : "just now";

    setBanner({
      title: `Provider tested ${testedAtLabel}`,
      variant: "success",
    });
    toast.success(result.message || "Tool provider tested.");
    await loadOverview();
    await refreshSelectedProvider();
  }

  async function saveDiscordBinding() {
    if (!selectedProvider || selectedProvider.key !== "discord") {
      return;
    }

    const currentBinding = toRecord(
      selectedProvider.connection.metadata.binding
    );
    const guildId = readString(currentBinding, "guildId");
    const guildName = readString(currentBinding, "guildName");
    const enabled = readBoolean(currentBinding, "enabled", true);

    setBusy(true);
    const result = await saveAdminDiscordBindingAction({
      enabled,
      guildId,
      guildName: guildName || null,
    });
    setBusy(false);

    if (!result.ok) {
      const message = result.error || "Failed to save Discord binding";
      setBanner({ title: message, variant: "error" });
      toast.error(message);
      return;
    }

    setBanner({
      title: result.message || "Discord binding saved.",
      variant: "success",
    });
    toast.success(result.message || "Discord binding saved.");
    await loadOverview();
    await refreshSelectedProvider();
  }

  async function activateGateway() {
    setBusy(true);
    const response = await fetch("/api/discord/gateway", { cache: "no-store" });
    const json = await readJson<{ error?: string; status?: string }>(response);
    setBusy(false);

    if (!response.ok) {
      const message = json.error || "Failed to activate Discord gateway";
      setBanner({ title: message, variant: "error" });
      toast.error(message);
      return;
    }

    const title =
      json.status === "already_active"
        ? "Discord gateway already active."
        : "Discord gateway activated.";
    setBanner({ title, variant: "success" });
    toast.success(title);
    await loadOverview();
    await refreshSelectedProvider();
  }

  function updateCapabilityDraft(
    capabilityKey: string,
    updater: (current: ToolCapabilityPolicy) => ToolCapabilityPolicy
  ) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        capabilityDrafts: {
          ...current.capabilityDrafts,
          [capabilityKey]: updater(
            current.capabilityDrafts[capabilityKey] ?? {
              enabled: true,
              approvalMode: "auto",
              surfaceAccess: { chat: true, admin: false },
              rateLimitMode: "default",
              loggingMode: "full",
              settings: {},
            }
          ),
        },
      };
    });
  }

  const discordBinding = toRecord(
    selectedProvider?.connection.metadata.binding
  );
  const discordGateway = toRecord(
    selectedProvider?.connection.metadata.gateway
  );
  const selectedProviderMetadata = toRecord(
    selectedProvider?.connection.metadata
  );
  const manageUrl = readString(selectedProviderMetadata, "manageUrl");

  return (
    <AppPage>
      <AdminPageHeader
        actions={
          <Button asChild variant="outline">
            <a href="/admin/docs">Open Docs</a>
          </Button>
        }
        description="Scan runtime tooling across built-ins, integrations, and source connectors. Open any row to inspect status and edit policy."
        eyebrow="Runtime"
        title="Tools"
      />

      {banner ? (
        <div data-testid="tools-status-banner">
          <AdminStatusBanner title={banner.title} variant={banner.variant} />
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <AdminStatCard
          detail={
            overview
              ? `of ${
                  view === "capabilities"
                    ? overview.summary.capabilities.total
                    : overview.summary.providers.total
                } total`
              : "Loading"
          }
          title={
            view === "capabilities" ? "Visible Tools" : "Visible Providers"
          }
          value={visibleSummary.total}
        />
        <AdminStatCard title="Enabled" value={visibleSummary.enabled} />
        <AdminStatCard title="Available Now" value={visibleSummary.available} />
        <AdminStatCard
          title="Setup Required"
          value={visibleSummary.setupRequired}
        />
      </div>

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ToggleGroup
              onValueChange={(value) => {
                if (value === "capabilities" || value === "providers") {
                  setView(value);
                }
              }}
              type="single"
              value={view}
              variant="outline"
            >
              <ToggleGroupItem value="capabilities">
                Capabilities
              </ToggleGroupItem>
              <ToggleGroupItem value="providers">Providers</ToggleGroupItem>
            </ToggleGroup>
            <div className="text-muted-foreground text-sm">
              {activeRowCount} row{activeRowCount === 1 ? "" : "s"} match the
              current filters
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,0.8fr))]">
            <Input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tools, providers, descriptions, and statuses"
              value={search}
            />
            <Select
              onValueChange={(value) => setTypeFilter(value as ToolTypeFilter)}
              value={typeFilter}
            >
              <SelectTrigger>
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {typeOptions.map((type) => (
                  <SelectItem key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) =>
                setStatusFilter(value as ToolStatusFilter)
              }
              value={statusFilter}
            >
              <SelectTrigger>
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="available">Available</SelectItem>
                <SelectItem value="setup_required">Setup Required</SelectItem>
                <SelectItem value="unavailable">Unavailable</SelectItem>
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) =>
                setEnabledFilter(value as EnabledFilter)
              }
              value={enabledFilter}
            >
              <SelectTrigger>
                <SelectValue placeholder="All states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Enabled + Disabled</SelectItem>
                <SelectItem value="enabled">Enabled</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => setSetupOnly((current) => !current)}
              variant={setupOnly ? "default" : "outline"}
            >
              Setup Required Only
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="overflow-hidden border border-border/70 bg-card">
        {overview ? (
          activeRowCount === 0 ? (
            <div className="p-6">
              <AdminEmptyState
                description="Adjust the scan filters or add more tool providers to broaden the catalog."
                title={
                  view === "capabilities"
                    ? "No tool capabilities match the current filters."
                    : "No tool providers match the current filters."
                }
              />
            </div>
          ) : view === "capabilities" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Tool</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead className="pr-4">Approval</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCapabilityRows.map((row) => (
                  <TableRow
                    className="cursor-pointer"
                    data-testid={`tools-capability-row-${row.providerKey}-${row.capabilityKey}`}
                    key={`${row.providerKey}:${row.capabilityKey}`}
                    onClick={() =>
                      void loadProvider(row.providerKey, row.capabilityKey)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void loadProvider(row.providerKey, row.capabilityKey);
                      }
                    }}
                    tabIndex={0}
                  >
                    <TableCell className="px-4">
                      <div className="space-y-1">
                        <div className="font-medium">{row.displayName}</div>
                        <div className="line-clamp-1 text-muted-foreground text-xs">
                          {row.description}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{row.providerDisplayName}</TableCell>
                    <TableCell>
                      <TypeBadge type={row.providerType} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.enabled ? "secondary" : "outline"}>
                        {row.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="text-sm">{row.connectionLabel}</div>
                        <div className="text-muted-foreground text-xs">
                          {row.connectionStatus}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.accessMode}</Badge>
                    </TableCell>
                    <TableCell className="pr-4">
                      <Badge variant="outline">{row.approvalMode}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Provider</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Runtime</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead className="pr-4">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProviderRows.map((row) => (
                  <TableRow
                    className="cursor-pointer"
                    data-testid={`tools-provider-row-${row.key.replace(/[^a-z0-9]+/gi, "-")}`}
                    key={row.key}
                    onClick={() => void loadProvider(row.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void loadProvider(row.key);
                      }
                    }}
                    tabIndex={0}
                  >
                    <TableCell className="px-4">
                      <div className="space-y-1">
                        <div className="font-medium">{row.displayName}</div>
                        <div className="line-clamp-1 text-muted-foreground text-xs">
                          {row.description}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <TypeBadge type={row.type} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.enabled ? "secondary" : "outline"}>
                        {row.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="text-sm">{row.connectionLabel}</div>
                        <div className="text-muted-foreground text-xs">
                          {row.connectionStatus}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.isReady ? "secondary" : "outline"}>
                        {row.isReady ? "Ready" : "Blocked"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {row.availableCapabilityCount}/{row.capabilityCount}{" "}
                        ready
                      </div>
                    </TableCell>
                    <TableCell className="pr-4">
                      <Badge
                        variant={row.actionRequired ? "destructive" : "outline"}
                      >
                        {row.actionRequired ? "Setup needed" : "OK"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : (
          <div className="px-6 py-12 text-center text-muted-foreground text-sm">
            Loading tools...
          </div>
        )}
      </div>

      <Dialog
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) {
            setActiveProviderKey(null);
            setFocusCapabilityKey(null);
          }
        }}
        open={modalOpen}
      >
        <DialogContent className="max-w-[min(1100px,calc(100%-2rem))] overflow-hidden p-0 sm:max-w-[1100px]">
          <DialogHeader className="border-b px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-3 pr-10">
              <div className="space-y-2">
                <DialogTitle>
                  {selectedProvider?.displayName ??
                    activeProviderRow?.displayName ??
                    "Tool provider"}
                </DialogTitle>
                <DialogDescription>
                  {selectedProvider?.description ??
                    activeProviderRow?.description ??
                    "Inspect runtime readiness and edit tool policy."}
                </DialogDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeProviderRow ? (
                  <>
                    <TypeBadge type={activeProviderRow.type} />
                    <StatusBadge status={activeProviderRow.status} />
                  </>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          <ScrollArea className="max-h-[78vh]">
            <div className="space-y-6 p-6">
              {detailLoading && !selectedProvider ? (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
                  Loading provider details...
                </div>
              ) : null}

              {selectedProvider && draft ? (
                <>
                  {selectedProvider.connection.lastError ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 text-sm">
                      {selectedProvider.connection.lastError}
                    </div>
                  ) : null}

                  <Section
                    description="Control provider availability and run readiness checks without leaving the modal."
                    title="Overview"
                  >
                    <div className="flex flex-wrap gap-2">
                      <TypeBadge type={selectedProvider.type} />
                      <Badge variant="outline">
                        {selectedProvider.connection.label}
                      </Badge>
                      <Badge variant="outline">
                        {selectedProvider.connection.status}
                      </Badge>
                      <Badge
                        variant={
                          selectedProvider.connection.isReady
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {selectedProvider.connection.isReady
                          ? "Ready"
                          : "Not ready"}
                      </Badge>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                      <div className="space-y-2">
                        <p className="text-sm">
                          {selectedProvider.description}
                        </p>
                        <div className="text-muted-foreground text-sm">
                          {selectedProvider.counts.available} of{" "}
                          {selectedProvider.counts.total} capabilities are
                          available now.
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          data-testid="tools-save-provider"
                          disabled={busy}
                          onClick={() =>
                            void patchProvider({ enabled: draft.enabled })
                          }
                        >
                          Save Provider
                        </Button>
                        <Button
                          data-testid="tools-test-provider"
                          disabled={busy}
                          onClick={() => void testProvider()}
                          variant="outline"
                        >
                          Test Connection
                        </Button>
                        {manageUrl ? (
                          <Button asChild variant="outline">
                            <a href={manageUrl}>Open Setup</a>
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center justify-between rounded-md border border-border/70 px-4 py-3">
                      <div className="space-y-1">
                        <div className="font-medium text-sm">
                          Provider enabled
                        </div>
                        <div className="text-muted-foreground text-sm">
                          Disabled providers stay visible in the catalog but are
                          not exposed to runtime or setup checks.
                        </div>
                      </div>
                      <Switch
                        checked={draft.enabled}
                        data-testid="tools-provider-enabled"
                        onCheckedChange={(checked) =>
                          setDraft((current) =>
                            current ? { ...current, enabled: checked } : current
                          )
                        }
                      />
                    </div>
                  </Section>

                  <Section
                    description="Inspect provider-specific runtime metadata and launch existing setup flows where needed."
                    title="Connection and Setup"
                  >
                    {selectedProvider.key === "github" ? (
                      <div className="grid gap-2 text-sm">
                        <div>
                          Webhook URL:{" "}
                          {String(
                            selectedProvider.connection.metadata.webhookUrl ??
                              "Unavailable"
                          )}
                        </div>
                        <div>
                          Source count:{" "}
                          {String(
                            selectedProvider.connection.metadata.sourceCount ??
                              0
                          )}
                        </div>
                        <div>
                          Snapshot:{" "}
                          {selectedProvider.connection.metadata.activeSnapshotId
                            ? String(
                                selectedProvider.connection.metadata
                                  .activeSnapshotId
                              )
                            : "No active snapshot"}
                        </div>
                        <div>
                          Bot user:{" "}
                          {String(
                            selectedProvider.connection.metadata.botUserName ??
                              "Not configured"
                          )}
                        </div>
                      </div>
                    ) : null}

                    {selectedProvider.key === "discord" ? (
                      <div className="space-y-4">
                        <div className="grid gap-2 text-sm">
                          <div>
                            Install URL:{" "}
                            {String(
                              selectedProvider.connection.metadata.installUrl ??
                                "Unavailable"
                            )}
                          </div>
                          <div>
                            Interactions Endpoint:{" "}
                            {String(
                              selectedProvider.connection.metadata.webhookUrl ??
                                "Unavailable"
                            )}
                          </div>
                          <div>
                            Gateway started{" "}
                            <TimeText
                              mode="datetime"
                              value={
                                typeof discordGateway.startedAt === "string"
                                  ? discordGateway.startedAt
                                  : null
                              }
                            />
                          </div>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="discord-guild-id">Guild ID</Label>
                            <Input
                              data-testid="discord-guild-id"
                              id="discord-guild-id"
                              onChange={(event) =>
                                setSelectedProvider((current) =>
                                  current
                                    ? {
                                        ...current,
                                        connection: {
                                          ...current.connection,
                                          metadata: {
                                            ...current.connection.metadata,
                                            binding: {
                                              ...toRecord(
                                                current.connection.metadata
                                                  .binding
                                              ),
                                              guildId: event.target.value,
                                            },
                                          },
                                        },
                                      }
                                    : current
                                )
                              }
                              value={readString(discordBinding, "guildId")}
                            />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="discord-guild-name">
                              Guild Name
                            </Label>
                            <Input
                              data-testid="discord-guild-name"
                              id="discord-guild-name"
                              onChange={(event) =>
                                setSelectedProvider((current) =>
                                  current
                                    ? {
                                        ...current,
                                        connection: {
                                          ...current.connection,
                                          metadata: {
                                            ...current.connection.metadata,
                                            binding: {
                                              ...toRecord(
                                                current.connection.metadata
                                                  .binding
                                              ),
                                              guildName: event.target.value,
                                            },
                                          },
                                        },
                                      }
                                    : current
                                )
                              }
                              value={readString(discordBinding, "guildName")}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between rounded-md border border-border/70 px-4 py-3">
                          <div className="space-y-1">
                            <div className="font-medium text-sm">
                              Binding Enabled
                            </div>
                            <div className="text-muted-foreground text-sm">
                              Only enabled guild bindings are eligible for
                              routing.
                            </div>
                          </div>
                          <Switch
                            checked={readBoolean(
                              discordBinding,
                              "enabled",
                              true
                            )}
                            data-testid="discord-enabled"
                            onCheckedChange={(checked) =>
                              setSelectedProvider((current) =>
                                current
                                  ? {
                                      ...current,
                                      connection: {
                                        ...current.connection,
                                        metadata: {
                                          ...current.connection.metadata,
                                          binding: {
                                            ...toRecord(
                                              current.connection.metadata
                                                .binding
                                            ),
                                            enabled: checked,
                                          },
                                        },
                                      },
                                    }
                                  : current
                              )
                            }
                          />
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            data-testid="discord-save-binding"
                            disabled={
                              busy ||
                              !readString(discordBinding, "guildId").trim()
                            }
                            onClick={() => void saveDiscordBinding()}
                          >
                            Save Binding
                          </Button>
                          <Button
                            data-testid="discord-activate-gateway"
                            disabled={
                              busy ||
                              !readBoolean(
                                selectedProvider.connection.metadata,
                                "credentialsConfigured"
                              )
                            }
                            onClick={() => void activateGateway()}
                            variant="outline"
                          >
                            Activate Gateway
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {selectedProvider.key === "built_in.knowledge_search" ? (
                      <div className="grid gap-2 text-sm">
                        <div>
                          Ready documents:{" "}
                          {String(
                            selectedProvider.connection.metadata
                              .readyDocumentCount ?? 0
                          )}
                        </div>
                        <div>
                          Processing documents:{" "}
                          {String(
                            selectedProvider.connection.metadata
                              .processingDocumentCount ?? 0
                          )}
                        </div>
                        <div>
                          OCR mode:{" "}
                          {String(
                            selectedProvider.connection.metadata.ocrMode ??
                              "n/a"
                          )}
                        </div>
                      </div>
                    ) : null}

                    {selectedProvider.key === "built_in.sandbox" ? (
                      <div className="grid gap-2 text-sm">
                        <div>
                          Source count:{" "}
                          {String(
                            selectedProvider.connection.metadata.sourceCount ??
                              0
                          )}
                        </div>
                        <div>
                          Active snapshot:{" "}
                          {String(
                            selectedProvider.connection.metadata
                              .activeSnapshotId ?? "No active snapshot"
                          )}
                        </div>
                      </div>
                    ) : null}

                    {selectedProvider.key === "source.github" ||
                    selectedProvider.key === "source.youtube" ? (
                      <div className="grid gap-2 text-sm">
                        <div>
                          Source count:{" "}
                          {String(
                            selectedProvider.connection.metadata.sourceCount ??
                              0
                          )}
                        </div>
                        <div>
                          Active snapshot:{" "}
                          {String(
                            selectedProvider.connection.metadata
                              .activeSnapshotId ?? "No active snapshot"
                          )}
                        </div>
                        {selectedProvider.key === "source.youtube" ? (
                          <div>
                            API key configured:{" "}
                            {readBoolean(
                              selectedProvider.connection.metadata,
                              "apiKeyConfigured"
                            )
                              ? "Yes"
                              : "No"}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {[
                      "github",
                      "discord",
                      "built_in.knowledge_search",
                      "built_in.sandbox",
                      "source.github",
                      "source.youtube",
                    ].includes(selectedProvider.key) ? null : (
                      <div className="text-muted-foreground text-sm">
                        No provider-specific setup fields are required for this
                        provider.
                      </div>
                    )}
                  </Section>

                  <Section
                    description="Edit capability policy for runtime exposure, approval, rate limiting, and provider-specific settings."
                    title="Capabilities"
                  >
                    {selectedProvider.capabilities.length === 0 ? (
                      <div
                        className="rounded-md border border-dashed px-4 py-6 text-muted-foreground text-sm"
                        data-testid="tools-no-runtime-capabilities"
                      >
                        This provider is tracked for readiness and setup, but it
                        does not currently expose runnable runtime capabilities.
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {selectedProvider.capabilities.map((capability) => {
                          const capabilityDraft =
                            draft.capabilityDrafts[capability.key];

                          if (!capabilityDraft) {
                            return null;
                          }

                          const isFocused =
                            focusCapabilityKey === capability.key;

                          return (
                            <div
                              className={`space-y-4 rounded-md border border-border/70 p-4 ${
                                isFocused
                                  ? "border-primary ring-1 ring-primary/20"
                                  : ""
                              }`}
                              key={capability.key}
                              ref={(node) => {
                                capabilityRefs.current[capability.key] = node;
                              }}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="space-y-1">
                                  <div className="font-medium">
                                    {capability.displayName}
                                  </div>
                                  <div className="text-muted-foreground text-sm">
                                    {capability.description}
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Badge variant="outline">
                                    {capability.accessMode}
                                  </Badge>
                                  <Badge
                                    variant={
                                      capability.isAvailable
                                        ? "secondary"
                                        : "outline"
                                    }
                                  >
                                    {capability.isAvailable
                                      ? "Available"
                                      : "Unavailable"}
                                  </Badge>
                                </div>
                              </div>

                              <div className="grid gap-4 lg:grid-cols-2">
                                <div className="flex items-center justify-between rounded-md border border-border/70 px-4 py-3">
                                  <div className="space-y-1">
                                    <div className="font-medium text-sm">
                                      Enabled
                                    </div>
                                    <div className="text-muted-foreground text-sm">
                                      Expose this capability to the runtime.
                                    </div>
                                  </div>
                                  <Switch
                                    checked={capabilityDraft.enabled}
                                    data-testid={`tool-capability-enabled-${capability.key}`}
                                    onCheckedChange={(checked) =>
                                      updateCapabilityDraft(
                                        capability.key,
                                        (current) => ({
                                          ...current,
                                          enabled: checked,
                                        })
                                      )
                                    }
                                  />
                                </div>

                                <div className="space-y-2">
                                  <Label>Approval Mode</Label>
                                  <Select
                                    onValueChange={(value) =>
                                      updateCapabilityDraft(
                                        capability.key,
                                        (current) => ({
                                          ...current,
                                          approvalMode:
                                            value as ToolCapabilityPolicy["approvalMode"],
                                        })
                                      )
                                    }
                                    value={capabilityDraft.approvalMode}
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="auto">Auto</SelectItem>
                                      <SelectItem value="ask">Ask</SelectItem>
                                      <SelectItem value="deny">Deny</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label>Rate Limit Mode</Label>
                                  <Select
                                    onValueChange={(value) =>
                                      updateCapabilityDraft(
                                        capability.key,
                                        (current) => ({
                                          ...current,
                                          rateLimitMode:
                                            value as ToolCapabilityPolicy["rateLimitMode"],
                                        })
                                      )
                                    }
                                    value={capabilityDraft.rateLimitMode}
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="default">
                                        Default
                                      </SelectItem>
                                      <SelectItem value="strict">
                                        Strict
                                      </SelectItem>
                                      <SelectItem value="off">Off</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label>Logging Mode</Label>
                                  <Select
                                    onValueChange={(value) =>
                                      updateCapabilityDraft(
                                        capability.key,
                                        (current) => ({
                                          ...current,
                                          loggingMode:
                                            value as ToolCapabilityPolicy["loggingMode"],
                                        })
                                      )
                                    }
                                    value={capabilityDraft.loggingMode}
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="full">Full</SelectItem>
                                      <SelectItem value="metadata_only">
                                        Metadata Only
                                      </SelectItem>
                                      <SelectItem value="minimal">
                                        Minimal
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>

                              {selectedProvider.key === "built_in.weather" &&
                              capability.key === "getWeather" ? (
                                <div className="grid gap-4 lg:grid-cols-2">
                                  <div className="space-y-2">
                                    <Label>Units</Label>
                                    <Select
                                      onValueChange={(value) =>
                                        updateCapabilityDraft(
                                          capability.key,
                                          (current) => ({
                                            ...current,
                                            settings: {
                                              ...current.settings,
                                              units: value,
                                            },
                                          })
                                        )
                                      }
                                      value={String(
                                        capabilityDraft.settings.units ??
                                          "fahrenheit"
                                      )}
                                    >
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="fahrenheit">
                                          Fahrenheit
                                        </SelectItem>
                                        <SelectItem value="celsius">
                                          Celsius
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>

                                  <div className="space-y-2">
                                    <Label htmlFor="weather-timeout">
                                      Timeout (ms)
                                    </Label>
                                    <Input
                                      id="weather-timeout"
                                      onChange={(event) =>
                                        updateCapabilityDraft(
                                          capability.key,
                                          (current) => ({
                                            ...current,
                                            settings: {
                                              ...current.settings,
                                              timeoutMs: Number(
                                                event.target.value || 0
                                              ),
                                            },
                                          })
                                        )
                                      }
                                      type="number"
                                      value={String(
                                        capabilityDraft.settings.timeoutMs ??
                                          8000
                                      )}
                                    />
                                  </div>
                                </div>
                              ) : null}

                              {selectedProvider.key ===
                                "built_in.knowledge_search" &&
                              capability.key === "searchKnowledgeDocuments" ? (
                                <div className="space-y-2">
                                  <Label htmlFor="knowledge-default-limit">
                                    Default Limit
                                  </Label>
                                  <Input
                                    id="knowledge-default-limit"
                                    onChange={(event) =>
                                      updateCapabilityDraft(
                                        capability.key,
                                        (current) => ({
                                          ...current,
                                          settings: {
                                            ...current.settings,
                                            defaultLimit: Number(
                                              event.target.value || 0
                                            ),
                                          },
                                        })
                                      )
                                    }
                                    type="number"
                                    value={String(
                                      capabilityDraft.settings.defaultLimit ?? 5
                                    )}
                                  />
                                </div>
                              ) : null}

                              <div className="flex justify-end">
                                <Button
                                  data-testid={`tool-capability-save-${capability.key}`}
                                  disabled={busy}
                                  onClick={() =>
                                    void patchCapability(capability.key)
                                  }
                                >
                                  Save Capability
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Section>
                </>
              ) : null}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
