import assert from "node:assert/strict";
import test from "node:test";
import { FakeKubernetesApi, FakeKubernetesApiError } from "./fake-kubernetes.js";

test("fake Kubernetes API injects a one-shot throttling response and then recovers", async () => {
  const fake = new FakeKubernetesApi();
  fake.setFault({ method: "GET", path: "/api/v1", status: 429, once: true });

  await assert.rejects(
    () => fake.get("/api/v1"),
    (error: unknown) => error instanceof FakeKubernetesApiError && error.status === 429,
  );
  const discovery = await fake.get("/api/v1");
  assert.ok(discovery);
});

test("fake Kubernetes API can delay and inject method-scoped failures", async () => {
  const fake = new FakeKubernetesApi();
  fake.setFault({ method: "DELETE", path: /namespaces\/canary/u, status: 409, delayMs: 5, once: true });
  const startedAt = Date.now();

  await assert.rejects(
    () => fake.delete("/api/v1/namespaces/canary"),
    (error: unknown) => error instanceof FakeKubernetesApiError && error.status === 409,
  );
  assert.ok(Date.now() - startedAt >= 5);
  await fake.delete("/api/v1/namespaces/canary");
});

test("fake Kubernetes API covers the provider failure status matrix", async () => {
  for (const status of [403, 404, 409, 429, 500, 503]) {
    const fake = new FakeKubernetesApi();
    fake.setFault({ method: "GET", path: "/api/v1", status });
    await assert.rejects(
      () => fake.get("/api/v1", { allowNotFound: true }),
      (error: unknown) => error instanceof FakeKubernetesApiError && error.status === status,
    );
  }
});
