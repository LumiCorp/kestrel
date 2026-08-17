import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Folder,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import type {
  DesktopLaunchState,
  DesktopModelProvider,
  DesktopOnboardingProjectCandidate,
  DesktopOnboardingStateV1,
  DesktopOnboardingStep,
  DesktopProviderModelCatalog,
} from "../../src/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "../../../../src/profile/modelDefaults";
import { DEFAULT_OLLAMA_BASE_URL } from "../../../../models/ollama/OllamaEnv";
import { DEFAULT_LMSTUDIO_BASE_URL } from "../../../../models/lmstudio/LmStudioEnv";

const kestrelLogoUrl = new URL(
  "../../static/kestrel-full-horz-dark-mode.png",
  import.meta.url,
).href;

const KEYCHAIN_RECOVERY_MESSAGE =
  "Kestrel can’t write to the macOS Keychain from this launch. If the login keychain is locked, unlock it and retry. If Kestrel was opened by a test or automation tool, quit it and open the app from Finder.";

const DesktopApp = lazy(async () => {
  const module = await import("./DesktopApp");
  return { default: module.DesktopApp };
});

const PROVIDERS: Array<{
  id: DesktopModelProvider;
  label: string;
  description: string;
  group: "hosted" | "local";
  keyUrl?: string;
}> = [
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "One key for models from multiple providers.",
    group: "hosted",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Use models available to your OpenAI project.",
    group: "hosted",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Connect directly to the Anthropic API.",
    group: "hosted",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "ollama",
    label: "Ollama",
    description: "Use models served by Ollama on this Mac.",
    group: "local",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    description: "Use the LM Studio local model server.",
    group: "local",
  },
];

export function LaunchRoot(): React.JSX.Element {
  const [launch, setLaunch] = useState<DesktopLaunchState>();
  const [onboarding, setOnboarding] = useState<DesktopOnboardingStateV1>();
  const [stepOverride, setStepOverride] = useState<DesktopOnboardingStep>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void window.kestrelDesktop.getLaunchState().then((state) => {
      if (!disposed) setLaunch(state);
    }).catch((cause) => {
      if (!disposed) {
        setLaunch({
          phase: "failed",
          message: "Kestrel could not read its launch state.",
          details: errorMessage(cause),
        });
      }
    });
    const unsubscribe = window.kestrelDesktop.onLaunchState((state) => {
      setLaunch(state);
      if (state.phase === "setup_required") {
        void window.kestrelDesktop.getOnboardingState().then((next) => {
          setOnboarding(next);
          setStepOverride(undefined);
          setError(state.details);
        }).catch((cause) => setError(errorMessage(cause)));
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (launch?.phase !== "setup_required") return;
    let disposed = false;
    void window.kestrelDesktop.getOnboardingState().then((state) => {
      if (!disposed) setOnboarding(state);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, [launch?.phase]);

  useEffect(() => {
    if (launch?.phase === "ready") return;
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }, [launch?.phase]);

  if (launch?.phase === "ready") {
    return (
      <Suspense fallback={<LaunchProgress state={{ phase: "starting_execution", message: "Opening your workspace…" }} />}>
        <DesktopApp onboardingHandoff={launch.onboardingHandoff} />
      </Suspense>
    );
  }
  if (launch?.phase === "failed") {
    return <LaunchRecovery state={launch} />;
  }
  if (
    launch === undefined ||
    launch.phase === "foundation_starting" ||
    launch.phase === "starting_execution"
  ) {
    return <LaunchProgress state={launch} />;
  }
  if (onboarding === undefined) {
    return <LaunchProgress state={{ phase: "foundation_starting", message: "Loading setup…" }} />;
  }

  const step = stepOverride ?? onboarding.step;
  return (
    <OnboardingShell
      state={onboarding}
      step={step}
      error={error}
      onState={(state) => {
        setOnboarding(state);
        setStepOverride(undefined);
        setError(undefined);
      }}
      onStep={(next) => {
        setStepOverride(next);
        setError(undefined);
      }}
      onError={setError}
    />
  );
}

function LaunchProgress({ state }: { state?: DesktopLaunchState | undefined }): React.JSX.Element {
  const startingExecution = state?.phase === "starting_execution";
  return (
    <main className="launch-root launch-progress" aria-live="polite">
      <KestrelMark />
      <LoaderCircle className="launch-spinner" aria-hidden="true" />
      <div>
        <h1>{startingExecution ? "Opening Kestrel" : "Preparing Kestrel"}</h1>
        <p>{state?.message ?? "Starting the local workspace…"}</p>
      </div>
    </main>
  );
}

function LaunchRecovery({ state }: { state: DesktopLaunchState }): React.JSX.Element {
  const [recovering, setRecovering] = useState(false);
  const [forceAvailable, setForceAvailable] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  const restart = async (force: boolean) => {
    setRecovering(true);
    setRecoveryError(undefined);
    try {
      const result = await window.kestrelDesktop.restartKestrel({ force });
      if (result.status === "blocked") {
        setForceAvailable(result.forceAvailable);
        setRecoveryError(result.blockers.map((blocker) => blocker.message).join("\n"));
      }
    } catch (cause) {
      setRecoveryError(errorMessage(cause));
    } finally {
      setRecovering(false);
    }
  };
  return (
    <main className="launch-root launch-recovery">
      <div className="launch-recovery-icon"><CircleAlert aria-hidden="true" /></div>
      <p className="launch-eyebrow">Startup needs attention</p>
      <h1>{state.message}</h1>
      {state.details !== undefined ? <p className="launch-error-detail">{state.details}</p> : null}
      {recoveryError !== undefined ? <p className="launch-error-detail">{recoveryError}</p> : null}
      {state.code !== undefined ? <code>{state.code}</code> : null}
      <div className="launch-actions">
        <button className="onboarding-primary" type="button" disabled={recovering} onClick={() => void restart(false)}>
          <RotateCcw size={15} aria-hidden="true" /> {recovering ? "Checking Kestrel…" : "Restart Kestrel"}
        </button>
        {forceAvailable ? (
          <button type="button" disabled={recovering} onClick={() => void restart(true)}>Force recovery</button>
        ) : null}
        <button type="button" onClick={() => void window.kestrelDesktop.openDiagnostics()}>Open Diagnostics</button>
      </div>
    </main>
  );
}

function OnboardingShell(props: {
  state: DesktopOnboardingStateV1;
  step: DesktopOnboardingStep;
  error?: string | undefined;
  onState(state: DesktopOnboardingStateV1): void;
  onStep(step: DesktopOnboardingStep): void;
  onError(error: string | undefined): void;
}): React.JSX.Element {
  return (
    <main className="onboarding-root">
      <header className="onboarding-header">
        <KestrelMark />
        <StepIndicator step={props.step} />
      </header>
      <section className="onboarding-stage">
        {props.step === "welcome" ? (
          <WelcomeStep mode={props.state.mode} onContinue={() => props.onStep("provider")} />
        ) : props.step === "provider" ? (
          <ProviderStep {...props} />
        ) : props.step === "project" ? (
          <ProjectStep {...props} />
        ) : (
          <ReviewStep {...props} />
        )}
      </section>
    </main>
  );
}

function WelcomeStep(props: {
  mode: DesktopOnboardingStateV1["mode"];
  onContinue(): void;
}): React.JSX.Element {
  const returning = props.mode === "resume";
  return (
    <div className="onboarding-panel onboarding-welcome">
      <p className="launch-eyebrow">{returning ? "Welcome back" : "Welcome to Kestrel"}</p>
      <h1>{returning ? "Let’s confirm your setup." : "Your work, with an agent beside you."}</h1>
      <p className="onboarding-lede">
        {returning
          ? "Kestrel found an existing model or project. We’ll keep it and only ask for what is missing."
          : "Connect a model. Choose a project. Takes about two minutes."}
      </p>
      <div className="welcome-points" aria-label="Setup steps">
        <span><KeyRound size={17} aria-hidden="true" /> Connect a model</span>
        <span><Folder size={17} aria-hidden="true" /> Choose a project</span>
        <span><ShieldCheck size={17} aria-hidden="true" /> Stored locally and securely</span>
      </div>
      <button className="onboarding-primary" type="button" onClick={props.onContinue} autoFocus>
        Get started <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function ProviderStep(props: Parameters<typeof OnboardingShell>[0]): React.JSX.Element {
  const [provider, setProvider] = useState<DesktopModelProvider>(props.state.provider ?? "openrouter");
  const [models, setModels] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<DesktopProviderModelCatalog>();
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [model, setModel] = useState(props.state.model ?? "");
  const [credential, setCredential] = useState("");
  const initialBaseUrl = localProviderBaseUrl(
    props.state.provider ?? "openrouter",
    props.state.baseUrl,
  );
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [catalogBaseUrl, setCatalogBaseUrl] = useState(initialBaseUrl);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const providerInfo = PROVIDERS.find((entry) => entry.id === provider)!;
  const hosted = providerInfo.group === "hosted";

  useEffect(() => {
    if (
      props.state.provider !== provider ||
      (provider !== "ollama" && provider !== "lmstudio")
    ) {
      return;
    }
    const nextBaseUrl = localProviderBaseUrl(provider, props.state.baseUrl);
    setBaseUrl(nextBaseUrl);
    setCatalogBaseUrl(nextBaseUrl);
  }, [provider, props.state.baseUrl, props.state.provider]);

  useEffect(() => {
    let disposed = false;
    setLoadingCatalog(true);
    setModels([]);
    setCatalog(undefined);
    void window.kestrelDesktop.getModelCatalog({
      provider,
      ...(!hosted && catalogBaseUrl.length > 0
        ? { baseUrl: catalogBaseUrl }
        : {}),
    }).then((catalog) => {
      if (disposed) return;
      setCatalog(catalog);
      const available = [...new Set(catalog.models)];
      setModels(available);
      const persisted = props.state.provider === provider ? props.state.model : undefined;
      const explicitDefault = DEFAULT_MODEL_BY_PROVIDER[provider];
      setModel((current) =>
        available.includes(current)
          ? current
          : persisted !== undefined && available.includes(persisted)
            ? persisted
            : catalog.source === "live" && available.includes(explicitDefault)
              ? explicitDefault
              : "",
      );
    }).catch((cause) => props.onError(errorMessage(cause))).finally(() => {
      if (!disposed) setLoadingCatalog(false);
    });
    return () => { disposed = true; };
  }, [provider, catalogRefresh, catalogBaseUrl, hosted]);

  async function selectProvider(next: DesktopModelProvider): Promise<void> {
    setProvider(next);
    setCredential("");
    setModel("");
    const nextBaseUrl = localProviderBaseUrl(
      next,
      props.state.provider === next ? props.state.baseUrl : undefined,
    );
    setBaseUrl(nextBaseUrl);
    setCatalogBaseUrl(nextBaseUrl);
    props.onError(undefined);
    try {
      props.onState(await window.kestrelDesktop.saveOnboardingDraft({ provider: next }));
      props.onStep("provider");
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  }

  async function verify(): Promise<void> {
    if (model.length === 0) return;
    setVerifying(true);
    props.onError(undefined);
    try {
      const result = await window.kestrelDesktop.verifyOnboardingProvider({
        provider,
        model,
        ...(!hosted ? { baseUrl } : {}),
        ...(hosted && credential.length > 0 ? { credential } : {}),
      });
      if (result.ok === false) {
        props.onError(result.failure.message);
        return;
      }
      props.onState(result.state);
      setCredential("");
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="onboarding-panel onboarding-wide">
      <button className="onboarding-back" type="button" onClick={() => props.onStep("welcome")}>
        <ArrowLeft size={14} aria-hidden="true" /> Back
      </button>
      <div className="onboarding-title-row">
        <div><p className="launch-eyebrow">Step 1 of 2</p><h1>Connect a model</h1></div>
        {props.state.providerVerified ? <span className="verified-pill"><Check size={13} /> Verified</span> : null}
      </div>
      <p className="onboarding-lede">Kestrel verifies access and model availability. It won’t send a prompt or create a paid model turn.</p>

      <div className="provider-groups">
        <div className="provider-grid" aria-label="Hosted providers">
          {PROVIDERS.filter((entry) => entry.group === "hosted").map((entry) => (
            <button key={entry.id} className={`provider-card ${provider === entry.id ? "selected" : ""}`} type="button" onClick={() => void selectProvider(entry.id)} aria-pressed={provider === entry.id}>
              <span className="provider-card-heading">{entry.label}{entry.id === "openrouter" ? <small>Recommended</small> : null}</span>
              <span>{entry.description}</span>
            </button>
          ))}
        </div>
        <p className="provider-group-label">Run locally</p>
        <div className="provider-grid provider-grid-local" aria-label="Local providers">
          {PROVIDERS.filter((entry) => entry.group === "local").map((entry) => (
            <button key={entry.id} className={`provider-card ${provider === entry.id ? "selected" : ""}`} type="button" onClick={() => void selectProvider(entry.id)} aria-pressed={provider === entry.id}>
              <span className="provider-card-heading">{entry.label}</span><span>{entry.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="provider-form">
        {!hosted ? (
          <div className="field-row">
            <div className="field-label-row">
              <label htmlFor="onboarding-endpoint">Endpoint URL</label>
              <button
                className="text-button"
                type="button"
                disabled={loadingCatalog || baseUrl.trim().length === 0}
                onClick={() => {
                  setCatalogBaseUrl(baseUrl.trim());
                  setCatalogRefresh((value) => value + 1);
                }}
              >
                Check endpoint
              </button>
            </div>
            <input
              id="onboarding-endpoint"
              type="url"
              spellCheck={false}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={provider === "ollama" ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL}
            />
          </div>
        ) : null}
        <div className="field-row">
          <label htmlFor="onboarding-model">Model</label>
          <select id="onboarding-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={loadingCatalog}>
            <option value="">{loadingCatalog ? "Finding available models…" : "Choose a model"}</option>
            {models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </div>
        {hosted ? (
          <div className="field-row">
            <div className="field-label-row">
              <label htmlFor="onboarding-key">API key</label>
              <button className="text-button" type="button" onClick={() => void window.kestrelDesktop.openExternal(providerInfo.keyUrl!)}>
                Get an API key <ExternalLink size={12} />
              </button>
            </div>
            <input id="onboarding-key" type="password" autoComplete="off" spellCheck={false} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={props.state.credentialConfigured ? "Stored securely — re-enter only to change or reverify" : `Enter your ${providerInfo.label} API key`} />
          </div>
        ) : (
          <div className={`local-provider-note ${catalog?.source === "live" ? "endpoint-ready" : "endpoint-unavailable"}`}>
            <span>
              {loadingCatalog
                ? "Checking the local endpoint…"
                : catalog?.source === "live"
                  ? `Endpoint reachable · ${catalog.models.length} loaded ${catalog.models.length === 1 ? "model" : "models"} found.`
                  : catalog?.note ?? "The local endpoint is not reachable. Start the server, then retry."}
            </span>
            {!loadingCatalog && catalog?.source !== "live" ? (
              <button className="text-button" type="button" onClick={() => {
                setCatalogBaseUrl(baseUrl.trim());
                setCatalogRefresh((value) => value + 1);
              }}>
                Check again
              </button>
            ) : null}
          </div>
        )}
      </div>
      {props.error !== undefined ? <InlineError message={props.error} /> : null}
      {props.error === undefined && !props.state.secureStorageAvailable && hosted
        ? <InlineError message={KEYCHAIN_RECOVERY_MESSAGE} />
        : null}
      <div className="onboarding-footer">
        <span className="privacy-note"><ShieldCheck size={14} /> {hosted ? "API keys stay in the macOS Keychain." : "The endpoint is stored only in local settings."}</span>
        <button className="onboarding-primary" type="button" disabled={model.length === 0 || verifying || (!hosted && baseUrl.trim().length === 0)} onClick={() => void verify()}>
          {verifying ? <><LoaderCircle className="button-spinner" size={15} /> Verifying…</> : <>Verify connection <ChevronRight size={16} /></>}
        </button>
      </div>
    </div>
  );
}

function localProviderBaseUrl(
  provider: DesktopModelProvider,
  configured?: string | undefined,
): string {
  if (provider === "ollama") return configured ?? DEFAULT_OLLAMA_BASE_URL;
  if (provider === "lmstudio") return configured ?? DEFAULT_LMSTUDIO_BASE_URL;
  return "";
}

function ProjectStep(props: Parameters<typeof OnboardingShell>[0]): React.JSX.Element {
  const [candidate, setCandidate] = useState<DesktopOnboardingProjectCandidate>();
  const [confirmGit, setConfirmGit] = useState(false);
  const [working, setWorking] = useState(false);

  async function inspect(projectPath?: string): Promise<void> {
    props.onError(undefined);
    try {
      const next = projectPath === undefined
        ? await window.kestrelDesktop.pickOnboardingProject()
        : await window.kestrelDesktop.inspectOnboardingProject(projectPath);
      if (next !== undefined) {
        setCandidate(next);
        setConfirmGit(false);
      }
    } catch (cause) {
      props.onError(errorMessage(cause));
    }
  }

  async function confirm(): Promise<void> {
    if (candidate === undefined) return;
    setWorking(true);
    props.onError(undefined);
    try {
      props.onState(await window.kestrelDesktop.confirmOnboardingProject({
        selectionId: candidate.selectionId,
        allowGitBootstrap: candidate.requiresGitBootstrap && confirmGit,
      }));
    } catch (cause) {
      props.onError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="onboarding-panel">
      <button className="onboarding-back" type="button" onClick={() => props.onStep("provider")}><ArrowLeft size={14} /> Back</button>
      <p className="launch-eyebrow">Step 2 of 2</p>
      <h1>Choose a project</h1>
      <p className="onboarding-lede">Kestrel works inside one real folder. Nothing is moved or uploaded.</p>
      {props.state.projects.length > 0 ? (
        <div className="existing-projects">
          <p className="provider-group-label">Already in Kestrel</p>
          {props.state.projects.map((project) => (
            <button key={project.path} type="button" disabled={!project.available} onClick={() => void inspect(project.path)}>
              <Folder size={16} /><span><strong>{project.label}</strong><small>{project.available ? project.path : "Folder unavailable"}</small></span><ChevronRight size={15} />
            </button>
          ))}
        </div>
      ) : null}
      <button className="folder-picker" type="button" onClick={() => void inspect()}>
        <Folder size={20} /><span><strong>Choose or create a folder</strong><small>Opens the macOS folder picker</small></span><ChevronRight size={16} />
      </button>
      {candidate !== undefined ? (
        <div className="project-confirmation">
          <div><span className="project-icon"><Folder size={18} /></span><span><strong>{candidate.label}</strong><small>{candidate.path}</small></span></div>
          {candidate.requiresGitBootstrap ? (
            <label className="git-disclosure">
              <input type="checkbox" checked={confirmGit} onChange={(event) => setConfirmGit(event.target.checked)} />
              <span><strong>Create an initial Git commit</strong><small>This folder has no commit yet. Kestrel will initialize Git if needed and create one empty commit.</small></span>
            </label>
          ) : (
            <p className="project-safe-note"><Check size={14} /> Kestrel will register this folder without changing its contents.</p>
          )}
          <button className="onboarding-primary" type="button" disabled={working || (candidate.requiresGitBootstrap && !confirmGit)} onClick={() => void confirm()}>
            {working ? "Adding project…" : "Use this project"} <ChevronRight size={16} />
          </button>
        </div>
      ) : null}
      {props.error !== undefined ? <InlineError message={props.error} /> : null}
    </div>
  );
}

function ReviewStep(props: Parameters<typeof OnboardingShell>[0]): React.JSX.Element {
  const [opening, setOpening] = useState(false);
  const provider = PROVIDERS.find((entry) => entry.id === props.state.provider);
  const project = props.state.projects.find((entry) => entry.path === props.state.projectPath);

  async function complete(): Promise<void> {
    setOpening(true);
    props.onError(undefined);
    try {
      await window.kestrelDesktop.completeOnboarding();
    } catch (cause) {
      props.onError(errorMessage(cause));
      setOpening(false);
    }
  }

  return (
    <div className="onboarding-panel onboarding-review">
      <button className="onboarding-back" type="button" onClick={() => props.onStep("project")}><ArrowLeft size={14} /> Back</button>
      <p className="launch-eyebrow">Ready to open</p>
      <h1>Your Kestrel workspace</h1>
      <p className="onboarding-lede">Everything required is connected. You can change providers and add tools later in Settings.</p>
      <div className="review-list">
        <button type="button" onClick={() => props.onStep("provider")}><span><KeyRound size={17} /></span><span><small>Model</small><strong>{provider?.label} · {props.state.model}</strong></span><Check size={16} /></button>
        <button type="button" onClick={() => props.onStep("project")}><span><Folder size={17} /></span><span><small>Project</small><strong>{project?.label}</strong><em>{project?.path}</em></span><Check size={16} /></button>
      </div>
      {props.error !== undefined ? <InlineError message={props.error} /> : null}
      <div className="launch-actions">
        <button className="onboarding-primary onboarding-open" type="button" disabled={!props.state.canComplete || opening} onClick={() => void complete()} autoFocus>
          {opening
            ? <><LoaderCircle className="button-spinner" size={15} /> Starting Kestrel…</>
            : <>{props.error !== undefined ? "Retry" : "Open Kestrel"} <ChevronRight size={16} /></>}
        </button>
        {props.error !== undefined ? (
          <button type="button" onClick={() => void window.kestrelDesktop.openDiagnostics()}>
            Open Diagnostics
          </button>
        ) : null}
      </div>
      <p className="review-note">Opens an empty conversation. No model request is sent.</p>
    </div>
  );
}

function StepIndicator({ step }: { step: DesktopOnboardingStep }): React.JSX.Element {
  if (step === "welcome") return <span className="step-label">First-time setup</span>;
  const active = step === "provider" ? 1 : step === "project" ? 2 : 3;
  return (
    <div className="step-indicator" aria-label={`Setup progress, step ${active} of 3`}>
      {[1, 2, 3].map((item) => <span key={item} className={item <= active ? "active" : ""} />)}
    </div>
  );
}

function KestrelMark(): React.JSX.Element {
  return <div className="kestrel-mark"><img src={kestrelLogoUrl} alt="Kestrel" /></div>;
}

function InlineError({ message }: { message: string }): React.JSX.Element {
  return <div className="onboarding-error" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>{message}</span></div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
