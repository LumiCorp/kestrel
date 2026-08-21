import assert from "node:assert/strict";
import test from "node:test";
import { resolveKubernetesCanaryEdgeMode } from "./kubernetes-canary-contract";

function connection(edgeMode: "gateway_api" | "ingress") {
  return {
    configuration: {
      value: {
        profile: {
          edge: { mode: edgeMode },
        },
      },
    },
  };
}

test("qualified proof uses the connection's configured Gateway API mode", () => {
  assert.equal(
    resolveKubernetesCanaryEdgeMode({
      connection: connection("gateway_api"),
      profile: "qualified",
    }),
    "gateway_api",
  );
});

test("qualified proof uses the connection's configured Ingress mode", () => {
  assert.equal(
    resolveKubernetesCanaryEdgeMode({
      connection: connection("ingress"),
      profile: "qualified",
    }),
    "ingress",
  );
});

test("reference proof profiles reject the wrong configured edge mode", () => {
  assert.throws(() =>
    resolveKubernetesCanaryEdgeMode({
      connection: connection("ingress"),
      profile: "gke",
    }),
  );
  assert.throws(() =>
    resolveKubernetesCanaryEdgeMode({
      connection: connection("gateway_api"),
      profile: "eks",
    }),
  );
});

test("proof fails when the sanitized connection omits edge configuration", () => {
  assert.throws(() =>
    resolveKubernetesCanaryEdgeMode({
      connection: {},
      profile: "qualified",
    }),
  );
});
