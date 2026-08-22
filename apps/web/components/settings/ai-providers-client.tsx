"use client";

import {
  Check,
  CheckCircle2,
  ChevronDown,
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
import {
  SettingsDisclosure,
  SettingsPage,
  SettingsPageHeader,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { getProviderSupportedModalities } from "@/lib/ai/gateway-utils";
import {
  getGatewayCollectionState,
  getGatewayOverview,
} from "@/lib/settings/gateway-presentation";
import { cn } from "@/lib/utils";

type Gateway = {
  id: string;
  provider:
    | "anthropic"
    | "lumi"
    | "openai"
    | "openrouter"
    | "ollama"
    | "runpod"
    | "replicate";
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  supportedModalities: string[];
  updatedAt?: string;
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
  economicsAdmission?: {
    status: "ready" | "unapproved" | "needs_profile";
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    source?: string;
    canonicalSlug?: string;
  };
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
  runpod: "RunPod",
  replicate: "Replicate",
};

const emptyGatewayForm = {
  provider: "openai" as Gateway["provider"],
  apiKey: "",
  endpointId: "",
};

type ModelDraft = {
  alias: string;
  approved: boolean;
  isDefault: boolean;
  protocol: GatewayLanguageProtocol;
};

type NewModelDraft = {
  alias: string;
  modality: GatewayModel["modality"];
  protocol: GatewayLanguageProtocol;
  rawModelId: string;
};

function getEmptyNewModelDraft(gateway: Gateway): NewModelDraft {
  return {
    alias: "",
    modality: getProviderSupportedModalities(gateway.provider)[0],
    protocol: "openai",
    rawModelId: "",
  };
}

function formatModalityLabel(modality: GatewayModel["modality"]) {
  return `${modality.charAt(0).toUpperCase()}${modality.slice(1)}`;
}

function isMetadataRecord(
  value: GatewayModel["metadata"]
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRunPodModelValidated(model: GatewayModel) {
  if (!isMetadataRecord(model.metadata)) {
    return false;
  }
  const evidence = model.metadata.kestrelRunPodValidation;
  const evidenceRecord =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : null;
  return (
    evidenceRecord !== null &&
    evidenceRecord.version === "runpod-tool-round-trip-v2" &&
    evidenceRecord.streaming === true &&
    evidenceRecord.toolRoundTrip === true &&
    evidenceRecord.rawModelId === model.rawModelId
  );
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
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [loadingGateways, setLoadingGateways] = useState(true);
  const [gatewayLoadError, setGatewayLoadError] = useState<string | null>(null);

  async function load() {
    setLoadingGateways(true);
    setGatewayLoadError(null);
    try {
      const response = await fetch("/api/organization/ai/gateways", {
        cache: "no-store",
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to load providers.");
      }
      setGateways(json.gateways || []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load providers.";
      setGatewayLoadError(message);
      toast.error(message);
    } finally {
      setLoadingGateways(false);
    }
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
  const gatewayCollectionState = getGatewayCollectionState({
    isLoading: loadingGateways,
    error: gatewayLoadError,
    count: gateways.length,
  });

  async function createProvider() {
    try {
      setCreatingGateway(true);
      const response = await fetch("/api/organization/ai/gateways", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: gatewayForm.provider,
          apiKey: gatewayForm.apiKey || null,
          ...(gatewayForm.provider === "runpod"
            ? { endpointId: gatewayForm.endpointId }
            : {}),
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
      setAddProviderOpen(false);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add provider."
      );
    } finally {
      setCreatingGateway(false);
    }
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        actions={
          <Dialog onOpenChange={setAddProviderOpen} open={addProviderOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 size-4" />
                Add provider
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Add provider</DialogTitle>
                <DialogDescription>
                  Connect a provider and sync its model catalog.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="gateway-provider">Provider</Label>
                  <Select
                    onValueChange={(value: Gateway["provider"]) =>
                      setGatewayForm((current) => ({
                        ...current,
                        provider: value,
                      }))
                    }
                    value={gatewayForm.provider}
                  >
                    <SelectTrigger id="gateway-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lumi">Lumi</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="ollama">Ollama</SelectItem>
                      <SelectItem value="runpod">RunPod</SelectItem>
                      <SelectItem value="replicate">Replicate</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {gatewayForm.provider === "runpod" ? (
                  <div className="space-y-2">
                    <Label htmlFor="gateway-endpoint-id">Endpoint ID</Label>
                    <Input
                      id="gateway-endpoint-id"
                      onChange={(event) =>
                        setGatewayForm((current) => ({
                          ...current,
                          endpointId: event.target.value,
                        }))
                      }
                      placeholder="RunPod Serverless endpoint ID"
                      value={gatewayForm.endpointId}
                    />
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="gateway-api-key">API key</Label>
                  <Input
                    id="gateway-api-key"
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
              </div>
              <DialogFooter>
                <Button
                  disabled={
                    creatingGateway ||
                    (gatewayForm.provider === "runpod" &&
                      !gatewayForm.endpointId.trim())
                  }
                  onClick={() => void createProvider()}
                >
                  {creatingGateway ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Add provider
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
        description="Add providers, sync their live model catalogs, and govern which models the app is allowed to use."
        eyebrow="AI Runtime"
        title="AI providers"
      />

      <SettingsSection
        description="Connection health, approved catalog, and current defaults."
        title="Providers"
      >
        {gatewayCollectionState === "loading" ? (
          <div
            aria-live="polite"
            className="border-y py-5 text-muted-foreground text-sm"
            role="status"
          >
            Loading providers…
          </div>
        ) : gatewayCollectionState === "error" ? (
          <div className="space-y-4 border-y py-5">
            <SettingsStatusNotice
              description={gatewayLoadError ?? "Failed to load providers."}
              title="Providers could not be loaded"
              tone="error"
            />
            <Button onClick={() => void load()} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : gatewayCollectionState === "empty" ? (
          <div className="border-y py-5 text-muted-foreground text-sm">
            No providers configured yet.
          </div>
        ) : (
          <SettingsRows>
            {gateways.map((bundle) => {
              const isSelected = bundle.gateway.id === selectedGatewayId;
              const overview = getGatewayOverview(bundle);

              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "grid w-full gap-3 py-4 text-left transition-colors sm:grid-cols-[minmax(12rem,1fr)_minmax(0,1.4fr)_auto] sm:items-center",
                    isSelected ? "text-foreground" : "text-foreground/90"
                  )}
                  key={bundle.gateway.id}
                  onClick={() => setSelectedGatewayId(bundle.gateway.id)}
                  type="button"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-sm">
                        {providerLabels[bundle.gateway.provider]}
                      </span>
                      {isSelected ? (
                        <Badge variant="outline">Selected</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-muted-foreground text-xs">
                      {overview.approvedCount} approved · {overview.defaultCount} default
                    </div>
                  </div>
                  <div className="min-w-0">
                    <SettingsStatusSummary
                      detail={
                        bundle.gateway.updatedAt
                          ? `Updated ${new Date(
                              bundle.gateway.updatedAt
                            ).toLocaleDateString()}`
                          : undefined
                      }
                      status={overview.status}
                      tone={overview.tone}
                    />
                    {overview.attentionReason ? (
                      <p className="mt-1 text-muted-foreground text-xs">
                        {overview.attentionReason}
                      </p>
                    ) : null}
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              );
            })}
          </SettingsRows>
        )}
      </SettingsSection>

      {selectedBundle ? (
        <GatewayDetailPane
          bundle={selectedBundle}
          onRefresh={() => void load()}
        />
      ) : null}
    </SettingsPage>
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
  const [addingModel, setAddingModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isAddModelOpen, setIsAddModelOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [newModelDraft, setNewModelDraft] = useState<NewModelDraft>(() =>
    getEmptyNewModelDraft(bundle.gateway)
  );
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [validatingModelId, setValidatingModelId] = useState<string | null>(
    null
  );
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
    setIsAddModelOpen(false);
    setNewModelDraft(getEmptyNewModelDraft(bundle.gateway));
  }, [bundle.gateway.id]);

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

    return bundle.models
      .filter((model) => {
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
      })
      .toSorted((left, right) => {
        const leftDraft = modelDrafts[left.id] ?? left;
        const rightDraft = modelDrafts[right.id] ?? right;
        return (
          Number(rightDraft.isDefault) - Number(leftDraft.isDefault) ||
          Number(rightDraft.approved) - Number(leftDraft.approved) ||
          left.rawModelId.localeCompare(right.rawModelId)
        );
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
        `/api/organization/ai/gateways/${bundle.gateway.id}/models`,
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

  async function addModel() {
    const rawModelId = newModelDraft.rawModelId.trim();
    if (!rawModelId) {
      toast.error("Provider model ID is required.");
      return;
    }

    try {
      setAddingModel(true);
      const response = await fetch(
        `/api/organization/ai/gateways/${bundle.gateway.id}/models`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            rawModelId,
            alias: newModelDraft.alias.trim() || null,
            modality: newModelDraft.modality,
            approved: bundle.gateway.provider !== "runpod",
            isDefault: false,
            description: null,
            metadata:
              bundle.gateway.provider === "lumi" &&
              newModelDraft.modality === "language"
                ? { protocol: newModelDraft.protocol }
                : null,
          }),
        }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to add model.");
      }

      toast.success(
        bundle.gateway.provider === "runpod"
          ? "Model added. Validate it before approval."
          : "Model added and approved."
      );
      setNewModelDraft(getEmptyNewModelDraft(bundle.gateway));
      setIsAddModelOpen(false);
      setFilter("");
      setModalityFilter("all");
      setApprovalFilter("all");
      onRefresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add model."
      );
    } finally {
      setAddingModel(false);
    }
  }

  async function replaceApiKey() {
    try {
      setBusy(true);
      const response = await fetch(
        `/api/organization/ai/gateways/${bundle.gateway.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
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
        error instanceof Error ? error.message : "Failed to save API key."
      );
    } finally {
      setBusy(false);
    }
  }

  async function syncModels() {
    try {
      setBusy(true);
      const response = await fetch(
        `/api/organization/ai/gateways/${bundle.gateway.id}/sync`,
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
        error instanceof Error ? error.message : "Failed to sync models."
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteProvider() {
    try {
      setBusy(true);
      const response = await fetch(
        `/api/organization/ai/gateways/${bundle.gateway.id}`,
        { method: "DELETE" }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to delete provider.");
      }
      toast.success("Provider deleted.");
      onRefresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete provider."
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(model: GatewayModel) {
    try {
      setBusy(true);
      const response = await fetch(
        `/api/organization/ai/gateways/${bundle.gateway.id}/models?modelId=${model.id}`,
        { method: "DELETE" }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to delete model.");
      }
      toast.success("Model removed.");
      onRefresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete model."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection
        actions={
          <Button
            disabled={busy}
            onClick={() => void syncModels()}
            size="sm"
            variant="outline"
          >
            {busy ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 size-4" />
            )}
            Sync models
          </Button>
        }
        description="Connection readiness and supported workloads."
        title={providerLabels[bundle.gateway.provider]}
      >
        <SettingsRows>
          <div className="grid gap-3 py-4 sm:grid-cols-2 sm:items-center">
            <SettingsStatusSummary
              detail={bundle.gateway.enabled ? undefined : "Provider disabled"}
              status={
                bundle.gateway.hasApiKey || bundle.gateway.provider === "ollama"
                  ? "Connected"
                  : "API key missing"
              }
              tone={
                bundle.gateway.hasApiKey || bundle.gateway.provider === "ollama"
                  ? "positive"
                  : "warning"
              }
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm sm:justify-end">
              {Object.entries(groupedCounts).map(([modality, count]) => (
                <span key={modality}>
                  {count} {modality}
                </span>
              ))}
            </div>
          </div>

          <Collapsible onOpenChange={setManageOpen} open={manageOpen}>
            <CollapsibleTrigger asChild>
              <button
                className="flex w-full items-center justify-between gap-4 py-4 text-left"
                type="button"
              >
                <span>
                  <span className="block font-medium text-sm">Manage</span>
                  <span className="mt-0.5 block text-muted-foreground text-xs">
                    Replace credentials or remove this provider.
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "size-4 text-muted-foreground transition-transform",
                    manageOpen && "rotate-180"
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t py-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="space-y-2">
                  <Label htmlFor={`gateway-key-${bundle.gateway.id}`}>
                    Replace API key
                  </Label>
                  <Input
                    id={`gateway-key-${bundle.gateway.id}`}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste a new API key"
                    type="password"
                    value={apiKey}
                  />
                </div>
                <Button
                  disabled={busy || !apiKey.trim()}
                  onClick={() => void replaceApiKey()}
                  variant="outline"
                >
                  <KeyRound className="mr-2 size-4" />
                  Replace key
                </Button>
              </div>

              <div className="mt-5 flex items-center justify-between gap-4 border-t pt-5">
                <p className="max-w-md text-muted-foreground text-xs">
                  Removing a provider also removes its imported model catalog.
                </p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button disabled={busy} size="sm" variant="destructive">
                      Delete provider
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete provider?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes {providerLabels[bundle.gateway.provider]} and
                        its imported models. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => void deleteProvider()}
                      >
                        Delete provider
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        description="Approved and default models appear first. Filter to inspect the full catalog."
        title="Models"
      >
      <SettingsDisclosure
        description={`${bundle.models.filter((model) => model.approved).length} approved · ${bundle.models.filter((model) => model.isDefault).length} default · ${bundle.models.length} total`}
        title="Model catalog"
      >
      <div className="min-w-0">
        <div className="mb-5 space-y-4">
          <p className="text-muted-foreground text-xs/5">
            Add provider model IDs, approve models for runtime, assign aliases,
            set defaults, or remove imported entries.
          </p>
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] xl:grid-cols-[auto_minmax(220px,1fr)_minmax(150px,0.6fr)_minmax(150px,0.6fr)_auto]">
            <Button
              className="h-10"
              onClick={() => setIsAddModelOpen((current) => !current)}
              variant={isAddModelOpen ? "secondary" : "outline"}
            >
              <Plus className="mr-2 size-4" />
              Add model
            </Button>
            <div className="relative">
              <Filter className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground" />
              <Input
                className="h-10 w-full border-border/70 bg-background pl-9"
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
              <SelectTrigger className="h-10 w-full min-w-[150px] border-border/70 bg-background">
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
              <SelectTrigger className="h-10 w-full min-w-[150px] border-border/70 bg-background">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="unapproved">Unapproved</SelectItem>
                <SelectItem value="default">Default only</SelectItem>
              </SelectContent>
            </Select>
            <Badge className="w-fit self-center rounded-full px-2.5 py-1" variant="outline">
              {filteredModels.length} / {bundle.models.length}
            </Badge>
          </div>
        </div>

        {isAddModelOpen ? (
          <div
            className="mb-4 rounded-md border border-border/70 bg-background p-4"
            data-testid="add-gateway-model-form"
          >
            <div className="grid gap-4 xl:grid-cols-[minmax(240px,1.4fr)_minmax(200px,1fr)_180px_minmax(200px,1fr)_auto] xl:items-end">
              <div className="space-y-2">
                <Label htmlFor={`new-model-id-${bundle.gateway.id}`}>
                  Provider model ID
                </Label>
                <Input
                  id={`new-model-id-${bundle.gateway.id}`}
                  onChange={(event) =>
                    setNewModelDraft((current) => ({
                      ...current,
                      rawModelId: event.target.value,
                    }))
                  }
                  placeholder="provider/model-name"
                  value={newModelDraft.rawModelId}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`new-model-alias-${bundle.gateway.id}`}>
                  Alias (optional)
                </Label>
                <Input
                  id={`new-model-alias-${bundle.gateway.id}`}
                  onChange={(event) =>
                    setNewModelDraft((current) => ({
                      ...current,
                      alias: event.target.value,
                    }))
                  }
                  placeholder="Friendly model alias"
                  value={newModelDraft.alias}
                />
              </div>
              <div className="space-y-2">
                <Label>Modality</Label>
                <Select
                  onValueChange={(modality: GatewayModel["modality"]) =>
                    setNewModelDraft((current) => ({
                      ...current,
                      modality,
                    }))
                  }
                  value={newModelDraft.modality}
                >
                  <SelectTrigger aria-label="Model modality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getProviderSupportedModalities(
                      bundle.gateway.provider
                    ).map((modality) => (
                      <SelectItem key={modality} value={modality}>
                        {formatModalityLabel(modality)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {bundle.gateway.provider === "lumi" &&
              newModelDraft.modality === "language" ? (
                <div className="space-y-2">
                  <Label>Protocol</Label>
                  <Select
                    onValueChange={(protocol: GatewayLanguageProtocol) =>
                      setNewModelDraft((current) => ({
                        ...current,
                        protocol,
                      }))
                    }
                    value={newModelDraft.protocol}
                  >
                    <SelectTrigger aria-label="Model protocol">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI-compatible</SelectItem>
                      <SelectItem value="anthropic">
                        Anthropic messages
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="hidden xl:block" />
              )}
              <div className="flex gap-2">
                <Button
                  disabled={addingModel || !newModelDraft.rawModelId.trim()}
                  onClick={() => void addModel()}
                >
                  {addingModel ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-2 size-4" />
                  )}
                  Add approved model
                </Button>
                <Button
                  disabled={addingModel}
                  onClick={() => {
                    setNewModelDraft(getEmptyNewModelDraft(bundle.gateway));
                    setIsAddModelOpen(false);
                  }}
                  variant="outline"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="min-w-0 overflow-x-auto border-y">
          <Table className="min-w-[1180px]">
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
                const runPodValidated =
                  bundle.gateway.provider !== "runpod" ||
                  isRunPodModelValidated(model);
                const economicsReady =
                  model.modality !== "language" ||
                  model.economicsAdmission?.status === "ready";
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
                      {model.economicsAdmission ? (
                        <div className="mt-1 text-muted-foreground text-xs">
                          {model.economicsAdmission.status === "ready" ? (
                            <>
                              Provider limits: {model.economicsAdmission.contextWindowTokens?.toLocaleString()} context ·{" "}
                              {model.economicsAdmission.maxOutputTokens?.toLocaleString()} output · {model.economicsAdmission.source}
                              {model.economicsAdmission.canonicalSlug ? (
                                <div>Canonical slug: {model.economicsAdmission.canonicalSlug}</div>
                              ) : null}
                              <div>Kestrel per-run allocation is configured separately.</div>
                            </>
                          ) : (
                            "Needs economics profile"
                          )}
                        </div>
                      ) : null}
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
                        {bundle.gateway.provider === "runpod" ? (
                          <IconActionButton
                            className="h-9 w-9 rounded-lg p-0"
                            disabled={
                              Boolean(savingModelId) ||
                              validatingModelId === model.id ||
                              model.modality !== "language"
                            }
                            icon={
                              validatingModelId === model.id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="size-4" />
                              )
                            }
                            label={
                              runPodValidated
                                ? "Revalidate RunPod model"
                                : "Validate RunPod model"
                            }
                            onClick={async () => {
                              try {
                                setValidatingModelId(model.id);
                                const response = await fetch(
                                  `/api/organization/ai/gateways/${bundle.gateway.id}/models/${model.id}/validate`,
                                  { method: "POST" }
                                );
                                const json = await response
                                  .json()
                                  .catch(() => ({}));
                                if (!response.ok) {
                                  throw new Error(
                                    json.error || "RunPod validation failed."
                                  );
                                }
                                toast.success(
                                  "RunPod streaming and tool round trip validated."
                                );
                                onRefresh();
                              } catch (error) {
                                toast.error(
                                  error instanceof Error
                                    ? error.message
                                    : "RunPod validation failed."
                                );
                              } finally {
                                setValidatingModelId(null);
                              }
                            }}
                            variant={runPodValidated ? "secondary" : "outline"}
                          />
                        ) : null}
                        <IconActionButton
                          className="h-9 w-9 rounded-lg p-0"
                          disabled={
                            Boolean(savingModelId) ||
                            !runPodValidated ||
                            (!draft.approved && !economicsReady)
                          }
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
                          disabled={
                            Boolean(savingModelId) ||
                            !runPodValidated ||
                            !economicsReady
                          }
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
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              aria-label="Delete model"
                              className="h-9 w-9 rounded-lg p-0"
                              disabled={busy || Boolean(savingModelId)}
                              title="Delete model"
                              variant="outline"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete model?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This removes {model.alias || model.rawModelId} from
                                the provider catalog. This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => void deleteModel(model)}
                              >
                                Delete model
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
      </SettingsDisclosure>
      </SettingsSection>
    </>
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
