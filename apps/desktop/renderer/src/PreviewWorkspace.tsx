import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Square,
  TerminalSquare,
} from "lucide-react";
import React, {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
  DesktopProjectLauncherDescriptor,
} from "../../src/contracts";
import {
  defaultPreviewDrawerOpen,
  formatPreviewElapsed,
  previewDiagnosticSeverity,
  previewRunSummary,
  presentPreviewLifecycle,
  projectPreviewActivity,
  resolveActivePreviewRuns,
  type PreviewLifecycleAction,
} from "./previewPresentation";

type PreviewWebview = HTMLElement & {
  loadURL(url: string): Promise<void>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  capturePage(): Promise<{ toDataURL(): string }>;
};
type Region = { x: number; y: number; width: number; height: number };
type DrawerView = "activity" | "raw";

export function PreviewWorkspace(props: {
  projectPath?: string | undefined;
  threadId: string;
  onAttachVisualFeedback: (input: {
    dataUrl: string;
    filename: string;
    comment: string;
    runId: string;
    url: string;
    region?: Region | undefined;
  }) => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [launcher, setLauncher] = useState<DesktopProjectLauncherDescriptor>();
  const [runs, setRuns] = useState<DesktopManagedProjectRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedUrl, setSelectedUrl] = useState("");
  const [address, setAddress] = useState("");
  const [scriptName, setScriptName] = useState("");
  const [viewport, setViewport] = useState<
    "fill" | "mobile" | "tablet" | "desktop"
  >("fill");
  const [diagnostics, setDiagnostics] = useState<DesktopPreviewDiagnostic[]>([]);
  const [screenshot, setScreenshot] = useState<string>();
  const [region, setRegion] = useState<Region>();
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>();
  const [feedback, setFeedback] = useState("");
  const [agentPermissionAt, setAgentPermissionAt] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PreviewLifecycleAction>();
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<DrawerView>("activity");
  const [drawerPreference, setDrawerPreference] = useState<{
    runId: string;
    open: boolean;
  }>();
  const [browserState, setBrowserState] = useState({
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const webviewRef = useRef<PreviewWebview | null>(null);
  const screenshotRef = useRef<HTMLImageElement | null>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);

  const visibleRuns = useMemo(
    () =>
      runs
        .filter(
          (run) =>
            launcher !== undefined && run.projectPath === launcher.projectPath,
        )
        .sort(
          (left, right) =>
            new Date(right.startedAt).getTime() -
            new Date(left.startedAt).getTime(),
        ),
    [launcher, runs],
  );
  const { activeRun, otherActiveRuns } = useMemo(
    () => resolveActivePreviewRuns(visibleRuns),
    [visibleRuns],
  );
  const selectedRun = visibleRuns.find((run) => run.runId === selectedRunId);
  const recordedUrls = useMemo(
    () =>
      selectedRun === undefined
        ? []
        : [
            ...new Set(
              [
                ...(selectedRun.previewUrls ?? []).map((entry) => entry.url),
                selectedRun.primaryPreviewUrl,
              ].filter((url): url is string => Boolean(url)),
            ),
          ],
    [selectedRun],
  );
  const lifecycleRun =
    activeRun ??
    (selectedRun?.scriptName === scriptName ? selectedRun : undefined);
  const lifecycle = presentPreviewLifecycle({
    run: lifecycleRun,
    scriptName,
    pendingAction,
  });
  const activityEntries = useMemo(
    () => projectPreviewActivity(selectedRun, diagnostics),
    [diagnostics, selectedRun],
  );
  const drawerRunId = selectedRun?.runId ?? "idle";
  const automaticDrawerOpen = defaultPreviewDrawerOpen({
    run: selectedRun,
    diagnostics,
    pendingAction,
  });
  const drawerOpen =
    drawerPreference?.runId === drawerRunId
      ? drawerPreference.open
      : automaticDrawerOpen;
  const statusSummary = previewRunSummary(
    activeRun ?? selectedRun,
    pendingAction,
    selectedUrl || undefined,
    scriptName,
  );
  const issueCount = diagnostics.filter(
    (entry) => previewDiagnosticSeverity(entry) !== "info",
  ).length;
  const previewWidth =
    viewport === "mobile"
      ? 390
      : viewport === "tablet"
        ? 768
        : viewport === "desktop"
          ? 1280
          : undefined;

  const refresh = async () => {
    if (!props.projectPath) return;
    try {
      const [nextLauncher, nextRuns] = await Promise.all([
        window.kestrelDesktop.readProjectLauncher(
          props.projectPath,
          undefined,
          props.threadId,
        ),
        window.kestrelDesktop.listProjectRuns(),
      ]);
      setLauncher(nextLauncher);
      setRuns(nextRuns);
      if (nextLauncher && !scriptName) {
        setScriptName(nextLauncher.scripts[0]?.name ?? "");
      }
      props.onError(undefined);
    } catch (cause) {
      props.onError(message(cause));
    }
  };

  useEffect(() => {
    void refresh();
    const unsubscribe = window.kestrelDesktop.onProjectRuns(setRuns);
    return unsubscribe;
  }, [props.projectPath, props.threadId]);

  useEffect(() => {
    if (activeRun !== undefined && selectedRunId !== activeRun.runId) {
      setSelectedRunId(activeRun.runId);
      return;
    }
    if (
      activeRun === undefined &&
      (selectedRunId === undefined ||
        !visibleRuns.some((run) => run.runId === selectedRunId))
    ) {
      setSelectedRunId(visibleRuns[0]?.runId);
    }
  }, [activeRun, selectedRunId, visibleRuns]);

  useEffect(() => {
    if (selectedRun === undefined) {
      setSelectedUrl("");
      setAddress("");
      return;
    }
    const urls = [
      ...new Set(
        [
          ...(selectedRun.previewUrls ?? []).map((entry) => entry.url),
          selectedRun.primaryPreviewUrl,
        ].filter((url): url is string => Boolean(url)),
      ),
    ];
    if (urls.length === 0) {
      setSelectedUrl("");
      setAddress("");
    } else if (!urls.includes(selectedUrl)) {
      setSelectedUrl(urls[0]!);
      setAddress(urls[0]!);
    }
  }, [selectedRun, selectedUrl]);

  useEffect(() => {
    setAgentPermissionAt(undefined);
    setDiagnostics([]);
    setDrawerPreference(undefined);
    setDrawerView("activity");
  }, [selectedRunId]);

  useEffect(
    () =>
      window.kestrelDesktop.onPreviewDiagnostic((diagnostic) => {
        const id = safeWebContentsId(webviewRef.current);
        if (id !== undefined && diagnostic.webContentsId === id) {
          setDiagnostics((current) => [...current, diagnostic].slice(-200));
        }
      }),
    [],
  );

  useEffect(() => {
    if (selectedRun?.status !== "running") return;
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedRun?.runId, selectedRun?.status]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (
      !webview ||
      !selectedUrl ||
      (selectedRun?.status !== "running" &&
        selectedRun?.status !== "stopping")
    ) {
      setBrowserState({
        canGoBack: false,
        canGoForward: false,
        loading: false,
      });
      return;
    }

    let loaded = false;
    let loadAttempt: Promise<void> | undefined;
    const updateNavigation = () => {
      setBrowserState((current) => ({
        ...current,
        canGoBack: canPreviewGoBack(webview),
        canGoForward: canPreviewGoForward(webview),
      }));
    };
    const load = async (reportError: boolean) => {
      if (loaded || selectedRun.status !== "running") return;
      if (loadAttempt !== undefined) {
        try {
          await loadAttempt;
        } catch {
          /* The dom-ready attempt below owns the actionable result. */
        }
        if (loaded) return;
      }
      setBrowserState((current) => ({ ...current, loading: true }));
      loadAttempt = loadPreviewUrl(webview, selectedUrl);
      try {
        await loadAttempt;
        loaded = true;
      } catch (cause) {
        setBrowserState((current) => ({ ...current, loading: false }));
        if (reportError && !isCancelledPreviewLoad(cause)) {
          props.onError(message(cause));
        }
      } finally {
        loadAttempt = undefined;
      }
    };
    const onDomReady = () => {
      updateNavigation();
      void load(true);
    };
    const onStartLoading = () =>
      setBrowserState((current) => ({ ...current, loading: true }));
    const onStopLoading = () => {
      setBrowserState((current) => ({ ...current, loading: false }));
      updateNavigation();
    };
    const onNavigate = (event: Event) => {
      const url = (event as Event & { url?: string }).url;
      if (url && isLocalPreviewUrl(url)) {
        setSelectedUrl(url);
        setAddress(url);
      }
      updateNavigation();
    };

    webview.addEventListener("dom-ready", onDomReady, { once: true });
    webview.addEventListener("did-start-loading", onStartLoading);
    webview.addEventListener("did-stop-loading", onStopLoading);
    webview.addEventListener("did-navigate", onNavigate);
    webview.addEventListener("did-navigate-in-page", onNavigate);
    const fallback = window.setTimeout(() => void load(false), 0);
    return () => {
      window.clearTimeout(fallback);
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("did-start-loading", onStartLoading);
      webview.removeEventListener("did-stop-loading", onStopLoading);
      webview.removeEventListener("did-navigate", onNavigate);
      webview.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [props.onError, selectedRun?.runId, selectedRun?.status, selectedUrl]);

  useEffect(() => {
    if (!overflowOpen) return;
    const close = (event: PointerEvent) => {
      if (
        overflowRef.current?.contains(event.target as Node) !== true &&
        overflowButtonRef.current?.contains(event.target as Node) !== true
      ) {
        closeOverflow();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOverflow();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = [
          ...(overflowRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ) ?? []),
        ];
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (items.length > 0 && index >= 0) {
          event.preventDefault();
          items[
            (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
          ]?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    overflowRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowOpen]);

  function closeOverflow(): void {
    setOverflowOpen(false);
    requestAnimationFrame(() => overflowButtonRef.current?.focus());
  }

  async function start(): Promise<void> {
    if (!(props.projectPath && scriptName)) return;
    setPendingAction("start");
    try {
      const run = await window.kestrelDesktop.startProjectRun({
        projectPath: props.projectPath,
        scriptName,
        threadId: props.threadId,
      });
      setSelectedRunId(run.runId);
      setScreenshot(undefined);
      await refresh();
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function stop(run = activeRun ?? selectedRun): Promise<void> {
    if (run === undefined) return;
    if (run.runId === (activeRun ?? selectedRun)?.runId) {
      setPendingAction("stop");
    }
    try {
      await window.kestrelDesktop.stopProjectRun(run.runId);
      await refresh();
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function restart(): Promise<void> {
    const run = activeRun ?? selectedRun;
    if (run === undefined) return;
    setPendingAction("restart");
    if (overflowOpen) closeOverflow();
    try {
      const next = await window.kestrelDesktop.restartProjectRun(run.runId);
      setSelectedRunId(next.runId);
      await refresh();
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function invokeLifecycle(): Promise<void> {
    if (lifecycle.action === "start") return start();
    if (lifecycle.action === "stop") return stop();
    return restart();
  }

  async function navigate(): Promise<void> {
    if (!isLocalPreviewUrl(address)) {
      props.onError("Preview navigation is limited to local http(s) URLs.");
      return;
    }
    setSelectedUrl(address);
    setDiagnostics([]);
    await loadPreviewUrl(webviewRef.current, address);
  }

  async function capture(): Promise<void> {
    try {
      const image = await capturePreviewPage(webviewRef.current);
      if (!image) return;
      setScreenshot(image.toDataURL());
      setRegion(undefined);
      setFeedback("");
    } catch (cause) {
      props.onError(message(cause));
    }
  }

  async function submitFeedback(): Promise<void> {
    if (!(screenshot && selectedRun && selectedUrl && feedback.trim())) return;
    setFeedbackBusy(true);
    try {
      const annotated = await annotateScreenshot(
        screenshot,
        region,
        feedback.trim(),
      );
      await props.onAttachVisualFeedback({
        dataUrl: annotated,
        filename: `preview-${selectedRun.scriptName}-${Date.now()}.png`,
        comment: feedback.trim(),
        runId: selectedRun.runId,
        url: selectedUrl,
        ...(region ? { region } : {}),
      });
      setScreenshot(undefined);
      setRegion(undefined);
      setFeedback("");
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setFeedbackBusy(false);
    }
  }

  const webview =
    selectedUrl &&
    (selectedRun?.status === "running" ||
      selectedRun?.status === "stopping")
      ? createElement("webview", {
          key: `${selectedRunId}:${selectedUrl}`,
          ref: (node: HTMLElement | null) => {
            webviewRef.current = node as PreviewWebview | null;
          },
          src: "about:blank",
          partition: "persist:kestrel-preview",
          className: "preview-webview",
        })
      : null;

  return (
    <section className="preview-workspace">
      <header className="preview-runbar">
        <select
          aria-label="Preview configuration"
          value={scriptName}
          disabled={activeRun !== undefined}
          onChange={(event) => setScriptName(event.target.value)}
        >
          {launcher?.scripts.map((script) => (
            <option value={script.name} key={script.name}>
              {script.name}
            </option>
          ))}
        </select>
        <button
          className="preview-lifecycle"
          disabled={lifecycle.disabled || pendingAction !== undefined}
          type="button"
          onClick={() => void invokeLifecycle()}
        >
          {pendingAction !== undefined || selectedRun?.status === "stopping" ? (
            <LoaderCircle className="preview-spin" size={14} />
          ) : lifecycle.action === "start" ? (
            <Play size={14} />
          ) : lifecycle.action === "stop" ? (
            <Square size={13} />
          ) : (
            <RotateCw size={14} />
          )}
          <span>{lifecycle.label}</span>
        </button>
        <div className="preview-live-status" aria-live="polite">
          <span
            className={`preview-status-dot preview-status-${selectedRun?.status ?? "idle"}`}
          />
          <span>{statusSummary}</span>
          {selectedRun ? (
            <time dateTime={selectedRun.startedAt}>
              {formatPreviewElapsed(
                selectedRun.startedAt,
                selectedRun.completedAt ?? elapsedNow,
              )}
            </time>
          ) : null}
        </div>
        <div className="preview-overflow-wrap">
          <button
            ref={overflowButtonRef}
            aria-label="Preview options"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            title="Preview options"
            type="button"
            onClick={() => setOverflowOpen((current) => !current)}
          >
            <MoreHorizontal size={15} />
          </button>
          {overflowOpen ? (
            <div
              className="preview-overflow"
              ref={overflowRef}
              role="menu"
              aria-label="Preview options"
            >
              {activeRun?.status === "running" ? (
                <button role="menuitem" type="button" onClick={() => void restart()}>
                  <RotateCw size={14} /> Restart {activeRun.scriptName}
                </button>
              ) : null}
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  if (
                    agentPermissionAt ||
                    window.confirm(
                      "Grant agent-controlled browser interaction for this preview run? This does not authorize external publication or deployment.",
                    )
                  ) {
                    setAgentPermissionAt(
                      agentPermissionAt ? undefined : new Date().toISOString(),
                    );
                    closeOverflow();
                  }
                }}
              >
                <ShieldCheck size={14} />
                {agentPermissionAt
                  ? "Revoke agent interaction"
                  : "Grant agent interaction"}
              </button>
              {otherActiveRuns.length > 0 ? (
                <>
                  <span className="preview-menu-label">Other active runs</span>
                  {otherActiveRuns.map((run) => (
                    <button
                      role="menuitem"
                      type="button"
                      key={run.runId}
                      onClick={() => {
                        closeOverflow();
                        void stop(run);
                      }}
                    >
                      <Square size={13} />
                      Stop {run.scriptName}
                    </button>
                  ))}
                </>
              ) : null}
              {visibleRuns.length > 0 ? (
                <>
                  <span className="preview-menu-label">Recent runs</span>
                  {visibleRuns.slice(0, 6).map((run) => (
                    <button
                      role="menuitem"
                      type="button"
                      key={run.runId}
                      disabled={activeRun !== undefined}
                      onClick={() => {
                        setSelectedRunId(run.runId);
                        closeOverflow();
                      }}
                    >
                      <span>{run.scriptName}</span>
                      <small>{run.status}</small>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className="preview-navigation">
        <div className="preview-nav-actions">
          <button
            aria-label="Go back"
            title="Go back"
            type="button"
            disabled={!browserState.canGoBack}
            onClick={() => navigatePreviewHistory(webviewRef.current, "back")}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            aria-label="Go forward"
            title="Go forward"
            type="button"
            disabled={!browserState.canGoForward}
            onClick={() => navigatePreviewHistory(webviewRef.current, "forward")}
          >
            <ArrowRight size={14} />
          </button>
          <button
            aria-label={browserState.loading ? "Preview is loading" : "Reload preview"}
            title={browserState.loading ? "Preview is loading" : "Reload preview"}
            type="button"
            disabled={!selectedUrl || browserState.loading}
            onClick={() => reloadPreview(webviewRef.current)}
          >
            <RefreshCw
              className={browserState.loading ? "preview-spin" : undefined}
              size={14}
            />
          </button>
        </div>
        <div className="preview-address">
          <Globe2 aria-hidden="true" size={14} />
          <input
            aria-label="Preview address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void navigate();
            }}
          />
        </div>
        <button
          aria-label="Open preview in browser"
          title="Open preview in browser"
          type="button"
          disabled={!selectedUrl}
          onClick={() => void window.kestrelDesktop.openExternal(selectedUrl)}
        >
          <ExternalLink size={14} />
          <span className="preview-control-label">Open</span>
        </button>
        <select
          aria-label="Preview viewport"
          value={viewport}
          onChange={(event) =>
            setViewport(event.target.value as typeof viewport)
          }
        >
          <option value="fill">Responsive fill</option>
          <option value="mobile">Mobile 390px</option>
          <option value="tablet">Tablet 768px</option>
          <option value="desktop">Desktop 1280px</option>
        </select>
        <button
          aria-label="Capture preview"
          title="Capture preview"
          type="button"
          disabled={!selectedUrl || selectedRun?.status !== "running"}
          onClick={() => void capture()}
        >
          <Camera size={14} />
          <span className="preview-control-label">Capture</span>
        </button>
      </div>

      <main className="preview-canvas">
        <div
          className="preview-device"
          style={previewWidth ? { width: previewWidth } : undefined}
        >
          {webview ?? (
            <div className="preview-empty">
              <Globe2 size={22} aria-hidden="true" />
              <strong>
                {selectedRun && selectedRun.status !== "running"
                  ? `Preview ${selectedRun.status}`
                  : "No active preview"}
              </strong>
              <span>
                {selectedRun && selectedRun.status !== "running"
                  ? `Restart ${selectedRun.scriptName} to open its preview.`
                  : "Start a project script to open a detected local URL."}
              </span>
            </div>
          )}
        </div>
      </main>

      <section
        className={`preview-output ${drawerOpen ? "open" : ""}`}
        aria-label="Preview output"
      >
        <button
          className="preview-output-summary"
          type="button"
          aria-expanded={drawerOpen}
          aria-controls="preview-output-panel"
          onClick={() =>
            setDrawerPreference({ runId: drawerRunId, open: !drawerOpen })
          }
        >
          <span>
            <TerminalSquare size={14} />
            <strong>Output</strong>
            <span>{statusSummary}</span>
            {issueCount > 0 ? (
              <small>
                {issueCount} browser {issueCount === 1 ? "issue" : "issues"}
              </small>
            ) : null}
          </span>
          {drawerOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        {drawerOpen ? (
          <div id="preview-output-panel" className="preview-output-panel">
            <div className="preview-output-tabs" role="tablist">
              <button
                className={drawerView === "activity" ? "active" : ""}
                role="tab"
                aria-selected={drawerView === "activity"}
                type="button"
                onClick={() => setDrawerView("activity")}
              >
                <Activity size={13} /> Activity
              </button>
              <button
                className={drawerView === "raw" ? "active" : ""}
                role="tab"
                aria-selected={drawerView === "raw"}
                type="button"
                onClick={() => setDrawerView("raw")}
              >
                <TerminalSquare size={13} /> Raw output
              </button>
              {recordedUrls.length > 1 ? (
                <select
                  aria-label="Detected preview URL"
                  value={selectedUrl}
                  onChange={(event) => {
                    setSelectedUrl(event.target.value);
                    setAddress(event.target.value);
                  }}
                >
                  {recordedUrls.map((url) => (
                    <option key={url} value={url}>
                      {url}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            {drawerView === "activity" ? (
              <div className="preview-activity" role="tabpanel">
                {activityEntries.length > 0 ? (
                  activityEntries.map((entry, index) => (
                    <article
                      className={`preview-activity-${entry.severity}`}
                      key={`${entry.at}:${entry.kind}:${index}`}
                    >
                      <time dateTime={entry.at}>{formatOutputTime(entry.at)}</time>
                      <span className="preview-activity-mark" />
                      <strong>{entry.label}</strong>
                      {entry.detail ? <code>{entry.detail}</code> : null}
                    </article>
                  ))
                ) : (
                  <p>No activity yet. Start the preview to see lifecycle events.</p>
                )}
              </div>
            ) : (
              <RawPreviewOutput run={selectedRun} />
            )}
          </div>
        ) : null}
      </section>

      {screenshot ? (
        <div className="preview-annotation">
          <div
            className="preview-shot"
            onPointerDown={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setDragStart({
                x: (event.clientX - bounds.left) / bounds.width,
                y: (event.clientY - bounds.top) / bounds.height,
              });
            }}
            onPointerUp={(event) => {
              if (!dragStart) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const end = {
                x: (event.clientX - bounds.left) / bounds.width,
                y: (event.clientY - bounds.top) / bounds.height,
              };
              setRegion({
                x: Math.min(dragStart.x, end.x),
                y: Math.min(dragStart.y, end.y),
                width: Math.abs(end.x - dragStart.x),
                height: Math.abs(end.y - dragStart.y),
              });
              setDragStart(undefined);
            }}
          >
            <img ref={screenshotRef} src={screenshot} alt="Captured preview" />
            {region ? (
              <div
                className="preview-region"
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.width * 100}%`,
                  height: `${region.height * 100}%`,
                }}
              />
            ) : null}
          </div>
          <div>
            <strong>Visual feedback</strong>
            <p>Drag over the screenshot to annotate a region.</p>
            <textarea
              aria-label="Visual feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What should the coding agent repair?"
            />
            <button
              disabled={feedbackBusy || !feedback.trim()}
              type="button"
              onClick={() => void submitFeedback()}
            >
              <MessageSquareText size={14} /> Attach feedback to coding thread
            </button>
            <button type="button" onClick={() => setScreenshot(undefined)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RawPreviewOutput(props: {
  run?: DesktopManagedProjectRun | undefined;
}) {
  if (props.run?.outputTail !== undefined) {
    return (
      <div className="preview-raw-output" role="tabpanel">
        {props.run.outputTail.length > 0 ? (
          props.run.outputTail.map((entry, index) => (
            <div key={`${entry.observedAt}:${index}`}>
              <time dateTime={entry.observedAt}>
                {formatOutputTime(entry.observedAt)}
              </time>
              <span className={`preview-source preview-source-${entry.source}`}>
                {entry.source}
              </span>
              <code>{entry.line}</code>
            </div>
          ))
        ) : (
          <p>No process output yet.</p>
        )}
      </div>
    );
  }
  return (
    <div className="preview-raw-output preview-raw-legacy" role="tabpanel">
      <LegacyOutputSection label="stdout" lines={props.run?.stdoutTail ?? []} />
      <LegacyOutputSection label="stderr" lines={props.run?.stderrTail ?? []} />
    </div>
  );
}

function LegacyOutputSection(props: { label: string; lines: string[] }) {
  return (
    <section>
      <strong>{props.label}</strong>
      {props.lines.length > 0 ? (
        <pre>{props.lines.join("\n")}</pre>
      ) : (
        <p>No {props.label} captured.</p>
      )}
    </section>
  );
}

function safeWebContentsId(webview: PreviewWebview | null): number | undefined {
  try {
    return webview?.getWebContentsId();
  } catch {
    return;
  }
}

function canPreviewGoBack(webview: PreviewWebview | null): boolean {
  try {
    return typeof webview?.canGoBack === "function" && webview.canGoBack();
  } catch {
    return false;
  }
}

function canPreviewGoForward(webview: PreviewWebview | null): boolean {
  try {
    return (
      typeof webview?.canGoForward === "function" && webview.canGoForward()
    );
  } catch {
    return false;
  }
}

function navigatePreviewHistory(
  webview: PreviewWebview | null,
  direction: "back" | "forward",
): void {
  try {
    const action = direction === "back" ? webview?.goBack : webview?.goForward;
    if (typeof action === "function") action.call(webview);
  } catch {
    /* Navigation readiness is reflected by the disabled controls. */
  }
}

function reloadPreview(webview: PreviewWebview | null): void {
  try {
    if (typeof webview?.reload === "function") webview.reload();
  } catch {
    /* A detached webview cannot be reloaded. */
  }
}

async function loadPreviewUrl(
  webview: PreviewWebview | null,
  url: string,
): Promise<void> {
  if (typeof webview?.loadURL === "function") await webview.loadURL(url);
}

async function capturePreviewPage(
  webview: PreviewWebview | null,
): Promise<{ toDataURL(): string } | undefined> {
  return typeof webview?.capturePage === "function"
    ? webview.capturePage()
    : undefined;
}

function isLocalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function formatOutputTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
}

async function annotateScreenshot(
  dataUrl: string,
  region: Region | undefined,
  comment: string,
): Promise<string> {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, 1600 / image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screenshot canvas is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (region) {
    context.strokeStyle = "#ff3b30";
    context.lineWidth = Math.max(3, canvas.width / 300);
    context.strokeRect(
      region.x * canvas.width,
      region.y * canvas.height,
      region.width * canvas.width,
      region.height * canvas.height,
    );
  }
  context.font = `${Math.max(16, Math.round(canvas.width / 70))}px sans-serif`;
  const label = comment.slice(0, 140);
  const metrics = context.measureText(label);
  context.fillStyle = "rgba(0,0,0,.78)";
  context.fillRect(
    8,
    8,
    Math.min(canvas.width - 16, metrics.width + 20),
    Math.max(30, canvas.width / 45),
  );
  context.fillStyle = "white";
  context.fillText(label, 18, Math.max(28, canvas.width / 55));
  return canvas.toDataURL("image/png");
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Captured screenshot could not be decoded."));
    image.src = dataUrl;
  });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isCancelledPreviewLoad(cause: unknown): boolean {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === -3
  ) {
    return true;
  }
  return cause instanceof Error && cause.message.includes("ERR_ABORTED (-3)");
}
