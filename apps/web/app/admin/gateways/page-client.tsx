"use client";

import {
  Check,
  CheckCircle2,
  ChevronRight,
  Filter,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Gateway = {
  id: string;
  provider:
    | "anthropic"
    | "lumi"
    | "openai"
    | "openrouter"
    | "ollama"
    | "replicate";
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  supportedModalities: string[];
};

type GatewayModel = {
  id: string;
  rawModelId: string;
  alias: string | null;
  modality: "language" | "image" | "speech" | "video" | "embedding";
  approved: boolean;
  isDefault: boolean;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

type GatewayBundle = {
  gateway: Gateway;
  models: GatewayModel[];
};

type GatewayLanguageProtocol = "openai" | "anthropic";

const providerLabels: Record<Gateway["provider"], string> = {
  anthropic: "Anthropic",
  lumi: "Lumi",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  replicate: "Replicate",
};

const emptyGatewayForm = {
  provider: "openai" as Gateway["provider"],
  apiKey: "",
};

type ModelDraft = {
  alias: string;
  approved: boolean;
  isDefault: boolean;
  protocol: GatewayLanguageProtocol;
};

function isMetadataRecord(
  value: GatewayModel["metadata"]
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLumiLanguageModel(gateway: Gateway, model: GatewayModel) {
  return gateway.provider === "lumi" && model.modality === "language";
}

function getModelProtocol(
  gateway: Gateway,
  model: GatewayModel
): GatewayLanguageProtocol {
  if (!isLumiLanguageModel(gateway, model)) {
    return "openai";
  }

  return isMetadataRecord(model.metadata) &&
    model.metadata.protocol === "anthropic"
    ? "anthropic"
    : "openai";
}

function getDraftMetadata(
  gateway: Gateway,
  model: GatewayModel,
  draft: ModelDraft
) {
  const metadata = isMetadataRecord(model.metadata) ? model.metadata : null;

  if (!isLumiLanguageModel(gateway, model)) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    protocol: draft.protocol,
  } satisfies Record<string, unknown>;
}

export function GatewayAdminClient() {
  const [gateways, setGateways] = useState<GatewayBundle[]>([]);
  const [selectedGatewayId, setSelectedGatewayId] = useState<string | null>(
    null
  );
  const [gatewayForm, setGatewayForm] = useState(emptyGatewayForm);
  const [creatingGateway, setCreatingGateway] = useState(false);

  async function load() {
    const response = await fetch("/api/admin/gateways", { cache: "no-store" });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast.error(json.error || "Failed to load gateways.");
      return;
    }
    setGateways(json.gateways || []);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (gateways.length === 0) {
      setSelectedGatewayId(null);
      return;
    }

    if (!selectedGatewayId) {
      setSelectedGatewayId(gateways[0]?.gateway.id ?? null);
      return;
    }

    if (!gateways.some((bundle) => bundle.gateway.id === selectedGatewayId)) {
      setSelectedGatewayId(gateways[0]?.gateway.id ?? null);
    }
  }, [gateways, selectedGatewayId]);

  const selectedBundle =
    gateways.find((bundle) => bundle.gateway.id === selectedGatewayId) ?? null;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Add providers, sync their live model catalogs, and govern which models the app is allowed to use."
        eyebrow="AI Runtime"
        title="Gateways"
      />

      <div className="overflow-hidden border border-border/70 bg-card">
        <div className="border-border/70 border-b px-6 py-5">
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_auto]">
            <div className="space-y-2">
              <Label className="text-[11px] text-muted-foreground/80 uppercase tracking-[0.18em]">
                Provider
              </Label>
              <Select
                onValueChange={(value: Gateway["provider"]) =>
                  setGatewayForm((current) => ({ ...current, provider: value }))
                }
                value={gatewayForm.provider}
              >
                <SelectTrigger className="h-11 border-border/70 bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lumi">Lumi</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="ollama">Ollama</SelectItem>
                  <SelectItem value="replicate">Replicate</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-[11px] text-muted-foreground/80 uppercase tracking-[0.18em]">
                API Key
              </Label>
              <Input
                className="h-11 border-border/70 bg-background"
                onChange={(event) =>
                  setGatewayForm((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
                placeholder={
                  gatewayForm.provider === "ollama"
                    ? "Optional for local Ollama"
                    : `Paste ${providerLabels[gatewayForm.provider]} API key`
                }
                type="password"
                value={gatewayForm.apiKey}
              />
            </div>

            <div className="flex items-end">
              <Button
                className="h-11 min-w-36 px-5"
                disabled={creatingGateway}
                onClick={async () => {
                  try {
                    setCreatingGateway(true);
                    const response = await fetch("/api/admin/gateways", {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({
                        provider: gatewayForm.provider,
                        apiKey: gatewayForm.apiKey || null,
                      }),
                    });
                    const json = await response.json().catch(() => ({}));
                    if (!response.ok) {
                      throw new Error(json.error || "Failed to add provider.");
                    }
                    toast.success(
                      json.syncError
                        ? `${providerLabels[gatewayForm.provider]} added, but model sync failed.`
                        : `${providerLabels[gatewayForm.provider]} added and models synced.`
                    );
                    if (json.syncError) {
                      toast.error(json.syncError);
                    }
                    setGatewayForm(emptyGatewayForm);
                    await load();
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Failed to add provider."
                    );
                  } finally {
                    setCreatingGateway(false);
                  }
                }}
              >
                {creatingGateway ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 size-4" />
                )}
                Add provider
              </Button>
            </div>
          </div>
        </div>

        <div className="grid min-h-[640px] lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="border-border/70 border-r bg-background/40">
            <div className="flex items-center justify-between px-5 py-4">
              <div>
                <div className="font-medium text-sm">Providers</div>
                <div className="text-muted-foreground text-xs">
                  Select a gateway to manage its catalog
                </div>
              </div>
              <Badge variant="outline">{gateways.length}</Badge>
            </div>
            <Separator />
            <ScrollArea className="h-[calc(640px-73px)]">
              <div className="p-3">
                {gateways.length === 0 ? (
                  <div className="rounded-md border border-border/70 border-dashed bg-background px-4 py-5 text-muted-foreground text-sm">
                    No providers configured yet.
                  </div>
                ) : null}

                <div className="space-y-2">
                  {gateways.map((bundle) => {
                    const isSelected = bundle.gateway.id === selectedGatewayId;
                    const approvedCount = bundle.models.filter(
                      (model) => model.approved
                    ).length;

                    return (
                      <button
                        className={cn(
                          "w-full rounded-md border px-4 py-3 text-left transition-colors",
                          isSelected
                            ? "border-primary/40 bg-primary/8"
                            : "border-border/60 bg-background hover:border-border hover:bg-background/80"
                        )}
                        key={bundle.gateway.id}
                        onClick={() => setSelectedGatewayId(bundle.gateway.id)}
                        type="button"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-sm">
                                {providerLabels[bundle.gateway.provider]}
                              </span>
                              {bundle.gateway.hasApiKey ? (
                                <CheckCircle2 className="size-3.5 text-emerald-400" />
                              ) : (
                                <ShieldOff className="size-3.5 text-amber-400" />
                              )}
                            </div>
                            <div className="mt-1 text-muted-foreground text-xs">
                              {approvedCount}/{bundle.models.length} approved
                            </div>
                          </div>
                          <ChevronRight
                            className={cn(
                              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                              isSelected
                                ? "translate-x-0.5 text-foreground"
                                : ""
                            )}
                          />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {bundle.gateway.supportedModalities.map(
                            (modality) => (
                              <Badge
                                className="rounded-full"
                                key={modality}
                                variant="outline"
                              >
                                {modality}
                              </Badge>
                            )
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </ScrollArea>
          </aside>

          <section className="bg-background/20">
            {selectedBundle ? (
              <GatewayDetailPane
                bundle={selectedBundle}
                onRefresh={() => void load()}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-10 text-center">
                <div className="max-w-sm space-y-2">
                  <div className="font-medium text-lg">
                    No provider selected
                  </div>
                  <div className="text-muted-foreground text-sm">
                    Add a provider or choose one from the left to manage its
                    models.
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function GatewayDetailPane({
  bundle,
  onRefresh,
}: {
  bundle: GatewayBundle;
  onRefresh: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [modalityFilter, setModalityFilter] = useState<
    "all" | GatewayModel["modality"]
  >("all");
  const [approvalFilter, setApprovalFilter] = useState<
    "all" | "approved" | "unapproved" | "default"
  >("all");
  const [modelDrafts, setModelDrafts] = useState<Record<string, ModelDraft>>(
    {}
  );

  useEffect(() => {
    setModelDrafts(
      Object.fromEntries(
        bundle.models.map((model) => [
          model.id,
          {
            alias: model.alias || "",
            approved: model.approved,
            isDefault: model.isDefault,
            protocol: getModelProtocol(bundle.gateway, model),
          },
        ])
      )
    );
  }, [bundle.gateway, bundle.models]);

  const filteredModels = useMemo(() => {
    const query = filter.trim().toLowerCase();

    return bundle.models.filter((model) => {
      const alias = modelDrafts[model.id]?.alias || model.alias || "";
      const matchesQuery =
        !query ||
        model.rawModelId.toLowerCase().includes(query) ||
        alias.toLowerCase().includes(query) ||
        model.modality.toLowerCase().includes(query);
      const draft = modelDrafts[model.id] || {
        alias: model.alias || "",
        approved: model.approved,
        isDefault: model.isDefault,
        protocol: getModelProtocol(bundle.gateway, model),
      };
      const matchesModality =
        modalityFilter === "all" || model.modality === modalityFilter;
      const matchesApproval =
        approvalFilter === "all" ||
        (approvalFilter === "approved" && draft.approved) ||
        (approvalFilter === "unapproved" && !draft.approved) ||
        (approvalFilter === "default" && draft.isDefault);

      return matchesQuery && matchesModality && matchesApproval;
    });
  }, [approvalFilter, bundle.models, filter, modalityFilter, modelDrafts]);

  const groupedCounts = bundle.models.reduce<Record<string, number>>(
    (acc, model) => {
      acc[model.modality] = (acc[model.modality] || 0) + 1;
      return acc;
    },
    {}
  );

  async function persistModel(
    model: GatewayModel,
    draft: ModelDraft,
    successMessage = "Model updated."
  ) {
    try {
      setSavingModelId(model.id);
      const response = await fetch(
        `/api/admin/gateways/${bundle.gateway.id}/models`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: model.id,
            rawModelId: model.rawModelId,
            alias: draft.alias.trim() || null,
            modality: model.modality,
            approved: draft.approved,
            isDefault: draft.isDefault,
            description: model.description,
            metadata: getDraftMetadata(bundle.gateway, model, draft),
          }),
        }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to save model.");
      }
      toast.success(successMessage);
      onRefresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save model."
      );
    } finally {
      setSavingModelId(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border/70 border-b px-6 py-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-semibold text-2xl">
                {providerLabels[bundle.gateway.provider]}
              </h2>
              <Badge
                className="rounded-full px-2.5 py-1"
                variant={bundle.gateway.hasApiKey ? "default" : "outline"}
              >
                {bundle.gateway.hasApiKey ? (
                  <ShieldCheck className="size-3.5" />
                ) : (
                  <ShieldOff className="size-3.5" />
                )}
                {bundle.gateway.hasApiKey
                  ? "API key configured"
                  : "API key missing"}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(groupedCounts).map(([modality, count]) => (
                <Badge
                  className="rounded-full"
                  key={modality}
                  variant="outline"
                >
                  {count} {modality}
                </Badge>
              ))}
            </div>
          </div>

          <div className="grid gap-3 xl:min-w-[520px] xl:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="space-y-2">
              <Label className="text-[11px] text-muted-foreground/80 uppercase tracking-[0.18em]">
                Replace API Key
              </Label>
              <Input
                className="h-10 border-border/70 bg-background"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste new API key to update"
                type="password"
                value={apiKey}
              />
            </div>
            <div className="flex items-end">
              <Button
                className="h-10 w-10 p-0"
                disabled={busy || !apiKey.trim()}
                onClick={async () => {
                  try {
                    setBusy(true);
                    const response = await fetch(
                      `/api/admin/gateways/${bundle.gateway.id}`,
                      {
                        method: "PUT",
                        headers: {
                          "content-type": "application/json",
                        },
                        body: JSON.stringify({ apiKey: apiKey.trim() }),
                      }
                    );
                    const json = await response.json().catch(() => ({}));
                    if (!response.ok) {
                      throw new Error(json.error || "Failed to save API key.");
                    }
                    toast.success("API key updated.");
                    setApiKey("");
                    onRefresh();
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Failed to save API key."
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                title="Save API key"
              >
                <KeyRound className="size-4" />
                <span className="sr-only">Save API key</span>
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <IconActionButton
                disabled={busy}
                icon={<RefreshCw className="size-4" />}
                label="Sync models"
                onClick={async () => {
                  try {
                    setBusy(true);
                    const response = await fetch(
                      `/api/admin/gateways/${bundle.gateway.id}/sync`,
                      { method: "POST" }
                    );
                    const json = await response.json().catch(() => ({}));
                    if (!response.ok) {
                      throw new Error(json.error || "Failed to sync models.");
                    }
                    toast.success(`Synced ${json.syncedCount || 0} models.`);
                    onRefresh();
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Failed to sync models."
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                variant="outline"
              />
              <IconActionButton
                disabled={busy}
                icon={<Trash2 className="size-4" />}
                label="Delete provider"
                onClick={async () => {
                  try {
                    setBusy(true);
                    const response = await fetch(
                      `/api/admin/gateways/${bundle.gateway.id}`,
                      {
                        method: "DELETE",
                      }
                    );
                    const json = await response.json().catch(() => ({}));
                    if (!response.ok) {
                      throw new Error(
                        json.error || "Failed to delete provider."
                      );
                    }
                    toast.success("Provider deleted.");
                    onRefresh();
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Failed to delete provider."
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                variant="outline"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="font-medium text-sm">Model Catalog</div>
            <div className="text-muted-foreground text-xs">
              Approve models for runtime, assign aliases, set defaults, or
              remove imported entries.
            </div>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative">
              <Filter className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground" />
              <Input
                className="h-10 w-full border-border/70 bg-background pl-9 lg:min-w-[280px]"
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search model, alias, or modality"
                value={filter}
              />
            </div>
            <Select
              onValueChange={(value: "all" | GatewayModel["modality"]) =>
                setModalityFilter(value)
              }
              value={modalityFilter}
            >
              <SelectTrigger className="h-10 min-w-[150px] border-border/70 bg-background">
                <SelectValue placeholder="All modalities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modalities</SelectItem>
                <SelectItem value="language">Language</SelectItem>
                <SelectItem value="image">Image</SelectItem>
                <SelectItem value="speech">Speech</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="embedding">Embedding</SelectItem>
              </SelectContent>
            </Select>
            <Select
              onValueChange={(
                value: "all" | "approved" | "unapproved" | "default"
              ) => setApprovalFilter(value)}
              value={approvalFilter}
            >
              <SelectTrigger className="h-10 min-w-[150px] border-border/70 bg-background">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="unapproved">Unapproved</SelectItem>
                <SelectItem value="default">Default only</SelectItem>
              </SelectContent>
            </Select>
            <Badge className="rounded-full px-2.5 py-1" variant="outline">
              {filteredModels.length} / {bundle.models.length}
            </Badge>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-border/70 bg-background">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4">Model</TableHead>
                <TableHead>Alias</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="w-[280px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredModels.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="px-4 py-10 text-center text-muted-foreground"
                    colSpan={7}
                  >
                    No models match the current filter.
                  </TableCell>
                </TableRow>
              ) : null}

              {filteredModels.map((model) => {
                const draft = modelDrafts[model.id] || {
                  alias: model.alias || "",
                  approved: model.approved,
                  isDefault: model.isDefault,
                  protocol: getModelProtocol(bundle.gateway, model),
                };

                return (
                  <TableRow key={model.id}>
                    <TableCell className="max-w-[360px] px-4 py-3 align-top">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-sm">
                          {model.rawModelId}
                        </div>
                        {model.description ? (
                          <div className="mt-1 line-clamp-2 text-muted-foreground text-xs">
                            {model.description}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <Input
                        className="h-9 min-w-[220px] rounded-lg border-border/70 bg-background/70"
                        onChange={(event) =>
                          setModelDrafts((current) => ({
                            ...current,
                            [model.id]: {
                              ...draft,
                              alias: event.target.value,
                            },
                          }))
                        }
                        placeholder="Optional alias"
                        value={draft.alias}
                      />
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <Badge className="rounded-full" variant="outline">
                        {model.modality}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      {isLumiLanguageModel(bundle.gateway, model) ? (
                        <Select
                          onValueChange={(value: GatewayLanguageProtocol) =>
                            setModelDrafts((current) => ({
                              ...current,
                              [model.id]: {
                                ...draft,
                                protocol: value,
                              },
                            }))
                          }
                          value={draft.protocol}
                        >
                          <SelectTrigger className="h-9 min-w-[220px] rounded-lg border-border/70 bg-background/70">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="openai">
                              OpenAI-compatible
                            </SelectItem>
                            <SelectItem value="anthropic">
                              Anthropic messages
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      ) : bundle.gateway.provider === "lumi" ? (
                        <Badge className="rounded-full" variant="outline">
                          OpenAI-compatible
                        </Badge>
                      ) : (
                        <Badge className="rounded-full" variant="outline">
                          Native
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <Badge
                        className="rounded-full"
                        variant={draft.approved ? "default" : "outline"}
                      >
                        {draft.approved ? "Approved" : "Unapproved"}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <Badge
                        className="rounded-full"
                        variant={draft.isDefault ? "secondary" : "outline"}
                      >
                        {draft.isDefault ? "Default" : "Optional"}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3 text-right align-top">
                      <div className="flex justify-end gap-2">
                        <IconActionButton
                          className="h-9 w-9 rounded-lg p-0"
                          disabled={Boolean(savingModelId)}
                          icon={
                            draft.approved ? (
                              <ShieldOff className="size-4" />
                            ) : (
                              <ShieldCheck className="size-4" />
                            )
                          }
                          label={
                            draft.approved ? "Unapprove model" : "Approve model"
                          }
                          onClick={() => {
                            const nextDraft = {
                              ...draft,
                              approved: !draft.approved,
                            };
                            setModelDrafts((current) => ({
                              ...current,
                              [model.id]: nextDraft,
                            }));
                            void persistModel(
                              model,
                              nextDraft,
                              nextDraft.approved
                                ? "Model approved."
                                : "Model unapproved."
                            );
                          }}
                          variant={draft.approved ? "outline" : "default"}
                        />
                        <IconActionButton
                          className="h-9 w-9 rounded-lg p-0"
                          disabled={Boolean(savingModelId)}
                          icon={<Star className="size-4" />}
                          label={
                            draft.isDefault ? "Default model" : "Make default"
                          }
                          onClick={() => {
                            const nextDraft = {
                              ...draft,
                              approved: true,
                              isDefault: true,
                            };
                            setModelDrafts((current) => {
                              const nextDrafts = { ...current };
                              for (const sibling of bundle.models) {
                                const siblingDraft = nextDrafts[sibling.id] || {
                                  alias: sibling.alias || "",
                                  approved: sibling.approved,
                                  isDefault: sibling.isDefault,
                                  protocol: getModelProtocol(
                                    bundle.gateway,
                                    sibling
                                  ),
                                };
                                if (sibling.modality === model.modality) {
                                  nextDrafts[sibling.id] = {
                                    ...siblingDraft,
                                    isDefault: sibling.id === model.id,
                                    approved:
                                      sibling.id === model.id
                                        ? true
                                        : siblingDraft.approved,
                                  };
                                }
                              }
                              return nextDrafts;
                            });
                            void persistModel(
                              model,
                              nextDraft,
                              "Default model updated."
                            );
                          }}
                          variant={draft.isDefault ? "secondary" : "outline"}
                        />
                        <IconActionButton
                          className="h-9 w-9 rounded-lg p-0"
                          disabled={Boolean(savingModelId)}
                          icon={<Check className="size-4" />}
                          label="Save model changes"
                          onClick={() => void persistModel(model, draft)}
                        />
                        <IconActionButton
                          className="h-9 w-9 rounded-lg p-0"
                          disabled={busy || Boolean(savingModelId)}
                          icon={<Trash2 className="size-4" />}
                          label="Delete model"
                          onClick={async () => {
                            try {
                              setBusy(true);
                              const response = await fetch(
                                `/api/admin/gateways/${bundle.gateway.id}/models?modelId=${model.id}`,
                                {
                                  method: "DELETE",
                                }
                              );
                              const json = await response
                                .json()
                                .catch(() => ({}));
                              if (!response.ok) {
                                throw new Error(
                                  json.error || "Failed to delete model."
                                );
                              }
                              toast.success("Model removed.");
                              onRefresh();
                            } catch (error) {
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : "Failed to delete model."
                              );
                            } finally {
                              setBusy(false);
                            }
                          }}
                          variant="outline"
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function IconActionButton({
  className,
  disabled,
  icon,
  label,
  onClick,
  variant = "default",
}: {
  className?: string;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "secondary";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={className}
          disabled={disabled}
          onClick={onClick}
          title={label}
          variant={variant}
        >
          {icon}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
