import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const chart = path.join(root, "deploy/kubernetes/kestrel-connector");

for (const profile of ["gke-gateway-values.yaml", "eks-ingress-values.yaml"]) {
  test(`Helm renders the ${profile} profile with fixed trust boundaries`, () => {
    const values = path.join(chart, "ci", profile);
    execFileSync("helm", ["lint", chart, "--values", values], { stdio: "pipe" });
    const rendered = execFileSync(
      "helm",
      ["template", "kestrel", chart, "--values", values],
      { encoding: "utf8" },
    );
    assert.match(rendered, /replicas: 2/u);
    assert.match(rendered, /maxUnavailable: 1/u);
    assert.match(rendered, /maxSurge: 1/u);
    assert.match(rendered, /kind: PodDisruptionBudget/u);
    assert.match(rendered, /runAsNonRoot: true/u);
    assert.match(rendered, /automountServiceAccountToken: false/u);
    assert.match(rendered, /serviceAccountToken:/u);
    assert.match(rendered, /@sha256:[a-f0-9]{64}/u);
    assert.doesNotMatch(rendered, /verbs:\s*\n\s*- "\*"/u);
    assert.match(
      rendered,
      /apiGroups: \["\*"\]\s+resources: \["\*"\]\s+verbs: \["get", "list"\]/u,
    );
    assert.match(rendered, /resources: \["namespaces"\]\s+verbs: \["get", "list", "create", "patch", "delete"\]/u);
    assert.match(rendered, /pod-security\.kubernetes\.io\/enforce: restricted/u);
    assert.match(rendered, /readOnlyRootFilesystem: true/u);
    assert.match(rendered, /allowPrivilegeEscalation: false/u);
  });
}

test("Helm refuses a mutable connector image", () => {
  assert.throws(() =>
    execFileSync("helm", ["template", "kestrel", chart, "--set", "image.digest=latest"], {
      stdio: "pipe",
    }),
  );
});
