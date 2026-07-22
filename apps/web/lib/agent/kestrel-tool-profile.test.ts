import assert from "node:assert/strict";
import type { RunnerProfile } from "@kestrel-agents/sdk/runner";
import { restrictKestrelOneProfileTools } from "./kestrel-tool-profile";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


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
  ],
} as RunnerProfile;

contractTest("web.hermetic", "calendar tools are exposed only for effective Project capabilities", () => {
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

contractTest("web.hermetic", "calendar tools are removed when the user has no effective capability", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile,
    effectiveCapabilities: [],
  });
  assert.deepEqual(restricted.toolAllowlist, []);
});

contractTest("web.hermetic", "Workspace preview tools follow Environment App approval capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        "workspace.preview.publish",
        "workspace.preview.list",
        "workspace.preview.renew",
        "workspace.preview.close",
      ],
    },
    effectiveCapabilities: [
      "app:ngrok.publish:auto",
      "app:ngrok.list:auto",
      "app:ngrok.close:ask",
    ],
  });
  assert.deepEqual(restricted.toolAllowlist, [
    "workspace.preview.publish",
    "workspace.preview.list",
    "workspace.preview.close",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "workspace.preview.publish": "auto",
    "workspace.preview.list": "auto",
    "workspace.preview.close": "ask",
  });
});

contractTest("web.hermetic", "GitHub tools are exposed only for effective Project capabilities", () => {
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

contractTest("web.hermetic", "Tavily tools and approval modes come only from effective Project Apps", () => {
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

contractTest("web.hermetic", "built-in agent tools are governed by their effective App capabilities", () => {
  const restricted = restrictKestrelOneProfileTools({
    profile: {
      ...profile,
      toolAllowlist: [
        "free.weather.current",
        "free.weather.forecast",
        "free.time.current",
        "free.geocode.lookup",
        "free.exchange.rate",
        "free.hn.top",
        "kestrel_one.search_knowledge_documents",
        "bash",
        "bash_batch",
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
      "app:built_in.hacker_news.topStories:auto",
      "app:built_in.knowledge_search.searchKnowledgeDocuments:ask",
      "app:built_in.sandbox.bash_batch:auto",
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
    "free.hn.top",
    "kestrel_one.search_knowledge_documents",
    "bash_batch",
    "createDocument",
    "requestSuggestions",
  ]);
  assert.deepEqual(restricted.kestrelOneAppApprovalModes, {
    "free.weather.current": "auto",
    "free.weather.forecast": "ask",
    "free.time.current": "auto",
    "free.geocode.lookup": "auto",
    "free.exchange.rate": "auto",
    "free.hn.top": "auto",
    "kestrel_one.search_knowledge_documents": "ask",
    bash_batch: "auto",
    createDocument: "ask",
    requestSuggestions: "auto",
  });
});
