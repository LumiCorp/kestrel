import type {
  DesktopUpdateBlocker,
  DesktopUpdateState,
} from "./contracts.js";

export interface DesktopUpdateInfo {
  version: string;
}

export interface DesktopUpdateProgress {
  percent: number;
}

export interface DesktopUpdaterAdapter {
  configureManualMode(): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  onUpdateAvailable(listener: (info: DesktopUpdateInfo) => void): void;
  onUpdateNotAvailable(listener: () => void): void;
  onDownloadProgress(listener: (progress: DesktopUpdateProgress) => void): void;
  onUpdateDownloaded(listener: (info: DesktopUpdateInfo) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface DesktopUpdateCoordinatorOptions {
  updater: DesktopUpdaterAdapter;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  currentVersion: string;
  getBlockers: () => Promise<DesktopUpdateBlocker[]>;
  prepareForInstall: () => Promise<DesktopUpdateBlocker[]>;
  publish: (state: DesktopUpdateState) => void;
}

export class DesktopUpdateCoordinator {
  readonly #options: DesktopUpdateCoordinatorOptions;
  #state: DesktopUpdateState;
  #operation: "check" | "download" | "install" | undefined;

  constructor(options: DesktopUpdateCoordinatorOptions) {
    this.#options = options;
    this.#state = initialDesktopUpdateState(options);
    if (!this.#state.supported) {
      return;
    }
    options.updater.configureManualMode();
    this.#subscribe();
  }

  state(): DesktopUpdateState {
    return copyState(this.#state);
  }

  async checkForUpdates(): Promise<DesktopUpdateState> {
    if (
      !this.#state.supported ||
      this.#operation !== undefined ||
      (this.#state.phase !== "idle" && this.#state.phase !== "error")
    ) {
      return this.state();
    }
    this.#operation = "check";
    this.#set({
      supported: true,
      phase: "checking",
      currentVersion: this.#options.currentVersion,
      blockers: [],
      message: "Checking for Desktop updates…",
    });
    try {
      await this.#options.updater.checkForUpdates();
    } catch (cause) {
      this.#fail("Update check failed", cause);
    } finally {
      this.#operation = undefined;
    }
    return this.state();
  }

  async downloadUpdate(): Promise<DesktopUpdateState> {
    if (
      !this.#state.supported ||
      this.#state.phase !== "available" ||
      this.#operation !== undefined
    ) {
      return this.state();
    }
    this.#operation = "download";
    this.#set({
      ...this.#state,
      phase: "downloading",
      progressPercent: 0,
      blockers: [],
      message: "Downloading the Desktop update…",
    });
    try {
      await this.#options.updater.downloadUpdate();
    } catch (cause) {
      this.#fail("Update download failed", cause);
    } finally {
      this.#operation = undefined;
    }
    return this.state();
  }

  async installUpdate(): Promise<DesktopUpdateState> {
    if (
      !this.#state.supported ||
      this.#operation !== undefined ||
      (this.#state.phase !== "downloaded" &&
        this.#state.phase !== "blocked")
    ) {
      return this.state();
    }
    this.#operation = "install";

    try {
      let blockers: DesktopUpdateBlocker[];
      blockers = await this.#options.getBlockers();
      if (blockers.length > 0) {
        this.#set({
          ...this.#state,
          phase: "blocked",
          blockers: blockers.map((blocker) => ({ ...blocker })),
          message: blockerMessage(blockers),
        });
        return this.state();
      }

      this.#set({
        ...this.#state,
        phase: "installing",
        blockers: [],
        message: "Preparing Kestrel to restart and install the update…",
      });
      const preparationBlockers = await this.#options.prepareForInstall();
      if (preparationBlockers.length > 0) {
        this.#set({
          ...this.#state,
          phase: "blocked",
          blockers: preparationBlockers.map((blocker) => ({ ...blocker })),
          message: blockerMessage(preparationBlockers),
        });
        return this.state();
      }
    } catch (cause) {
      this.#fail(
        "Kestrel could not safely prepare for update installation",
        cause,
      );
      return this.state();
    } finally {
      this.#operation = undefined;
    }
    this.#options.updater.quitAndInstall();
    return this.state();
  }

  #subscribe(): void {
    const updater = this.#options.updater;
    updater.onUpdateAvailable((info) => {
      if (this.#state.phase !== "checking") return;
      this.#set({
        supported: true,
        phase: "available",
        currentVersion: this.#options.currentVersion,
        targetVersion: info.version,
        blockers: [],
        message: `Kestrel Desktop ${info.version} is available.`,
      });
    });
    updater.onUpdateNotAvailable(() => {
      if (this.#state.phase !== "checking") return;
      this.#set({
        supported: true,
        phase: "idle",
        currentVersion: this.#options.currentVersion,
        blockers: [],
        message: "Kestrel Desktop is up to date.",
      });
    });
    updater.onDownloadProgress((progress) => {
      if (this.#state.phase !== "downloading") return;
      const progressPercent = Math.max(
        0,
        Math.min(100, Math.round(progress.percent)),
      );
      this.#set({
        ...this.#state,
        phase: "downloading",
        progressPercent,
        blockers: [],
        message: `Downloading the Desktop update… ${progressPercent}%`,
      });
    });
    updater.onUpdateDownloaded((info) => {
      if (this.#state.phase !== "downloading") return;
      this.#set({
        supported: true,
        phase: "downloaded",
        currentVersion: this.#options.currentVersion,
        targetVersion: info.version,
        progressPercent: 100,
        blockers: [],
        message: `Kestrel Desktop ${info.version} is ready to install.`,
      });
    });
    updater.onError((error) => {
      this.#fail("Desktop update failed", error);
    });
  }

  #fail(context: string, cause: unknown): void {
    this.#set({
      supported: this.#state.supported,
      phase: "error",
      currentVersion: this.#options.currentVersion,
      ...(this.#state.targetVersion !== undefined
        ? { targetVersion: this.#state.targetVersion }
        : {}),
      blockers: [],
      message: `${context}: ${errorMessage(cause)}`,
    });
  }

  #set(state: DesktopUpdateState): void {
    this.#state = copyState(state);
    this.#options.publish(this.state());
  }
}

export function initialDesktopUpdateState(
  input: Pick<
    DesktopUpdateCoordinatorOptions,
    "isPackaged" | "platform" | "arch" | "currentVersion"
  >,
): DesktopUpdateState {
  const supported =
    input.isPackaged && input.platform === "darwin" && input.arch === "arm64";
  return supported
    ? {
        supported: true,
        phase: "idle",
        currentVersion: input.currentVersion,
        blockers: [],
        message: "Ready to check for Desktop updates.",
      }
    : {
        supported: false,
        phase: "unsupported",
        currentVersion: input.currentVersion,
        blockers: [],
        message:
          "Manual updates are available in signed macOS Apple silicon builds.",
      };
}

function blockerMessage(blockers: DesktopUpdateBlocker[]): string {
  const count = blockers.reduce((total, blocker) => total + blocker.count, 0);
  const descriptions = blockers.map((blocker) => blocker.message);
  return `The update is ready, but Kestrel cannot restart while ${count} restart-unsafe operation${count === 1 ? "" : "s"} remain: ${descriptions.join(
    " ",
  )}`;
}

function copyState(state: DesktopUpdateState): DesktopUpdateState {
  return { ...state, blockers: [...state.blockers] };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
