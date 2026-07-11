import type { UiRuntimeState } from "./store/UiStore.js";
import { regionForDigit, type FocusRegion } from "./keymap.js";
import {
  isComposerSoftLineBreakKeypress,
  resolveSplashInputAction,
} from "./inputActions.js";
import { shouldSeedComposerFromChatInput } from "./focusPolicy.js";

export interface InkInputKey {
  escape?: boolean | undefined;
  ctrl?: boolean | undefined;
  shift?: boolean | undefined;
  tab?: boolean | undefined;
  return?: boolean | undefined;
  upArrow?: boolean | undefined;
  downArrow?: boolean | undefined;
  pageUp?: boolean | undefined;
  pageDown?: boolean | undefined;
  f1?: boolean | undefined;
}

export interface AppInputController {
  cycleFocus(reverse: boolean): void;
  setActiveRegion(region: FocusRegion): void;
  openContextSearch(): void;
  openSlashPalette(): void;
  closeContextSearch(): void;
  moveActiveSelection(delta: number): void;
  pageActiveSelection(direction: "up" | "down"): void;
  jumpActiveSelection(to: "start" | "end"): void;
  activatePrimaryAction(): void;
  goBack(): void;
  appendDraftLineBreak(): void;
  clearDraft(): void;
  dismissSplash(): void;
  toggleDetailDrawer(): void;
  toggleHelp(): void;
  openPalette(): void;
  closePalette(): void;
  focusComposerWithInput(input: string): void;
  movePaletteSelection(delta: number): void;
  executePaletteSelection(): void;
  toggleErrorDetails(): void;
  moveErrorScroll(delta: number): void;
  pageErrorScroll(direction: "up" | "down"): void;
  jumpErrorScroll(to: "start" | "end"): void;
  toggleLogsPause(): void;
  toggleLogsGrouped(): void;
  cycleLogLevel(): void;
  createSession(): void;
  dismissError(): void;
  requestQuit(): void;
  confirmQuit(): void;
}

export function dispatchAppInput(input: {
  state: UiRuntimeState;
  controller: AppInputController;
  input: string;
  key: InkInputKey;
}): void {
  const { state, controller, key } = input;
  const rawInput = input.input;
  const lower = rawInput.toLowerCase();
  const f1Pressed = key.f1 === true;
  const composerEditable = state.activeRegion === "composer" && isComposerEditable(state);

  if (state.splashVisible) {
    const splashAction = resolveSplashInputAction(rawInput, {
      escape: key.escape,
      ctrl: key.ctrl,
    });
    if (splashAction === "quit") {
      controller.confirmQuit();
      return;
    }
    if (splashAction === "dismiss") {
      controller.dismissSplash();
    }
    return;
  }

  if (state.errorOverlay !== undefined) {
    if (key.escape) {
      controller.dismissError();
      return;
    }
    if (lower === "d") {
      controller.toggleErrorDetails();
      return;
    }
    if (key.upArrow || rawInput === "k") {
      controller.moveErrorScroll(-1);
      return;
    }
    if (key.downArrow || rawInput === "j") {
      controller.moveErrorScroll(1);
      return;
    }
    if (key.pageUp) {
      controller.pageErrorScroll("up");
      return;
    }
    if (key.pageDown) {
      controller.pageErrorScroll("down");
      return;
    }
    if (rawInput === "g") {
      controller.jumpErrorScroll("start");
      return;
    }
    if (rawInput === "G") {
      controller.jumpErrorScroll("end");
    }
    return;
  }

  if (key.ctrl && rawInput === "c") {
    if (state.quitConfirm) {
      controller.confirmQuit();
    } else {
      controller.requestQuit();
    }
    return;
  }

  if (state.paletteOpen) {
    if (key.escape) {
      controller.closePalette();
      return;
    }
    if (key.upArrow) {
      controller.movePaletteSelection(-1);
      return;
    }
    if (key.downArrow) {
      controller.movePaletteSelection(1);
      return;
    }
    if (key.return) {
      controller.executePaletteSelection();
    }
    return;
  }

  if (key.ctrl && rawInput === "6") {
    controller.openPalette();
    return;
  }

  const digitRegion = key.ctrl ? regionForDigit(rawInput) : undefined;
  if (digitRegion !== undefined) {
    controller.setActiveRegion(digitRegion);
    return;
  }

  if (state.helpOpen) {
    if (key.escape || f1Pressed || rawInput === "?") {
      controller.toggleHelp();
    }
    return;
  }

  if (composerEditable) {
    if (f1Pressed) {
      controller.toggleHelp();
      return;
    }
    if (key.upArrow) {
      controller.moveActiveSelection(-1);
      return;
    }
    if (key.downArrow) {
      controller.moveActiveSelection(1);
      return;
    }
    if (key.pageUp) {
      controller.pageActiveSelection("up");
      return;
    }
    if (key.pageDown) {
      controller.pageActiveSelection("down");
      return;
    }
    if (key.ctrl && lower === "p") {
      controller.openPalette();
      return;
    }
    if (key.ctrl && lower === "f") {
      controller.openContextSearch();
      return;
    }
    if (key.escape) {
      controller.clearDraft();
      return;
    }
    if (isComposerSoftLineBreakKeypress(rawInput, key)) {
      controller.appendDraftLineBreak();
      return;
    }
    if (key.tab) {
      controller.cycleFocus(Boolean(key.shift));
    }
    return;
  }

  if (f1Pressed || rawInput === "?") {
    controller.toggleHelp();
    return;
  }

  if (key.ctrl && lower === "p") {
    controller.openPalette();
    return;
  }

  if (rawInput === ":") {
    controller.openPalette();
    return;
  }

  if (state.logsFilterMode || state.sessionsSearchMode) {
    if (key.escape || key.return) {
      controller.closeContextSearch();
    }
    return;
  }

  if (key.ctrl && lower === "f") {
    controller.openContextSearch();
    return;
  }

  if (rawInput === "/") {
    controller.openSlashPalette();
    return;
  }

  if (key.escape) {
    controller.goBack();
    return;
  }

  if (key.tab) {
    controller.cycleFocus(Boolean(key.shift));
    return;
  }

  if (state.activeRegion === "sessions" && lower === "n") {
    controller.createSession();
    return;
  }

  if (state.activeRegion === "logs") {
    if (lower === "p") {
      controller.toggleLogsPause();
      return;
    }
    if (lower === "m") {
      controller.toggleLogsGrouped();
      return;
    }
    if (lower === "l") {
      controller.cycleLogLevel();
      return;
    }
  }

  if (shouldSeedComposerFromChatInput({
    activeView: state.activeView,
    activeRegion: state.activeRegion,
    chatTailLocked: state.scroll.chat.tailLocked,
  }, rawInput, key)) {
    controller.focusComposerWithInput(rawInput);
    return;
  }

  if (key.upArrow || rawInput === "k") {
    controller.moveActiveSelection(-1);
    return;
  }

  if (key.downArrow || rawInput === "j") {
    controller.moveActiveSelection(1);
    return;
  }

  if (key.pageUp) {
    controller.pageActiveSelection("up");
    return;
  }

  if (key.pageDown) {
    controller.pageActiveSelection("down");
    return;
  }

  if (rawInput === "g") {
    controller.jumpActiveSelection("start");
    return;
  }

  if (rawInput === "G") {
    controller.jumpActiveSelection("end");
    return;
  }

  if (lower === "i") {
    controller.toggleDetailDrawer();
    return;
  }

  if (key.return) {
    controller.activatePrimaryAction();
  }
}

function isComposerEditable(state: UiRuntimeState): boolean {
  return state.activeRegion === "composer";
}
