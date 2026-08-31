import {
  default as React,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  DesktopBrowserViewerBindingV1,
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerInputV1,
  DesktopBrowserViewerStateV1,
} from "../../src/contracts";

const DESKTOP_BROWSER_VIEWER_REQUEST_VERSION: DesktopBrowserViewerBindingV1["version"] =
  "desktop_browser_viewer_request_v1";
const DESKTOP_BROWSER_VIEWER_INPUT_VERSION: DesktopBrowserViewerInputV1["version"] =
  "desktop_browser_viewer_input_v1";

const VIEWER_DISCOVERY_MS = 1_000;
const VIEWER_FRAME_MS = 500;
const VIEWER_LEASE_RENEW_MS = 15_000;

export function BrowserViewer(props: {
  threadId: string;
  projectId: string;
}) {
  const [viewer, setViewer] = useState<DesktopBrowserViewerStateV1>();
  const [frame, setFrame] = useState<DesktopBrowserViewerFrameV1>();
  const [error, setError] = useState<string>();
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const imageRef = useRef<HTMLImageElement>(null);

  const binding = useMemo<DesktopBrowserViewerBindingV1>(() => ({
    version: DESKTOP_BROWSER_VIEWER_REQUEST_VERSION,
    threadId: props.threadId,
    projectId: props.projectId,
    ...(viewer?.sessionId === undefined
      ? {}
      : {
          sessionId: viewer.sessionId,
          generation: viewer.generation,
          connectionId: viewer.connectionId,
        }),
  }), [props.threadId, props.projectId, viewer]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const discover = async () => {
      try {
        const next = await window.kestrelDesktop.connectBrowserViewer({
          version: DESKTOP_BROWSER_VIEWER_REQUEST_VERSION,
          threadId: props.threadId,
          projectId: props.projectId,
        });
        if (cancelled) return;
        setViewer(next);
        setError(undefined);
        if (!next.available) {
          setFrame(undefined);
        }
      } catch {
        if (cancelled) return;
        setViewer(undefined);
        setFrame(undefined);
        setError("The live Browser viewer is temporarily unavailable.");
      } finally {
        if (!cancelled) {
          // Connection refresh is also the viewer-state subscription: it makes
          // a takeover requested after initial connection visible without
          // adding a second event or streaming authority surface.
          timer = setTimeout(discover, VIEWER_DISCOVERY_MS);
        }
      }
    };
    void discover();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [props.threadId, props.projectId, connectionAttempt]);

  useEffect(() => {
    if (
      !viewer?.available ||
      viewer.sessionId === undefined ||
      viewer.generation === undefined ||
      viewer.connectionId === undefined
    ) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await window.kestrelDesktop.readBrowserViewerFrame(
          exactBinding(viewer, props),
        );
        if (!cancelled) {
          setFrame(next);
          setError(undefined);
        }
      } catch {
        if (!cancelled) setError("The live Browser frame is unavailable.");
      } finally {
        if (!cancelled) timer = setTimeout(read, VIEWER_FRAME_MS);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    props.threadId,
    props.projectId,
    viewer?.available,
    viewer?.sessionId,
    viewer?.generation,
    viewer?.connectionId,
  ]);

  useEffect(() => {
    if (
      viewer?.inputLeaseId === undefined ||
      viewer.sessionId === undefined ||
      viewer.generation === undefined ||
      viewer.connectionId === undefined
    ) return;
    const leaseId = viewer.inputLeaseId;
    const timer = setInterval(() => {
      void window.kestrelDesktop
        .renewBrowserInputLease({
          ...exactBinding(viewer, props),
          leaseId,
        })
        .then(setViewer)
        .catch(() => {
          setViewer((current) => {
            if (current === undefined) return current;
            const {
              inputLeaseId: _lease,
              inputLeaseExpiresAt: _expiry,
              ...withoutLease
            } = current;
            return withoutLease;
          });
        });
    }, VIEWER_LEASE_RENEW_MS);
    return () => clearInterval(timer);
  }, [props.threadId, props.projectId, viewer?.inputLeaseId]);

  if (!viewer?.available) {
    return error === undefined ? null : (
      <section className="browser-viewer browser-viewer-unavailable" aria-live="polite">
        <span>{error}</span>
      </section>
    );
  }

  const leaseActive = viewer.inputLeaseId !== undefined;
  const frameSource = frame === undefined
    ? undefined
    : `data:${frame.mediaType};base64,${frame.dataBase64}`;

  async function acceptTakeover(): Promise<void> {
    setError(undefined);
    try {
      const next = await window.kestrelDesktop.acceptBrowserTakeover(binding);
      setViewer(next);
    } catch {
      setError("Kestrel could not grant this viewer input control.");
    }
  }

  async function returnControl(): Promise<void> {
    if (viewer?.inputLeaseId === undefined) return;
    setError(undefined);
    try {
      setViewer(await window.kestrelDesktop.returnBrowserControl({
        ...binding,
        leaseId: viewer.inputLeaseId,
      }));
    } catch {
      setError("Kestrel could not return Browser control to the agent.");
    }
  }

  async function disconnect(): Promise<void> {
    try {
      await window.kestrelDesktop.disconnectBrowserViewer(binding);
    } finally {
      setViewer(undefined);
      setFrame(undefined);
      setConnectionAttempt((current) => current + 1);
    }
  }

  async function closeSession(): Promise<void> {
    try {
      await window.kestrelDesktop.closeBrowserViewerSession(binding);
    } finally {
      setViewer(undefined);
      setFrame(undefined);
    }
  }

  async function sendPointer(
    event: ReactPointerEvent<HTMLImageElement>,
    phase: "move" | "down" | "up",
  ): Promise<void> {
    if (!leaseActive || viewer?.inputLeaseId === undefined) return;
    event.currentTarget.parentElement?.focus();
    const image = imageRef.current;
    if (image === null || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const bounds = image.getBoundingClientRect();
    const x = Math.max(0, (event.clientX - bounds.left) * image.naturalWidth / bounds.width);
    const y = Math.max(0, (event.clientY - bounds.top) * image.naturalHeight / bounds.height);
    if (phase === "down") event.currentTarget.setPointerCapture(event.pointerId);
    const modifiers = eventModifiers(event);
    await sendInput({
      version: DESKTOP_BROWSER_VIEWER_INPUT_VERSION,
      kind: "pointer",
      phase,
      x,
      y,
      button: pointerButton(event.button, phase),
      ...(modifiers === undefined ? {} : { modifiers }),
    });
  }

  async function sendKeyboard(
    event: ReactKeyboardEvent<HTMLElement>,
    phase: "down" | "up",
  ): Promise<void> {
    if (!leaseActive || viewer?.inputLeaseId === undefined) return;
    event.preventDefault();
    const modifiers = eventModifiers(event);
    await sendInput({
      version: DESKTOP_BROWSER_VIEWER_INPUT_VERSION,
      kind: "keyboard",
      phase,
      key: event.key,
      code: event.code,
      ...(phase === "down" && event.key.length === 1 ? { text: event.key } : {}),
      ...(modifiers === undefined ? {} : { modifiers }),
    });
  }

  async function sendInput(
    input: Parameters<typeof window.kestrelDesktop.sendBrowserViewerInput>[0]["input"],
  ): Promise<void> {
    if (viewer?.inputLeaseId === undefined) return;
    try {
      setViewer(await window.kestrelDesktop.sendBrowserViewerInput({
        ...binding,
        leaseId: viewer.inputLeaseId,
        input,
      }));
    } catch {
      setError("Browser input control is no longer available.");
    }
  }

  return (
    <section className="browser-viewer" aria-label="Live Browser viewer">
      <header>
        <div>
          <strong>Live Browser</strong>
          <span>{viewer.sessionState === "human_control" ? "Human control" : "Agent control"}</span>
        </div>
        <div className="browser-viewer-actions">
          {(viewer.takeoverRequested || (viewer.sessionState === "human_control" && !leaseActive)) ? (
            <button type="button" onClick={() => void acceptTakeover()}>
              {viewer.takeoverRequested ? "Take control" : "Reconnect input"}
            </button>
          ) : null}
          {leaseActive ? (
            <button type="button" onClick={() => void returnControl()}>Return to agent</button>
          ) : null}
          <button type="button" onClick={() => void disconnect()}>Disconnect viewer</button>
          <button type="button" onClick={() => void closeSession()}>Close session</button>
        </div>
      </header>
      <div
        className={`browser-viewer-frame ${leaseActive ? "browser-viewer-frame-input" : ""}`}
        tabIndex={leaseActive ? 0 : -1}
        onKeyDown={(event) => void sendKeyboard(event, "down")}
        onKeyUp={(event) => void sendKeyboard(event, "up")}
      >
        {frameSource === undefined ? (
          <span>Waiting for the live frame…</span>
        ) : (
          <img
            ref={imageRef}
            src={frameSource}
            alt="Current Browser Session"
            draggable={false}
            onPointerMove={(event) => void sendPointer(event, "move")}
            onPointerDown={(event) => void sendPointer(event, "down")}
            onPointerUp={(event) => void sendPointer(event, "up")}
          />
        )}
      </div>
      {error === undefined ? null : <p role="status">{error}</p>}
    </section>
  );
}

function exactBinding(
  viewer: DesktopBrowserViewerStateV1,
  props: { threadId: string; projectId: string },
): DesktopBrowserViewerBindingV1 & {
  sessionId: string;
  generation: number;
  connectionId: string;
} {
  if (
    viewer.sessionId === undefined ||
    viewer.generation === undefined ||
    viewer.connectionId === undefined
  ) {
    throw new Error("Browser viewer identity is unavailable.");
  }
  return {
    version: DESKTOP_BROWSER_VIEWER_REQUEST_VERSION,
    threadId: props.threadId,
    projectId: props.projectId,
    sessionId: viewer.sessionId,
    generation: viewer.generation,
    connectionId: viewer.connectionId,
  };
}

function eventModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): Array<"alt" | "control" | "meta" | "shift"> | undefined {
  const modifiers: Array<"alt" | "control" | "meta" | "shift"> = [];
  if (event.altKey) modifiers.push("alt");
  if (event.ctrlKey) modifiers.push("control");
  if (event.metaKey) modifiers.push("meta");
  if (event.shiftKey) modifiers.push("shift");
  return modifiers.length === 0 ? undefined : modifiers;
}

function pointerButton(
  button: number,
  phase: "move" | "down" | "up",
): "none" | "left" | "middle" | "right" {
  if (phase === "move") return "none";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}
