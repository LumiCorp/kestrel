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
  HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  parseHostedBrowserViewerServerMessage,
} from "../../../../src/browser/hostedViewerProtocol";
import type {
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerInputV1,
  DesktopBrowserViewerStateV1,
} from "../../../../src/desktopShell/contracts";
import {
  classifyHostedBrowserViewerAvailabilityResponse,
  hostedBrowserViewerCleanupUnknownPresentation,
  type HostedBrowserViewerAvailability,
  type HostedBrowserViewerCleanupUnknownPresentation,
} from "./hosted-browser-viewer-presentation";

export function HostedBrowserViewer({ threadId }: { threadId: string }) {
  const [availability, setAvailability] = useState<HostedBrowserViewerAvailability>({ available: false });
  const [state, setState] = useState<DesktopBrowserViewerStateV1 | null>(null);
  const [frame, setFrame] = useState<DesktopBrowserViewerFrameV1 | null>(null);
  const [transportState, setTransportState] = useState<"closed" | "connecting" | "open">("closed");
  const [cleanupUnknown, setCleanupUnknown] =
    useState<HostedBrowserViewerCleanupUnknownPresentation | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const availabilityAbortRef = useRef<AbortController | null>(null);
  const viewerIdentityRef = useRef<{
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  } | null>(null);

  useEffect(() => {
    if (transportState !== "closed") return;
    let cancelled = false;
    const controller = new AbortController();
    availabilityAbortRef.current = controller;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/browser-viewer`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await classifyHostedBrowserViewerAvailabilityResponse(response);
        if (result.kind === "transient") return;
        if (!cancelled) {
          const value = result.kind === "unavailable"
            ? { available: false }
            : result.availability;
          setAvailability(value);
          setCleanupUnknown(value.cleanupPending
            ? hostedBrowserViewerCleanupUnknownPresentation(
                "BROWSER_ACTION_OUTCOME_UNKNOWN",
              )
            : null);
        }
      } catch {
        // Keep the last server-authoritative cleanup state across transient
        // polling failures. Only a successful status response may clear it.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      controller.abort();
      if (availabilityAbortRef.current === controller) {
        availabilityAbortRef.current = null;
      }
      window.clearInterval(timer);
    };
  }, [threadId, transportState]);

  useEffect(() => () => socketRef.current?.close(1000, "viewer unmounted"), []);

  const connect = useCallback(async () => {
    if (availability.cleanupPending) return;
    availabilityAbortRef.current?.abort();
    socketRef.current?.close(1000, "viewer reconnecting");
    setTransportState("connecting");
    setFrame(null);
    setState(null);
    viewerIdentityRef.current = null;
    setCleanupUnknown(null);
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
      try {
        const serialized = String(event.data);
        if (
          new TextEncoder().encode(serialized).byteLength >
            HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES
        ) {
          throw new Error("BROWSER_SESSION_LOST");
        }
        const identity = viewerIdentityRef.current;
        const message = parseHostedBrowserViewerServerMessage(
          JSON.parse(serialized),
          {
            threadId,
            ...(identity ?? {}),
          },
        );
        if (!identity && message.type === "frame") {
          throw new Error("BROWSER_SESSION_LOST");
        }
        if (message.type === "state") {
          viewerIdentityRef.current = {
            projectId: message.state.projectId!,
            sessionId: message.state.sessionId!,
            generation: message.state.generation!,
            connectionId: message.state.connectionId!,
          };
          setState(message.state);
        }
        if (message.type === "frame") setFrame(message.frame);
        if (message.type === "error") {
          setCleanupUnknown(hostedBrowserViewerCleanupUnknownPresentation(message.code));
          socket.close();
        }
        if (message.type === "closed") socket.close();
      } catch {
        viewerIdentityRef.current = null;
        setState(null);
        setFrame(null);
        socket.close(1008, "invalid viewer message");
      }
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      setTransportState("closed");
      setState(null);
      setFrame(null);
      viewerIdentityRef.current = null;
    });
  }, [availability.cleanupPending, threadId]);

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

  if (cleanupUnknown && transportState === "closed") {
    return (
      <div className="mx-auto w-full max-w-4xl px-2 md:px-4" data-testid="hosted-browser-viewer-cleanup-unknown">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="font-medium text-sm">{cleanupUnknown.title}</p>
          <p className="text-muted-foreground text-xs">{cleanupUnknown.instruction}</p>
        </div>
      </div>
    );
  }
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
