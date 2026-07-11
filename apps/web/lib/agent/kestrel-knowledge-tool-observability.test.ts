import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  buildKnowledgeToolAuditEvent,
  classifyKnowledgeToolFailure,
  getKnowledgeToolQueryLength,
  logKnowledgeToolAuditEvent,
  readKnowledgeToolRequestMetadata,
} from "@/lib/agent/kestrel-knowledge-tool-observability";

test("knowledge tool audit metadata reads tenant and correlation headers", () => {
  const request = new Request("http://example.test/tool", {
    headers: {
      "x-kestrel-tenant-id": "org_123",
      "x-kestrel-correlation-id": "corr_123",
      "x-kestrel-request-id": "req_123",
    },
  });

  assert.deepEqual(readKnowledgeToolRequestMetadata(request), {
    tenantId: "org_123",
    correlationId: "corr_123",
    requestId: "req_123",
  });
});

test("knowledge tool audit events omit raw query text", () => {
  const query = "private launch plan";
  const event = buildKnowledgeToolAuditEvent({
    status: "success",
    organizationId: "org_123",
    tenantId: "org_123",
    correlationId: "corr_123",
    requestId: "req_123",
    queryLength: getKnowledgeToolQueryLength({ query }),
    resultCount: 4,
    latencyMs: 12.4,
  });

  assert.equal(event.queryLength, query.length);
  assert.equal(event.resultCount, 4);
  assert.equal(event.latencyMs, 12);
  assert.equal(JSON.stringify(event).includes(query), false);
});

test("knowledge tool audit classifies invalid auth and runtime failures", () => {
  const unauthorized = Object.assign(new Error("Unauthorized"), {
    code: "UNAUTHORIZED",
  });

  assert.equal(
    classifyKnowledgeToolFailure(new z.ZodError([])),
    "invalid_input",
  );
  assert.equal(classifyKnowledgeToolFailure(unauthorized), "unauthorized");
  assert.equal(
    classifyKnowledgeToolFailure(new Error("database unavailable")),
    "runtime_error",
  );
});

test("knowledge tool audit logger routes success and failure by severity", () => {
  const calls: Array<{ level: string; message: string; event: unknown }> = [];
  const logger = {
    info(message: string, event: unknown) {
      calls.push({ level: "info", message, event });
    },
    error(message: string, event: unknown) {
      calls.push({ level: "error", message, event });
    },
  };

  logKnowledgeToolAuditEvent(
    buildKnowledgeToolAuditEvent({
      status: "success",
      latencyMs: 1,
    }),
    logger,
  );
  logKnowledgeToolAuditEvent(
    buildKnowledgeToolAuditEvent({
      status: "failure",
      latencyMs: 1,
      failureClass: "runtime_error",
    }),
    logger,
  );

  assert.deepEqual(
    calls.map((call) => call.level),
    ["info", "error"],
  );
  assert.equal(
    calls.every(
      (call) => call.message === "kestrel_one.search_knowledge_documents.audit",
    ),
    true,
  );
});
