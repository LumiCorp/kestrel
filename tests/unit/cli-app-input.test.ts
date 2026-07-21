import assert from "node:assert/strict";

import {
  dispatchAppInput,
  type AppInputController,
  type InkInputKey,
} from "../../cli/ink/inputDispatcher.js";
import { buildInitialUiRuntimeState, type UiRuntimeState } from "../../cli/ink/store/UiStore.js";
import { contractTest } from "../helpers/contract-test.js";


function makeState(): UiRuntimeState {
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
    transcript: [],
  });
  state.splashVisible = false;
  return state;
}

function makeController(calls: string[]): AppInputController {
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(args.length > 0 ? `${name}:${args.join(",")}` : name);
  };
  return {
    cycleFocus: record("cycleFocus"),
    setActiveRegion: record("setActiveRegion"),
    openContextSearch: record("openContextSearch"),
    openSlashPalette: record("openSlashPalette"),
    closeContextSearch: record("closeContextSearch"),
    moveActiveSelection: record("moveActiveSelection"),
    pageActiveSelection: record("pageActiveSelection"),
    jumpActiveSelection: record("jumpActiveSelection"),
    activatePrimaryAction: record("activatePrimaryAction"),
    goBack: record("goBack"),
    appendDraftLineBreak: record("appendDraftLineBreak"),
    clearDraft: record("clearDraft"),
    dismissSplash: record("dismissSplash"),
    toggleDetailDrawer: record("toggleDetailDrawer"),
    toggleHelp: record("toggleHelp"),
    openPalette: record("openPalette"),
    closePalette: record("closePalette"),
    focusComposerWithInput: record("focusComposerWithInput"),
    movePaletteSelection: record("movePaletteSelection"),
    executePaletteSelection: record("executePaletteSelection"),
    toggleErrorDetails: record("toggleErrorDetails"),
    moveErrorScroll: record("moveErrorScroll"),
    pageErrorScroll: record("pageErrorScroll"),
    jumpErrorScroll: record("jumpErrorScroll"),
    toggleLogsPause: record("toggleLogsPause"),
    toggleLogsGrouped: record("toggleLogsGrouped"),
    cycleLogLevel: record("cycleLogLevel"),
    createSession: record("createSession"),
    dismissError: record("dismissError"),
    requestQuit: record("requestQuit"),
    confirmQuit: record("confirmQuit"),
  };
}

function dispatch(state: UiRuntimeState, input: string, key: InkInputKey = {}): string[] {
  const calls: string[] = [];
  dispatchAppInput({
    state,
    controller: makeController(calls),
    input,
    key,
  });
  return calls;
}

contractTest("runtime.hermetic", "splash owns input before global shortcuts", () => {
  const state = makeState();
  state.splashVisible = true;

  assert.deepEqual(dispatch(state, "c", { ctrl: true }), ["confirmQuit"]);
  assert.deepEqual(dispatch(state, " ", {}), ["dismissSplash"]);
});

contractTest("runtime.hermetic", "error overlay owns escape, details, and scroll keys", () => {
  const state = makeState();
  state.errorOverlay = { message: "boom" };

  assert.deepEqual(dispatch(state, "", { escape: true }), ["dismissError"]);
  assert.deepEqual(dispatch(state, "d"), ["toggleErrorDetails"]);
  assert.deepEqual(dispatch(state, "k"), ["moveErrorScroll:-1"]);
  assert.deepEqual(dispatch(state, "", { pageDown: true }), ["pageErrorScroll:down"]);
  assert.deepEqual(dispatch(state, "G"), ["jumpErrorScroll:end"]);
});

contractTest("runtime.hermetic", "help overlay owns close keys before normal navigation", () => {
  const state = makeState();
  state.helpOpen = true;

  assert.deepEqual(dispatch(state, "?"), ["toggleHelp"]);
  assert.deepEqual(dispatch(state, "", { escape: true }), ["toggleHelp"]);
  assert.deepEqual(dispatch(state, "", { f1: true }), ["toggleHelp"]);
});

contractTest("runtime.hermetic", "palette owns close, move, and select keys", () => {
  const state = makeState();
  state.paletteOpen = true;
  state.activeRegion = "command_bar";

  assert.deepEqual(dispatch(state, "", { escape: true }), ["closePalette"]);
  assert.deepEqual(dispatch(state, "j"), []);
  assert.deepEqual(dispatch(state, "k"), []);
  assert.deepEqual(dispatch(state, "?"), []);
  assert.deepEqual(dispatch(state, ":"), []);
  assert.deepEqual(dispatch(state, "1", { ctrl: true }), []);
  assert.deepEqual(dispatch(state, "p", { ctrl: true }), []);
  assert.deepEqual(dispatch(state, "", { upArrow: true }), ["movePaletteSelection:-1"]);
  assert.deepEqual(dispatch(state, "", { downArrow: true }), ["movePaletteSelection:1"]);
  assert.deepEqual(dispatch(state, "", { return: true }), ["executePaletteSelection"]);
});

contractTest("runtime.hermetic", "composer owns palette, search, draft clear, newline, and tab keys", () => {
  const state = makeState();
  state.activeRegion = "composer";

  assert.deepEqual(dispatch(state, "p", { ctrl: true }), ["openPalette"]);
  assert.deepEqual(dispatch(state, "f", { ctrl: true }), ["openContextSearch"]);
  assert.deepEqual(dispatch(state, "", { escape: true }), ["clearDraft"]);
  assert.deepEqual(dispatch(state, "", { shift: true, return: true }), ["appendDraftLineBreak"]);
  assert.deepEqual(dispatch(state, "", { tab: true, shift: true }), ["cycleFocus:true"]);
  assert.deepEqual(dispatch(state, "", { upArrow: true }), ["moveActiveSelection:-1"]);
  assert.deepEqual(dispatch(state, "", { downArrow: true }), ["moveActiveSelection:1"]);
  assert.deepEqual(dispatch(state, "k"), []);
  assert.deepEqual(dispatch(state, "j"), []);
  assert.deepEqual(dispatch(state, "g"), []);
  assert.deepEqual(dispatch(state, "G"), []);
});

contractTest("runtime.hermetic", "composer remains editable for plain queued messages while a run is active", () => {
  const state = makeState();
  state.activeRegion = "composer";
  state.running = true;
  state.chatDraft = "queue this after the current run";

  assert.deepEqual(dispatch(state, "", { escape: true }), ["clearDraft"]);
  assert.deepEqual(dispatch(state, "", { shift: true, return: true }), ["appendDraftLineBreak"]);
});

contractTest("runtime.hermetic", "global focus, search, and slash keys route outside the composer", () => {
  const state = makeState();
  state.activeRegion = "chat_list";

  assert.deepEqual(dispatch(state, "1", { ctrl: true }), ["setActiveRegion:sessions"]);
  assert.deepEqual(dispatch(state, "f", { ctrl: true }), ["openContextSearch"]);
  assert.deepEqual(dispatch(state, "/"), ["openSlashPalette"]);
});

contractTest("runtime.hermetic", "chat view printable input seeds the composer when focus is on transcript", () => {
  const state = makeState();
  state.activeView = "chat";
  state.activeRegion = "chat_list";

  assert.deepEqual(dispatch(state, "h"), ["focusComposerWithInput:h"]);
  assert.deepEqual(dispatch(state, "j"), ["focusComposerWithInput:j"]);
  assert.deepEqual(dispatch(state, "/"), ["openSlashPalette"]);
});

contractTest("runtime.hermetic", "chat transcript keeps list keys while browsing history", () => {
  const state = makeState();
  state.activeView = "chat";
  state.activeRegion = "chat_list";
  state.scroll.chat.tailLocked = false;

  assert.deepEqual(dispatch(state, "j"), ["moveActiveSelection:1"]);
  assert.deepEqual(dispatch(state, "i"), ["toggleDetailDrawer"]);
  assert.deepEqual(dispatch(state, "h"), []);
});

contractTest("runtime.hermetic", "context search closes on escape or return", () => {
  const state = makeState();
  state.activeRegion = "logs";
  state.logsFilterMode = true;

  assert.deepEqual(dispatch(state, "", { escape: true }), ["closeContextSearch"]);
  assert.deepEqual(dispatch(state, "", { return: true }), ["closeContextSearch"]);
  assert.deepEqual(dispatch(state, "/"), []);
});
