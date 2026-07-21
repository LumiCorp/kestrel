import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const PROOF_LANES = [
  "policy",
  "runtime",
  "packages",
  "web",
  "services",
  "postgres",
  "product",
  "desktop",
  "docs",
  "package-macos",
];

const root = process.cwd();
const registryPath = path.join(root, "tests/proof/registry.json");
const catalogPath = path.join(root, "tests/proof/catalog.json");
const mutationsPath = path.join(root, "tests/proof/mutations.json");
const evidencePath = path.join(root, "tests/proof/mutation-evidence.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const mutations = JSON.parse(readFileSync(mutationsPath, "utf8"));
const mutationEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const writeCatalog = process.argv.includes("--write-catalog");
const errors = [];

if (registry.version !== 1 || !Array.isArray(registry.contracts)) {
  throw new Error("tests/proof/registry.json must contain version 1 contracts.");
}

const contractIds = new Set();
for (const contract of registry.contracts) {
  if (contractIds.has(contract.id)) errors.push(`duplicate contract id: ${contract.id}`);
  contractIds.add(contract.id);
  if (!PROOF_LANES.includes(contract.lane)) errors.push(`${contract.id}: unknown lane ${contract.lane}`);
  for (const field of ["owner", "risk", "counterexample", "environment"]) {
    if (typeof contract[field] !== "string" || contract[field].trim().length === 0) {
      errors.push(`${contract.id}: ${field} is required`);
    }
  }
}

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => existsSync(path.join(root, file)))
  .filter(isTestFile);
const discovered = [];
for (const relativeFile of trackedFiles) {
  discoverTests(relativeFile, discovered, errors);
}

for (const relativeFile of execFileSync("git", ["ls-files", "-z", ".github/workflows/*", "**/*playwright*.config.ts"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
  const sourceText = readFileSync(path.join(root, relativeFile), "utf8");
  for (const match of sourceText.matchAll(/\bretries\s*:\s*([^,\n}]+)/gu)) {
    if (match[1]?.trim() !== "0") errors.push(`${relativeFile}: CI retries are prohibited (${match[0]})`);
  }
}

const identities = new Set();
for (const item of discovered) {
  if (identities.has(item.identity)) errors.push(`duplicate test identity: ${item.identity}`);
  identities.add(item.identity);
}

const contractCounts = new Map();
const catalogTests = discovered.map((item) => {
  const matches = registry.contracts.filter((contract) => matchesContract(item.file, contract));
  if (matches.length === 0) {
    errors.push(`${item.identity}: no proof contract owns this test`);
    return { ...item, contractId: "unowned" };
  }
  const contract = matches[0];
  contractCounts.set(contract.id, (contractCounts.get(contract.id) ?? 0) + 1);
  return {
    ...item,
    contractId: contract.id,
    owner: contract.owner,
    risk: contract.risk,
    counterexample: `${contract.counterexample} Executable counterexample: ${item.title}`,
    dimension: item.title,
    lane: contract.lane,
    environment: contract.environment,
  };
});

for (const contract of registry.contracts) {
  if (!contractCounts.has(contract.id)) errors.push(`${contract.id}: contract has no executable tests`);
}

const dimensions = new Set();
for (const item of catalogTests) {
  const key = `${item.contractId}\0${item.dimension}`;
  if (dimensions.has(key)) errors.push(`${item.identity}: duplicate contract dimension`);
  dimensions.add(key);
}

verifyMutationEvidence(registry, mutations, mutationEvidence, errors);

const catalog = {
  version: 1,
  generatedFrom: "tracked static test declarations",
  testCount: catalogTests.length,
  tests: assignStableRoles(catalogTests),
};
const rendered = `${JSON.stringify(catalog, null, 2)}\n`;
if (writeCatalog) {
  writeFileSync(catalogPath, rendered, "utf8");
} else if (readFileSync(catalogPath, "utf8") !== rendered) {
  errors.push("tests/proof/catalog.json is stale; run pnpm run test-proofs:catalog");
}

if (errors.length > 0) {
  throw new Error(`Test-proof verification failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
process.stdout.write(
  `[test-proofs] verified ${catalog.testCount} tests across ${contractCounts.size} contracts\n`,
);

function isTestFile(file) {
  return (
    !(file.startsWith("apps/desktop/resources/") || file.includes("/.external/")) &&
    /(?:\.(?:test|spec)\.(?:[cm]?[jt]sx?)|\.ops\.ts)$/u.test(file)
  );
}

function matchesContract(file, contract) {
  return (
    (contract.files ?? []).includes(file) ||
    (contract.prefixes ?? []).some((prefix) => file.startsWith(prefix)) ||
    (contract.suffixes ?? []).some((suffix) => file.endsWith(suffix))
  );
}

function discoverTests(relativeFile, output, violations) {
  const sourceText = readFileSync(path.join(root, relativeFile), "utf8");
  const source = ts.createSourceFile(
    relativeFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativeFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node, ancestors) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "skip"
      ) {
        violations.push(`${relativeFile}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: skip is prohibited`);
      }
      const kind = testCallKind(node.expression);
      if (kind === "describe") {
        const title = staticTitle(node.arguments[0]);
        if (title === undefined) {
          violations.push(`${relativeFile}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: describe title must be a literal string`);
        }
        const callback = node.arguments.find(
          (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
        );
        if (callback) visit(callback.body, [...ancestors, title ?? "<dynamic describe>"]);
        return;
      }
      if (kind === "skip" || kind === "todo" || kind === "only") {
        violations.push(`${relativeFile}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${kind} is prohibited`);
      }
      if (kind === "test" || kind === "skip" || kind === "todo" || kind === "only") {
        const title = staticTitle(node.arguments[0]);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const options = node.arguments[1];
        if (
          options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "skip",
          )
        ) {
          violations.push(`${relativeFile}:${line}: skip is prohibited`);
        }
        if (title === undefined) {
          violations.push(`${relativeFile}:${line}: test title must be a literal string`);
        } else {
          output.push({
            identity: [relativeFile, ...ancestors, title].join(" :: "),
            file: relativeFile,
            line,
            ancestors,
            title,
          });
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, ancestors));
  };
  visit(source, []);
}

function testCallKind(expression) {
  if (ts.isIdentifier(expression) && (expression.text === "test" || expression.text === "it")) {
    return "test";
  }
  if (!ts.isPropertyAccessExpression(expression)) return;
  if (ts.isIdentifier(expression.expression) && expression.expression.text === "describe") {
    return expression.name.text === "only" ? "only" : "describe";
  }
  if (
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "test" || expression.expression.text === "it")
  ) {
    if (expression.name.text === "describe") return "describe";
    if (["skip", "todo", "only"].includes(expression.name.text)) return expression.name.text;
  }
  return;
}

function staticTitle(node) {
  if (!node) return;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
}

function assignStableRoles(tests) {
  const primaryContracts = new Set();
  return tests
    .sort((left, right) => left.identity.localeCompare(right.identity))
    .map((item) => {
      const role = primaryContracts.has(item.contractId) ? "variant" : "primary";
      primaryContracts.add(item.contractId);
      const { lane, environment, ...identity } = item;
      return { ...identity, role, lane, environment };
    });
}

function verifyMutationEvidence(input, mutationInput, evidenceInput, violations) {
  if (mutationInput.version !== 1 || !Array.isArray(mutationInput.mutations)) {
    violations.push("tests/proof/mutations.json must contain version 1 mutations");
    return;
  }
  if (evidenceInput.version !== 1 || !Array.isArray(evidenceInput.evidence)) {
    violations.push("tests/proof/mutation-evidence.json must contain version 1 evidence");
    return;
  }
  const specs = new Map();
  for (const mutation of mutationInput.mutations) {
    if (specs.has(mutation.id)) violations.push(`${mutation.id}: duplicate mutation id`);
    specs.set(mutation.id, mutation);
    if (!contractIds.has(mutation.contractId)) {
      violations.push(`${mutation.id}: mutation references unknown contract ${mutation.contractId}`);
    }
    const targetText = readFileSync(path.join(root, mutation.target), "utf8");
    const occurrences = targetText.split(mutation.find).length - 1;
    if (occurrences !== 1 || mutation.find === mutation.replace) {
      violations.push(`${mutation.id}: mutation must define one exact, behavior-changing target`);
    }
  }
  const byContract = new Map();
  for (const evidence of evidenceInput.evidence) {
    const spec = specs.get(evidence.id);
    if (!spec) {
      violations.push(`${evidence.id}: evidence has no mutation specification`);
      continue;
    }
    if (!contractIds.has(evidence.contractId)) {
      violations.push(`${evidence.id}: mutation references unknown contract ${evidence.contractId}`);
      continue;
    }
    byContract.set(evidence.contractId, (byContract.get(evidence.contractId) ?? 0) + 1);
    if (evidence.sourceSha256 !== sha256(evidence.target)) {
      violations.push(`${evidence.id}: production source hash is stale`);
    }
    const testHash = createHash("sha256");
    for (const file of evidence.testFiles ?? []) testHash.update(readFileSync(path.join(root, file)));
    if (evidence.testsSha256 !== testHash.digest("hex")) {
      violations.push(`${evidence.id}: owning test hash is stale`);
    }
    if (evidence.result !== "killed" || typeof evidence.command !== "string") {
      violations.push(`${evidence.id}: mutation must record a killed result and command`);
    }
    if (
      evidence.contractId !== spec.contractId ||
      evidence.target !== spec.target ||
      evidence.command !== [spec.command, ...spec.args].join(" ")
    ) {
      violations.push(`${evidence.id}: evidence does not match its mutation specification`);
    }
  }
  for (const contract of input.contracts) {
    if (["high", "critical"].includes(contract.risk) && !byContract.has(contract.id)) {
      violations.push(`${contract.id}: ${contract.risk} contract requires mutation evidence`);
    }
  }
}
