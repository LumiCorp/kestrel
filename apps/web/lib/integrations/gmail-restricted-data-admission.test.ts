import test from "node:test";
import assert from "node:assert/strict";
import {
  admitGmailRestrictedData,
  createGmailRestrictedDataRouteEvidence,
  readGmailRestrictedDataRouteEvidence,
  withGmailRestrictedDataRouteEvidence,
  type GmailRestrictedDataRouteEvidence,
} from "./gmail-restricted-data-admission";
import { createHostedModelRegistration } from "../ai/hosted-model-registration";

const registration = createHostedModelRegistration({
  registrationId: "hosted:gateway-test:gpt-4.1-mini",
  revision: "test-registration-v1",
  observedAt: "2026-08-27T00:00:00.000Z",
  modelId: "gpt-4.1-mini",
  credentialRevision: "7",
  providerConfiguration: {
    version: "provider_runtime_configuration_v1",
    providerId: "openai",
    protocol: "openai",
    authentication: { mode: "required", credentialReference: { source: "hosted-gateway", id: "provider.openai.hosted" } },
    endpoint: "https://api.openai.com/v1",
    timeoutMs: 15_000,
    allowedHeaders: [],
    dataHandling: "provider_managed",
  },
  providerEvidence: { provider: "openai", catalogRecord: { id: "gpt-4.1-mini" } },
}).registration;

const qualifiedRoute: GmailRestrictedDataRouteEvidence = {
  version: "gmail_restricted_data_v1",
  routeFingerprint: "route-fingerprint-1",
  processorId: "processor-1",
  purpose: "user_authorized_productivity",
  retention: "documented",
  trainingUse: "prohibited",
  deletion: "documented",
  qualification: "qualified",
  evidenceRevision: "evidence-1",
  observedAt: "2026-08-27T00:00:00.000Z",
};

test("Gmail restricted data fails closed for Project and OAuth denial", () => {
  assert.deepEqual(
    admitGmailRestrictedData({
      projectAuthorized: false,
      gmailReadonlyGranted: true,
      primaryRoute: qualifiedRoute,
      fallbackRoutes: [],
    }),
    { allowed: false, code: "GMAIL_RESTRICTED_DATA_PROJECT_DENIED" },
  );
  assert.deepEqual(
    admitGmailRestrictedData({
      projectAuthorized: true,
      gmailReadonlyGranted: false,
      primaryRoute: qualifiedRoute,
      fallbackRoutes: [],
    }),
    { allowed: false, code: "GMAIL_RESTRICTED_DATA_SCOPE_DENIED" },
  );
});

test("Gmail restricted data requires durable qualification on every route", () => {
  assert.deepEqual(
    admitGmailRestrictedData({
      projectAuthorized: true,
      gmailReadonlyGranted: true,
      primaryRoute: qualifiedRoute,
      fallbackRoutes: [undefined],
    }),
    { allowed: false, code: "GMAIL_RESTRICTED_DATA_ROUTE_UNQUALIFIED" },
  );
  assert.deepEqual(
    admitGmailRestrictedData({
      projectAuthorized: true,
      gmailReadonlyGranted: true,
      primaryRoute: qualifiedRoute,
      fallbackRoutes: [qualifiedRoute],
    }),
    { allowed: true },
  );
});

test("Gmail restricted-data evidence is persisted only for its exact registered route", () => {
  const evidence = createGmailRestrictedDataRouteEvidence({
    registration,
    processorId: "processor-1",
    purpose: "user_authorized_productivity",
    retention: "documented",
    trainingUse: "prohibited",
    deletion: "documented",
    qualification: "qualified",
    evidenceRevision: "evidence-1",
    observedAt: "2026-08-27T00:00:00.000Z",
  });
  const metadata = withGmailRestrictedDataRouteEvidence({ metadata: { userNote: "keep" }, evidence });
  assert.equal(metadata.userNote, "keep");
  assert.deepEqual(
    readGmailRestrictedDataRouteEvidence({ metadata, registration }),
    evidence,
  );
  assert.equal(
    readGmailRestrictedDataRouteEvidence({
      metadata,
      registration: { ...registration, credentialRevision: "8" },
    }),
    undefined,
  );
});
