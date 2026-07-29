import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { DesktopUpdateState } from "../../apps/desktop/src/contracts.js";
import {
  DESKTOP_OTA_SERVER_PREFIX,
  isValidDesktopOtaRequestPath,
  parseDesktopByteRange,
  resolveDesktopOtaArtifactResponse,
  summarizeDesktopOtaTransfer,
} from "../../scripts/desktop-ota-https-server.js";
import {
  assertDesktopOtaBusyBlocker,
  resolveDesktopOtaInstalledAppPath,
  runDesktopOtaCleanupActions,
  sanitizeDesktopUpdaterLog,
  shapeDesktopOtaEvidence,
} from "../../scripts/desktop-ota-gate.js";

test("Desktop OTA renderer callbacks resolve the preload bridge in page context", () => {
  const source = readFileSync(
    new URL("../../scripts/desktop-ota-smoke.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /requireDesktopBridge/u);
  assert.equal(
    source.match(
      /\(globalThis as DesktopPageGlobal\)\.kestrelDesktop/gu,
    )?.length,
    14,
  );
});

test("Desktop OTA range parser produces exact single-range responses", () => {
  assert.deepEqual(parseDesktopByteRange("bytes=10-19", 100), {
    start: 10,
    end: 19,
    length: 10,
    contentRange: "bytes 10-19/100",
  });
  assert.deepEqual(parseDesktopByteRange("bytes=90-", 100), {
    start: 90,
    end: 99,
    length: 10,
    contentRange: "bytes 90-99/100",
  });
  assert.deepEqual(parseDesktopByteRange("bytes=-8", 100), {
    start: 92,
    end: 99,
    length: 8,
    contentRange: "bytes 92-99/100",
  });
  assert.throws(() => parseDesktopByteRange("bytes=100-101", 100));
  assert.throws(() => parseDesktopByteRange("bytes=0-1,4-5", 100));
  assert.throws(() => parseDesktopByteRange("items=0-1", 100));
});

test("Desktop OTA artifact decisions expose 206, 416, and injected 503", () => {
  assert.deepEqual(
    resolveDesktopOtaArtifactResponse({
      name: "Kestrel-0.7.0-mac-arm64.zip",
      size: 1_000,
      range: "bytes=100-199",
    }),
    {
      status: 206,
      bytes: 100,
      byteRange: {
        start: 100,
        end: 199,
        length: 100,
        contentRange: "bytes 100-199/1000",
      },
      contentRange: "bytes 100-199/1000",
    },
  );
  assert.deepEqual(
    resolveDesktopOtaArtifactResponse({
      name: "Kestrel-0.7.0-mac-arm64.zip",
      size: 1_000,
      range: "bytes=1000-",
    }),
    {
      status: 416,
      bytes: 0,
      contentRange: "bytes */1000",
    },
  );
  assert.deepEqual(
    resolveDesktopOtaArtifactResponse({
      name: "Kestrel-0.7.0-ota.3-mac-arm64.zip.blockmap",
      size: 500,
      faultBlockmapName: "Kestrel-0.7.0-ota.3-mac-arm64.zip.blockmap",
    }),
    {
      status: 503,
      bytes: 27,
      fault: "blockmap_503",
    },
  );
});

test("Desktop OTA server rejects traversal and non-exact routes", () => {
  assert.equal(
    isValidDesktopOtaRequestPath(
      `${DESKTOP_OTA_SERVER_PREFIX}/Kestrel-0.7.0-mac-arm64.zip`,
    ),
    true,
  );
  assert.equal(
    isValidDesktopOtaRequestPath(
      `${DESKTOP_OTA_SERVER_PREFIX}/../secret`,
    ),
    false,
  );
  assert.equal(
    isValidDesktopOtaRequestPath(
      `${DESKTOP_OTA_SERVER_PREFIX}/%2e%2e%2fsecret`,
    ),
    false,
  );
  assert.equal(
    isValidDesktopOtaRequestPath(
      `${DESKTOP_OTA_SERVER_PREFIX}/artifact.zip?token=secret`,
    ),
    false,
  );
});

test("Desktop OTA accounting distinguishes full and differential transfers", () => {
  const differential = summarizeDesktopOtaTransfer({
    phase: "final-differential",
    targetZipName: "Kestrel-0.7.0-mac-arm64.zip",
    targetZipSize: 1_000,
    ledger: [
      {
        sequence: 1,
        at: "2026-07-29T00:00:00.000Z",
        phase: "final-differential",
        method: "GET",
        path: `${DESKTOP_OTA_SERVER_PREFIX}/Kestrel-0.7.0-mac-arm64.zip`,
        status: 206,
        range: "bytes=0-99",
        contentRange: "bytes 0-99/1000",
        bytes: 100,
      },
      {
        sequence: 2,
        at: "2026-07-29T00:00:01.000Z",
        phase: "final-differential",
        method: "GET",
        path: `${DESKTOP_OTA_SERVER_PREFIX}/Kestrel-0.7.0-mac-arm64.zip`,
        status: 206,
        range: "bytes=900-999",
        contentRange: "bytes 900-999/1000",
        bytes: 100,
      },
    ],
  });
  assert.deepEqual(differential, {
    fullBytes: 0,
    rangeBytes: 200,
    rangeRequests: 2,
    partialResponses: 2,
    faultResponses: 0,
    differential: true,
  });
});

test("Desktop OTA cleanup attempts every action and aggregates failures", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    runDesktopOtaCleanupActions([
      {
        label: "first",
        run() {
          attempted.push("first");
          throw new Error("first failed");
        },
      },
      {
        label: "second",
        async run() {
          attempted.push("second");
          throw new Error("second failed");
        },
      },
      {
        label: "third",
        run() {
          attempted.push("third");
        },
      },
    ]),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(
        (error as AggregateError).errors.map((entry) => entry.message),
        ["first: first failed", "second: second failed"],
      );
      return true;
    },
  );
  assert.deepEqual(attempted, ["first", "second", "third"]);
});

test("Desktop OTA evidence is bounded and excludes unselected log content", () => {
  const blocked: DesktopUpdateState = {
    supported: true,
    phase: "blocked",
    currentVersion: "0.7.0-ota.3",
    targetVersion: "0.7.0",
    blockers: [
      {
        source: "local_core",
        code: "LOCAL_CORE_PROJECT_RUNS_ACTIVE",
        message: "A managed project run is active.",
        count: 1,
      },
    ],
    message: "Update blocked.",
  };
  const blocker = assertDesktopOtaBusyBlocker({
    state: blocked,
    runStillActive: true,
  });
  const evidence = shapeDesktopOtaEvidence({
    sourceCommit: "a".repeat(40),
    artifactEvidence: [],
    transitions: [blocked],
    requestLedger: [],
    transfers: [],
    updaterLog: [
      "electron-updater differential Full: 1000, To download: 200",
      "Authorization: Bearer top-secret",
      "client_id=public-but-not-evidence",
    ].join("\n"),
    screenshots: [],
    blocker,
    persistenceMarker: "marker",
    finalFeedUrl: "https://updates.lumicorp.ai/desktop/stable/arm64",
    cleanup: { attempted: ["server"], completed: ["server"] },
  });
  const serialized = JSON.stringify(evidence);
  assert.match(serialized, /desktop-ota-smoke-v1/u);
  assert.doesNotMatch(serialized, /top-secret|public-but-not-evidence/u);
  assert.deepEqual(
    sanitizeDesktopUpdaterLog(
      "electron-updater token=secret differential\nordinary secret",
    ),
    ["electron-updater [REDACTED] differential"],
  );
  assert.equal(
    resolveDesktopOtaInstalledAppPath({ runId: "123-abc" }),
    "/Applications/Kestrel OTA Gate 123-abc.app",
  );
});
