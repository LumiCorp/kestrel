import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";
import { assertLiveCodeModeE2E, runLiveCodeModeE2E } from "../src/live/codeModeE2E.js";

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: [
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
      "OPENROUTER_BASE_URL",
      "OPENROUTER_SITE_URL",
      "OPENROUTER_APP_NAME",
      "TAVILY_API_KEY",
      "TAVILY_BASE_URL",
      "TAVILY_PROJECT",
      "TAVILY_HTTP_PROXY",
      "TAVILY_HTTPS_PROXY",
    ],
  });

  const summary = await runLiveCodeModeE2E();
  process.stdout.write(`Live code-mode E2E intermediate results:\n${JSON.stringify(summary.results, null, 2)}\n`);
  assertLiveCodeModeE2E(summary);
  process.stdout.write("Live code-mode E2E passed.\n");
  process.stdout.write(`${JSON.stringify(summary.results, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`[live-code-mode-e2e] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
