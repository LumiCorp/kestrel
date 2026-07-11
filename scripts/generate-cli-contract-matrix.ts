import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCliContractMatrixV1 } from "../cli/contractMatrix.js";

const ROOT = process.cwd();
const JSON_OUTPUT = path.join(ROOT, "docs", "generated", "cli-contract-matrix.json");
const DOC_OUTPUT = path.join(ROOT, "docs", "cli", "contract-matrix.md");

async function main(): Promise<void> {
  const matrix = buildCliContractMatrixV1();
  await mkdir(path.dirname(JSON_OUTPUT), { recursive: true });
  await writeFile(JSON_OUTPUT, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  await writeFile(DOC_OUTPUT, renderMarkdown(matrix), "utf8");
  process.stdout.write(`cli contract matrix written: ${path.relative(ROOT, JSON_OUTPUT)}\n`);
  process.stdout.write(`cli contract doc written: ${path.relative(ROOT, DOC_OUTPUT)}\n`);
}

function renderMarkdown(matrix: ReturnType<typeof buildCliContractMatrixV1>): string {
  const verifiedAt = matrix.generatedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const commandRows = matrix.commandMode
    .map((entry) => `| \`${entry.command}\` | \`${entry.usage}\` | ${entry.flags.map((flag) => `\`${flag}\``).join(", ") || "-" } |`)
    .join("\n");
  const executableRows = matrix.executables
    .map((entry) => `| \`${entry.name}\` | \`${entry.entrypoint}\` | ${entry.aliases.map((alias) => `\`${alias}\``).join(", ") || "-" } |`)
    .join("\n");
  return [
    "---",
    "id: cli-contract-matrix",
    "domain: cli",
    "status: active",
    "owner: kestrel-cli",
    `last_verified_at: ${verifiedAt}`,
    "depends_on:",
    "  - ./kchat.md",
    "  - ./kchat-protocol.md",
    "  - ../generated/cli-contract-matrix.json",
    "---",
    "",
    "# CLI Contract Matrix",
    "",
    "This page is generated from `cli/contractMatrix.ts` and must stay aligned with parser behavior and protocol contracts.",
    "",
    "## Executables",
    "",
    "| Binary | Entrypoint | Aliases |",
    "| --- | --- | --- |",
    executableRows,
    "",
    "## Command Mode",
    "",
    "| Command | Usage | Flags |",
    "| --- | --- | --- |",
    commandRows,
    "",
    "## Slash Commands",
    "",
    matrix.slashCommands.map((command) => `- \`/${command}\``).join("\n"),
    "",
    "## Runner Protocol Commands",
    "",
    matrix.runnerProtocol.commands.map((command) => `- \`${command}\``).join("\n"),
    "",
    "## Runner Protocol Events",
    "",
    matrix.runnerProtocol.events.map((event) => `- \`${event}\``).join("\n"),
    "",
    "## Streaming Commands",
    "",
    matrix.runnerProtocol.streamingCommands.map((command) => `- \`${command}\``).join("\n"),
    "",
    "## Contract Notes",
    "",
    matrix.notes.map((note) => `- ${note}`).join("\n"),
    "",
    "## Source Of Truth",
    "",
    "- [cli/contractMatrix.ts](../../cli/contractMatrix.ts)",
    "- [docs/generated/cli-contract-matrix.json](../generated/cli-contract-matrix.json)",
    "",
  ].join("\n");
}

void main().catch((error) => {
  process.stderr.write(
    `generate-cli-contract-matrix failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
