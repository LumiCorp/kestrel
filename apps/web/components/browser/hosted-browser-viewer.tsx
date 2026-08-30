"use client";

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  type HostedBrowserViewerServerMessageV1,
} from "../../../../src/browser/hostedViewerProtocol";
import type {
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerInputV1,
  DesktopBrowserViewerStateV1,
} from "../../../../src/desktopShell/contracts";

type Availability = {
  available: boolean;
  sessionState?: string;
};

export function HostedBrowserViewer({ threadId }: { threadId: string }) {
  const [availability, setAvailability] = useState<Availability>({ available: false });
  const [state, setState] = useState<DesktopBrowserViewerStateV1 | null>(null);
  const [frame, setFrame] = useState<DesktopBrowserViewerFrameV1 | null>(null);
  const [transportState, setTransportState] = useState<"closed" | "connecting" | "open">("closed");
  const socketRef = useRef<WebSocket | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/browser-viewer`, {
          cache: "no-store",
        });
        const value = response.ok ? (await response.json()) as Availability : { available: false };
        if (!cancelled) setAvailability(value);
      } catch {
        if (!cancelled) setAvailability({ available: false });
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId]);

  useEffect(() => () => socketRef.current?.close(1000, "viewer unmounted"), []);

  const connect = useCallback(async () => {
    socketRef.current?.close(1000, "viewer reconnecting");
    setTransportState("connecting");
    setFrame(null);
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/browser-viewer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      setTransportState("closed");
      return;
    }
    const ticket = await response.json() as { ticket: string; route: string };
    const url = new URL(ticket.route, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, [HOSTED_BROWSER_VIEWER_ROUTE_VERSION]);
    socketRef.current = socket;
    socket.addEventListener("open", () => {
      setTransportState("open");
      socket.send(JSON.stringify({
        version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
        type: "authenticate",
        ticket: ticket.ticket,
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as HostedBrowserViewerServerMessageV1;
      if (message.type === "state") setState(message.state);
      if (message.type === "frame") setFrame(message.frame);
      if (message.type === "closed" || message.type === "error") socket.close();
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      setTransportState("closed");
      setState(null);
      setFrame(null);
    });
  }, [threadId]);

  useEffect(() => {
    if (!(state?.inputLeaseId && transportState === "open")) return;
    const timer = window.setInterval(() => {
      socketRef.current?.send(JSON.stringify({
        version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
        type: "renew_lease",
        leaseId: state.inputLeaseId,
      }));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [state?.inputLeaseId, transportState]);

  const send = (message: Record<string, unknown>) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
        ...message,
      }));
    }
  };

  const sendInput = (input: DesktopBrowserViewerInputV1) => {
    if (state?.inputLeaseId) send({ type: "input", leaseId: state.inputLeaseId, input });
  };

  if (!availability.available && transportState === "closed") return null;
  if (transportState === "closed") {
    return (
      <div className="mx-auto w-full max-w-4xl px-2 md:px-4" data-testid="hosted-browser-viewer-available">
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
          <div>
            <p className="font-medium text-sm">Browser Session available</p>
            <p className="text-muted-foreground text-xs">View the live browser or reconnect to return control.</p>
          </div>
          <Button onClick={() => void connect()} size="sm">View browser</Button>
        </div>
      </div>
    );
  }

  return (
    <section className="mx-auto w-full max-w-4xl px-2 md:px-4" data-testid="hosted-browser-viewer">
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-2">
          <p className="font-medium text-sm">
            {state?.sessionState === "human_control" ? "You control the browser" : "Agent controls the browser"}
          </p>
          <div className="flex gap-2">
            {state?.takeoverRequested && state.sessionState === "ready" ? (
              <Button onClick={() => send({ type: "accept_takeover" })} size="sm">Take control</Button>
            ) : null}
            {state?.sessionState === "human_control" && state.inputLeaseId ? (
              <Button onClick={() => send({ type: "return_control", leaseId: state.inputLeaseId })} size="sm">Return to agent</Button>
            ) : null}
            <Button onClick={() => send({ type: "close_session" })} size="sm" variant="outline">Close browser</Button>
          </div>
        </div>
        <div
          aria-label="Live Browser Session"
          className="relative min-h-64 bg-black outline-none"
          onKeyDown={(event) => {
            if (!state?.inputLeaseId) return;
            event.preventDefault();
            sendInput({
              version: "desktop_browser_viewer_input_v1",
              kind: "keyboard",
              phase: "down",
              key: event.key,
              code: event.code,
              text: event.key.length === 1 ? event.key : undefined,
              modifiers: keyboardModifiers(event),
            });
          }}
          onKeyUp={(event) => {
            if (!state?.inputLeaseId) return;
            event.preventDefault();
            sendInput({
              version: "desktop_browser_viewer_input_v1",
              kind: "keyboard",
              phase: "up",
              key: event.key,
              code: event.code,
              modifiers: keyboardModifiers(event),
            });
          }}
          onPointerDown={(event) => sendPointer(event, "down", imageRef.current, sendInput)}
          onPointerMove={(event) => sendPointer(event, "move", imageRef.current, sendInput)}
          onPointerUp={(event) => sendPointer(event, "up", imageRef.current, sendInput)}
          role="application"
          tabIndex={state?.inputLeaseId ? 0 : -1}
        >
          {frame ? (
            // biome-ignore lint/performance/noImgElement: transient authenticated frames cannot be fetched by the Next image optimizer.
            <img
              alt="Live Browser Session"
              className="block h-auto w-full select-none"
              draggable={false}
              ref={imageRef}
              src={`data:image/png;base64,${frame.dataBase64}`}
            />
          ) : (
            <div className="flex min-h-64 items-center justify-center text-sm text-white/70">Connecting to browser…</div>
          )}
        </div>
      </div>
    </section>
  );
}

function keyboardModifiers(event: KeyboardEvent) {
  return [
    ...(event.altKey ? ["alt" as const] : []),
    ...(event.ctrlKey ? ["control" as const] : []),
    ...(event.metaKey ? ["meta" as const] : []),
    ...(event.shiftKey ? ["shift" as const] : []),
  ];
}

function sendPointer(
  event: PointerEvent,
  phase: "move" | "down" | "up",
  image: HTMLImageElement | null,
  send: (input: DesktopBrowserViewerInputV1) => void,
) {
  if (!(image?.naturalWidth && image.naturalHeight)) return;
  const bounds = image.getBoundingClientRect();
  send({
    version: "desktop_browser_viewer_input_v1",
    kind: "pointer",
    phase,
    x: Math.max(0, Math.min(image.naturalWidth, (event.clientX - bounds.left) * image.naturalWidth / bounds.width)),
    y: Math.max(0, Math.min(image.naturalHeight, (event.clientY - bounds.top) * image.naturalHeight / bounds.height)),
    button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
  });
}
