import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInitialUiRuntimeState,
  buildWindow,
  computeUnreadIncrement,
  derivePaneRowCounts,
  deriveLayoutProfile,
  ensureCursorVisible,
  isAtTail,
  jumpCursor,
  moveCursor,
  pageCursor,
} from "../../cli/ink/store/UiStore.js";
import { LIGHT_THEME_PRESET_ID, resolveThemeConfig } from "../../cli/ink/theme/tokens.js";

test("deriveLayoutProfile maps viewport width to narrow/standard/wide", () => {
  assert.equal(deriveLayoutProfile(80), "narrow");
  assert.equal(deriveLayoutProfile(120), "standard");
  assert.equal(deriveLayoutProfile(160), "wide");
});

test("moveCursor clamps cursor and keeps it visible inside window", () => {
  const start = { offset: 0, cursor: 0, tailLocked: false };
  const moved = moveCursor(start, 20, 8, 5);
  assert.deepEqual(moved, {
    offset: 4,
    cursor: 8,
    tailLocked: false,
  });

  const clamped = moveCursor(moved, 20, -100, 5);
  assert.deepEqual(clamped, {
    offset: 0,
    cursor: 0,
    tailLocked: false,
  });
});

test("pageCursor jumps by window fraction and respects bounds", () => {
  const start = { offset: 0, cursor: 0, tailLocked: false };
  const pagedDown = pageCursor(start, 50, 10, "down");
  assert.equal(pagedDown.cursor, 8);
  assert.equal(pagedDown.offset, 0);

  const pagedUp = pageCursor(pagedDown, 50, 10, "up");
  assert.equal(pagedUp.cursor, 0);
  assert.equal(pagedUp.offset, 0);
});

test("buildWindow returns a bounded item slice around visible cursor", () => {
  const items = Array.from({ length: 12 }, (_, idx) => `item-${idx}`);
  const scroll = ensureCursorVisible(
    {
      offset: 0,
      cursor: 9,
      tailLocked: false,
    },
    items.length,
    4,
  );
  const windowed = buildWindow(items, scroll, 4);
  assert.equal(windowed.start, 6);
  assert.equal(windowed.end, 10);
  assert.deepEqual(windowed.items, ["item-6", "item-7", "item-8", "item-9"]);

  const end = jumpCursor(scroll, items.length, 4, "end");
  assert.equal(end.cursor, 11);
});

test("isAtTail and computeUnreadIncrement drive chat unread behavior", () => {
  assert.equal(isAtTail({ offset: 0, cursor: 3, tailLocked: true }, 4), true);
  assert.equal(isAtTail({ offset: 0, cursor: 1, tailLocked: false }, 4), false);

  assert.equal(
    computeUnreadIncrement({ currentUnread: 0, wasAtTail: true, appendedCount: 1 }),
    0,
  );
  assert.equal(
    computeUnreadIncrement({ currentUnread: 2, wasAtTail: false, appendedCount: 1 }),
    3,
  );
});

test("buildInitialUiRuntimeState migrates legacy inspector persisted state to detail drawer", () => {
  const now = new Date().toISOString();
  const persistedLegacy = {
    activeView: "logs",
    inspector: {
      active: true,
      source: "logs",
    },
  } as unknown as Parameters<typeof buildInitialUiRuntimeState>[0]["persisted"];

  const runtime = buildInitialUiRuntimeState({
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
    persisted: persistedLegacy,
  });

  assert.equal(runtime.detailDrawer.open, false);
  assert.equal(runtime.detailDrawer.source, "logs");
  assert.equal(runtime.layoutMode, "minimal");
});

test("buildInitialUiRuntimeState always forces minimal layout mode", () => {
  const now = new Date().toISOString();
  const runtime = buildInitialUiRuntimeState({
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
    persisted: {
      activeView: "chat",
      layoutMode: "dashboard" as unknown as "minimal",
    },
  });

  assert.equal(runtime.layoutMode, "minimal");
});

test("buildInitialUiRuntimeState normalizes persisted chat details focus back to composer", () => {
  const now = new Date().toISOString();
  const runtime = buildInitialUiRuntimeState({
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
    persisted: {
      activeView: "chat",
      activeRegion: "details",
    },
  });

  assert.equal(runtime.activeRegion, "composer");
  assert.equal(runtime.focusRegion, "composer");
});

test("buildInitialUiRuntimeState normalizes stale command-bar focus back to composer", () => {
  const now = new Date().toISOString();
  const runtime = buildInitialUiRuntimeState({
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
    persisted: {
      activeView: "chat",
      activeRegion: "command_bar",
    },
  });

  assert.equal(runtime.activeRegion, "composer");
  assert.equal(runtime.focusRegion, "composer");
});

test("buildInitialUiRuntimeState resolves active profile theme overrides", () => {
  const now = new Date().toISOString();
  const runtime = buildInitialUiRuntimeState({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "reference",
      theme: {
        brandAlt: "#00FF00",
      },
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
    persisted: {
      themeMode: "light",
    },
  });

  assert.equal(runtime.theme.brandAlt, "#00FF00");
  assert.equal(runtime.theme.text, resolveThemeConfig({ preset: LIGHT_THEME_PRESET_ID }).text);
  assert.equal(runtime.themeMode, "light");
  assert.equal(runtime.resolvedThemeMode, "light");
  assert.equal(runtime.themePreset, LIGHT_THEME_PRESET_ID);
  assert.equal(runtime.splashVisible, true);
});

test("derivePaneRowCounts uses single-screen rows in minimal mode", () => {
  const rowCounts = derivePaneRowCounts({
    viewport: {
      columns: 120,
      rows: 40,
    },
    layoutMode: "minimal",
  } as const);

  assert.equal(rowCounts.chat, rowCounts.logs);
  assert.equal(rowCounts.chat, rowCounts.sessions);
});
