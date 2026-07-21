import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "UiStateStore migrates v2 payload to v5 and forces minimal layout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-ui-state-"));
  const filePath = path.join(tempDir, "ui-state.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      state: {
        version: 2,
        activeView: "logs",
        activeRegion: "logs",
        layoutMode: "dashboard",
        paneSizes: {
          sessions: 0.2,
          chat: 0.6,
          logs: 0.2,
        },
        splashVisible: false,
        densityMode: "dense",
        layoutProfile: "wide",
        overlayLayout: "adaptive",
        logFilters: {
          level: "WARN",
          eventQuery: "queue",
          runIdQuery: "run-1",
          paused: true,
          grouped: false,
        },
        scroll: {
          chat: { offset: 1, cursor: 2, tailLocked: false },
          logs: { offset: 3, cursor: 4, tailLocked: true },
          sessions: { offset: 5, cursor: 6, tailLocked: false },
        },
        detailDrawer: {
          open: true,
          source: "logs",
        },
        paletteRecentCommands: ["/status"],
      },
    }),
    "utf8",
  );

  const store = new UiStateStore(tempDir);
  const loaded = await store.load();

  assert.equal(loaded?.version, 5);
  assert.equal(loaded?.layoutMode, "minimal");
  assert.equal(loaded?.activeView, "logs");
  assert.equal(loaded?.scroll.logs.cursor, 4);
  assert.equal(loaded?.logFilters.eventQuery, "queue");
  assert.equal(loaded?.themeMode, "system");
});

contractTest("runtime.hermetic", "UiStateStore migrates legacy theme preset to theme mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-ui-state-theme-"));
  const filePath = path.join(tempDir, "ui-state.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 4,
      state: {
        version: 4,
        activeView: "chat",
        activeRegion: "composer",
        layoutMode: "minimal",
        themePreset: "midnight-flight",
        paneSizes: {
          sessions: 0.28,
          chat: 0.44,
          logs: 0.28,
        },
        splashVisible: false,
        densityMode: "dense",
        layoutProfile: "standard",
        overlayLayout: "adaptive",
        logFilters: {
          level: "ALL",
          eventQuery: "",
          runIdQuery: "",
          paused: false,
          grouped: true,
        },
        scroll: {
          chat: { offset: 0, cursor: 0, tailLocked: true },
          logs: { offset: 0, cursor: 0, tailLocked: true },
          sessions: { offset: 0, cursor: 0, tailLocked: false },
        },
        detailDrawer: {
          open: false,
          source: "chat",
        },
        paletteRecentCommands: [],
      },
    }),
    "utf8",
  );

  const store = new UiStateStore(tempDir);
  const loaded = await store.load();

  assert.equal(loaded?.version, 5);
  assert.equal(loaded?.themeMode, "dark");
});

contractTest("runtime.hermetic", "UiStateStore migrates stale command-bar focus to composer", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-ui-state-command-bar-"));
  const filePath = path.join(tempDir, "ui-state.json");

  await writeFile(
    filePath,
    JSON.stringify({
      version: 5,
      state: {
        version: 5,
        activeView: "chat",
        activeRegion: "command_bar",
        layoutMode: "minimal",
        themeMode: "system",
        paneSizes: {
          sessions: 0.28,
          chat: 0.44,
          logs: 0.28,
        },
        splashVisible: false,
        densityMode: "dense",
        layoutProfile: "standard",
        overlayLayout: "adaptive",
        logFilters: {
          level: "ALL",
          eventQuery: "",
          runIdQuery: "",
          paused: false,
          grouped: true,
        },
        scroll: {
          chat: { offset: 0, cursor: 0, tailLocked: true },
          logs: { offset: 0, cursor: 0, tailLocked: true },
          sessions: { offset: 0, cursor: 0, tailLocked: false },
        },
        detailDrawer: {
          open: false,
          source: "chat",
        },
        paletteRecentCommands: [],
      },
    }),
    "utf8",
  );

  const store = new UiStateStore(tempDir);
  const loaded = await store.load();

  assert.equal(loaded?.activeRegion, "composer");
});

contractTest("runtime.hermetic", "UiStateStore save writes v5 envelope", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-ui-state-save-"));
  const store = new UiStateStore(tempDir);

  await store.save({
    version: 5,
    activeView: "chat",
    activeRegion: "composer",
    layoutMode: "minimal",
    paneSizes: {
      sessions: 0.28,
      chat: 0.44,
      logs: 0.28,
    },
    themeMode: "dark",
    splashVisible: false,
    densityMode: "dense",
    layoutProfile: "standard",
    overlayLayout: "adaptive",
    logFilters: {
      level: "ALL",
      eventQuery: "",
      runIdQuery: "",
      paused: false,
      grouped: true,
    },
    scroll: {
      chat: { offset: 0, cursor: 0, tailLocked: true },
      logs: { offset: 0, cursor: 0, tailLocked: true },
      sessions: { offset: 0, cursor: 0, tailLocked: false },
    },
    detailDrawer: {
      open: false,
      source: "chat",
    },
    paletteRecentCommands: [],
  });

  const raw = await readFile(path.join(tempDir, "ui-state.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    version: number;
    state: {
      version: number;
      themeMode?: string;
      layoutMode: string;
    };
  };

  assert.equal(parsed.version, 5);
  assert.equal(parsed.state.version, 5);
  assert.equal(parsed.state.layoutMode, "minimal");
  assert.equal(parsed.state.themeMode, "dark");
});
