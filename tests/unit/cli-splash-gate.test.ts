import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToString } from "ink";

import { SplashGate } from "../../cli/ink/splash/SplashGate.js";
import type { SplashPreflightState } from "../../cli/contracts.js";

function createPreflightState(
  overrides: Partial<SplashPreflightState> = {},
): SplashPreflightState {
  return {
    phase: "ready",
    summary: "pre-flight complete",
    checks: [
      { id: "profiles", label: "profiles", state: "ok", detail: "reference" },
      { id: "runner", label: "runner", state: "ok", detail: "child" },
      { id: "mcp", label: "mcp", state: "warn", detail: "0/1 healthy, tools=0, unhealthy=docker-gw" },
    ],
    ...overrides,
  };
}

test("SplashGate renders the ascii mark and dismiss prompt when visible", () => {
  const text = renderToString(
    React.createElement(SplashGate, {
      visible: true,
      onDismiss: () => {},
      preflight: createPreflightState(),
    }),
  );
  assert.match(text, /Press Space to continue/);
  assert.match(text, /AUTONOMOUS RUNTIME/);
  assert.match(text, /profiles/);
  assert.match(text, /WARN/);
});

test("SplashGate falls back to a readable KESTREL wordmark at narrow widths", () => {
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: 28,
  });

  try {
    const text = renderToString(
      React.createElement(SplashGate, {
        visible: true,
        onDismiss: () => {},
        preflight: createPreflightState(),
      }),
    );
    assert.match(text, /KESTREL/);
    assert.match(text, /Press Space to/);
    assert.match(text, /continue/);
  } finally {
    if (originalColumns) {
      Object.defineProperty(process.stdout, "columns", originalColumns);
    } else {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        enumerable: true,
        value: undefined,
      });
    }
  }
});

test("SplashGate shows failure summary and keeps the prompt hidden until pre-flight succeeds", () => {
  const text = renderToString(
    React.createElement(SplashGate, {
      visible: true,
      onDismiss: () => {},
      preflight: createPreflightState({
        phase: "failed",
        summary: "missing OPENROUTER_API_KEY",
        checks: [
          { id: "provider", label: "credentials", state: "fail", detail: "missing OPENROUTER_API_KEY" },
        ],
      }),
    }),
  );
  assert.match(text, /missing OPENROUTER_API_KEY/);
  assert.doesNotMatch(text, /Press Space to continue/);
});

test("SplashGate wraps long failure details instead of truncating them", () => {
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: 52,
  });

  try {
    const text = renderToString(
      React.createElement(SplashGate, {
        visible: true,
        onDismiss: () => {},
        preflight: createPreflightState({
          phase: "failed",
          summary:
            "Runner process exited with code 1: Error: Cannot find module './missing-runner-dependency.js'",
          checks: [
            { id: "handshake", label: "handshake", state: "fail", detail: "runner exited" },
          ],
        }),
      }),
    );
    assert.match(text, /Runner process exited with code 1:/);
    assert.match(text, /Cannot find module/);
    assert.doesNotMatch(text, /Runner process exited with code 1: Error: Cannot find module '\.\/missing-runner-dependency\.js'\u2026/);
  } finally {
    if (originalColumns) {
      Object.defineProperty(process.stdout, "columns", originalColumns);
    } else {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: undefined,
      });
    }
  }
});

test("SplashGate returns null when hidden", () => {
  const text = renderToString(
    React.createElement(SplashGate, {
      visible: false,
      onDismiss: () => {},
      preflight: createPreflightState(),
    }),
  );

  assert.equal(text.trim(), "");
});
