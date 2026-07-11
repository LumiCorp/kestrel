import type { AppView } from "../contracts.js";
import type { FocusRegion } from "./keymap.js";

export interface InputKeySnapshot {
  escape?: boolean | undefined;
  ctrl?: boolean | undefined;
  tab?: boolean | undefined;
  return?: boolean | undefined;
  upArrow?: boolean | undefined;
  downArrow?: boolean | undefined;
  pageUp?: boolean | undefined;
  pageDown?: boolean | undefined;
  f1?: boolean | undefined;
}

export interface ChatFocusSnapshot {
  activeView: AppView;
  activeRegion: FocusRegion;
  chatTailLocked?: boolean | undefined;
}

export function normalizeRestoredActiveRegion(activeView: AppView, region: FocusRegion): FocusRegion {
  if (region === "command_bar") {
    return "composer";
  }
  if (region === "details" && activeView === "chat") {
    return "composer";
  }
  return region;
}

export function toPersistedActiveRegion(input: {
  activeRegion: FocusRegion;
  commandBarReturnRegion?: FocusRegion | undefined;
}): FocusRegion {
  if (input.activeRegion !== "command_bar") {
    return input.activeRegion;
  }
  return input.commandBarReturnRegion ?? "composer";
}

export function shouldSeedComposerFromChatInput(
  state: ChatFocusSnapshot,
  rawInput: string,
  key: InputKeySnapshot,
): boolean {
  if (state.activeView !== "chat" || state.activeRegion === "composer") {
    return false;
  }
  if (state.activeRegion === "chat_list" && state.chatTailLocked === false) {
    return false;
  }
  if (
    key.ctrl ||
    key.escape ||
    key.tab ||
    key.return ||
    key.upArrow ||
    key.downArrow ||
    key.pageUp ||
    key.pageDown ||
    key.f1
  ) {
    return false;
  }
  return rawInput.length > 0 &&
    rawInput.trimStart().length > 0 &&
    rawInput !== "/" &&
    rawInput !== "?" &&
    rawInput !== ":";
}
