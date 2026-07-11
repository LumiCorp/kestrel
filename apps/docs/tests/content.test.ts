import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DocsShell } from "../components/DocsShell";
import { pageRegistry } from "../lib/content-registry";
import { getAllPages, getNavigation, getRenderedPageBySlug } from "../lib/content";
import { resolveDocsAppRoot } from "../lib/site";

test("all registered docs pages expose complete metadata and normalized links", async () => {
  const pages = await getAllPages();
  const urls = new Set<string>();

  assert.ok(pages.length >= 40, "expected a broad authored docs corpus");

  for (const page of pages) {
    assert.ok(page.meta.title.length > 0, `missing title for ${page.meta.url}`);
    assert.ok(page.meta.summary.length > 0, `missing summary for ${page.meta.url}`);
    assert.ok(page.meta.updatedAt.length > 0, `missing updatedAt for ${page.meta.url}`);
    assert.notEqual(page.meta.summary, "undefined", `invalid summary for ${page.meta.url}`);
    assert.ok(!urls.has(page.meta.url), `duplicate url ${page.meta.url}`);
    urls.add(page.meta.url);
  }
});

test("archive section includes plans and runbooks as archived pages", async () => {
  const pages = await getAllPages();
  const archived = pages.filter((page) => page.meta.archive);

  assert.ok(archived.some((page) => page.meta.archiveGroup === "plans"), "expected archived plan pages");
  assert.ok(archived.some((page) => page.meta.archiveGroup === "runbooks"), "expected archived runbook pages");
});

test("navigation includes the new build and deploy journeys", async () => {
  const navigation = await getNavigation();
  const sections = new Set(navigation.map((group) => group.section));

  assert.ok(sections.has("build"), "expected Build section in navigation");
  assert.ok(sections.has("deploy"), "expected Deploy section in navigation");
});

test("new companion and capability pages exist and are part of the curated docs corpus", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["build", "nextjs-route-cookbook"]),
    getRenderedPageBySlug(["build", "openai-compatible-http"]),
    getRenderedPageBySlug(["cli", "profiles-code-mode-and-mcp"]),
    getRenderedPageBySlug(["operations", "artifact-inspection"]),
    getRenderedPageBySlug(["operations", "operator-control-workflows"]),
    getRenderedPageBySlug(["operations", "review-and-state-workflows"]),
  ]);

  for (const page of pages) {
    assert.ok(page, "expected companion page to exist");
  }

  assert.ok(pages[0]?.rawContent.includes("/api/copilot/webhook"), "expected cookbook to cover webhook route");
  assert.ok(pages[1]?.rawContent.includes("/v1/chat/completions"), "expected OpenAI-compatible page to cover chat completions");
  assert.ok(pages[1]?.rawContent.includes("/v1/responses"), "expected OpenAI-compatible page to cover responses");
  assert.ok(pages[2]?.rawContent.includes("toolAllowlist"), "expected profiles page to mention tool allowlists");
  assert.ok(pages[2]?.rawContent.includes("codeMode"), "expected profiles page to mention codeMode");
  assert.ok(pages[2]?.rawContent.includes("mcpServers"), "expected profiles page to mention mcpServers");
  assert.ok(pages[3]?.rawContent.includes("reports/nightly-review.md"), "expected artifact page to mention report artifact");
  assert.ok(pages[4]?.rawContent.includes("operator.inbox"), "expected operator control page to cover inbox");
  assert.ok(pages[4]?.rawContent.includes("operator.thread"), "expected operator control page to cover thread view");
  assert.ok(pages[4]?.rawContent.includes("operator.control"), "expected operator control page to cover control actions");
  assert.ok(pages[5]?.rawContent.includes("task.graph.get"), "expected review/state page to cover task graph get");
  assert.ok(pages[5]?.rawContent.includes("project.snapshot.get"), "expected review/state page to cover project snapshot get");
  assert.ok(pages[5]?.rawContent.includes("project.review.get"), "expected review/state page to cover project review get");
  assert.ok(pages[5]?.rawContent.includes("project.review.action"), "expected review/state page to cover project review action");
});

test("primary journey pages exist and tutorials include code blocks and next-step links", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["build", "workspace-copilot-demo"]),
    getRenderedPageBySlug(["build", "building-your-first-agent"]),
    getRenderedPageBySlug(["build", "running-your-first-streamed-request"]),
    getRenderedPageBySlug(["build", "adding-session-memory"]),
    getRenderedPageBySlug(["build", "workspaces-and-automation"]),
    getRenderedPageBySlug(["deploy", "running-the-runner-service"]),
    getRenderedPageBySlug(["docs", "faq"]),
  ]);

  for (const page of pages) {
    assert.ok(page, "expected primary docs page to exist");
  }

  const [demoPage, firstAgentPage, streamPage, memoryPage, workspacePage, deployPage, faqPage] = pages;

  assert.ok(demoPage?.rawContent.includes("Workspace Copilot"), "expected canonical demo page to mention Workspace Copilot");
  assert.ok(demoPage?.rawContent.includes("lib/workspace-copilot.ts"), "expected canonical demo page to include shared agent module");
  assert.ok(demoPage?.rawContent.includes("app/api/copilot/run/route.ts"), "expected canonical demo page to include route files");
  assert.ok(demoPage?.rawContent.includes("~/.kestrel/workspaces.json"), "expected canonical demo page to include workspace catalog identity");
  assert.ok(demoPage?.rawContent.includes("workspace catalog"), "expected canonical demo page to include catalog language");
  assert.ok(demoPage?.rawContent.includes("/api/copilot/webhook"), "expected canonical demo page to include webhook route usage");
  assert.ok(demoPage?.rawContent.includes("reports/nightly-review.md"), "expected canonical demo page to include report artifact");
  assert.ok(firstAgentPage?.rawContent.includes("```"), "expected first-agent tutorial to include code examples");
  assert.ok(firstAgentPage?.rawContent.includes("scripts/workspace-copilot-smoke.ts"), "expected first-agent tutorial to include smoke test file");
  assert.ok(firstAgentPage?.rawContent.includes("run.completed"), "expected first-agent tutorial to include representative terminal output");
  assert.ok(firstAgentPage?.rawContent.includes("What To Read Next"), "expected first-agent tutorial to include next steps");
  assert.ok(streamPage?.rawContent.includes("What changes in this step"), "expected stream tutorial to include step summary");
  assert.ok(memoryPage?.rawContent.includes("expectedRevision"), "expected memory tutorial to include versioned update example");
  assert.ok(workspacePage?.rawContent.includes("~/.kestrel/workspaces.json"), "expected workspace page to include catalog examples");
  assert.ok(workspacePage?.rawContent.includes("kestrel workspace status"), "expected workspace page to include command examples");
  assert.ok(deployPage?.rawContent.includes("```bash"), "expected deploy page to include command examples");
  assert.ok(faqPage?.meta.toc.some((item) => item.text.includes("?")), "expected FAQ headings to be question-driven");
});

test("workspace copilot demo contract is reused across the main build and deploy pages", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["build", "building-your-first-agent"]),
    getRenderedPageBySlug(["build", "running-your-first-streamed-request"]),
    getRenderedPageBySlug(["build", "adding-session-memory"]),
    getRenderedPageBySlug(["build", "integrating-with-nextjs"]),
    getRenderedPageBySlug(["build", "nextjs-route-cookbook"]),
    getRenderedPageBySlug(["build", "workspaces-and-automation"]),
    getRenderedPageBySlug(["deploy", "running-the-runner-service"]),
    getRenderedPageBySlug(["deploy", "environment-and-auth"]),
  ]);

  for (const page of pages) {
    assert.ok(page, "expected workspace copilot journey page to exist");
    assert.ok(page.rawContent.includes("Workspace Copilot"), `expected Workspace Copilot in ${page.meta.url}`);
  }

  const nextPage = pages[3];
  assert.ok(nextPage?.rawContent.includes("/api/copilot/run"), "expected canonical json route");
  assert.ok(nextPage?.rawContent.includes("/api/copilot/stream"), "expected canonical stream route");
  assert.ok(nextPage?.rawContent.includes("app/api/copilot/run/route.ts"), "expected full route-file examples");
  assert.ok(nextPage?.rawContent.includes("fetch(\"/api/copilot/run\""), "expected browser-side request example");
  assert.ok(nextPage?.rawContent.includes("x-kestrel-correlation-id"), "expected correlation header guidance");

  const cookbookPage = pages[4];
  assert.ok(cookbookPage?.rawContent.includes("x-kestrel-request-id"), "expected cookbook to mention response headers");

  const deployPage = pages[6];
  assert.ok(deployPage?.rawContent.includes("runner.ping"), "expected runner-service page to include smoke-test command output");
  assert.ok(deployPage?.rawContent.includes("/commands"), "expected runner-service page to include command endpoint checks");
});

test("runtime and operations priority pages include concrete commands or flow descriptions", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["runtime", "engine"]),
    getRenderedPageBySlug(["runtime", "io-and-tools"]),
    getRenderedPageBySlug(["runtime", "store-and-replay"]),
    getRenderedPageBySlug(["operations", "reliability"]),
    getRenderedPageBySlug(["operations", "evaluations"]),
    getRenderedPageBySlug(["operations", "quality-gates"]),
    getRenderedPageBySlug(["operations", "artifact-inspection"]),
  ]);

  for (const page of pages) {
    assert.ok(page, "expected runtime/operations page to exist");
    const hasCommand = page.rawContent.includes("```bash");
    const hasFlow = page.rawContent.includes("->");
    const hasOperatorSection = page.rawContent.includes("Operator consequence") || page.rawContent.includes("What this means");
    assert.ok(hasCommand || hasFlow || hasOperatorSection, `expected concrete operator detail in ${page.meta.url}`);
  }
});

test("package pages include structured contract tables and app pages include workflow sections", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["packages", "sdk"]),
    getRenderedPageBySlug(["packages", "next"]),
    getRenderedPageBySlug(["packages", "observability"]),
    getRenderedPageBySlug(["apps", "web"]),
    getRenderedPageBySlug(["apps", "desktop"]),
  ]);

  for (const page of pages.slice(0, 3)) {
    assert.ok(page, "expected package page to exist");
    assert.ok(page.rawContent.includes("|"), `expected structured table content in ${page.meta.url}`);
  }

  for (const page of pages.slice(3)) {
    assert.ok(page, "expected app page to exist");
    assert.ok(page.rawContent.includes("## Workflow"), `expected workflow section in ${page.meta.url}`);
  }
});

test("homepage and landing pages route readers toward advanced capability pages", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug([]),
    getRenderedPageBySlug(["build"]),
    getRenderedPageBySlug(["cli"]),
    getRenderedPageBySlug(["packages"]),
    getRenderedPageBySlug(["apps"]),
    getRenderedPageBySlug(["operations"]),
  ]);

  const [homePage, buildPage, cliPage, packagesPage, appsPage, operationsPage] = pages;

  for (const page of pages) {
    assert.ok(page, "expected landing or home page to exist");
  }

  assert.ok(homePage?.rawContent.includes("Start Here For Capabilities"), "expected home page to route by capability");
  assert.ok(homePage?.rawContent.includes("/operations/review-and-state-workflows"), "expected home page to route to review/state workflows");
  assert.ok(buildPage?.rawContent.includes("/build/openai-compatible-http"), "expected build landing to route to OpenAI-compatible HTTP");
  assert.ok(cliPage?.rawContent.includes("CLI terminal client"), "expected cli landing to route to the CLI terminal client");
  assert.ok(cliPage?.rawContent.includes("/cli/profiles-code-mode-and-mcp"), "expected cli landing to route to profiles and MCP");
  assert.ok(packagesPage?.rawContent.includes("How to choose"), "expected packages landing to compare integration choices");
  assert.ok(packagesPage?.rawContent.includes("/operations/review-and-state-workflows"), "expected packages landing to route to review/state workflows");
  assert.ok(appsPage?.rawContent.includes("/operations/evaluations"), "expected apps landing to route to Ruhroh evaluations");
  assert.ok(operationsPage?.rawContent.includes("/operations/operator-control-workflows"), "expected operations landing to route to operator control");
  assert.ok(operationsPage?.rawContent.includes("/operations/review-and-state-workflows"), "expected operations landing to route to review/state workflows");
});

test("secondary landing pages still include reader-routing language", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["deploy"]),
    getRenderedPageBySlug(["runtime"]),
    getRenderedPageBySlug(["reference"]),
    getRenderedPageBySlug(["archive"]),
  ]);

  for (const page of pages) {
    assert.ok(page, "expected landing page to exist");
    assert.ok(page.rawContent.includes("Start here if"), `expected reader-routing language in ${page.meta.url}`);
  }
});

test("faq, reference, and archive pages include the deeper support content", async () => {
  const [faqPage, architecturePage, lintPage, heuristicPage, archivePage, docsLandingPage, conceptsPage] =
    await Promise.all([
    getRenderedPageBySlug(["docs", "faq"]),
    getRenderedPageBySlug(["reference", "architecture-rules"]),
    getRenderedPageBySlug(["reference", "lint-invariants"]),
    getRenderedPageBySlug(["reference", "heuristic-hotspots"]),
    getRenderedPageBySlug(["archive"]),
    getRenderedPageBySlug(["docs"]),
    getRenderedPageBySlug(["docs", "core-concepts"]),
  ]);

  assert.ok(faqPage?.rawContent.includes("When is Kestrel overkill?"), "expected FAQ to cover overkill decision");
  assert.ok(faqPage?.rawContent.includes("When should I not use workspaces?"), "expected FAQ to cover workspace non-fit");
  assert.ok(faqPage?.rawContent.includes("What do operator control surfaces buy me?"), "expected FAQ to cover control surfaces");
  assert.ok(faqPage?.rawContent.includes("project/review state"), "expected FAQ to mention richer runtime state choices");
  assert.ok(docsLandingPage?.rawContent.includes("Jump to the strongest capabilities"), "expected docs landing to route to major capabilities");
  assert.ok(conceptsPage?.rawContent.includes("## Operator control"), "expected core concepts to define operator control");
  assert.ok(architecturePage?.rawContent.includes("When you hit this"), "expected architecture rules to include concrete usage guidance");
  assert.ok(lintPage?.rawContent.includes("When you hit this"), "expected lint invariants to include concrete usage guidance");
  assert.ok(heuristicPage?.rawContent.includes("When you hit this"), "expected heuristic hotspots to include concrete usage guidance");
  assert.ok(archivePage?.rawContent.includes("Guided reading paths"), "expected archive to include curated reading paths");
});

test("capability-heavy pages cover the advanced runner surfaces explicitly", async () => {
  const [sdkPage, cliTerminalPage, evaluationsPage, webPage, compatPage, reviewStatePage, operatorPage] =
    await Promise.all([
    getRenderedPageBySlug(["packages", "sdk"]),
    getRenderedPageBySlug(["cli", "kchat"]),
    getRenderedPageBySlug(["operations", "evaluations"]),
    getRenderedPageBySlug(["apps", "web"]),
    getRenderedPageBySlug(["build", "openai-compatible-http"]),
    getRenderedPageBySlug(["operations", "review-and-state-workflows"]),
    getRenderedPageBySlug(["operations", "operator-control-workflows"]),
  ]);

  assert.ok(sdkPage?.rawContent.includes("getSessionState"), "expected SDK page to cover getSessionState");
  assert.ok(sdkPage?.rawContent.includes("operator.inbox"), "expected SDK page to cover operator inbox");
  assert.ok(sdkPage?.rawContent.includes("task.graph"), "expected SDK page to cover task graph");
  assert.ok(sdkPage?.rawContent.includes("project.snapshot"), "expected SDK page to cover project snapshot");
  assert.ok(sdkPage?.rawContent.includes("project.action"), "expected SDK page to cover project action");
  assert.ok(sdkPage?.rawContent.includes("getProjectReview()"), "expected SDK page to cover getProjectReview");
  assert.ok(sdkPage?.rawContent.includes("applyProjectReviewAction()"), "expected SDK page to cover applyProjectReviewAction");
  assert.ok(sdkPage?.rawContent.includes("\"task:thread:thread-main\""), "expected SDK page to include a concrete task graph mutation example");
  assert.ok(sdkPage?.rawContent.includes("Record<string, unknown>"), "expected SDK page to keep the task graph example type-safe");

  assert.ok(cliTerminalPage?.rawContent.includes("/stop"), "expected CLI page to cover /stop");
  assert.ok(cliTerminalPage?.rawContent.includes("/steer"), "expected CLI page to cover /steer");
  assert.ok(cliTerminalPage?.rawContent.includes("/mcp"), "expected CLI page to cover /mcp");
  assert.ok(cliTerminalPage?.rawContent.includes("/code"), "expected CLI page to cover /code");
  assert.ok(cliTerminalPage?.rawContent.includes("Workflow: from blocked thread to controlled resolution"), "expected CLI page to include operator workflow");

  assert.ok(evaluationsPage?.rawContent.includes("evals:release-check"), "expected evaluations page to cover the release gate");
  assert.ok(evaluationsPage?.rawContent.includes("ownership-ledger.json"), "expected evaluations page to cover behavior ownership");
  assert.ok(evaluationsPage?.rawContent.includes("Ruhroh"), "expected evaluations page to name the external evaluator");

  assert.ok(webPage?.rawContent.includes("operator.inbox"), "expected web app page to cover operator control surfaces");
  assert.ok(webPage?.rawContent.includes("task.graph.get"), "expected web app page to cover task inspection");
  assert.ok(webPage?.rawContent.includes("project.review.action"), "expected web app page to cover project review action");
  assert.ok(webPage?.rawContent.includes("Workflow: browser review and state loop"), "expected web app page to include browser control workflow");
  assert.ok(compatPage?.rawContent.includes("GET /v1/models"), "expected compat page to cover model listing");
  assert.ok(compatPage?.rawContent.includes("/v1/responses"), "expected compat page to cover responses");
  assert.ok(compatPage?.rawContent.includes("\"type\": \"message\""), "expected compat page to use the real responses output shape");
  assert.ok(compatPage?.rawContent.includes("\"kestrel\": {"), "expected compat page to show nested kestrel metadata");

  assert.ok(reviewStatePage?.rawContent.includes("/api/kchat/control"), "expected review/state page to include browser control flow");
  assert.ok(reviewStatePage?.rawContent.includes("updateTaskGraph("), "expected review/state page to include task graph mutation example");
  assert.ok(reviewStatePage?.rawContent.includes("updateProjectSnapshot("), "expected review/state page to include project snapshot mutation example");
  assert.ok(reviewStatePage?.rawContent.includes("runProjectAction("), "expected review/state page to include project action example");
  assert.ok(reviewStatePage?.rawContent.includes("Workflow: choosing the right state surface"), "expected review/state page to compare state surfaces");
  assert.ok(operatorPage?.rawContent.includes("Workflow: blocked thread to resolution"), "expected operator control page to include thread-level workflow");
});

test("canonical pages include the deeper copy-paste examples added after search hardening", async () => {
  const [compatPage, cliTerminalPage, deployPage, buildPage, nextjsPage] = await Promise.all([
    getRenderedPageBySlug(["build", "openai-compatible-http"]),
    getRenderedPageBySlug(["cli", "kchat"]),
    getRenderedPageBySlug(["deploy", "running-the-runner-service"]),
    getRenderedPageBySlug(["build", "building-your-first-agent"]),
    getRenderedPageBySlug(["build", "integrating-with-nextjs"]),
  ]);

  assert.ok(compatPage?.rawContent.includes("\"metadata\": {"), "expected compat page to include representative responses payloads");
  assert.ok(compatPage?.rawContent.includes("\"kestrel\": {"), "expected compat page to include nested Kestrel metadata");
  assert.ok(compatPage?.rawContent.includes("\"run_id\""), "expected compat page to include Kestrel run metadata");
  assert.ok(cliTerminalPage?.rawContent.includes("kestrel workspace status"), "expected CLI page to include workspace status flow");
  assert.ok(cliTerminalPage?.rawContent.includes("kestrel workspace list"), "expected CLI page to include workspace list flow");
  assert.ok(cliTerminalPage?.rawContent.includes("/status"), "expected CLI page to include operator status flow");
  assert.ok(deployPage?.rawContent.includes("/v1/models"), "expected runner-service page to include model smoke checks");
  assert.ok(deployPage?.rawContent.includes("runner.ping"), "expected runner-service page to include ping smoke checks");
  assert.ok(buildPage?.rawContent.includes("\"payload\": {"), "expected first-agent page to use the real terminal event envelope");
  assert.ok(buildPage?.rawContent.includes("\"result\": {"), "expected first-agent page to show payload.result");
  assert.ok(nextjsPage?.rawContent.includes("\"payload\": {"), "expected nextjs page to use the real terminal event envelope");
  assert.ok(nextjsPage?.rawContent.includes("\"type\": \"run.completed\""), "expected nextjs page to show terminal webhook responses");
  assert.ok(nextjsPage?.rawContent.includes("\"status\": \"COMPLETED\""), "expected nextjs page to show terminal output status");
});

test("faq keeps the workspace non-fit guidance without duplicating the question", async () => {
  const faqPage = await getRenderedPageBySlug(["docs", "faq"]);

  assert.ok(faqPage, "expected FAQ page to exist");
  const occurrences = faqPage.rawContent.match(/## When should I not use workspaces\?/g) ?? [];
  assert.equal(occurrences.length, 1, "expected only one workspace non-fit question in FAQ");
});

test("curated docs content tree has no unregistered mdx files", async () => {
  const contentRoot = path.join(resolveDocsAppRoot(), "content");
  const registered = new Set(
    pageRegistry
      .filter((spec) => spec.filePath)
      .map((spec) => path.join(contentRoot, spec.filePath!)),
  );

  async function walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(fullPath)));
        continue;
      }
      if (fullPath.endsWith(".mdx")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const files = await walk(contentRoot);
  const unregistered = files.filter((filePath) => registered.has(filePath) === false);
  assert.deepEqual(unregistered, [], `found unregistered content files: ${unregistered.join(", ")}`);
});

test("representative docs page renders with metadata badges and prose", async () => {
  const [page, navigation] = await Promise.all([
    getRenderedPageBySlug(["runtime", "governance-and-invariants"]),
    getNavigation(),
  ]);

  assert.ok(page, "expected runtime governance page to exist");
  const html = renderToStaticMarkup(
    createElement(
      DocsShell,
      {
        currentUrl: page.meta.url,
        navigation,
        pageMeta: page.meta,
        toc: page.meta.toc,
      },
      page.content,
    ),
  );

  assert.match(html, /repo-inferred/);
  assert.match(html, /Governance and invariants/);
});
