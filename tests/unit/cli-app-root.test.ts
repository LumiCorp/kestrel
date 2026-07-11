import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToString } from "ink";

import {
  AppRoot,
  isComposerSoftLineBreakKeypress,
  resolveSplashInputAction,
  type InkAppController,
} from "../../cli/ink/AppRoot.js";
import { buildInitialUiRuntimeState } from "../../cli/ink/store/UiStore.js";

function buildController(state: ReturnType<typeof buildInitialUiRuntimeState>): InkAppController {
  const noop = () => {};
  return {
    getState: () => state,
    subscribe: () => () => {},
    getPaletteActions: () => [],
    getPaletteTotalCount: () => 0,
    updateViewport: noop,
    cycleFocus: noop,
    setActiveRegion: noop,
    openContextSearch: noop,
    openSlashPalette: noop,
    closeContextSearch: noop,
    moveActiveSelection: noop,
    pageActiveSelection: noop,
    jumpActiveSelection: noop,
    activatePrimaryAction: noop,
    goBack: noop,
    submitLine: noop,
    setDraft: noop,
    appendDraftLineBreak: noop,
    clearDraft: noop,
    dismissSplash: noop,
    toggleDetailDrawer: noop,
    toggleHelp: noop,
    openPalette: noop,
    closePalette: noop,
    focusComposerWithInput: noop,
    setPaletteQuery: noop,
    movePaletteSelection: noop,
    executePaletteSelection: noop,
    toggleErrorDetails: noop,
    moveErrorScroll: noop,
    pageErrorScroll: noop,
    jumpErrorScroll: noop,
    toggleLogsPause: noop,
    toggleLogsGrouped: noop,
    cycleLogLevel: noop,
    setLogEventQuery: noop,
    setSessionQuery: noop,
    createSession: noop,
    dismissError: noop,
    requestQuit: noop,
    confirmQuit: noop,
  };
}

test("AppRoot keeps chat visible behind the blocking error modal", () => {
  const now = new Date().toISOString();
  const state = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    activeSession: {
      name: "alpha",
      sessionId: "alpha-1",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
    sessions: [],
    transcript: [
      {
        role: "user",
        text: "again?",
        timestamp: now,
      },
    ],
  });

  state.splashVisible = false;
  state.viewport = { columns: 120, rows: 40 };
  state.statusLine = "failed | mcp:unknown";
  state.errorOverlay = {
    code: "LOOP_GUARD_TRIGGERED",
    message: "Loop guard triggered for step 'react.route' after repeated identical control states.",
    details: {
      guardType: "IDENTICAL_CONTROL_STATE",
    },
  };

  const text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));

  assert.match(text, /again\?/);
  assert.match(text, /Runtime Error \(LOOP_GUARD_TRIGGERED\)/);
});

test("AppRoot renders compact operator header and waiting composer state", () => {
  const now = new Date().toISOString();
  const state = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    activeSession: {
      name: "long-thread",
      sessionId: "thread-1",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
      pendingWaitFor: {
        kind: "user",
        eventType: "user.message",
        metadata: {
          prompt: "Confirm the next batch before continuing.",
        },
      },
    },
    sessions: [],
    transcript: [
      {
        role: "assistant",
        text: "Need confirmation before continuing.",
        timestamp: now,
      },
    ],
  });

  state.splashVisible = false;
  state.viewport = { columns: 120, rows: 40 };
  state.statusLine = "waiting (user.message) | mcp:unknown";
  state.chatUnreadCount = 4;
  state.scroll.chat = {
    offset: 0,
    cursor: 0,
    tailLocked: false,
  };

  const text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));

  assert.match(text, /long-thread · CHAT/);
  assert.doesNotMatch(text, /Kestrel Chat · Confirm the next batch before continuing/);
  assert.match(text, /1\/1 msgs · 1\/1 rows · history · 4 unread/);
  assert.match(text, /Waiting · Confirm the next batch before continuing/);
});

test("AppRoot labels delegation and recovery views explicitly", () => {
  const now = new Date().toISOString();
  const state = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    activeSession: {
      name: "ops-thread",
      sessionId: "thread-ops",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
    sessions: [],
    transcript: [],
  });

  state.splashVisible = false;
  state.viewport = { columns: 120, rows: 40 };

  state.activeView = "delegation";
  let text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));
  assert.match(text, /ops-thread · DELEGATION/);

  state.activeView = "recovery";
  text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));
  assert.match(text, /ops-thread · RECOVERY/);
});

test("AppRoot surfaces live reasoning updates while a run is active", () => {
  const now = new Date().toISOString();
  const state = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    activeSession: {
      name: "reasoning-thread",
      sessionId: "thread-reasoning",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
    },
    sessions: [],
    transcript: [
      {
        role: "assistant",
        text: "I am checking evidence.",
        timestamp: now,
      },
    ],
  });

  state.splashVisible = false;
  state.viewport = { columns: 120, rows: 40 };
  state.running = true;
  state.latestReasoningForSession = {
    version: "v1",
    runId: "run-123",
    sessionId: "thread-reasoning",
    ts: now,
    seq: 2,
    milestone: "tool_activity",
    message: "I am narrowing the next tool call to keep evidence quality high.",
  };

  const text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));

  assert.doesNotMatch(text, /Thinking: I am narrowing the next tool call to keep evidence quality high\./);
});

test("AppRoot omits adaptation and evidence summary from the compact header", () => {
  const now = new Date().toISOString();
  const state = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    activeSession: {
      name: "adaptation-thread",
      sessionId: "thread-adaptation",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
      operatorState: {
        interactionMode: "plan",
        allowedToolClasses: ["read_only"],
        latestAdaptation: {
          status: "auto_applied",
          recommendedAction: "compact",
          reason: "Context pressure exceeded budget.",
          at: now,
        },
        latestEvidenceRecovery: {
          attempts: 4,
          lowSignalAttempts: 2,
          consecutiveLowSignal: 1,
          broadenedSearchUsed: true,
          targetedFetchUsed: true,
          latestQuality: "mixed",
        },
      },
    },
    sessions: [],
    transcript: [],
  });

  state.splashVisible = false;
  state.viewport = { columns: 120, rows: 40 };
  state.statusLine = "running";

  const text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));

  assert.match(text, /adaptation-thread · CHAT/u);
  assert.doesNotMatch(text, /adapt=auto_applied action=compact evidence=4\/2 quality=mixed/u);
});

test("AppRoot omits multi-child supervision summary from the compact header", () => {
  const now = new Date().toISOString();
  const state = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
    },
    activeSession: {
      name: "supervision-thread",
      sessionId: "thread-supervision",
      profileId: "reference",
      createdAt: now,
      updatedAt: now,
      started: true,
      operatorState: {
        interactionMode: "build",
        actSubmode: "safe",
        allowedToolClasses: ["read_only"],
        childThreads: [
          {
            threadId: "child-waiting",
            title: "Waiting child",
            status: "WAITING",
            updatedAt: now,
            waitEventType: "user.approval",
            delegationStatus: "WAITING",
          },
          {
            threadId: "child-superseded",
            title: "Superseded child",
            status: "COMPLETED",
            updatedAt: now,
            delegationStatus: "CANCELLED",
            superseded: true,
          },
        ],
        latestCheckpointDisposition: "PENDING",
        nextAction: "switch_thread",
      },
    },
    sessions: [],
    transcript: [],
  });

  state.splashVisible = false;
  state.viewport = { columns: 120, rows: 40 };
  state.statusLine = "running";

  const text = renderToString(React.createElement(AppRoot, { controller: buildController(state) }));

  assert.match(text, /supervision-thread · CHAT/u);
  assert.doesNotMatch(text, /children=1\/2 superseded=1 fanIn=pending next=switch_thread/u);
});

test("composer soft line break is only shift+return (not raw CR/LF)", () => {
  assert.equal(isComposerSoftLineBreakKeypress("", { return: true, shift: true }), true);
  assert.equal(isComposerSoftLineBreakKeypress("\r", { return: true, shift: true }), false);
  assert.equal(isComposerSoftLineBreakKeypress("\n", { return: true, shift: true }), false);
  assert.equal(isComposerSoftLineBreakKeypress("", { return: true, shift: false }), false);
});

test("resolveSplashInputAction dismisses on space and quits on escape or ctrl-c", () => {
  assert.equal(resolveSplashInputAction(" ", {}), "dismiss");
  assert.equal(resolveSplashInputAction("", { escape: true }), "quit");
  assert.equal(resolveSplashInputAction("c", { ctrl: true }), "quit");
  assert.equal(resolveSplashInputAction("x", {}), undefined);
});
