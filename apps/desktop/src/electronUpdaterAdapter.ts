import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";

import type { DesktopUpdaterAdapter } from "./updater.js";

export function createElectronUpdaterAdapter(
  updater: AppUpdater,
): DesktopUpdaterAdapter {
  return {
    configureManualMode() {
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
    },
    async checkForUpdates() {
      return await updater.checkForUpdates();
    },
    async downloadUpdate() {
      return await updater.downloadUpdate();
    },
    quitAndInstall() {
      updater.quitAndInstall();
    },
    onUpdateAvailable(listener) {
      updater.on("update-available", (info: UpdateInfo) => listener(info));
    },
    onUpdateNotAvailable(listener) {
      updater.on("update-not-available", () => listener());
    },
    onDownloadProgress(listener) {
      updater.on("download-progress", (progress: ProgressInfo) =>
        listener(progress),
      );
    },
    onUpdateDownloaded(listener) {
      updater.on("update-downloaded", (info: UpdateInfo) => listener(info));
    },
    onError(listener) {
      updater.on("error", (error: Error) => listener(error));
    },
  };
}
