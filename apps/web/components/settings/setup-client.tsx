"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  SettingsActionGroup,
  SettingsDisclosure,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusSummary,
  SettingsStatusNotice,
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
import {
  getSignupEnvironmentExperience,
  getSignupEnvironmentMilestones,
} from "@/lib/signup-onboarding-progress";

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
  credentialStatus?: string;
  credentialValidatedAt?: string | null;
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

type SignupOnboardingPayload = {
  onboarding?: { readiness?: OrganizationChatReadiness | null };
  gateways?: SetupGateway[];
  canComplete?: boolean;
  redirectTo?: string;
  error?: string;
};

type SignupOnboardingAction =
  | { action: "connect-provider"; provider: SetupProvider; apiKey: string }
  | { action: "select-default-model"; modelId: string }
  | {
      action: "configure-fly";
      organizationSlug: string;
      apiToken: string | null;
    }
  | { action: "retry-default-environment" }
  | { action: "complete" };

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as SignupOnboardingPayload;
}

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

function SignupSuccessReceipt({
  detail,
  status,
}: {
  detail: string;
  status: string;
}) {
  return (
    <div className="grid gap-2 py-4 sm:grid-cols-[auto_minmax(0,1fr)_minmax(12rem,auto)] sm:items-center sm:gap-5">
      <CheckCircle2
        aria-hidden="true"
        className="size-5 text-emerald-600"
      />
      <span className="font-medium text-sm">{status}</span>
      <span className="text-muted-foreground text-sm sm:text-right">
        {detail}
      </span>
    </div>
  );
}

function humanizeStatus(status: string | null) {
  if (!status) return "Preparing";
  return status.replaceAll("_", " ");
}

function SignupEnvironmentProgress({
  completionFailed,
  executionBusy,
  onFinish,
  onRetry,
  readiness,
}: {
  completionFailed: boolean;
  executionBusy: boolean;
  onFinish: () => void;
  onRetry: () => void;
  readiness: OrganizationChatReadiness["environmentExecution"];
}) {
  const milestones = getSignupEnvironmentMilestones({
    environmentReady: readiness.ready,
    operationStage: readiness.operationStage,
  });
  const experience = getSignupEnvironmentExperience(readiness.status);

  return (
    <div>
      {experience.kind !== "progress" ? (
        <div className="border-y py-5">
          <SettingsStatusNotice
            description={readiness.detail}
            title={experience.title}
            tone={experience.kind === "action" ? "warning" : "error"}
          />
          {experience.kind === "action" ? (
            <div className="mt-4">
              <Button
                disabled={executionBusy}
                onClick={onRetry}
                size="sm"
                variant="outline"
              >
                {executionBusy ? experience.busyLabel : experience.actionLabel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <ol
          aria-label="Environment setup progress"
          className="relative border-y py-2 before:absolute before:top-7 before:bottom-7 before:left-[0.6875rem] before:border-border before:border-l"
        >
          {milestones.map((milestone) => {
            const active = milestone.status === "active";
            const completed = milestone.status === "completed";
            return (
              <li
                aria-current={active ? "step" : undefined}
                className="relative grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3 py-4"
                key={milestone.id}
              >
                <span className="relative z-10 flex size-6 items-center justify-center bg-background">
                  {completed ? (
                    <CheckCircle2
                      aria-hidden="true"
                      className="size-5 text-emerald-600"
                    />
                  ) : active ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-5 animate-spin text-accent motion-reduce:animate-none"
                    />
                  ) : (
                    <Circle
                      aria-hidden="true"
                      className="size-5 text-muted-foreground"
                    />
                  )}
                </span>
                <div className="min-w-0 pt-0.5">
                  <p
                    className={
                      active
                        ? "font-semibold text-sm"
                        : completed
                          ? "font-medium text-sm"
                          : "text-muted-foreground text-sm"
                    }
                  >
                    {milestone.label}
                  </p>
                  {active ? (
                    <p
                      aria-live="polite"
                      className="mt-1 text-muted-foreground text-sm/6"
                    >
                      {readiness.ready
                        ? "Your Environment is ready. Opening a new blank Thread."
                        : "This first setup can take a little while. Your progress is saved."}
                    </p>
                  ) : null}
                </div>
                {completed ? (
                  <span className="pt-0.5 text-muted-foreground text-sm">
                    Completed
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {completionFailed ? (
        <div className="mt-5">
          <SettingsStatusNotice
            description="Your Environment is ready, but onboarding could not open the new Thread."
            title="Opening your Thread paused"
            tone="error"
          />
          <Button className="mt-4" onClick={onFinish} size="sm">
            Open first Thread
          </Button>
        </div>
      ) : null}

      <SettingsDisclosure className="mt-2.5" title="Technical details">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs">Environment</dt>
            <dd className="mt-1">{readiness.environmentName ?? "Default"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Operation status</dt>
            <dd className="mt-1 capitalize">
              {humanizeStatus(readiness.operationStatus)}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground text-xs">Current stage</dt>
            <dd className="mt-1 break-all font-mono text-xs">
              {readiness.operationStage ?? "environment.activation.requested"}
            </dd>
          </div>
          {readiness.providerRequestId ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground text-xs">Fly request ID</dt>
              <dd className="mt-1 break-all font-mono text-xs">
                {readiness.providerRequestId}
              </dd>
            </div>
          ) : null}
        </dl>
      </SettingsDisclosure>

      <p className="mt-5 text-muted-foreground text-sm">
        A new blank Thread will open when your workspace is ready.
      </p>
    </div>
  );
}

export function OrganizationSetupClient({
  initialReadiness,
  initialGateways,
  initialCanComplete = false,
  mode = "organization",
}: {
  initialReadiness: OrganizationChatReadiness;
  initialGateways: SetupGateway[];
  initialCanComplete?: boolean;
  mode?: "organization" | "signup";
}) {
  const router = useRouter();
  const [readiness, setReadiness] = useState(initialReadiness);
  const [gateways, setGateways] = useState(initialGateways);
  const [canComplete, setCanComplete] = useState(initialCanComplete);
  const [completionState, setCompletionState] = useState<
    "idle" | "busy" | "failed"
  >("idle");
  const completionRequested = useRef(false);
  const [provider, setProvider] = useState<SetupProvider>(
    mode === "signup" ? "openai" : "lumi",
  );
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
            (mode !== "signup" ||
              (gateway.credentialStatus === "ready" &&
                Boolean(gateway.credentialValidatedAt))) &&
            (gateway.environmentId === null ||
              gateway.environmentId ===
                readiness.environmentExecution.environmentId)
        )
        .flatMap((gateway) =>
          gateway.models
            .filter((model) => model.modality === "language")
            .map((model) => ({ ...model, gatewayName: gateway.displayName }))
        ),
    [gateways, mode, readiness.environmentExecution.environmentId]
  );

  useEffect(() => {
    if (
      selectedModelId &&
      !languageModels.some((model) => model.id === selectedModelId)
    ) {
      setSelectedModelId("");
    }
  }, [languageModels, selectedModelId]);

  const applySignupPayload = useCallback(
    (payload: SignupOnboardingPayload) => {
      const nextReadiness = payload.onboarding?.readiness;
      if (!(nextReadiness && Array.isArray(payload.gateways))) {
        throw new Error("Personal workspace readiness is unavailable.");
      }
      setReadiness(nextReadiness);
      setGateways(payload.gateways);
      setCanComplete(Boolean(payload.canComplete));
      setFlySlug(
        (current) =>
          current || nextReadiness.workspaceCompute.organizationSlug || "",
      );
      if (payload.redirectTo) {
        window.location.assign(payload.redirectTo);
      }
      return nextReadiness;
    },
    [],
  );

  const requestSignupAction = useCallback(
    async (action: SignupOnboardingAction) => {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "Onboarding update failed.");
      }
      applySignupPayload(payload);
      return payload;
    },
    [applySignupPayload],
  );

  const refreshReadiness = useCallback(async () => {
    if (mode === "signup") {
      const response = await fetch("/api/onboarding", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "Personal workspace readiness is unavailable.");
      }
      return applySignupPayload(payload);
    }
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
  }, [applySignupPayload, mode, router]);

  const refreshGateways = useCallback(async () => {
    if (mode === "signup") {
      const response = await fetch("/api/onboarding", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(payload.error ?? "Model providers are unavailable.");
      }
      applySignupPayload(payload);
      return payload.gateways ?? [];
    }
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
        credentialStatus: item.gateway.credentialStatus,
        credentialValidatedAt: item.gateway.credentialValidatedAt,
        models: item.models,
      })
    );
    setGateways(next);
    return next;
  }, [applySignupPayload, mode]);

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
      if (mode === "signup") {
        await requestSignupAction({
          action: "connect-provider",
          provider,
          apiKey,
        });
        setApiKey("");
        toast.success("Provider connected and language models synced.");
        return;
      }
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
      if (mode === "signup") {
        await refreshReadiness().catch(() => {});
      }
    } finally {
      setProviderBusy(false);
    }
  }

  async function saveDefaultModel() {
    const model = languageModels.find((candidate) => candidate.id === selectedModelId);
    if (!model) return;
    setModelBusy(true);
    try {
      if (mode === "signup") {
        await requestSignupAction({
          action: "select-default-model",
          modelId: model.id,
        });
        toast.success("Default language model is ready.");
        return;
      }
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
    if (mode === "signup") {
      await requestSignupAction({ action: "retry-default-environment" });
      return;
    }
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
      if (mode === "signup") {
        const payload = await requestSignupAction({
          action: "configure-fly",
          organizationSlug: flySlug,
          apiToken: flyToken || null,
        });
        setFlyToken("");
        toast.success(
          payload.onboarding?.readiness?.environmentExecution.deploymentEnabled
            ? "Fly is verified and Environment recovery was requested."
            : "Fly is verified. Hosted Environments must be enabled for this deployment.",
        );
        return;
      }
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
      if (mode === "signup") {
        await requestEnvironmentRecovery();
        toast.success("Environment execution enabled and recovery requested.");
        return;
      }
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

  const completeSignup = useCallback(async () => {
    if (completionRequested.current) return;
    completionRequested.current = true;
    setCompletionState("busy");
    try {
      await requestSignupAction({ action: "complete" });
    } catch (error) {
      completionRequested.current = false;
      setCompletionState("failed");
      toast.error(
        error instanceof Error
          ? error.message
          : "Workspace completion could not be saved.",
      );
    }
  }, [requestSignupAction]);

  useEffect(() => {
    if (mode === "signup" && readiness.ready && canComplete) {
      void completeSignup();
    }
  }, [canComplete, completeSignup, mode, readiness.ready]);

  const signupLaunchActive =
    mode === "signup" &&
    readiness.modelAccess.ready &&
    readiness.workspaceCompute.ready;
  const signupEnvironmentExperience = getSignupEnvironmentExperience(
    readiness.environmentExecution.status,
  );
  const signupEnvironmentProgressing =
    signupLaunchActive && signupEnvironmentExperience.kind === "progress";

  if (readiness.ready && mode !== "signup") {
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
    <SettingsPage className={signupLaunchActive ? "space-y-0" : undefined}>
      <SettingsPageHeader
        description={
          signupEnvironmentProgressing
            ? "Your connections are ready. We’re creating the private Environment where Kestrel will work."
            : signupLaunchActive
              ? "Your connections are ready. Environment setup is paused, and your progress is saved."
            : mode === "signup"
            ? "Your progress is saved as each connection is verified."
            : "Complete these three checks to let your team start agent chats. You can leave and return at any time."
        }
        eyebrow={mode === "signup" ? "Kestrel One" : "Organization"}
        size={signupLaunchActive ? "large" : "default"}
        title={
          signupLaunchActive
            ? "Your workspace is taking shape"
            : mode === "signup"
              ? "Finish your workspace"
              : "Finish setup"
        }
      />

      <SettingsSection
        className={signupLaunchActive ? "mt-12" : undefined}
        description="Connect a provider, sync its catalog, then explicitly choose the default language model."
        title="1. Model access"
      >
        <SettingsRows>
          {signupLaunchActive ? (
            <SignupSuccessReceipt
              detail={`${readiness.modelAccess.gatewayName ?? "Model provider"} · ${readiness.modelAccess.modelName ?? "Default model"}`}
              status="Model connected"
            />
          ) : (
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
          )}
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
                      {SETUP_PROVIDERS.filter(
                        (option) => mode !== "signup" || option.key !== "lumi",
                      ).map((option) => (
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

      {mode !== "signup" || readiness.modelAccess.ready ? (
      <SettingsSection
        description="Fly provides the CPU workspace runtimes where agents execute and persistent workspaces live."
        title="2. Workspace compute"
      >
        <SettingsRows>
          {signupLaunchActive ? (
            <SignupSuccessReceipt
              detail="The saved organization and token passed Fly's read-only app-list check."
              status="Fly organization connected"
            />
          ) : (
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
          )}
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
                <p className="text-muted-foreground text-xs/5">
                  Create an organization-scoped token with{" "}
                  <code>
                    fly tokens create org --org &lt;slug&gt; --name &quot;Kestrel
                    One&quot; --expiry 8760h
                  </code>
                  .
                </p>
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
      ) : null}

      {mode !== "signup" || readiness.workspaceCompute.ready ? (
      <SettingsSection
        description={
          signupLaunchActive
            ? signupEnvironmentProgressing
              ? "The default Environment is provisioned automatically after Fly verification."
              : "Review the Environment status below to continue onboarding."
            : "The existing default Environment is provisioned automatically after Fly verification."
        }
        title={
          signupLaunchActive
            ? signupEnvironmentProgressing
              ? "3. Preparing your Environment"
              : "3. Environment setup"
            : "3. Environment execution"
        }
      >
        {signupLaunchActive ? (
          <SignupEnvironmentProgress
            completionFailed={completionState === "failed"}
            executionBusy={executionBusy}
            onFinish={() => void completeSignup()}
            onRetry={() => void retryExecution()}
            readiness={readiness.environmentExecution}
          />
        ) : (
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
                {readiness.environmentExecution.environmentId &&
                mode !== "signup" ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={`/organization/environments/${readiness.environmentExecution.environmentId}/activity`}
                    >
                      View Environment operations
                    </Link>
                  </Button>
                ) : null}
              </SettingsActionGroup>
            </SettingsRow>
          )}
        </SettingsRows>
        )}
      </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
