import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Globe2,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import { createElement, useEffect, useMemo, useRef, useState } from "react";

import type {
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
  DesktopProjectLauncherDescriptor,
} from "../../src/contracts";

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
  const [diagnostics, setDiagnostics] = useState<DesktopPreviewDiagnostic[]>(
    [],
  );
  const [screenshot, setScreenshot] = useState<string>();
  const [region, setRegion] = useState<Region>();
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>();
  const [feedback, setFeedback] = useState("");
  const [agentPermissionAt, setAgentPermissionAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const webviewRef = useRef<PreviewWebview | null>(null);
  const screenshotRef = useRef<HTMLImageElement | null>(null);
  const visibleRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          launcher !== undefined && run.projectPath === launcher.projectPath,
      ),
    [launcher, runs],
  );
  const selectedRun = visibleRuns.find((run) => run.runId === selectedRunId);
  const recordedUrls = useMemo(() => {
    if (!selectedRun) return [];
    return [
      ...new Set(
        [
          selectedRun.primaryPreviewUrl,
          ...(selectedRun.previewUrls ?? []).map((entry) => entry.url),
        ].filter((url): url is string => Boolean(url)),
      ),
    ];
  }, [selectedRun]);

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
      if (nextLauncher && !scriptName)
        setScriptName(nextLauncher.scripts[0]?.name ?? "");
      if (!selectedRunId) {
        const first = nextRuns.find(
          (run) =>
            run.projectPath === nextLauncher?.projectPath &&
            (run.primaryPreviewUrl || run.previewUrls?.length),
        );
        if (first) {
          setSelectedRunId(first.runId);
          const url =
            first.primaryPreviewUrl ?? first.previewUrls?.[0]?.url ?? "";
          setSelectedUrl(url);
          setAddress(url);
        }
      }
      props.onError(undefined);
    } catch (cause) {
      props.onError(message(cause));
    }
  };
  useEffect(() => {
    void refresh();
    const unsubscribe = window.kestrelDesktop.onProjectRuns((next) =>
      setRuns(next),
    );
    return unsubscribe;
  }, [props.projectPath, props.threadId]);
  useEffect(
    () =>
      window.kestrelDesktop.onPreviewDiagnostic((diagnostic) => {
        const id = safeWebContentsId(webviewRef.current);
        if (id !== undefined && diagnostic.webContentsId === id)
          setDiagnostics((current) => [...current, diagnostic].slice(-200));
      }),
    [],
  );
  useEffect(() => {
    const run = visibleRuns.find(
      (candidate) => candidate.runId === selectedRunId,
    );
    if (!run) return;
    const available = [
      ...new Set(
        [
          run.primaryPreviewUrl,
          ...(run.previewUrls ?? []).map((entry) => entry.url),
        ].filter((url): url is string => Boolean(url)),
      ),
    ];
    if (available.length > 0 && !available.includes(selectedUrl)) {
      setSelectedUrl(available[0]!);
      setAddress(available[0]!);
    }
  }, [visibleRuns, selectedRunId]);
  useEffect(() => setAgentPermissionAt(undefined), [selectedRunId]);

  const start = async () => {
    if (!props.projectPath || !scriptName) return;
    setBusy(true);
    try {
      const run = await window.kestrelDesktop.startProjectRun({
        projectPath: props.projectPath,
        scriptName,
        threadId: props.threadId,
      });
      setSelectedRunId(run.runId);
      setDiagnostics([]);
      setScreenshot(undefined);
      await refresh();
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!selectedRun) return;
    setBusy(true);
    try {
      await window.kestrelDesktop.stopProjectRun(selectedRun.runId);
      await refresh();
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const restart = async () => {
    if (!selectedRun) return;
    setBusy(true);
    try {
      const run = await window.kestrelDesktop.restartProjectRun(
        selectedRun.runId,
      );
      setSelectedRunId(run.runId);
      setDiagnostics([]);
      await refresh();
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const navigate = async () => {
    if (!isLocalPreviewUrl(address)) {
      props.onError("Preview navigation is limited to local http(s) URLs.");
      return;
    }
    setSelectedUrl(address);
    setDiagnostics([]);
    await loadPreviewUrl(webviewRef.current, address);
  };
  const capture = async () => {
    try {
      const image = await capturePreviewPage(webviewRef.current);
      if (!image) return;
      setScreenshot(image.toDataURL());
      setRegion(undefined);
      setFeedback("");
    } catch (cause) {
      props.onError(message(cause));
    }
  };
  const submitFeedback = async () => {
    if (!screenshot || !selectedRun || !selectedUrl || !feedback.trim()) return;
    setBusy(true);
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
      setBusy(false);
    }
  };
  const previewWidth =
    viewport === "mobile"
      ? 390
      : viewport === "tablet"
        ? 768
        : viewport === "desktop"
          ? 1280
          : undefined;
  const webview =
    selectedUrl && selectedRun?.status === "running"
      ? createElement("webview", {
          ref: (node: HTMLElement | null) => {
            webviewRef.current = node as PreviewWebview | null;
          },
          src: selectedUrl,
          partition: "persist:kestrel-preview",
          className: "preview-webview",
        })
      : null;

  return (
    <section className="preview-workspace">
      <header className="diff-toolbar">
        <select
          aria-label="Preview configuration"
          value={scriptName}
          onChange={(event) => setScriptName(event.target.value)}
        >
          {launcher?.scripts.map((script) => (
            <option value={script.name} key={script.name}>
              {script.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !scriptName}
          type="button"
          onClick={() => void start()}
        >
          <Play size={14} /> Start
        </button>
        <select
          aria-label="Preview run"
          value={selectedRunId ?? ""}
          onChange={(event) => {
            const id = event.target.value;
            const run = visibleRuns.find((candidate) => candidate.runId === id);
            setSelectedRunId(id);
            const url =
              run?.primaryPreviewUrl ?? run?.previewUrls?.[0]?.url ?? "";
            setSelectedUrl(url);
            setAddress(url);
            setDiagnostics([]);
          }}
        >
          <option value="">Select run</option>
          {visibleRuns.map((run) => (
            <option value={run.runId} key={run.runId}>
              {run.scriptName} · {run.status}
            </option>
          ))}
        </select>
        {selectedRun?.status === "running" ||
        selectedRun?.status === "stopping" ? (
          <button
            disabled={busy || selectedRun.status === "stopping"}
            type="button"
            onClick={() => void stop()}
          >
            <Square size={13} /> Stop
          </button>
        ) : selectedRun ? (
          <button disabled={busy} type="button" onClick={() => void restart()}>
            <RotateCw size={13} /> Restart
          </button>
        ) : null}
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
          type="button"
          onClick={() => {
            if (
              !agentPermissionAt &&
              window.confirm(
                "Grant agent-controlled browser interaction for this preview run? This does not authorize external publication or deployment.",
              )
            )
              setAgentPermissionAt(new Date().toISOString());
          }}
        >
          <ShieldCheck size={14} />{" "}
          {agentPermissionAt
            ? "Agent interaction granted"
            : "Grant agent interaction"}
        </button>
      </header>
      <div className="preview-navigation">
        <button
          aria-label="Go back"
          title="Go back"
          type="button"
          disabled={!canPreviewGoBack(webviewRef.current)}
          onClick={() => navigatePreviewHistory(webviewRef.current, "back")}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          aria-label="Go forward"
          title="Go forward"
          type="button"
          disabled={!canPreviewGoForward(webviewRef.current)}
          onClick={() => navigatePreviewHistory(webviewRef.current, "forward")}
        >
          <ArrowRight size={14} />
        </button>
        <button
          aria-label="Reload preview"
          title="Reload preview"
          type="button"
          disabled={!selectedUrl}
          onClick={() => reloadPreview(webviewRef.current)}
        >
          <RefreshCw size={14} />
        </button>
        <Globe2 aria-hidden="true" size={14} />
        <input
          aria-label="Preview address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void navigate();
          }}
        />
        <button
          type="button"
          disabled={!address}
          onClick={() => void navigate()}
        >
          Go
        </button>
        <button
          type="button"
          disabled={!selectedUrl}
          onClick={() => void window.kestrelDesktop.openExternal(selectedUrl)}
        >
          <ExternalLink size={14} /> Browser
        </button>
        <button
          type="button"
          disabled={!selectedUrl || selectedRun?.status !== "running"}
          onClick={() => void capture()}
        >
          <Camera size={14} /> Screenshot
        </button>
      </div>
      <div className="preview-layout">
        <main className="preview-canvas">
          <div
            className="preview-device"
            style={previewWidth ? { width: previewWidth } : undefined}
          >
            {webview ?? (
              <div className="preview-empty">
                {selectedRun && selectedRun.status !== "running"
                  ? `Server is ${selectedRun.status}; restart it before previewing.`
                  : "Start a project script and select a detected local URL."}
              </div>
            )}
          </div>
        </main>
        <aside className="preview-inspector">
          <section>
            <strong>Server</strong>
            <span>{selectedRun?.status ?? "not started"}</span>
            <code>{selectedRun?.command ?? "—"}</code>
            {recordedUrls.map((url) => (
              <button
                type="button"
                key={url}
                onClick={() => {
                  setSelectedUrl(url);
                  setAddress(url);
                }}
              >
                {url}
              </button>
            ))}
            {selectedRun?.stderrTail.length ? (
              <pre>{selectedRun.stderrTail.join("\n")}</pre>
            ) : selectedRun?.stdoutTail.length ? (
              <pre>{selectedRun.stdoutTail.join("\n")}</pre>
            ) : null}
          </section>
          <section>
            <strong>Browser diagnostics</strong>
            {diagnostics.map((entry, index) => (
              <article key={`${entry.at}:${index}`}>
                <span>{entry.kind}</span>
                <p>{entry.message}</p>
                {entry.url ? <code>{entry.url}</code> : null}
              </article>
            ))}
            {diagnostics.length === 0 ? (
              <p>No console or failed-network diagnostics.</p>
            ) : null}
          </section>
          <section>
            <strong>Agent interaction</strong>
            <p>
              {agentPermissionAt
                ? `Explicitly granted for this pane at ${new Date(agentPermissionAt).toLocaleTimeString()}.`
                : "Off. Browser control is never granted implicitly."}
            </p>
          </section>
        </aside>
      </div>
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
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What should the coding agent repair?"
            />
            <button
              disabled={busy || !feedback.trim()}
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

function safeWebContentsId(webview: PreviewWebview | null): number | undefined {
  try {
    return webview?.getWebContentsId();
  } catch {
    return undefined;
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
