"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  SettingsActionGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OrganizationChatReadiness } from "@/lib/organizations/chat-readiness";

const SETUP_PROVIDERS = [
  { key: "lumi", label: "Lumi" },
  { key: "openai", label: "OpenAI" },
  { key: "openrouter", label: "OpenRouter" },
  { key: "anthropic", label: "Anthropic" },
] as const;

type SetupProvider = (typeof SETUP_PROVIDERS)[number]["key"];

export type SetupGateway = {
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  environmentId: string | null;
  models: SetupModel[];
};

type SetupModel = {
  id: string;
  gatewayId: string;
  rawModelId: string;
  alias: string | null;
  modality: string;
  approved: boolean;
  isDefault: boolean;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

const POLL_MS = 3000;

function statusTone(ready: boolean) {
  return ready ? "positive" as const : "neutral" as const;
}

function SetupStepIcon({ ready }: { ready: boolean }) {
  return ready ? (
    <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-600" />
  ) : (
    <Circle aria-hidden="true" className="size-4 text-muted-foreground" />
  );
}

export function OrganizationSetupClient({
  initialReadiness,
  initialGateways,
}: {
  initialReadiness: OrganizationChatReadiness;
  initialGateways: SetupGateway[];
}) {
  const router = useRouter();
  const [readiness, setReadiness] = useState(initialReadiness);
  const [gateways, setGateways] = useState(initialGateways);
  const [provider, setProvider] = useState<SetupProvider>("lumi");
  const [apiKey, setApiKey] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(
    () =>
      initialGateways
        .filter(
          (gateway) =>
            gateway.enabled &&
            (gateway.environmentId === null ||
              gateway.environmentId ===
                initialReadiness.environmentExecution.environmentId)
        )
        .flatMap((gateway) => gateway.models)
        .find(
          (model) =>
            model.modality === "language" &&
            model.approved &&
            model.isDefault
        )?.id ?? ""
  );
  const [flySlug, setFlySlug] = useState(
    initialReadiness.workspaceCompute.organizationSlug
  );
  const [flyToken, setFlyToken] = useState("");
  const [flyBusy, setFlyBusy] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);

  const languageModels = useMemo(
    () =>
      gateways
        .filter(
          (gateway) =>
            gateway.enabled &&
            (gateway.environmentId === null ||
              gateway.environmentId ===
                readiness.environmentExecution.environmentId)
        )
        .flatMap((gateway) =>
          gateway.models
            .filter((model) => model.modality === "language")
            .map((model) => ({ ...model, gatewayName: gateway.displayName }))
        ),
    [gateways, readiness.environmentExecution.environmentId]
  );

  useEffect(() => {
    if (
      selectedModelId &&
      !languageModels.some((model) => model.id === selectedModelId)
    ) {
      setSelectedModelId("");
    }
  }, [languageModels, selectedModelId]);

  const refreshReadiness = useCallback(async () => {
    const response = await fetch("/api/organization/setup", {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!(response.ok && payload.readiness)) {
      throw new Error(payload.error ?? "Organization readiness is unavailable.");
    }
    setReadiness(payload.readiness);
    if (payload.readiness.ready) router.refresh();
    setFlySlug((current) =>
      current || payload.readiness.workspaceCompute.organizationSlug || ""
    );
    return payload.readiness as OrganizationChatReadiness;
  }, [router]);

  const refreshGateways = useCallback(async () => {
    const response = await fetch("/api/organization/ai/gateways", {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!(response.ok && Array.isArray(payload.gateways))) {
      throw new Error(payload.error ?? "Model providers are unavailable.");
    }
    const next: SetupGateway[] = payload.gateways.map(
      (item: {
        gateway: Omit<SetupGateway, "models">;
        models: SetupModel[];
      }) => ({
        id: item.gateway.id,
        provider: item.gateway.provider,
        displayName: item.gateway.displayName,
        enabled: item.gateway.enabled,
        hasApiKey: item.gateway.hasApiKey,
        environmentId: item.gateway.environmentId,
        models: item.models,
      })
    );
    setGateways(next);
    return next;
  }, []);

  useEffect(() => {
    if (
      readiness.ready ||
      (readiness.environmentExecution.status !== "provisioning" &&
        readiness.environmentExecution.operationStatus !== "queued" &&
        readiness.environmentExecution.operationStatus !== "running")
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshReadiness().catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [readiness, refreshReadiness]);

  async function connectProvider() {
    setProviderBusy(true);
    try {
      const existingGateway = gateways.find(
        (gateway) => gateway.provider === provider && gateway.environmentId === null
      );
      let syncFailed = false;
      if (existingGateway) {
        const updateResponse = await fetch(
          `/api/organization/ai/gateways/${encodeURIComponent(existingGateway.id)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiKey, enabled: true }),
          }
        );
        const updatePayload = await updateResponse.json().catch(() => ({}));
        if (!updateResponse.ok) {
          throw new Error(updatePayload.error ?? "Model provider update failed.");
        }
        const syncResponse = await fetch(
          `/api/organization/ai/gateways/${encodeURIComponent(existingGateway.id)}/sync`,
          { method: "POST" }
        );
        syncFailed = !syncResponse.ok;
      } else {
        const response = await fetch("/api/organization/ai/gateways", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, apiKey, enabled: true }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error ?? "Model provider connection failed.");
        }
        syncFailed = Boolean(payload.syncError);
      }
      if (syncFailed) {
        throw new Error(
          "The provider was saved, but its model catalog could not be synced. Check the credential and try again in AI providers."
        );
      }
      await Promise.all([refreshGateways(), refreshReadiness()]);
      setApiKey("");
      toast.success("Provider connected and language models synced.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Provider setup failed.");
    } finally {
      setProviderBusy(false);
    }
  }

  async function saveDefaultModel() {
    const model = languageModels.find((candidate) => candidate.id === selectedModelId);
    if (!model) return;
    setModelBusy(true);
    try {
      const response = await fetch(
        `/api/organization/ai/gateways/${encodeURIComponent(model.gatewayId)}/models`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: model.id,
            rawModelId: model.rawModelId,
            alias: model.alias,
            modality: "language",
            approved: true,
            isDefault: true,
            description: model.description,
            metadata: model.metadata,
          }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error ?? "Default model update failed.");
      }
      await Promise.all([refreshGateways(), refreshReadiness()]);
      toast.success("Default language model is ready.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Model setup failed.");
    } finally {
      setModelBusy(false);
    }
  }

  async function requestEnvironmentRecovery() {
    const response = await fetch("/api/organization/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-default-environment" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Default Environment recovery failed.");
    }
    if (payload.readiness) setReadiness(payload.readiness);
  }

  async function configureFly() {
    setFlyBusy(true);
    try {
      const configureResponse = await fetch(
        "/api/organization/infrastructure/connections/fly",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "configure",
            organizationSlug: flySlug,
            apiToken: flyToken || null,
            enabled: true,
          }),
        }
      );
      const configurePayload = await configureResponse.json().catch(() => ({}));
      if (!configureResponse.ok) {
        throw new Error(configurePayload.error ?? "Fly connection save failed.");
      }
      const testResponse = await fetch(
        "/api/organization/infrastructure/connections/fly",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "test" }),
        }
      );
      const testPayload = await testResponse.json().catch(() => ({}));
      if (!testResponse.ok) {
        throw new Error(testPayload.error ?? "Fly connection test failed.");
      }
      setFlyToken("");
      await requestEnvironmentRecovery();
      await refreshReadiness();
      toast.success("Fly is verified and Environment recovery was requested.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Fly setup failed.");
      await refreshReadiness().catch(() => {});
    } finally {
      setFlyBusy(false);
    }
  }

  async function enableExecution() {
    setExecutionBusy(true);
    try {
      const response = await fetch("/api/organization/environments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error ?? "Environment execution update failed.");
      }
      await requestEnvironmentRecovery();
      await refreshReadiness();
      toast.success("Environment execution enabled.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Execution setup failed.");
    } finally {
      setExecutionBusy(false);
    }
  }

  async function retryExecution() {
    setExecutionBusy(true);
    try {
      await requestEnvironmentRecovery();
      await refreshReadiness();
      toast.success("Default Environment recovery requested.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Recovery failed.");
    } finally {
      setExecutionBusy(false);
    }
  }

  if (readiness.ready) {
    return (
      <SettingsPage>
        <SettingsPageHeader
          description="Your organization has the minimum configuration required to run agent chats."
          eyebrow="Organization"
          title="Setup complete"
        />
        <SettingsSection
          description="Model access, workspace compute, and Environment execution are ready."
          title="Readiness"
        >
          <SettingsRows>
            <SettingsRow label="Model access">
              <SettingsStatusSummary
                detail={readiness.modelAccess.modelName ?? undefined}
                status="Ready"
                tone="positive"
              />
            </SettingsRow>
            <SettingsRow label="Workspace compute">
              <SettingsStatusSummary status="Fly verified" tone="positive" />
            </SettingsRow>
            <SettingsRow label="Environment execution">
              <SettingsStatusSummary
                detail={readiness.environmentExecution.environmentName ?? undefined}
                status="Ready"
                tone="positive"
              />
            </SettingsRow>
          </SettingsRows>
          <div className="mt-5">
            <Button asChild>
              <Link href="/threads/new">Start first chat</Link>
            </Button>
          </div>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Complete these three checks to let your team start agent chats. You can leave and return at any time."
        eyebrow="Organization"
        title="Finish setup"
      />

      <SettingsSection
        description="Connect a provider, sync its catalog, then explicitly choose the default language model."
        title="1. Model access"
      >
        <SettingsRows>
          <SettingsRow label="Readiness">
            <div className="flex items-center gap-2">
              <SetupStepIcon ready={readiness.modelAccess.ready} />
              <SettingsStatusSummary
                detail={readiness.modelAccess.detail}
                status={readiness.modelAccess.ready ? "Ready" : "Required"}
                tone={statusTone(readiness.modelAccess.ready)}
              />
            </div>
          </SettingsRow>
          {readiness.modelAccess.ready ? null : (
            <>
              <div className="grid gap-4 py-5 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end">
                <div className="space-y-2">
                  <Label htmlFor="setup-provider">Provider</Label>
                  <Select
                    onValueChange={(value) => setProvider(value as SetupProvider)}
                    value={provider}
                  >
                    <SelectTrigger id="setup-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SETUP_PROVIDERS.map((option) => (
                        <SelectItem key={option.key} value={option.key}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-provider-key">API key</Label>
                  <Input
                    autoComplete="off"
                    id="setup-provider-key"
                    onChange={(event) => setApiKey(event.target.value)}
                    type="password"
                    value={apiKey}
                  />
                </div>
                <Button
                  disabled={providerBusy || !apiKey.trim()}
                  onClick={() => void connectProvider()}
                  size="sm"
                >
                  {providerBusy ? "Connecting…" : "Connect and sync"}
                </Button>
              </div>
              <SettingsRow
                description="No model is chosen from catalog ordering. Select the one your organization should use."
                label="Default language model"
              >
                <SettingsActionGroup>
                  <Select onValueChange={setSelectedModelId} value={selectedModelId}>
                    <SelectTrigger className="min-w-64 flex-1">
                      <SelectValue placeholder="Select a synced model" />
                    </SelectTrigger>
                    <SelectContent>
                      {languageModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.gatewayName} · {model.alias || model.rawModelId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={modelBusy || !selectedModelId}
                    onClick={() => void saveDefaultModel()}
                    size="sm"
                  >
                    {modelBusy ? "Saving…" : "Approve and use default"}
                  </Button>
                </SettingsActionGroup>
              </SettingsRow>
            </>
          )}
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        description="Fly provides the CPU workspace runtimes where agents execute and persistent workspaces live."
        title="2. Workspace compute"
      >
        <SettingsRows>
          <SettingsRow label="Readiness">
            <div className="flex items-center gap-2">
              <SetupStepIcon ready={readiness.workspaceCompute.ready} />
              <SettingsStatusSummary
                detail={readiness.workspaceCompute.detail}
                status={readiness.workspaceCompute.ready ? "Ready" : "Required"}
                tone={statusTone(readiness.workspaceCompute.ready)}
              />
            </div>
          </SettingsRow>
          {readiness.workspaceCompute.ready ? null : (
            <div className="grid gap-4 py-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="setup-fly-slug">Fly organization slug</Label>
                <Input
                  id="setup-fly-slug"
                  onChange={(event) => setFlySlug(event.target.value)}
                  value={flySlug}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-fly-token">Fly API token</Label>
                <Input
                  autoComplete="off"
                  id="setup-fly-token"
                  onChange={(event) => setFlyToken(event.target.value)}
                  placeholder={
                    readiness.workspaceCompute.hasApiToken
                      ? "Leave empty to keep the stored token"
                      : "Required"
                  }
                  type="password"
                  value={flyToken}
                />
              </div>
              <div className="sm:col-span-2">
                <Button
                  disabled={
                    flyBusy ||
                    !flySlug.trim() ||
                    !(flyToken.trim() || readiness.workspaceCompute.hasApiToken)
                  }
                  onClick={() => void configureFly()}
                  size="sm"
                >
                  {flyBusy ? "Verifying…" : "Save, test, and continue"}
                </Button>
              </div>
            </div>
          )}
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        description="The existing default Environment is provisioned automatically after Fly verification."
        title="3. Environment execution"
      >
        <SettingsRows>
          <SettingsRow label="Readiness">
            <div className="flex items-center gap-2">
              {readiness.environmentExecution.status === "provisioning" ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <SetupStepIcon ready={readiness.environmentExecution.ready} />
              )}
              <SettingsStatusSummary
                detail={readiness.environmentExecution.detail}
                status={
                  readiness.environmentExecution.ready
                    ? "Ready"
                    : readiness.environmentExecution.status === "provisioning"
                      ? "Provisioning"
                      : "Required"
                }
                tone={statusTone(readiness.environmentExecution.ready)}
              />
            </div>
          </SettingsRow>
          {readiness.environmentExecution.ready ? null : (
            <SettingsRow label="Action">
              <SettingsActionGroup>
                {!readiness.environmentExecution.organizationEnabled &&
                readiness.environmentExecution.deploymentEnabled ? (
                  <Button
                    disabled={executionBusy || !readiness.workspaceCompute.ready}
                    onClick={() => void enableExecution()}
                    size="sm"
                  >
                    {executionBusy ? "Enabling…" : "Enable"}
                  </Button>
                ) : null}
                {readiness.environmentExecution.status === "failed" ? (
                  <Button
                    disabled={executionBusy || !readiness.workspaceCompute.ready}
                    onClick={() => void retryExecution()}
                    size="sm"
                    variant="outline"
                  >
                    {executionBusy ? "Retrying…" : "Retry"}
                  </Button>
                ) : null}
                {readiness.environmentExecution.environmentId ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={`/settings/organization/environments/${readiness.environmentExecution.environmentId}/activity`}
                    >
                      View Environment operations
                    </Link>
                  </Button>
                ) : null}
              </SettingsActionGroup>
            </SettingsRow>
          )}
        </SettingsRows>
      </SettingsSection>
    </SettingsPage>
  );
}
