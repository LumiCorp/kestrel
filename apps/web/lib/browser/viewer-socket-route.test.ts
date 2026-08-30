import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";
import {
  HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  type HostedBrowserViewerClientMessageV1,
} from "../../../../src/browser/hostedViewerProtocol.js";
import {
  HostedBrowserViewerOutcomeUnknownError,
  type HostedBrowserViewerConnection,
} from "./viewer-service";
import { attachHostedBrowserViewerSocket } from "./viewer-socket-route";

test("close waits for a pending connect success and disconnects the late exact connection once", async () => {
  const socket = new FakeSocket();
  const connect = deferred<HostedBrowserViewerConnection>();
  const connection = fakeConnection();
  const timers = fakeTimers();
  const controller = attach(socket, () => connect.promise, timers);

  socket.emitMessage();
  await nextTurn();
  socket.emitClose();
  socket.emitError();
  connect.resolve(connection.value);
  await controller.whenClosed();

  assert.equal(connection.disconnects, 1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.sent.length, 0);
  assert.equal(timers.intervalHandlers.length, 0);
  assert.equal(timers.timeoutHandlers.length, 1);
});

test("close waits for a pending outcome-unknown connect and runs its exact retry once", async () => {
  const socket = new FakeSocket();
  const connect = deferred<HostedBrowserViewerConnection>();
  let retries = 0;
  const controller = attach(socket, () => connect.promise);

  socket.emitMessage();
  await nextTurn();
  socket.emitClose();
  connect.reject(new HostedBrowserViewerOutcomeUnknownError(async () => {
    retries += 1;
    return true;
  }));
  await controller.whenClosed();

  assert.equal(retries, 1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.sent.length, 0);
});

test("an outcome-unknown connect sends the typed code before its exact retry", async () => {
  const socket = new FakeSocket();
  let retries = 0;
  const controller = attach(socket, async () => {
    throw new HostedBrowserViewerOutcomeUnknownError(async () => {
      retries += 1;
      return true;
    });
  });

  socket.emitMessage();
  await waitFor(() => socket.closeCalls === 1);
  await controller.whenClosed();

  assert.equal(retries, 1);
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "error",
    code: "BROWSER_ACTION_OUTCOME_UNKNOWN",
  });
});

test("a synchronous state send failure still disconnects and cannot install timers", async () => {
  const socket = new FakeSocket();
  socket.sendThrows = true;
  const connection = fakeConnection();
  const timers = fakeTimers();
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => socket.closeCalls === 1);
  await controller.whenClosed();

  assert.equal(connection.disconnects, 1);
  assert.equal(timers.intervalHandlers.length, 0);
  assert.equal(timers.timeoutHandlers.length, 1);
});

test("an outcome-unknown frame is typed and its retry survives socket send failure", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const timers = fakeTimers();
  let retries = 0;
  connection.frame = async () => {
    throw new HostedBrowserViewerOutcomeUnknownError(async () => {
      retries += 1;
      return true;
    });
  };
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  socket.sendThrows = true;
  timers.intervalHandlers[1]?.();
  await waitFor(() => socket.closeCalls === 1);
  await controller.whenClosed();

  assert.equal(retries, 1);
  assert.equal(connection.disconnects, 1);
  assert.equal(socket.closeCalls, 1);
});

test("concurrent close and error events share one settlement and one exact disconnect", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const timers = fakeTimers();
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  socket.emitClose();
  socket.emitError();
  await controller.whenClosed();

  assert.equal(connection.disconnects, 1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(timers.clearedIntervals, 2);
  assert.equal(timers.clearedTimeouts, 2);
});

test("explicit return closes the socket and frame authority immediately", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const timers = fakeTimers();
  connection.dispatch = async () => ({
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "closed",
    reason: "returned_to_agent",
  });
  let messages = 0;
  const controller = attach(
    socket,
    async () => connection.value,
    timers,
    () => messages++ === 0
      ? authenticateMessage()
      : {
          version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
          type: "return_control",
          leaseId: "lease-1",
        },
  );

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  socket.emitMessage();
  await waitFor(() => socket.closeCalls === 1);
  await controller.whenClosed();

  assert.equal(connection.disconnects, 1);
  assert.equal(timers.clearedIntervals, 2);
  assert.equal(timers.clearedTimeouts, 2);
});

test("authority revalidation continues independently of frame capture", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const timers = fakeTimers();
  let revalidations = 0;
  connection.revalidate = async () => {
    revalidations += 1;
    throw new Error("BROWSER_SESSION_LOST");
  };
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  timers.intervalHandlers[0]?.();
  await waitFor(() => socket.closeCalls === 1);
  await controller.whenClosed();

  assert.equal(revalidations, 1);
  assert.equal(connection.disconnects, 1);
});

test("authority revalidation remains single-flight while one check is unresolved", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const timers = fakeTimers();
  const revalidation = deferred<void>();
  let revalidations = 0;
  connection.revalidate = async () => {
    revalidations += 1;
    await revalidation.promise;
  };
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  timers.intervalHandlers[0]?.();
  timers.intervalHandlers[0]?.();
  timers.intervalHandlers[0]?.();
  await nextTurn();
  assert.equal(revalidations, 1);

  revalidation.resolve();
  await nextTurn();
  timers.intervalHandlers[0]?.();
  await waitFor(() => revalidations === 2);
  await controller.close(1000, "test complete");
});

test("a silent peer is closed at the explicit authentication deadline without worker work", async () => {
  const socket = new FakeSocket();
  const timers = fakeTimers();
  let connects = 0;
  const controller = attach(socket, async () => {
    connects += 1;
    return fakeConnection().value;
  }, timers);

  assert.equal(timers.timeoutHandlers.length, 1);
  timers.timeoutHandlers[0]?.();
  await controller.whenClosed();

  assert.equal(connects, 0);
  assert.equal(socket.closeCalls, 1);
});

test("authentication deadline closes promptly while a late proven connection is cleaned exactly", async () => {
  const socket = new FakeSocket();
  const timers = fakeTimers();
  const connect = deferred<HostedBrowserViewerConnection>();
  const connection = fakeConnection();
  const controller = attach(socket, () => connect.promise, timers);

  socket.emitMessage();
  await nextTurn();
  assert.equal(timers.clearedTimeouts, 0);
  timers.timeoutHandlers[0]?.();
  await nextTurn();

  assert.equal(socket.closeCalls, 1);
  assert.equal(connection.disconnects, 0);
  connect.resolve(connection.value);
  await controller.whenClosed();
  assert.equal(connection.disconnects, 1);
  assert.equal(socket.closeCalls, 1);
});

test("a malformed first message closes without worker work", async () => {
  const socket = new FakeSocket();
  let connects = 0;
  const controller = attach(
    socket,
    async () => {
      connects += 1;
      return fakeConnection().value;
    },
    fakeTimers(),
    () => { throw new Error("invalid"); },
  );

  socket.emitMessage();
  await controller.whenClosed();

  assert.equal(connects, 0);
  assert.equal(socket.closeCalls, 1);
});

test("slow capture stays single-flight and late completion cannot delay or outlive close", async () => {
  const socket = new FakeSocket();
  const timers = fakeTimers();
  const connection = fakeConnection();
  const captured = deferred<Awaited<ReturnType<HostedBrowserViewerConnection["frame"]>>>();
  connection.frame = () => captured.promise;
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  timers.intervalHandlers[1]?.();
  timers.intervalHandlers[1]?.();
  timers.intervalHandlers[1]?.();
  assert.equal(connection.frameCalls, 1);

  socket.emitClose();
  await controller.whenClosed();
  assert.equal(connection.disconnects, 1);

  captured.resolve(frameMessage(1));
  await nextTurn();
  assert.equal(socket.sent.filter((value) => JSON.parse(value).type === "frame").length, 0);
});

test("buffered output pauses capture and retains at most one unsent frame", async () => {
  const socket = new FakeSocket();
  const timers = fakeTimers();
  const connection = fakeConnection();
  const captured = deferred<Awaited<ReturnType<HostedBrowserViewerConnection["frame"]>>>();
  connection.frame = () => captured.promise;
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  socket.bufferedAmount = 1;
  timers.intervalHandlers[1]?.();
  timers.intervalHandlers[1]?.();
  assert.equal(connection.frameCalls, 0);

  socket.bufferedAmount = 0;
  timers.intervalHandlers[1]?.();
  socket.bufferedAmount = 1;
  captured.resolve(frameMessage(1));
  await nextTurn();
  timers.intervalHandlers[1]?.();
  assert.equal(connection.frameCalls, 1);
  assert.equal(socket.sent.filter((value) => JSON.parse(value).type === "frame").length, 0);

  socket.bufferedAmount = 0;
  timers.intervalHandlers[1]?.();
  assert.equal(connection.frameCalls, 1);
  assert.equal(socket.sent.filter((value) => JSON.parse(value).type === "frame").length, 1);
  await controller.close(1000, "test complete");
});

test("buffered output coalesces state responses instead of growing socket output", async () => {
  const socket = new FakeSocket();
  const timers = fakeTimers();
  const connection = fakeConnection();
  const messages: HostedBrowserViewerClientMessageV1[] = [
    authenticateMessage(),
    pointerMessage("down", 1),
    pointerMessage("up", 2),
  ];
  const controller = attach(socket, async () => connection.value, timers, () => messages.shift()!);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  socket.bufferedAmount = 1;
  socket.emitMessage();
  socket.emitMessage();
  await waitFor(() => connection.dispatched.length === 2);
  assert.equal(socket.sent.length, 1);

  socket.bufferedAmount = 0;
  timers.intervalHandlers[1]?.();
  assert.equal(socket.sent.length, 2);
  assert.equal(connection.frameCalls, 0);
  await controller.close(1000, "test complete");
});

test("renewal and return control run ahead of pending input", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const firstInput = deferred<Awaited<ReturnType<HostedBrowserViewerConnection["dispatch"]>>>();
  let dispatches = 0;
  connection.dispatch = async () => {
    dispatches += 1;
    if (dispatches === 1) return firstInput.promise;
    return stateMessage(connection.value);
  };
  const messages: HostedBrowserViewerClientMessageV1[] = [
    authenticateMessage(),
    pointerMessage("down", 1),
    pointerMessage("up", 2),
    { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "renew_lease", leaseId: "lease-1" },
    { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "return_control", leaseId: "lease-1" },
  ];
  const controller = attach(socket, async () => connection.value, fakeTimers(), () => messages.shift()!);

  socket.emitMessage();
  await waitFor(() => socket.sent.length === 1);
  for (let index = 0; index < 4; index += 1) socket.emitMessage();
  await waitFor(() => connection.dispatched.length === 1);
  firstInput.resolve(stateMessage(connection.value));
  await waitFor(() => connection.dispatched.length === 4);

  assert.deepEqual(connection.dispatched.slice(0, 3).map((message) => message.type), [
    "input",
    "renew_lease",
    "return_control",
  ]);
  assert.deepEqual(connection.dispatched.slice(3).map((message) =>
    message.type === "input" ? message.input.phase : message.type), ["up"]);
  await controller.close(1000, "test complete");
});

test("pointer-move flood coalesces to the latest pending move", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const firstInput = deferred<Awaited<ReturnType<HostedBrowserViewerConnection["dispatch"]>>>();
  connection.dispatch = async () => connection.dispatched.length === 1
    ? firstInput.promise
    : stateMessage(connection.value);
  const messages: HostedBrowserViewerClientMessageV1[] = [authenticateMessage(), pointerMessage("down", 0)];
  for (let index = 1; index <= 100; index += 1) messages.push(pointerMessage("move", index));
  const controller = attach(socket, async () => connection.value, fakeTimers(), () => messages.shift()!);

  socket.emitMessage();
  await waitFor(() => socket.sent.length === 1);
  socket.emitMessage();
  await waitFor(() => connection.dispatched.length === 1);
  for (let index = 0; index < 100; index += 1) socket.emitMessage();
  firstInput.resolve(stateMessage(connection.value));
  await waitFor(() => connection.dispatched.length === 2);

  const latest = connection.dispatched[1];
  assert.equal(latest?.type, "input");
  assert.equal(latest?.type === "input" && latest.input.kind === "pointer" ? latest.input.x : -1, 100);
  await controller.close(1000, "test complete");
});

test("non-coalescible input is capped and closes an abusive peer", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const firstInput = deferred<Awaited<ReturnType<HostedBrowserViewerConnection["dispatch"]>>>();
  connection.dispatch = async () => firstInput.promise;
  const messages: HostedBrowserViewerClientMessageV1[] = [authenticateMessage()];
  for (let index = 0; index < 66; index += 1) messages.push(keyboardMessage(index));
  const controller = attach(socket, async () => connection.value, fakeTimers(), () => messages.shift()!);

  socket.emitMessage();
  await waitFor(() => socket.sent.length === 1);
  for (let index = 0; index < 66; index += 1) socket.emitMessage();
  await controller.whenClosed();

  assert.equal(connection.dispatched.length, 1);
  assert.equal(connection.disconnects, 1);
  assert.equal(socket.closeCalls, 1);
  firstInput.resolve(stateMessage(connection.value));
});

test("control messages share the explicit pending-memory bound", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const firstInput = deferred<Awaited<ReturnType<HostedBrowserViewerConnection["dispatch"]>>>();
  connection.dispatch = async () => firstInput.promise;
  const messages: HostedBrowserViewerClientMessageV1[] = [
    authenticateMessage(),
    pointerMessage("down", 0),
  ];
  for (let index = 0; index < 65; index += 1) {
    messages.push({
      version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
      type: "renew_lease",
      leaseId: `lease-${index}`,
    });
  }
  const controller = attach(socket, async () => connection.value, fakeTimers(), () => messages.shift()!);

  socket.emitMessage();
  await waitFor(() => socket.sent.length === 1);
  socket.emitMessage();
  await waitFor(() => connection.dispatched.length === 1);
  for (let index = 0; index < 65; index += 1) socket.emitMessage();
  await controller.whenClosed();

  assert.equal(connection.dispatched.length, 1);
  assert.equal(connection.disconnects, 1);
  assert.equal(socket.closeCalls, 1);
  firstInput.resolve(stateMessage(connection.value));
});

test("ordinary agent-operation frame unavailability skips a frame without closing", async () => {
  const socket = new FakeSocket();
  const connection = fakeConnection();
  const timers = fakeTimers();
  connection.frame = async () => { throw new Error(HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE); };
  const controller = attach(socket, async () => connection.value, timers);

  socket.emitMessage();
  await waitFor(() => timers.intervalHandlers.length === 2);
  timers.intervalHandlers[1]?.();
  await nextTurn();

  assert.equal(connection.frameCalls, 1);
  assert.equal(connection.disconnects, 0);
  assert.equal(socket.closeCalls, 0);
  await controller.close(1000, "test complete");
});

function attach(
  socket: FakeSocket,
  connect: () => Promise<HostedBrowserViewerConnection>,
  timers = fakeTimers(),
  parseMessage: Parameters<typeof attachHostedBrowserViewerSocket>[0]["parseMessage"] = () => authenticateMessage(),
) {
  return attachHostedBrowserViewerSocket({
    socket: socket as unknown as Parameters<typeof attachHostedBrowserViewerSocket>[0]["socket"],
    parseMessage,
    connect,
    timers,
  });
}

function authenticateMessage(): HostedBrowserViewerClientMessageV1 {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "authenticate",
    ticket: "ticket-1",
  };
}

function pointerMessage(
  phase: "move" | "down" | "up",
  x: number,
): HostedBrowserViewerClientMessageV1 {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "input",
    leaseId: "lease-1",
    input: {
      version: "desktop_browser_viewer_input_v1",
      kind: "pointer",
      phase,
      x,
      y: x,
      button: "left",
    },
  };
}

function keyboardMessage(index: number): HostedBrowserViewerClientMessageV1 {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "input",
    leaseId: "lease-1",
    input: {
      version: "desktop_browser_viewer_input_v1",
      kind: "keyboard",
      phase: "down",
      key: `key-${index}`,
    },
  };
}

function stateMessage(connection: HostedBrowserViewerConnection) {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "state" as const,
    state: connection.state,
  };
}

function frameMessage(sequence: number) {
  return {
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "frame" as const,
    frame: {
      version: "desktop_browser_viewer_frame_v1" as const,
      sessionId: "session-1",
      generation: 1,
      sequence,
      capturedAt: "2026-08-30T12:00:00.000Z",
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
    },
  };
}

function fakeConnection() {
  let disconnects = 0;
  let frameCalls = 0;
  const dispatched: HostedBrowserViewerClientMessageV1[] = [];
  let frame: HostedBrowserViewerConnection["frame"] = async () => ({
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "frame" as const,
    frame: {
      version: "desktop_browser_viewer_frame_v1" as const,
      sessionId: "session-1",
      generation: 1,
      sequence: 1,
      capturedAt: "2026-08-30T12:00:00.000Z",
      mediaType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
    },
  });
  let dispatch: HostedBrowserViewerConnection["dispatch"] = async () => ({
    version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
    type: "state" as const,
    state: value.state,
  });
  let revalidate: HostedBrowserViewerConnection["revalidate"] = async () => {};
  const value = {
    claims: {
      version: "hosted_browser_viewer_ticket_v1" as const,
      audience: "kestrel-one-browser-viewer" as const,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      sessionId: "session-1",
      generation: 1,
      actorId: "user-1",
      connectionId: "connection-1",
      nonce: "nonce-1",
      issuedAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T12:01:00.000Z",
    },
    state: {
      version: "desktop_browser_viewer_state_v1" as const,
      available: true,
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: "session-1",
      generation: 1,
      connectionId: "connection-1",
      sessionState: "ready" as const,
      takeoverRequested: false,
    },
    async disconnect() { disconnects += 1; },
    revalidate: () => revalidate(),
    dispatch: (message: HostedBrowserViewerClientMessageV1) => {
      dispatched.push(message);
      return dispatch(message);
    },
    frame: () => {
      frameCalls += 1;
      return frame();
    },
  } as unknown as HostedBrowserViewerConnection;
  return {
    value,
    get disconnects() { return disconnects; },
    get frameCalls() { return frameCalls; },
    dispatched,
    set frame(next: typeof frame) { frame = next; },
    set dispatch(next: typeof dispatch) { dispatch = next; },
    set revalidate(next: typeof revalidate) { revalidate = next; },
  };
}

function fakeTimers() {
  const intervalHandlers: Array<() => void> = [];
  const timeoutHandlers: Array<() => void> = [];
  let clearedIntervals = 0;
  let clearedTimeouts = 0;
  const handle = {} as ReturnType<typeof setTimeout>;
  return {
    intervalHandlers,
    timeoutHandlers,
    get clearedIntervals() { return clearedIntervals; },
    get clearedTimeouts() { return clearedTimeouts; },
    setInterval(handler: () => void) { intervalHandlers.push(handler); return handle; },
    clearInterval() { clearedIntervals += 1; },
    setTimeout(handler: () => void) { timeoutHandlers.push(handler); return handle; },
    clearTimeout() { clearedTimeouts += 1; },
  };
}

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls = 0;
  sendThrows = false;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  send(value: string) {
    if (this.sendThrows) throw new Error("send failed");
    this.sent.push(value);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  emitMessage() {
    this.#emit("message", Buffer.from("authenticate"));
  }

  emitClose() { this.#emit("close"); }
  emitError() { this.#emit("error"); }

  #emit(event: string, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("condition did not become true");
}
