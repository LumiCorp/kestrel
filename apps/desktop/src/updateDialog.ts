import type { DesktopUpdateState } from "./contracts.js";

export type DesktopUpdateDialogAction =
  | "download"
  | "install"
  | "later"
  | "dismiss";

export interface DesktopUpdateDialog {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export function buildDesktopUpdateDialog(
  state: DesktopUpdateState,
): DesktopUpdateDialog {
  if (state.phase === "available") {
    return {
      message: `Kestrel Desktop ${state.targetVersion ?? "update"} is available`,
      detail: state.message,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    };
  }
  if (state.phase === "downloaded" || state.phase === "blocked") {
    return {
      message:
        state.phase === "blocked"
          ? "Kestrel cannot restart yet"
          : `Kestrel Desktop ${state.targetVersion ?? "update"} is ready`,
      detail: state.message,
      buttons: ["Restart and Install", "Later"],
      defaultId: 0,
      cancelId: 1,
    };
  }
  return {
    message:
      state.phase === "idle"
        ? "Kestrel Desktop is up to date"
        : "Kestrel Desktop update",
    detail: state.message,
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
  };
}

export function resolveDesktopUpdateDialogAction(
  state: DesktopUpdateState,
  response: number,
): DesktopUpdateDialogAction {
  if (response !== 0) {
    return "later";
  }
  if (state.phase === "available") {
    return "download";
  }
  if (state.phase === "downloaded" || state.phase === "blocked") {
    return "install";
  }
  return "dismiss";
}
