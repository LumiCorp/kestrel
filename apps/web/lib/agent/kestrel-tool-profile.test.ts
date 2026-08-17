import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerProfile } from "@kestrel-agents/sdk/runner";
import {
  resolveKestrelOneToolCapability,
  restrictKestrelOneProfileTools,
} from "./kestrel-tool-profile";

const profile = {
  id: "kestrel-one",
  label: "Kestrel One",
  agent: "reference-react",
  sessionPrefix: "kestrel-one",
  toolAllowlist: [
    "kestrel_one.search_knowledge_documents",
    "kestrel_one.google_calendar_list_events",
    "kestrel_one.google_calendar_create_event",
    "kestrel_one.google_calendar_check_availability",
    "kestrel_one.microsoft_365_list_mail",
    "kestrel_one.microsoft_365_send_mail",
  ],
} as RunnerProfile;

test("hosted runtime tools resolve to the existing App capability owner", () => {
  assert.deepEqual(resolveKestrelOneToolCapability("internet.research"), {
    appKey: "tavily",
    capabilityKey: "research",
  });
  assert.deepEqual(resolveKestrelOneToolCapability("free.weather.current"), {
    appKey: "built_in.weather",
    capabilityKey: "getWeather",
  });
  assert.equal(resolveKestrelOneToolCapability("unknown.tool"), null);
});

test("calendar tools are exposed only for effective Project capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile,
    effectiveCapabilities: [
      "app:built_in.knowledge_search.searchKnowledgeDocuments:auto",
      "app:google_workspace.calendar.events.read:auto",
      "app:google_workspace.calendar.availability.read:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "kestrel_one.search_knowledge_documents",
    "kestrel_one.google_calendar_list_events",
    "kestrel_one.google_calendar_check_availability",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "kestrel_one.search_knowledge_documents": "auto",
    "kestrel_one.google_calendar_list_events": "auto",
    "kestrel_one.google_calendar_check_availability": "ask",
  });
});

test("hosted profile carries source policy evidence alongside effective modes", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile,
    effectiveCapabilities: ["app:google_workspace.calendar.events.create:ask"],
    approvalPolicies: [
      {
        appKey: "google_workspace",
        capabilityKey: "calendar.events.create",
        environment: "auto",
        project: "ask",
        minimum: "auto",
      },
    ],
  });
  assert.deepEqual(restricted.kestrelOneAppApprovalPolicies, {
    "kestrel_one.google_calendar_create_event": {
      environment: "auto",
      project: "ask",
      minimum: "auto",
    },
  });
});

test("Microsoft 365 tools follow effective capability packs", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile,
    effectiveCapabilities: [
      "app:microsoft_365.outlook.mail.read:auto",
      "app:microsoft_365.outlook.mail.send:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "kestrel_one.microsoft_365_list_mail",
    "kestrel_one.microsoft_365_send_mail",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "kestrel_one.microsoft_365_list_mail": "auto",
    "kestrel_one.microsoft_365_send_mail": "ask",
  });
});

test("calendar tools are removed when the user has no effective capability", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile,
    effectiveCapabilities: [],
  });
  assert.deepEqual(restricted.toolAllowlist, []);
});

test("Workspace preview tools follow Environment App approval capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        "workspace.preview.publish",
        "workspace.preview.list",
        "workspace.preview.inspect",
        "workspace.preview.renew",
        "workspace.preview.close",
      ],
    },
    effectiveCapabilities: [
      "app:built_in.previews.publish:auto",
      "app:built_in.previews.list:auto",
      "app:built_in.previews.inspect:auto",
      "app:built_in.previews.close:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "workspace.preview.publish",
    "workspace.preview.list",
    "workspace.preview.inspect",
    "workspace.preview.close",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "workspace.preview.publish": "auto",
    "workspace.preview.list": "auto",
    "workspace.preview.inspect": "auto",
    "workspace.preview.close": "ask",
  });
});

test("GitHub tools are exposed only for effective Project capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        "kestrel_one.github_repository_read",
        "kestrel_one.github_issue_create",
        "kestrel_one.github_push_agent_branch",
      ],
    },
    effectiveCapabilities: [
      "app:github.repository.read:auto",
      "app:github.issue.write:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "kestrel_one.github_repository_read",
    "kestrel_one.github_issue_create",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "kestrel_one.github_repository_read": "auto",
    "kestrel_one.github_issue_create": "ask",
  });
});

test("Tavily tools and approval modes come only from effective Project Apps", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        ...(profile.toolAllowlist ?? []),
        "internet.search",
        "internet.crawl",
        "internet.usage",
      ],
    },
    effectiveCapabilities: [
      "app:built_in.knowledge_search.searchKnowledgeDocuments:auto",
      "app:tavily.search:auto",
      "app:tavily.crawl:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "kestrel_one.search_knowledge_documents",
    "internet.search",
    "internet.crawl",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "kestrel_one.search_knowledge_documents": "auto",
    "internet.search": "auto",
    "internet.crawl": "ask",
  });
});

test("Vercel tools follow effective Project App capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        "kestrel_one.vercel_list_projects",
        "kestrel_one.vercel_list_deployments",
        "kestrel_one.vercel_deployment_events",
      ],
    },
    effectiveCapabilities: [
      "app:vercel.projects.read:auto",
      "app:vercel.operations.read:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "kestrel_one.vercel_list_projects",
    "kestrel_one.vercel_deployment_events",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "kestrel_one.vercel_list_projects": "auto",
    "kestrel_one.vercel_deployment_events": "ask",
  });
});

test("built-in agent tools are governed by their effective App capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        "free.weather.current",
        "free.weather.forecast",
        "free.time.current",
        "free.geocode.lookup",
        "free.exchange.rate",
        "kestrel_one.search_knowledge_documents",
        "createDocument",
        "updateDocument",
        "requestSuggestions",
      ],
    },
    effectiveCapabilities: [
      "app:built_in.weather.getWeather:auto",
      "app:built_in.weather.forecast:ask",
      "app:built_in.time.current:auto",
      "app:built_in.geocoding.lookup:auto",
      "app:built_in.exchange_rates.rate:auto",
      "app:built_in.knowledge_search.searchKnowledgeDocuments:ask",
      "app:built_in.artifacts.createDocument:ask",
      "app:built_in.artifacts.requestSuggestions:auto",
    ],
  });

  assert.deepEqual(restricted.toolAllowlist, [
    "free.weather.current",
    "free.weather.forecast",
    "free.time.current",
    "free.geocode.lookup",
    "free.exchange.rate",
    "kestrel_one.search_knowledge_documents",
    "createDocument",
    "requestSuggestions",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "free.weather.current": "auto",
    "free.weather.forecast": "ask",
    "free.time.current": "auto",
    "free.geocode.lookup": "auto",
    "free.exchange.rate": "auto",
    "kestrel_one.search_knowledge_documents": "ask",
    createDocument: "ask",
    requestSuggestions: "auto",
  });
});
