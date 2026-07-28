import assert from "node:assert/strict";

import type {
  DesktopUpdateBlocker,
  DesktopUpdateState,
} from "../src/contracts.js";
import {
  DesktopUpdateCoordinator,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
  type DesktopUpdaterAdapter,
} from "../src/updater.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

class FakeUpdater implements DesktopUpdaterAdapter {
  manualMode = false;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  checkAction: () => Promise<unknown> = async () => undefined;
  downloadAction: () => Promise<unknown> = async () => undefined;
  updateAvailable?: (info: DesktopUpdateInfo) => void;
  updateNotAvailable?: () => void;
  downloadProgress?: (progress: DesktopUpdateProgress) => void;
  updateDownloaded?: (info: DesktopUpdateInfo) => void;
  error?: (error: Error) => void;

  configureManualMode(): void {
    this.manualMode = true;
  }
  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    return await this.checkAction();
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    return await this.downloadAction();
  }
  quitAndInstall(): void {
    this.installCalls += 1;
  }
  onUpdateAvailable(listener: (info: DesktopUpdateInfo) => void): void {
    this.updateAvailable = listener;
  }
  onUpdateNotAvailable(listener: () => void): void {
    this.updateNotAvailable = listener;
  }
  onDownloadProgress(
    listener: (progress: DesktopUpdateProgress) => void,
  ): void {
    this.downloadProgress = listener;
  }
  onUpdateDownloaded(listener: (info: DesktopUpdateInfo) => void): void {
    this.updateDownloaded = listener;
  }
  onError(listener: (error: Error) => void): void {
    this.error = listener;
  }
}

function coordinator(input: {
  updater?: FakeUpdater;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  blockers?: () => Promise<DesktopUpdateBlocker[]>;
  prepare?: () => Promise<DesktopUpdateBlocker[]>;
  published?: DesktopUpdateState[];
} = {}) {
  const updater = input.updater ?? new FakeUpdater();
  const published = input.published ?? [];
  const result = new DesktopUpdateCoordinator({
    updater,
    isPackaged: input.isPackaged ?? true,
    platform: input.platform ?? "darwin",
    arch: input.arch ?? "arm64",
    currentVersion: "0.6.0",
    getBlockers: input.blockers ?? (async () => []),
    prepareForInstall: input.prepare ?? (async () => []),
    publish: (state) => published.push(state),
  });
  return { result, updater, published };
}

contractTest(
  "desktop.hermetic",
  "unsupported environments remain inert",
  async () => {
    const { result, updater } = coordinator({ isPackaged: false });
    assert.equal(result.state().phase, "unsupported");
    assert.equal(updater.manualMode, false);
    assert.equal((await result.checkForUpdates()).phase, "unsupported");
    assert.equal(updater.checkCalls, 0);
  },
);

contractTest(
  "desktop.hermetic",
  "manual check, download progress, and completion publish every transition",
  async () => {
    const fake = new FakeUpdater();
    fake.checkAction = async () => {
      fake.updateAvailable?.({ version: "0.7.0" });
    };
    fake.downloadAction = async () => {
      fake.downloadProgress?.({ percent: 42.4 });
      fake.updateDownloaded?.({ version: "0.7.0" });
    };
    const { result, published } = coordinator({ updater: fake });

    assert.equal(fake.manualMode, true);
    assert.equal((await result.checkForUpdates()).phase, "available");
    assert.equal((await result.downloadUpdate()).phase, "downloaded");
    assert.deepEqual(
      published.map(({ phase }) => phase),
      ["checking", "available", "downloading", "downloading", "downloaded"],
    );
    assert.equal(published[3]?.progressPercent, 42);
    assert.equal(result.state().targetVersion, "0.7.0");
  },
);

contractTest(
  "desktop.hermetic",
  "not-available and updater errors produce durable user-facing states",
  async () => {
    const fake = new FakeUpdater();
    fake.checkAction = async () => fake.updateNotAvailable?.();
    const { result } = coordinator({ updater: fake });
    assert.equal((await result.checkForUpdates()).phase, "idle");
    assert.match(result.state().message, /up to date/u);

    fake.error?.(new Error("signature mismatch"));
    assert.equal(result.state().phase, "error");
    assert.match(result.state().message, /signature mismatch/u);
  },
);

contractTest(
  "desktop.hermetic",
  "check and download promise failures enter the error phase",
  async () => {
    const checkFake = new FakeUpdater();
    checkFake.checkAction = async () => {
      throw new Error("network unavailable");
    };
    const check = coordinator({ updater: checkFake }).result;
    assert.equal((await check.checkForUpdates()).phase, "error");
    assert.match(check.state().message, /network unavailable/u);

    const downloadFake = new FakeUpdater();
    downloadFake.checkAction = async () =>
      downloadFake.updateAvailable?.({ version: "0.7.0" });
    downloadFake.downloadAction = async () => {
      throw new Error("disk full");
    };
    const download = coordinator({ updater: downloadFake }).result;
    await download.checkForUpdates();
    assert.equal((await download.downloadUpdate()).phase, "error");
    assert.match(download.state().message, /disk full/u);
  },
);

contractTest(
  "desktop.hermetic",
  "blocked installation rechecks blockers and installs after work stops",
  async () => {
    const fake = new FakeUpdater();
    fake.checkAction = async () =>
      fake.updateAvailable?.({ version: "0.7.0" });
    fake.downloadAction = async () =>
      fake.updateDownloaded?.({ version: "0.7.0" });
    let blockers: DesktopUpdateBlocker[] = [
      {
        source: "desktop",
        code: "DESKTOP_EXECUTIONS_ACTIVE",
        message: "Desktop workspace executions are active.",
        count: 1,
      },
      {
        source: "local_core",
        code: "LOCAL_CORE_PROJECT_RUNS_ACTIVE",
        message: "Desktop project runs are active.",
        count: 1,
      },
    ];
    let prepared = 0;
    const { result } = coordinator({
      updater: fake,
      blockers: async () => blockers,
      prepare: async () => {
        prepared += 1;
        return [];
      },
    });
    await result.checkForUpdates();
    await result.downloadUpdate();

    const blocked = await result.installUpdate();
    assert.equal(blocked.phase, "blocked");
    assert.deepEqual(blocked.blockers, blockers);
    assert.equal(fake.installCalls, 0);

    blockers = [];
    const installing = await result.installUpdate();
    assert.equal(installing.phase, "installing");
    assert.equal(prepared, 1);
    assert.equal(fake.installCalls, 1);
  },
);

contractTest(
  "desktop.hermetic",
  "cleanup failure aborts installation",
  async () => {
    const fake = new FakeUpdater();
    fake.checkAction = async () =>
      fake.updateAvailable?.({ version: "0.7.0" });
    fake.downloadAction = async () =>
      fake.updateDownloaded?.({ version: "0.7.0" });
    const { result } = coordinator({
      updater: fake,
      prepare: async () => {
        throw new Error("database close failed");
      },
    });
    await result.checkForUpdates();
    await result.downloadUpdate();

    assert.equal((await result.installUpdate()).phase, "error");
    assert.match(result.state().message, /database close failed/u);
    assert.equal(fake.installCalls, 0);
  },
);

contractTest(
  "desktop.hermetic",
  "reentrant operations and stale updater events cannot advance state",
  async () => {
    const fake = new FakeUpdater();
    let releaseCheck = () => {};
    fake.checkAction = async () => {
      await new Promise<void>((resolve) => {
        releaseCheck = resolve;
      });
    };
    const { result } = coordinator({ updater: fake });

    const pendingCheck = result.checkForUpdates();
    assert.equal(result.state().phase, "checking");
    assert.equal((await result.checkForUpdates()).phase, "checking");
    assert.equal((await result.downloadUpdate()).phase, "checking");
    assert.equal(fake.checkCalls, 1);
    assert.equal(fake.downloadCalls, 0);

    fake.downloadProgress?.({ percent: 80 });
    fake.updateDownloaded?.({ version: "9.9.9" });
    assert.equal(result.state().phase, "checking");
    releaseCheck();
    await pendingCheck;

    fake.updateNotAvailable?.();
    assert.equal(result.state().phase, "idle");
    fake.updateAvailable?.({ version: "9.9.9" });
    assert.equal(result.state().phase, "idle");
  },
);
