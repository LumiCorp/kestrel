import {
  CheckCircle2,
  Circle,
  CircleAlert,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { KESTREL_STANDARD_APP_MANIFESTS } from "@kestrel-agents/protocol";

import type {
  DesktopCapability,
  DesktopCapabilityCategory,
  DesktopCapabilityView,
  DesktopCapabilityId,
  DesktopModelProvider,
  DesktopRendererSettings,
  DesktopRendererSettingsUpdate,
  DesktopEnvironmentStatusProjection,
  DesktopUninstallApplyInput,
  KestrelUninstallApplyResultV1,
  KestrelUninstallPlanOptions,
  KestrelUninstallPlanV1,
  KestrelUninstallScope,
  KestrelOneAccountStatus,
  KestrelOneAuthorizationSessionView,
  KestrelOneThreadSnapshot,
} from "../../src/contracts";
import {
  appendDesktopModelConfigurationRevision,
  createDesktopModelConfiguration,
} from "../../../../src/desktopShell/configuration";
import { keepFocusInsideDialog } from "./dialogFocus";
import type { DesktopAppsNavigationTarget } from "./appsNavigation";

export const DEFAULT_KESTREL_ONE_BASE_URL = "https://kestrelagents.dev";

type SettingsPage = "general" | Exclude<DesktopCapabilityCategory, "tools_services">;

const CATEGORY_ORDER: Exclude<DesktopCapabilityCategory, "tools_services">[] = [
  "models",
  "local_capabilities",
  "connections",
  "workspace_data",
  "permissions",
];

const SETTINGS_PAGE_ORDER: SettingsPage[] = ["general", ...CATEGORY_ORDER];

const SETTINGS_PAGE_LABELS: Record<SettingsPage, string> = {
  general: "General",
  models: "Models",
  local_capabilities: "Local capabilities",
  connections: "Connections",
  workspace_data: "Workspace & data",
  permissions: "Permissions",
};

const SETTINGS_PAGE_DESCRIPTIONS: Record<SettingsPage, string> = {
  general: "Personalize Kestrel and finish anything that needs your attention.",
  models: "Providers and conversation model configurations.",
  local_capabilities: "Filesystem, developer shell, and sandboxed execution.",
  connections: "Kestrel One environments and connected Apps.",
  workspace_data: "Projects, runtime storage, privacy, and removal.",
  permissions: "Operating-system access used by Desktop features.",
};

interface SettingsWorkspaceProps {
  settings: DesktopRendererSettings;
  initialCapabilityId?: DesktopCapabilityId | undefined;
  onSettings: (
    update: DesktopRendererSettingsUpdate,
  ) => Promise<DesktopRendererSettings>;
  onCapabilitiesChange?: ((view: DesktopCapabilityView) => void) | undefined;
  onOpenApps: (target?: DesktopAppsNavigationTarget) => void;
  onAddProject: () => Promise<void>;
  onCreateUninstallPlan: (
    scope: KestrelUninstallScope,
    options?: KestrelUninstallPlanOptions | undefined,
  ) => Promise<KestrelUninstallPlanV1>;
  onApplyUninstallPlan: (
    input: DesktopUninstallApplyInput,
  ) => Promise<KestrelUninstallApplyResultV1>;
  onRequestMicrophone: () => Promise<void>;
  onError: (message: string | undefined) => void;
}

export function SettingsWorkspace({
  settings,
  initialCapabilityId,
  onSettings,
  onCapabilitiesChange,
  onOpenApps,
  onAddProject,
  onCreateUninstallPlan,
  onApplyUninstallPlan,
  onRequestMicrophone,
  onError,
}: SettingsWorkspaceProps) {
  const [view, setView] = useState<DesktopCapabilityView>();
  const [activePage, setActivePage] = useState<SettingsPage>(() =>
    settingsPageFromHash(window.location.hash),
  );
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DesktopCapability>();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmingCredentialRemoval, setConfirmingCredentialRemoval] =
    useState(false);
  const [openedTarget, setOpenedTarget] = useState<DesktopCapabilityId>();
  const [systemIsDark, setSystemIsDark] = useState(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const [selectedId, setSelectedId] = useState(
    settings.defaultModelConfigurationId,
  );
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [uninstallScope, setUninstallScope] =
    useState<KestrelUninstallScope>("current_component");
  const [uninstallDisconnectKestrelOne, setUninstallDisconnectKestrelOne] =
    useState(false);
  const [uninstallExportWorktreesDirectory, setUninstallExportWorktreesDirectory] =
    useState("");
  const [uninstallDiscardWorktrees, setUninstallDiscardWorktrees] =
    useState(false);
  const [uninstallDeleteDataPhrase, setUninstallDeleteDataPhrase] =
    useState("");
  const [uninstallDiscardPhrase, setUninstallDiscardPhrase] = useState("");
  const [uninstallPlan, setUninstallPlan] = useState<KestrelUninstallPlanV1>();
  const [uninstallResult, setUninstallResult] =
    useState<KestrelUninstallApplyResultV1>();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<DesktopModelProvider>("openrouter");
  const [model, setModel] = useState("");
  const [timeout, setTimeoutValue] = useState("");
  const [vision, setVision] = useState(false);
  const [stageOverrides, setStageOverrides] = useState("{}");
  const [apiKey, setApiKey] = useState("");
  const [catalog, setCatalog] = useState<string[]>([]);
  const [kestrelOne, setKestrelOne] =
    useState<DesktopEnvironmentStatusProjection>();
  const [kestrelOneAccount, setKestrelOneAccount] =
    useState<KestrelOneAccountStatus>();
  const [kestrelOneAuthorization, setKestrelOneAuthorization] =
    useState<KestrelOneAuthorizationSessionView>();
  const [kestrelOneThreadId, setKestrelOneThreadId] = useState("");
  const [kestrelOneThread, setKestrelOneThread] =
    useState<KestrelOneThreadSnapshot>();
  const [kestrelOneMessage, setKestrelOneMessage] = useState("");
  const [kestrelOneInteractionMode, setKestrelOneInteractionMode] = useState<
    "chat" | "plan" | "build"
  >("chat");
  const [kestrelOneModelId, setKestrelOneModelId] = useState("");
  const [kestrelOneUrl, setKestrelOneUrl] = useState(DEFAULT_KESTREL_ONE_BASE_URL);
  const [desktopName, setDesktopName] = useState("Kestrel Desktop");
  const [kestrelOneBusy, setKestrelOneBusy] = useState(false);
  const [desktopModelReadinessBusy, setDesktopModelReadinessBusy] =
    useState(false);
  const [desktopModelReadiness, setDesktopModelReadiness] = useState<
    DesktopEnvironmentStatusProjection["environments"][number]["models"][number]
  >();
  const dialogRef = useRef<HTMLFormElement>(null);
  const savingRef = useRef(false);
  const refreshVersionRef = useRef(0);
  const grouped = useMemo(
    () =>
      new Map(
        CATEGORY_ORDER.map((category) => [
          category,
          view?.capabilities.filter(
            (capability) => capability.category === category && capability.id !== "connections.mcp",
          ) ?? [],
        ]),
      ),
    [view],
  );
  const includedAppCount = settings.apps.filter(
    (app) => KESTREL_STANDARD_APP_MANIFESTS.find((manifest) => manifest.id === app.id)?.preinstalled === true,
  ).length;
  const connectedAppCount = settings.enabledConnectedAppIds.length;
  const attentionCapabilities = useMemo(
    () => getDesktopCapabilityAttentionQueue(view?.capabilities ?? []),
    [view],
  );
  const selected = useMemo(
    () => settings.modelConfigurations.find((entry) => entry.id === selectedId),
    [settings.modelConfigurations, selectedId],
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (query === undefined) return;
    const update = () => setSystemIsDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    void refresh();
    void refreshKestrelOne();
    void refreshKestrelOneAccount();
    void window.kestrelDesktop
      .getPendingUninstallResult()
      .then((result) => {
        if (result !== undefined) {
          setUninstallResult(result);
          setNotice(
            `A previous Desktop uninstall completed with ${result.status} status.`,
          );
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (window.location.hash === "#settings-tools_services") {
      onOpenApps();
      return;
    }
    const syncPageFromHash = () => {
      if (window.location.hash === "#settings-tools_services") {
        onOpenApps();
        return;
      }
      setActivePage(settingsPageFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", syncPageFromHash);
    return () => window.removeEventListener("hashchange", syncPageFromHash);
  }, []);

  useEffect(() => {
    if (!kestrelOne?.enrollments.length) return;
    const timer = window.setInterval(() => {
      void refreshKestrelOne(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [kestrelOne?.enrollments.length]);

  useEffect(() => {
    if (!kestrelOne?.environments.length) return;
    const timer = window.setInterval(() => {
      void window.kestrelDesktop
        .getKestrelOneEnvironments()
        .then(setKestrelOne)
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [kestrelOne?.environments.length]);

  useEffect(() => {
    if (!kestrelOneThreadId) {
      setKestrelOneThread(undefined);
      return;
    }
    let disposed = false;
    const refreshThread = () => {
      void window.kestrelDesktop
        .getKestrelOneThread(kestrelOneThreadId)
        .then((thread) => {
          if (!disposed) setKestrelOneThread(thread);
        })
        .catch((error) => {
          if (!disposed) onError(errorMessage(error));
        });
    };
    refreshThread();
    const timer = window.setInterval(refreshThread, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [kestrelOneThreadId]);

  useEffect(() => {
    if (kestrelOneAuthorization?.state !== "awaiting_user") return;
    const timer = window.setInterval(() => {
      void window.kestrelDesktop
        .getKestrelOneAuthorizationStatus(kestrelOneAuthorization.sessionId)
        .then((session) => {
          setKestrelOneAuthorization(session);
          if (session.state === "complete") {
            void refreshKestrelOneAccount();
          }
        })
        .catch((error) => onError(errorMessage(error)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [kestrelOneAuthorization?.sessionId, kestrelOneAuthorization?.state]);

  useEffect(() => {
    const revision = selected?.revisions.find(
      (entry) => entry.revision === selected.currentRevision,
    );
    setName(selected?.name ?? "");
    setProvider(revision?.policy.provider ?? "openrouter");
    setModel(revision?.policy.model ?? "");
    setTimeoutValue(revision?.policy.modelTimeoutMs?.toString() ?? "");
    setVision(revision?.policy.modelCapabilities.visionInputEnabled ?? false);
    setStageOverrides(
      JSON.stringify(revision?.policy.modelByStage ?? {}, null, 2),
    );
  }, [selected]);

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop
      .getModelCatalog({ provider })
      .then((result) => {
        if (!disposed) setCatalog(result.models);
      })
      .catch(() => {
        if (!disposed) setCatalog([]);
      });
    return () => {
      disposed = true;
    };
  }, [provider]);

  useEffect(() => {
    if (
      initialCapabilityId === undefined ||
      initialCapabilityId === openedTarget ||
      view === undefined
    )
      return;
    const target = view.capabilities.find(
      (capability) => capability.id === initialCapabilityId,
    );
    if (target !== undefined) {
      if (target.category === "tools_services" || target.id === "connections.mcp") {
        onOpenApps({ kind: "capability", capabilityId: target.id });
      } else {
        navigateToSettingsPage(target.category);
        if (isConfigurable(target)) openEditor(target);
      }
    }
    setOpenedTarget(initialCapabilityId);
  }, [initialCapabilityId, openedTarget, view]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    if (editing === undefined) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && savingRef.current === false) closeEditor();
      keepFocusInsideDialog(event, dialogRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [editing?.id]);

  async function refresh(): Promise<void> {
    const refreshVersion = ++refreshVersionRef.current;
    setLoading(true);
    onError(undefined);
    try {
      const nextView = await window.kestrelDesktop.getCapabilities();
      if (refreshVersion !== refreshVersionRef.current) return;
      setView(nextView);
      onCapabilitiesChange?.(nextView);
    } catch (error) {
      if (refreshVersion !== refreshVersionRef.current) return;
      onError(errorMessage(error));
    } finally {
      if (refreshVersion === refreshVersionRef.current) setLoading(false);
    }
  }

  function commitCapabilityView(nextView: DesktopCapabilityView): void {
    // An apply result is newer than any readiness request already in flight.
    // Ignore a late probe response rather than repainting the previous state.
    refreshVersionRef.current += 1;
    setView(nextView);
    onCapabilitiesChange?.(nextView);
  }

  async function refreshKestrelOne(poll = false): Promise<void> {
    if (!poll) setKestrelOneBusy(true);
    try {
      const next = poll
        ? await window.kestrelDesktop.refreshKestrelOneEnrollments()
        : await window.kestrelDesktop.getKestrelOneEnvironments();
      setKestrelOne(next);
    } catch (error) {
      if (!poll) onError(errorMessage(error));
    } finally {
      if (!poll) setKestrelOneBusy(false);
    }
  }

  async function refreshDesktopModelReadiness(): Promise<void> {
    setDesktopModelReadinessBusy(true);
    onError(undefined);
    try {
      const readiness = await window.kestrelDesktop.refreshDesktopModelReadiness();
      setDesktopModelReadiness(readiness);
      setNotice(
        readiness.reachability === "reachable"
          ? `Model readiness refreshed: ${readiness.qualification}.`
          : `Model readiness refreshed: ${readiness.reachability}.`,
      );
      await refreshKestrelOne();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDesktopModelReadinessBusy(false);
    }
  }

  async function refreshKestrelOneAccount(): Promise<void> {
    try {
      setKestrelOneAccount(await window.kestrelDesktop.getKestrelOneAccount());
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  async function signInToKestrelOne(): Promise<void> {
    setKestrelOneBusy(true);
    onError(undefined);
    try {
      const session = await window.kestrelDesktop.startKestrelOneAuthorization({
        baseUrl: kestrelOneUrl,
      });
      setKestrelOneAuthorization(session);
      setNotice("Finish signing in through your system browser.");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setKestrelOneBusy(false);
    }
  }

  async function submitKestrelOneTurn(event: FormEvent): Promise<void> {
    event.preventDefault();
    setKestrelOneBusy(true);
    onError(undefined);
    try {
      const turn = await window.kestrelDesktop.submitKestrelOneTurn({
        threadId: kestrelOneThreadId,
        text: kestrelOneMessage,
        interactionMode: kestrelOneInteractionMode,
        ...(kestrelOneModelId ? { model: kestrelOneModelId } : {}),
      });
      setKestrelOneMessage("");
      setNotice(
        `Turn ${turn.sequence} is ${turn.status}. It will run in the Thread's bound Environment.`,
      );
      await Promise.all([
        refreshKestrelOneAccount(),
        window.kestrelDesktop
          .getKestrelOneThread(kestrelOneThreadId)
          .then(setKestrelOneThread),
      ]);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setKestrelOneBusy(false);
    }
  }

  async function enrollDesktopEnvironment(event: FormEvent): Promise<void> {
    event.preventDefault();
    setKestrelOneBusy(true);
    onError(undefined);
    try {
      const next = await window.kestrelDesktop.startKestrelOneEnrollment({
        baseUrl: kestrelOneUrl,
        desktopName,
      });
      setKestrelOne(next);
      const enrollment = next.enrollments.at(-1);
      if (enrollment) {
        await window.kestrelDesktop.openExternal(enrollment.verificationUrl);
        setNotice(
          "Finish the one-time organization approval in your browser. Desktop will connect automatically.",
        );
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setKestrelOneBusy(false);
    }
  }

  async function runAction(
    action: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (action === undefined) return;
    setNotice(undefined);
    onError(undefined);
    try {
      await action();
      await refresh();
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  function actionFor(
    capability: DesktopCapability,
  ): (() => void | Promise<void>) | undefined {
    if (capability.id === "connections.mcp") {
      return () => onOpenApps({ kind: "capability", capabilityId: capability.id });
    }
    if (isConfigurable(capability)) return () => openEditor(capability);
    if (capability.id === "data.workspace") return onAddProject;
    if (capability.id === "permission.microphone") return onRequestMicrophone;
    return;
  }

  function attentionActionFor(
    capability: DesktopCapability,
  ): (() => void | Promise<void>) | undefined {
    if (capability.category === "tools_services") {
      return () => onOpenApps({ kind: "capability", capabilityId: capability.id });
    }
    return actionFor(capability);
  }

  function navigateToSettingsPage(page: SettingsPage): void {
    setActivePage(page);
    const nextHash = `#settings-${page}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".settings-surface")?.scrollTo({
        top: 0,
      });
    });
  }

  function openEditor(capability: DesktopCapability): void {
    setEditing(capability);
    setCredential("");
    setEditorError(undefined);
    setConfirmingCredentialRemoval(false);
    setDraft({
      ...Object.fromEntries(
        capability.settings
          .filter((field) => field.secret === false)
          .map((field) => [field.key, field.value ?? ""]),
      ),
      enabled: capability.enabled,
    });
  }

  function closeEditor(): void {
    setEditing(undefined);
    setCredential("");
    setEditorError(undefined);
    setConfirmingCredentialRemoval(false);
  }

  async function saveConfiguration(): Promise<void> {
    if (editing === undefined) return;
    setSaving(true);
    setEditorError(undefined);
    onError(undefined);
    try {
      const settings = Object.fromEntries(
        editing.settings
          .filter((field) => field.secret === false)
          .map((field) => {
            const value = draft[field.key];
            return [
              field.key,
              typeof value === "string" && value.trim().length === 0
                ? null
                : (value ?? null),
            ];
          }),
      );
      const result = await window.kestrelDesktop.configureCapability({
        capabilityId: editing.id,
        ...(supportsEnablement(editing)
          ? { enabled: draft.enabled === true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(credential.trim().length > 0
          ? { credential: credential.trim() }
          : {}),
      });
      commitCapabilityView(result.view);
      setNotice(
        `${editing.name} was verified and applied${result.runtimeRestarted ? "; the runtime restarted with the new configuration" : ""}.`,
      );
      closeEditor();
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeCredential(): Promise<void> {
    if (editing === undefined) return;
    setSaving(true);
    setEditorError(undefined);
    try {
      const capabilityName = editing.name;
      const result = await window.kestrelDesktop.configureCapability({
        capabilityId: editing.id,
        credential: null,
      });
      commitCapabilityView(result.view);
      setNotice(`${capabilityName} credential removed.`);
      closeEditor();
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveModel(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim().length === 0 || model.trim().length === 0) {
      onError("A name and model ID are required.");
      return;
    }
    setSaving(true);
    onError(undefined);
    try {
      const parsedStageOverrides = JSON.parse(stageOverrides) as unknown;
      if (
        typeof parsedStageOverrides !== "object" ||
        parsedStageOverrides === null ||
        Array.isArray(parsedStageOverrides)
      ) {
        throw new Error("Stage overrides must be a JSON object.");
      }
      if (apiKey.trim().length > 0) {
        const result = await window.kestrelDesktop.configureCapability({
          capabilityId: `model.${provider}`,
          enabled: true,
          settings: { model: model.trim() },
          credential: apiKey.trim(),
        });
        setView(result.view);
        onCapabilitiesChange?.(result.view);
        setApiKey("");
      }
      const base =
        selected ??
        createDesktopModelConfiguration(
          {
            version: 1,
            provider,
            model: model.trim(),
            modelByStage: {},
            modelCapabilities: { visionInputEnabled: vision },
          },
          {
            id: crypto.randomUUID(),
            name: name.trim(),
            createdAt: new Date().toISOString(),
          },
        );
      const current = base.revisions.find(
        (entry) => entry.revision === base.currentRevision,
      )!.policy;
      const { modelTimeoutMs: _currentTimeout, ...currentWithoutTimeout } =
        current;
      const nextPolicy = {
        ...currentWithoutTimeout,
        provider,
        model: model.trim(),
        modelByStage: parsedStageOverrides as Record<string, string>,
        ...(timeout.trim().length > 0
          ? { modelTimeoutMs: Number(timeout) }
          : {}),
        modelCapabilities: { visionInputEnabled: vision },
      };
      const next =
        selected === undefined
          ? {
              ...base,
              name: name.trim(),
              revisions: [{ ...base.revisions[0]!, policy: nextPolicy }],
            }
          : {
              ...appendDesktopModelConfigurationRevision(base, nextPolicy),
              name: name.trim(),
            };
      await onSettings({
        modelConfigurations:
          selected === undefined
            ? [...settings.modelConfigurations, next]
            : settings.modelConfigurations.map((entry) =>
                entry.id === next.id ? next : entry,
              ),
      });
      setSelectedId(next.id);
      setNotice(`${next.name} configuration saved.`);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function createUninstallPlan(
    scope: KestrelUninstallScope,
  ): Promise<void> {
    setUninstallBusy(true);
    setNotice(undefined);
    setUninstallResult(undefined);
    try {
      const options: KestrelUninstallPlanOptions = {
        disconnectKestrelOne: uninstallDisconnectKestrelOne,
        exportWorktreesDirectory: uninstallExportWorktreesDirectory.trim(),
        discardWorktrees: uninstallDiscardWorktrees,
      };
      const plan = await onCreateUninstallPlan(scope, options);
      setUninstallPlan(plan);
      setNotice(`Uninstall plan ${plan.planId} created.`);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setUninstallBusy(false);
    }
  }

  async function applyUninstallPlan(): Promise<void> {
    if (uninstallPlan === undefined) return;
    setUninstallBusy(true);
    setNotice(undefined);
    setUninstallResult(undefined);
    try {
      const result = await onApplyUninstallPlan({
        plan: uninstallPlan,
        confirmPlanId: uninstallPlan.planId,
        ...(uninstallDeleteDataPhrase.length > 0
          ? { deleteDataPhrase: uninstallDeleteDataPhrase }
          : {}),
        ...(uninstallDiscardPhrase.length > 0
          ? { discardWorktreesPhrase: uninstallDiscardPhrase }
          : {}),
      });
      setUninstallResult(result);
      setNotice(`Uninstall apply ${result.status}.`);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setUninstallBusy(false);
    }
  }

  const uninstallConfirmationsSatisfied =
    desktopUninstallConfirmationsSatisfied(
      uninstallPlan,
      uninstallDeleteDataPhrase,
      uninstallDiscardPhrase,
    );

  return (
    <main className="surface-pane settings-surface" id="app-main">
      <header className="surface-header">
        <div>
          <h1>Settings</h1>
          <p>{SETTINGS_PAGE_DESCRIPTIONS[activePage]}</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw
            size={15}
            className={loading ? "spin" : undefined}
            aria-hidden="true"
          />
          {loading ? "Checking…" : "Refresh status"}
        </button>
      </header>

      <nav
        className="settings-category-nav"
        aria-label="Settings categories"
      >
        {SETTINGS_PAGE_ORDER.map((page) => (
          <a
            aria-current={activePage === page ? "page" : undefined}
            className={activePage === page ? "active" : undefined}
            href={`#settings-${page}`}
            key={page}
            onClick={(event) => {
              event.preventDefault();
              navigateToSettingsPage(page);
            }}
          >
            {SETTINGS_PAGE_LABELS[page]}
          </a>
        ))}
      </nav>

      {view !== undefined ? (
        <>
          {view.credentialStore.available ? null : (
            <div className="settings-authority-note" role="status">
              <CircleAlert size={17} aria-hidden="true" />
              <span>
                Secure credential storage is unavailable on this system.
              </span>
            </div>
          )}
          {activePage === "general" && attentionCapabilities.length > 0 ? (
            <section
              className="capability-attention-queue"
              aria-labelledby="capability-attention-title"
            >
              <div className="capability-attention-heading">
                <div>
                  <h2 id="capability-attention-title">Needs attention</h2>
                  <p>
                    {attentionCapabilities.length}{" "}
                    {attentionCapabilities.length === 1
                      ? "item needs"
                      : "items need"}{" "}
                    your attention.
                  </p>
                </div>
                <p>
                  Last checked {new Date(view.refreshedAt).toLocaleString()}.
                </p>
              </div>
              <div className="capability-attention-list">
                {attentionCapabilities.map((capability) => {
                  const action = attentionActionFor(capability);
                  const CapabilityIcon = readinessIcon(capability.readiness);
                  return (
                    <article
                      className="capability-attention-item"
                      data-readiness={capability.readiness}
                      key={capability.id}
                    >
                      <div>
                        <div className="capability-attention-title">
                          <CapabilityIcon size={16} aria-hidden="true" />
                          <h3>{capability.name}</h3>
                          <span
                            className={`capability-readiness readiness-${capability.readiness}`}
                          >
                            {readinessLabel(capability.readiness)}
                          </span>
                        </div>
                        <p>{capability.detail}</p>
                      </div>
                      {action !== undefined ? (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void runAction(action)}
                        >
                          {actionLabel(capability)}
                        </button>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {notice !== undefined ? (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      {activePage === "workspace_data" ? (
        <section
          className="settings-section"
          aria-labelledby="data-privacy-title"
        >
        <div className="settings-section-heading">
          <div>
            <h2 id="data-privacy-title">Data & Privacy</h2>
            <p>
              Plan removal of this Desktop, all Kestrel software, or all
              verified local data.
            </p>
          </div>
        </div>
        <div className="settings-content settings-card">
          <div className="settings-form">
            <label>
              Removal scope
              <select
                value={uninstallScope}
                disabled={uninstallBusy}
                onChange={(event) =>
                  setUninstallScope(event.currentTarget.value as KestrelUninstallScope)}
              >
                <option value="current_component">Current Desktop</option>
                <option value="all_software">All software</option>
                <option value="complete">Complete removal</option>
              </select>
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={uninstallDisconnectKestrelOne}
                disabled={uninstallBusy}
                onChange={(event) =>
                  setUninstallDisconnectKestrelOne(event.currentTarget.checked)}
              />
              Disconnect local Kestrel One enrollments before removing credentials
            </label>
            <label>
              Worktree recovery export directory
              <input
                type="text"
                value={uninstallExportWorktreesDirectory}
                disabled={uninstallBusy || uninstallDiscardWorktrees}
                placeholder="/Users/me/Desktop/kestrel-worktree-recovery"
                onChange={(event) =>
                  setUninstallExportWorktreesDirectory(event.currentTarget.value)}
              />
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={uninstallDiscardWorktrees}
                disabled={uninstallBusy}
                onChange={(event) =>
                  setUninstallDiscardWorktrees(event.currentTarget.checked)}
              />
              Discard retained managed worktrees instead of exporting them
            </label>
          </div>
          <div className="settings-inline-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={uninstallBusy}
              onClick={() => void createUninstallPlan(uninstallScope)}
            >
              Create plan
            </button>
          </div>
          {uninstallPlan !== undefined ? (
            <div className="settings-form">
              <strong>Plan {uninstallPlan.planId}</strong>
              <p>
                {
                  uninstallPlan.targets.filter((target) => target.selected)
                    .length
                }{" "}
                selected · {uninstallPlan.blockers.length} blocker
                {uninstallPlan.blockers.length === 1 ? "" : "s"}
              </p>
              <p>
                Managed worktrees: {uninstallPlan.worktrees.cleanDisposable} clean,{" "}
                {uninstallPlan.worktrees.retained} retained,{" "}
                {uninstallPlan.worktrees.blocked} blocked ·{" "}
                {uninstallPlan.worktrees.totalBytes.toLocaleString()} bytes
              </p>
              <ul>
                {uninstallPlan.targets
                  .filter((target) => target.selected)
                  .map((target) => (
                    <li key={target.id}>
                      {target.kind}: {target.path ?? target.id}
                    </li>
                  ))}
              </ul>
              {uninstallPlan.blockers.length > 0 ? (
                <ul>
                  {uninstallPlan.blockers.map((blocker) => (
                    <li key={`${blocker.code}-${blocker.targetId ?? "global"}`}>
                      {blocker.code}: {blocker.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              {uninstallPlan.confirmations.some((entry) => entry.kind === "delete_data") ? (
                <label>
                  Complete removal confirmation
                  <input
                    type="text"
                    value={uninstallDeleteDataPhrase}
                    disabled={uninstallBusy}
                    placeholder="DELETE KESTREL DATA"
                    onChange={(event) =>
                      setUninstallDeleteDataPhrase(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              {uninstallPlan.confirmations.some((entry) => entry.kind === "discard_worktrees") ? (
                <label>
                  Worktree discard confirmation
                  <input
                    type="text"
                    value={uninstallDiscardPhrase}
                    disabled={uninstallBusy}
                    placeholder={
                      uninstallPlan.confirmations.find((entry) => entry.kind === "discard_worktrees")
                        ?.phrase ?? "DISCARD 0 KESTREL WORKTREES"
                    }
                    onChange={(event) =>
                      setUninstallDiscardPhrase(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              <div className="settings-inline-actions">
                <button
                  className="secondary-button danger"
                  type="button"
                  disabled={
                    uninstallBusy ||
                    uninstallPlan.blockers.length > 0 ||
                    uninstallConfirmationsSatisfied === false
                  }
                  onClick={() => void applyUninstallPlan()}
                >
                  {uninstallBusy ? "Applying..." : "Apply uninstall"}
                </button>
              </div>
              {uninstallResult !== undefined ? (
                <div>
                  <strong>Apply result: {uninstallResult.status}</strong>
                  <p>
                    {uninstallResult.removedTargets.length} removed ·{" "}
                    {uninstallResult.skippedTargets.length} skipped ·{" "}
                    {uninstallResult.blockers.length} issue
                    {uninstallResult.blockers.length === 1 ? "" : "s"}
                  </p>
                  {uninstallResult.blockers.length > 0 ? (
                    <ul>
                      {uninstallResult.blockers.map((blocker) => (
                        <li key={`result-${blocker.code}-${blocker.targetId ?? "global"}`}>
                          {blocker.code}: {blocker.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {uninstallResult.kestrelOneDisconnects.length > 0 ? (
                    <ul>
                      {uninstallResult.kestrelOneDisconnects.map((outcome) => (
                        <li key={`disconnect-${outcome.connectionId}`}>
                          {outcome.connectionId} ({outcome.baseUrl || "unknown URL"}):{" "}
                          {outcome.status}
                          {outcome.message ? ` — ${outcome.message}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {uninstallResult.deferredCompletions.length > 0 ? (
                    <ul>
                      {uninstallResult.deferredCompletions.map((completion) => (
                        <li key={`${completion.executor}-${completion.reportPath}`}>
                          {completion.executor}: {completion.state}; report{" "}
                          {completion.reportPath}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        </section>
      ) : null}

      {activePage === "connections" ? (
        <section
          className="settings-section"
          aria-labelledby="kestrel-one-environments-title"
        >
        <div className="settings-section-heading">
          <div>
            <h2 id="kestrel-one-environments-title">
              Kestrel One Environments
            </h2>
            <p>
              Enroll this Desktop once per organization. Project members can
              then run work here without per-task approval.
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={kestrelOneBusy}
            onClick={() => void refreshKestrelOne()}
          >
            <RefreshCw
              size={15}
              className={kestrelOneBusy ? "spin" : undefined}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>
        <div className="settings-content settings-card">
          {kestrelOneAccount?.status === "signed_in" ? (
            <div className="settings-form">
              <strong>{kestrelOneAccount.projection.account.name}</strong>
              <p>{kestrelOneAccount.projection.account.email}</p>
              <small>
                {kestrelOneAccount.projection.organizations.length} organization
                {kestrelOneAccount.projection.organizations.length === 1
                  ? ""
                  : "s"}{" "}
                · {kestrelOneAccount.projection.projects.length} Project
                {kestrelOneAccount.projection.projects.length === 1
                  ? ""
                  : "s"}{" "}
                · {kestrelOneAccount.projection.threads.length} Thread
                {kestrelOneAccount.projection.threads.length === 1 ? "" : "s"}
              </small>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  void window.kestrelDesktop
                    .signOutKestrelOneAccount()
                    .then(setKestrelOneAccount)
                    .catch((error) => onError(errorMessage(error)))
                }
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="settings-form">
              <strong>Kestrel One account</strong>
              <p>
                Sign in to see your organizations, Projects, and canonical
                Threads in Desktop.
              </p>
              <button
                className="primary-button"
                type="button"
                disabled={
                  kestrelOneBusy || view?.credentialStore.available === false
                }
                onClick={() => void signInToKestrelOne()}
              >
                Sign in with Kestrel One
              </button>
              {view?.credentialStore.available === false ? (
                <small>
                  Secure credential storage is required before signing in.
                </small>
              ) : null}
              {kestrelOneAuthorization?.state === "awaiting_user" ? (
                <small>Waiting for browser sign-in…</small>
              ) : null}
            </div>
          )}
          {kestrelOneAccount?.status === "signed_in" ? (
            <div className="settings-form">
              <strong>Accessible Projects</strong>
              {kestrelOneAccount.projection.projects.length === 0 ? (
                <p>No Projects have been shared with this account.</p>
              ) : (
                kestrelOneAccount.projection.projects.map((project) => (
                  <div className="capability-detail" key={project.id}>
                    <strong>{project.name}</strong>
                    <small>
                      {project.role} ·{" "}
                      {project.environmentProvider === "desktop"
                        ? "Desktop Environment"
                        : "Fly.io Environment"}
                    </small>
                  </div>
                ))
              )}
            </div>
          ) : null}
          {kestrelOneAccount?.status === "signed_in" &&
          kestrelOneAccount.projection.threads.length > 0 ? (
            <form
              className="settings-form"
              onSubmit={(event) => void submitKestrelOneTurn(event)}
            >
              <strong>Continue a Kestrel One Thread</strong>
              <label>
                Thread
                <select
                  required
                  value={kestrelOneThreadId}
                  onChange={(event) => {
                    setKestrelOneThreadId(event.target.value);
                    setKestrelOneThread(undefined);
                    setKestrelOneModelId("");
                  }}
                >
                  <option value="">Choose a Thread</option>
                  {kestrelOneAccount.projection.threads.map((thread) => (
                    <option value={thread.id} key={thread.id}>
                      {thread.title || "Untitled Thread"}
                    </option>
                  ))}
                </select>
              </label>
              {kestrelOneThread ? (
                <div className="settings-form">
                  <div className="capability-detail">
                    <strong>{kestrelOneThread.thread.title}</strong>
                    <small>
                      Queue: {kestrelOneThread.queue.state}
                      {kestrelOneThread.queue.queuedTurnIds.length > 0
                        ? ` · ${kestrelOneThread.queue.queuedTurnIds.length} queued`
                        : ""}
                    </small>
                  </div>
                  {kestrelOneThread.messages.slice(-20).map((message) => {
                    const turn = kestrelOneThread.turns.find(
                      (candidate) => candidate.id === message.turnId,
                    );
                    return (
                      <article
                        className="capability-card"
                        data-readiness={
                          turn?.status === "failed" ? "setup_required" : "ready"
                        }
                        key={message.id}
                      >
                        <div className="capability-card-main">
                          <div className="capability-title-row">
                            <div>
                              <h3>
                                {message.role === "user"
                                  ? "You"
                                  : message.role === "assistant"
                                    ? "Kestrel"
                                    : "System"}
                              </h3>
                              {turn ? (
                                <p>
                                  Turn {turn.sequence} · {turn.status} ·{" "}
                                  {turn.stage.replaceAll("_", " ")}
                                </p>
                              ) : null}
                            </div>
                          </div>
                          {message.parts.map((part, index) => (
                            <div
                              className="capability-detail"
                              key={`${message.id}:${part.kind}:${index}`}
                            >
                              {part.kind === "text" ? null : (
                                <small>{part.label}</small>
                              )}
                              <p>{part.text}</p>
                            </div>
                          ))}
                          {turn?.failure ? (
                            <p className="capability-detail">
                              {turn.failure.message}
                            </p>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : null}
              <label>
                Mode
                <select
                  value={kestrelOneInteractionMode}
                  onChange={(event) =>
                    setKestrelOneInteractionMode(
                      event.target.value as "chat" | "plan" | "build",
                    )
                  }
                >
                  <option value="chat">Chat</option>
                  <option value="plan">Plan</option>
                  <option value="build">Build</option>
                </select>
              </label>
              {(() => {
                const thread = kestrelOneAccount.projection.threads.find(
                  (candidate) => candidate.id === kestrelOneThreadId,
                );
                const project = kestrelOneAccount.projection.projects.find(
                  (candidate) => candidate.id === thread?.projectId,
                );
                const environment = kestrelOne?.environments.find(
                  (candidate) =>
                    candidate.environmentId === project?.environmentId,
                );
                const localModels =
                  environment?.models.filter(
                    (candidate) =>
                      candidate.eligibleRoles.includes("agent.loop"),
                  ) ?? [];
                return localModels.length > 0 ? (
                  <label>
                    Model
                    <select
                      value={kestrelOneModelId}
                      onChange={(event) =>
                        setKestrelOneModelId(event.target.value)
                      }
                    >
                      <option value="">Kestrel One default</option>
                      {localModels.map((candidate) => {
                        const provider = candidate.registration.providerId;
                        const model = candidate.registration.modelId;
                        const id = `desktop-local:${provider}:${encodeURIComponent(model)}`;
                        return (
                          <option value={id} key={id}>
                            This Desktop · {provider}/{model}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ) : null;
              })()}
              <label>
                Message
                <textarea
                  required
                  value={kestrelOneMessage}
                  onChange={(event) => setKestrelOneMessage(event.target.value)}
                  placeholder="Message this canonical Thread"
                />
              </label>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  kestrelOneBusy ||
                  !kestrelOneThreadId ||
                  !kestrelOneMessage.trim()
                }
              >
                Send to Thread
              </button>
            </form>
          ) : null}
        </div>
        <div className="settings-content settings-card">
          <form
            className="settings-form"
            onSubmit={(event) => void enrollDesktopEnvironment(event)}
          >
            <strong>Enroll this Desktop</strong>
            <label>
              Kestrel One URL
              <input
                type="url"
                required
                value={kestrelOneUrl}
                onChange={(event) => setKestrelOneUrl(event.target.value)}
              />
            </label>
            <label>
              Desktop name
              <input
                required
                value={desktopName}
                onChange={(event) => setDesktopName(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={kestrelOneBusy}
            >
              {kestrelOneBusy ? "Connecting…" : "Enroll in organization"}
            </button>
          </form>
          <div className="settings-form">
            <strong>Remote-task capacity</strong>
            <p>
              One machine-wide limit shared fairly across all enrolled
              organizations.
            </p>
            <label>
              Concurrent tasks
              <input
                type="number"
                min={1}
                max={16}
                value={kestrelOne?.globalCapacity ?? 1}
                onChange={(event) => {
                  const capacity = Number(event.target.value);
                  if (
                    Number.isInteger(capacity) &&
                    capacity >= 1 &&
                    capacity <= 16
                  ) {
                    void window.kestrelDesktop
                      .setKestrelOneCapacity(capacity)
                      .then(setKestrelOne)
                      .catch((error) => onError(errorMessage(error)));
                  }
                }}
              />
            </label>
            <small>
              {kestrelOne?.activeRuns ?? 0} active remote task
              {(kestrelOne?.activeRuns ?? 0) === 1 ? "" : "s"}
            </small>
          </div>
          <div className="settings-form">
            <strong>Model readiness</strong>
            {(() => {
              const readiness =
                desktopModelReadiness ?? kestrelOne?.environments[0]?.models[0];
              return readiness === undefined ? (
                <p>
                  Refresh the exact configured model before making it available
                  for remote tasks.
                </p>
              ) : (
                <>
                  <p>
                    {readiness.registration.providerId}/
                    {readiness.registration.modelId} · Reachability: {readiness.reachability} · Qualification: {readiness.qualification}
                  </p>
                  {readiness.eligibleRoles.length > 0 ? (
                    <small>
                      Eligible roles: {readiness.eligibleRoles.join(", ")}
                    </small>
                  ) : (
                    <small>
                      {readiness.unavailableRoles[0]?.reason ??
                        "No runtime role is currently qualified."}
                    </small>
                  )}
                </>
              );
            })()}
            <button
              className="secondary-button"
              type="button"
              disabled={desktopModelReadinessBusy}
              onClick={() => void refreshDesktopModelReadiness()}
            >
              {desktopModelReadinessBusy
                ? "Refreshing model…"
                : "Refresh model readiness"}
            </button>
          </div>
        </div>
        {kestrelOne?.activity.length ? (
          <div className="capability-card-list">
            {kestrelOne.activity.map((activity) => (
              <article
                className="capability-card"
                data-readiness="ready"
                key={activity.commandId}
              >
                <div className="capability-card-main">
                  <div className="capability-title-row">
                    <RefreshCw size={17} aria-hidden="true" />
                    <div>
                      <h3>
                        {activity.projectName} · {activity.threadTitle}
                      </h3>
                      <p>
                        {activity.organizationName} · requested by{" "}
                        {activity.requestingUserName}
                      </p>
                    </div>
                  </div>
                  <p className="capability-detail">
                    Queue: {activity.queueState} · Run: {activity.runState}
                  </p>
                </div>
                <div className="capability-card-actions">
                  <span className="capability-readiness readiness-ready">
                    {activity.runState === "running" ? "Running" : "Starting"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : null}
        {kestrelOne?.enrollments.map((enrollment) => (
          <article
            className="capability-card"
            data-readiness="setup_required"
            key={enrollment.requestId}
          >
            <div className="capability-card-main">
              <div className="capability-title-row">
                <CircleAlert size={17} aria-hidden="true" />
                <div>
                  <h3>{enrollment.desktopName}</h3>
                  <p>Waiting for organization approval in Kestrel One.</p>
                </div>
              </div>
              <p className="capability-detail">
                Pairing fingerprint: <code>{enrollment.fingerprint}</code>
              </p>
            </div>
            <div className="capability-card-actions">
              <span className="capability-readiness readiness-setup_required">
                Approval pending
              </span>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  void window.kestrelDesktop.openExternal(
                    enrollment.verificationUrl,
                  )
                }
              >
                Continue in browser
              </button>
            </div>
          </article>
        ))}
        <div className="capability-card-list">
          {kestrelOne?.environments.map((environment) => (
            <article
              className="capability-card"
              data-readiness={
                environment.connectionStatus === "online" ? "ready" : "inactive"
              }
              key={environment.connectionId}
            >
              <div className="capability-card-main">
                <div className="capability-title-row">
                  {environment.connectionStatus === "online" ? (
                    <CheckCircle2 size={17} aria-hidden="true" />
                  ) : (
                    <Circle size={17} aria-hidden="true" />
                  )}
                  <div>
                    <h3>{environment.desktopName}</h3>
                    <p>
                      Organization {environment.organizationId.slice(0, 8)} ·{" "}
                      {environment.workspaces.length} synced project
                      {environment.workspaces.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <p className="capability-detail">
                  {environment.connectionStatus === "online"
                    ? `${environment.activeRuns} active task${environment.activeRuns === 1 ? "" : "s"}`
                    : (environment.lastError ??
                      "Offline. New tasks remain queued until this Desktop reconnects.")}
                </p>
              </div>
              <div className="capability-card-actions">
                <span
                  className={`capability-readiness readiness-${environment.connectionStatus === "online" ? "ready" : "inactive"}`}
                >
                  {environment.connectionStatus === "online"
                    ? "Online"
                    : "Offline"}
                </span>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    void window.kestrelDesktop
                      .disconnectKestrelOneEnvironment(environment.connectionId)
                      .then(setKestrelOne)
                      .catch((error) => onError(errorMessage(error)))
                  }
                >
                  Disconnect
                </button>
              </div>
            </article>
          ))}
        </div>
        </section>
      ) : null}

      {activePage === "general" ? null : (
        <div className="settings-sections" aria-busy={loading}>
          {(() => {
            const category = activePage;
            const capabilities = grouped.get(category) ?? [];
            return (
              <section
                className="settings-section"
                aria-labelledby={`settings-${category}-title`}
                id={`settings-${category}`}
              >
              <div className="settings-section-heading">
                <h2 id={`settings-${category}-title`}>
                    {SETTINGS_PAGE_LABELS[category]}
                </h2>
                <span>
                  {capabilities.length}{" "}
                  {capabilities.length === 1 ? "capability" : "capabilities"}
                </span>
              </div>
              <div className="capability-card-list">
                {capabilities.map((capability) => {
                  const action = actionFor(capability);
                  const CapabilityIcon = readinessIcon(capability.readiness);
                  return (
                    <article
                      className="capability-card"
                      data-readiness={capability.readiness}
                      key={capability.id}
                    >
                      <div className="capability-card-main">
                        <div className="capability-title-row">
                          <CapabilityIcon size={17} aria-hidden="true" />
                          <div>
                            <h3>{capability.name}</h3>
                            <p>{capability.description}</p>
                          </div>
                        </div>
                        <p className="capability-detail">{capability.detail}</p>
                        {capability.lastVerifiedAt !== undefined ? (
                          <p className="capability-verification-time">
                            Last verified{" "}
                            {new Date(
                              capability.lastVerifiedAt,
                            ).toLocaleString()}
                          </p>
                        ) : null}
                        {capability.toolNames.length > 0 ? (
                          <p className="capability-tools">
                            <strong>
                              {capability.toolNames.length} tool
                              {capability.toolNames.length === 1 ? "" : "s"}
                            </strong>
                            <span title={capability.toolNames.join(", ")}>
                              {summarizeTools(capability.toolNames)}
                            </span>
                          </p>
                        ) : null}
                      </div>
                      <div className="capability-card-actions">
                        <span
                          className={`capability-readiness readiness-${capability.readiness}`}
                        >
                          {readinessLabel(capability.readiness)}
                        </span>
                        {action !== undefined ? (
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void runAction(action)}
                          >
                            {actionLabel(capability)}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
              </section>
            );
          })()}
        </div>
      )}

      {activePage === "models" ? (
        <section
          className="settings-section"
          aria-labelledby="model-configurations-title"
        >
        <div className="settings-section-heading">
          <div>
            <h2 id="model-configurations-title">
              Conversation model configurations
            </h2>
            <p>
              Named, revisioned model choices available in the conversation
              composer.
            </p>
          </div>
        </div>
        <div className="settings-content model-settings-grid">
          <div className="settings-list">
            {settings.modelConfigurations.map((configuration) => (
              <button
                key={configuration.id}
                type="button"
                className={selectedId === configuration.id ? "active" : ""}
                onClick={() => setSelectedId(configuration.id)}
              >
                <strong>{configuration.name}</strong>
                <small>
                  {
                    configuration.revisions.find(
                      (entry) =>
                        entry.revision === configuration.currentRevision,
                    )?.policy.model
                  }
                </small>
                {configuration.id === settings.defaultModelConfigurationId ? (
                  <span>Default</span>
                ) : null}
              </button>
            ))}
            <button
              type="button"
              className={selected === undefined ? "active" : ""}
              onClick={() => {
                setSelectedId("");
                setName("New model");
                setProvider("openrouter");
                setModel("");
                setTimeoutValue("");
                setVision(false);
                setStageOverrides("{}");
              }}
            >
              + Add model
            </button>
          </div>
          <form
            className="settings-form"
            onSubmit={(event) => void saveModel(event)}
          >
            <label>
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Provider
              <select
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as DesktopModelProvider)
                }
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
              </select>
            </label>
            <label>
              Model ID
              <input
                list="model-catalog"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <datalist id="model-catalog">
              {catalog.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
            {provider === "openrouter" ||
            provider === "openai" ||
            provider === "anthropic" ? (
              <label>
                Provider API key
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder="Leave blank to keep the stored key"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            ) : null}
            <details>
              <summary>Advanced policy</summary>
              <label>
                Timeout (ms)
                <input
                  inputMode="numeric"
                  value={timeout}
                  onChange={(event) =>
                    setTimeoutValue(event.target.value.replace(/\D/g, ""))
                  }
                />
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={vision}
                  onChange={(event) => setVision(event.target.checked)}
                />
                Enable vision input
              </label>
              <label>
                Stage overrides (JSON)
                <textarea
                  rows={5}
                  value={stageOverrides}
                  onChange={(event) => setStageOverrides(event.target.value)}
                />
              </label>
            </details>
            <div className="settings-form-actions">
              {selected !== undefined &&
              selected.id !== settings.defaultModelConfigurationId ? (
                <button
                  type="button"
                  onClick={() =>
                    void onSettings({
                      defaultModelConfigurationId: selected.id,
                    })
                  }
                >
                  Make default
                </button>
              ) : null}
              {selected !== undefined &&
              selected.id !== settings.defaultModelConfigurationId ? (
                <button
                  type="button"
                  onClick={() =>
                    void onSettings({
                      modelConfigurations: settings.modelConfigurations.map(
                        (entry) =>
                          entry.id === selected.id
                            ? { ...entry, archivedAt: new Date().toISOString() }
                            : entry,
                      ),
                    })
                  }
                >
                  Archive
                </button>
              ) : null}
              <button
                className="primary-button"
                type="submit"
                disabled={saving}
              >
                {saving ? "Saving…" : "Save model"}
              </button>
            </div>
          </form>
        </div>
        </section>
      ) : null}

      {activePage === "general" ? (
        <section
          className="settings-section"
          aria-labelledby="desktop-preferences-title"
        >
        <div className="settings-section-heading">
          <h2 id="desktop-preferences-title">Desktop preferences</h2>
        </div>
        <div className="settings-content settings-card">
          <fieldset className="appearance-options">
            <legend>Appearance</legend>
            <p className="settings-preference-description">
              Choose the appearance that feels most comfortable.
            </p>
            <div className="settings-theme-options">
              {(["system", "light", "dark"] as const).map((theme) => (
                <label key={theme}>
                  <input
                    type="radio"
                    name="theme"
                    checked={settings.appearanceTheme === theme}
                    onChange={() => void onSettings({ appearanceTheme: theme })}
                  />
                  {theme[0]!.toUpperCase() + theme.slice(1)}
                </label>
              ))}
            </div>
            {settings.appearanceTheme === "system" ? (
              <p className="compact-note">
                Follows macOS — currently {systemIsDark ? "Dark" : "Light"}.
              </p>
            ) : null}
          </fieldset>
          <div className="settings-form settings-apps-summary">
            <div>
              <strong>Apps</strong>
              <p className="settings-preference-description">
                Manage the tools and services available to Kestrel.
              </p>
              <p className="compact-note">
                {includedAppCount} included · {connectedAppCount} connected
              </p>
            </div>
            <button className="secondary-button" type="button" onClick={() => onOpenApps()}>
              Manage Apps
            </button>
          </div>
        </div>
        </section>
      ) : null}

      {editing !== undefined ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && saving === false)
              closeEditor();
          }}
        >
          <form
            className="provider-dialog capability-dialog"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="capability-dialog-title"
            aria-describedby="capability-dialog-description"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void saveConfiguration();
            }}
          >
            <div className="provider-dialog-header">
              <div>
                <span className="surface-kicker">
                  {editing.category === "tools_services" ? "Apps" : SETTINGS_PAGE_LABELS[editing.category]}
                </span>
                <h2 id="capability-dialog-title">{editing.name}</h2>
                <p id="capability-dialog-description">
                  {editing.verificationStrategy}
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close capability settings"
                disabled={saving}
                onClick={closeEditor}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            {supportsEnablement(editing) ? (
              <label className="capability-toggle-field">
                <input
                  data-autofocus
                  type="checkbox"
                  checked={draft.enabled === true}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>
                  {editing.category === "models"
                    ? "Use as active model provider"
                    : "Enable this capability pack"}
                </span>
              </label>
            ) : null}
            {editing.settings.map((field, index) => {
              const credentialStored =
                field.secret &&
                editing.requirements.some(
                  (requirement) =>
                    requirement.kind === "credential" && requirement.satisfied,
                );
              const controlId = `capability-setting-${field.key}`;
              return (
                <label
                  className="provider-dialog-field"
                  htmlFor={controlId}
                  key={field.key}
                >
                  <span>
                    {field.label}
                    {field.required && credentialStored === false ? " *" : ""}
                    {credentialStored ? <small>Stored securely</small> : null}
                  </span>
                  {field.kind === "select" ? (
                    <select
                      id={controlId}
                      data-autofocus={
                        supportsEnablement(editing) === false && index === 0
                          ? true
                          : undefined
                      }
                      value={String(draft[field.key] ?? field.value ?? "")}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    >
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={controlId}
                      data-autofocus={
                        supportsEnablement(editing) === false && index === 0
                          ? true
                          : undefined
                      }
                      type={
                        field.secret
                          ? "password"
                          : field.kind === "url"
                            ? "url"
                            : "text"
                      }
                      value={
                        field.secret
                          ? credential
                          : String(draft[field.key] ?? "")
                      }
                      placeholder={
                        field.secret
                          ? credentialStored
                            ? "Enter a new value to replace"
                            : "Enter credential"
                          : field.placeholder
                      }
                      autoComplete="off"
                      required={field.required && credentialStored === false}
                      onChange={(event) =>
                        field.secret
                          ? setCredential(event.target.value)
                          : setDraft((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                      }
                    />
                  )}
                </label>
              );
            })}
            <p className="provider-dialog-note">{editing.runtimeApplication}</p>
            {editorError !== undefined ? (
              <p className="provider-dialog-error" role="alert">
                {editorError}
              </p>
            ) : null}
            <div className="provider-dialog-actions provider-dialog-actions-split">
              {editing.requirements.some(
                (requirement) =>
                  requirement.kind === "credential" && requirement.satisfied,
              ) ? (
                confirmingCredentialRemoval ? (
                  <div className="destructive-confirmation">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={saving}
                      onClick={() => setConfirmingCredentialRemoval(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="provider-dialog-remove"
                      type="button"
                      disabled={saving}
                      onClick={() => void removeCredential()}
                    >
                      Confirm removal
                    </button>
                  </div>
                ) : (
                  <button
                    className="provider-dialog-remove"
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirmingCredentialRemoval(true)}
                  >
                    Remove credential
                  </button>
                )
              ) : (
                <span />
              )}
              <button
                className="provider-dialog-save"
                type="submit"
                disabled={saving}
              >
                {saving ? "Verifying…" : "Verify and apply"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function supportsEnablement(capability: DesktopCapability): boolean {
  return (
    capability.category === "models" ||
    capability.id === "tools.network.free" ||
    capability.id === "local.filesystem" ||
    capability.id === "local.developer_shell" ||
    capability.id === "local.sandbox_code"
  );
}

function settingsPageFromHash(hash: string): SettingsPage {
  const candidate = hash.startsWith("#settings-")
    ? hash.slice("#settings-".length)
    : "";
  return SETTINGS_PAGE_ORDER.includes(candidate as SettingsPage)
    ? (candidate as SettingsPage)
    : "general";
}

function isConfigurable(capability: DesktopCapability): boolean {
  return capability.settings.length > 0 || supportsEnablement(capability);
}

function readinessLabel(readiness: DesktopCapability["readiness"]): string {
  if (readiness === "setup_required") return "Setup required";
  if (readiness === "verification_failed") return "Verification failed";
  return readiness.charAt(0).toUpperCase() + readiness.slice(1);
}

function readinessIcon(
  readiness: DesktopCapability["readiness"],
): typeof CheckCircle2 {
  if (readiness === "ready") return CheckCircle2;
  if (
    readiness === "setup_required" ||
    readiness === "verification_failed" ||
    readiness === "unavailable"
  )
    return CircleAlert;
  return Circle;
}

function actionLabel(capability: DesktopCapability): string {
  if (capability.id === "connections.mcp") return "Manage Apps";
  if (capability.id === "data.workspace") return "Add project";
  if (capability.id === "permission.microphone") return "Request access";
  if (
    capability.readiness === "setup_required" ||
    capability.readiness === "verification_failed"
  )
    return "Set up";
  return "Configure";
}

export function getDesktopCapabilityAttentionQueue(
  capabilities: DesktopCapability[],
): DesktopCapability[] {
  return capabilities.filter(
    (capability) =>
      capability.readiness === "setup_required" ||
      capability.readiness === "verification_failed" ||
      capability.readiness === "unavailable",
  );
}

export function desktopUninstallConfirmationsSatisfied(
  plan: KestrelUninstallPlanV1 | undefined,
  deleteDataPhrase: string,
  discardWorktreesPhrase: string,
): boolean {
  return plan !== undefined
    && plan.confirmations.every((confirmation) => {
      if (confirmation.kind === "plan_id") return true;
      if (confirmation.kind === "delete_data") {
        return deleteDataPhrase === confirmation.phrase;
      }
      return discardWorktreesPhrase === confirmation.phrase;
    });
}

function summarizeTools(toolNames: string[]): string {
  const visible = toolNames.slice(0, 4);
  return toolNames.length > visible.length
    ? `${visible.join(", ")} +${toolNames.length - visible.length} more`
    : visible.join(", ");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
