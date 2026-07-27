import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalCoreDesktopEnvironmentConfigStore } from "../../src/localCore/desktopEnvironmentConfig.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "Desktop Environment configuration serializes concurrent organization updates",
  async (context) => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-desktop-environment-config-"),
    );
    context.after(() => rm(home, { recursive: true, force: true }));
    const store = new LocalCoreDesktopEnvironmentConfigStore(home);
    const createdAt = new Date().toISOString();

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        store.update((current) => ({
          ...current,
          enrollments: [
            ...current.enrollments,
            {
              requestId: `request-${index}`,
              baseUrl: "https://kestrel.example",
              desktopName: `Desktop ${index}`,
              fingerprint: `fingerprint-${index}`,
              verificationUrl: `https://kestrel.example/desktop/enroll/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              expiresAt: createdAt,
              status: "pending",
              createdAt,
            },
          ],
        })),
      ),
    );

    const config = await store.read();
    assert.equal(config.enrollments.length, 24);
    assert.deepEqual(
      new Set(config.enrollments.map((entry) => entry.requestId)),
      new Set(Array.from({ length: 24 }, (_, index) => `request-${index}`)),
    );
    assert.deepEqual((await readdir(path.join(home, "settings"))).sort(), [
      "desktop-environments-v1.json",
    ]);
  },
);
