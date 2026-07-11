import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateNewsletterResearchRealUserCliScenario: MountaintopScenario = {
  id: "nextjs-template-newsletter-research-real-user-cli",
  title: "Next.js Newsletter Research Real User CLI",
  description:
    "Prove the CLI can use live research tools to gather a grounded top-10 U.S. business and technology briefing and save it as a structured local report.",
  supportedEngines: ["cli"],
  promptEnvelope: "operator",
  provider: {
    profileId: "reference",
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
  },
  setupCommands: ["/profiles use reference", "/mode build"],
  promptProgram: [
    {
      id: "operator-request",
      label: "Operator request",
      instruction:
        "Research the top 10 current U.S. business and technology stories and save them in this empty folder as newsletter-report.json.",
    },
    {
      id: "research-tools",
      label: "Research tools",
      instruction:
        "Use the live research tools in this runtime, specifically internet.news, internet.search, or internet.search_advanced when available, to gather current headlines and source URLs. Use real reporting, not placeholder copy or invented stories.",
    },
    {
      id: "report-only",
      label: "Report only",
      instruction:
        "This is a research-only task. Do not scaffold a Next.js app and do not create package.json for this canary. The required output is a grounded newsletter-report.json file only.",
    },
    {
      id: "report-contract",
      label: "Structured report",
      instruction:
        "Save the curated result locally as newsletter-report.json with a stories array of exactly 10 items. Each item must include title, publisher, url, category, and summary. Do not write newsletter-report.json until every story has a real populated publisher, an absolute http or https source URL, and a non-placeholder summary.",
    },
    {
      id: "finish-line",
      label: "Definition of done",
      instruction:
        "Before you finish, make sure newsletter-report.json contains 10 distinct real stories with unique titles, real publishers, and absolute source URLs.",
    },
    {
      id: "runtime-verifier",
      label: "Runtime verifier",
      instruction:
        "Before you finalize, run fs.verify_json against newsletter-report.json with arrayPath stories, minLength 10, requiredStringFields title,publisher,url,category,summary, requiredAbsoluteUrlFields url, and forbiddenStringLiterals [to be researched]. Do not finalize until that verifier reports passed.",
    },
    {
      id: "no-bookkeeping",
      label: "No bookkeeping files",
      instruction:
        "Do not create generic bookkeeping files or memory notes unless the task explicitly requires them.",
    },
  ],
  requiredArtifacts: ["newsletter-report.json"],
  requiredJsonArrayArtifacts: [
    {
      paths: ["newsletter-report.json"],
      arrayPath: "stories",
      minLength: 10,
      requiredStringFields: ["title", "publisher", "url", "category", "summary"],
      requiredAbsoluteUrlFields: ["url"],
      forbiddenStringLiterals: ["[to be researched]"],
    },
  ],
  requiredToolEvidence: [
    {
      tools: ["internet.news", "internet.search", "internet.search_advanced"],
      minSuccessfulCalls: 1,
    },
    {
      tools: ["fs.verify_json"],
      minSuccessfulCalls: 1,
    },
  ],
  qualityGates: [],
  smokeRoutes: [],
  workspacePrecondition: "none",
  completionMode: "runtime_finalize",
  completionTimeoutSeconds: 420,
};
