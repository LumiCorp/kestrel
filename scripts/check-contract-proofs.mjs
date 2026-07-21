import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const registry = readJson("tests/proof/registry.json");
const mutations = readJson("tests/proof/mutations.json");
const evidence = readJson("tests/proof/mutation-evidence.json");
const errors = [];

if (registry.version !== 2 || !Array.isArray(registry.contracts)) throw new Error("tests/proof/registry.json must contain version 2 contracts");
const contracts = new Map();
for (const contract of registry.contracts) {
  if (contracts.has(contract.id)) errors.push(`duplicate contract id: ${contract.id}`);
  contracts.set(contract.id, contract);
  if (!["hermetic", "process", "postgres", "chromium"].includes(contract.boundary)) errors.push(`${contract.id}: invalid boundary ${contract.boundary}`);
  for (const field of ["owner", "risk", "counterexample"]) if (!contract[field]?.trim()) errors.push(`${contract.id}: ${field} is required`);
  if (!Array.isArray(contract.proofs) || contract.proofs.length === 0) errors.push(`${contract.id}: at least one explicit proof is required`);
  if (contract.risk === "critical" && (!Array.isArray(contract.mutations) || contract.mutations.length === 0)) errors.push(`${contract.id}: critical contracts require a semantic mutation`);
}

const discovered = [];
for (const file of trackedTestFiles()) discover(file, discovered);
const identities = new Map();
for (const proof of discovered) {
  for (const contractId of proof.contractIds) {
    const contract = contracts.get(contractId);
    if (!contract) {
      errors.push(`${proof.file}:${proof.line}: unknown contract ${contractId}`);
      continue;
    }
    if (contract.boundary !== proof.boundary) errors.push(`${proof.file}:${proof.line}: ${contractId} declares ${contract.boundary} but test uses ${proof.boundary}`);
    identities.set(`${contractId}\0${proof.file}\0${proof.test}`, proof);
  }
}

for (const contract of registry.contracts) {
  for (const proof of contract.proofs ?? []) {
    if (!identities.has(`${contract.id}\0${proof.file}\0${proof.test}`)) errors.push(`${contract.id}: missing explicit proof ${proof.file} :: ${proof.test}`);
  }
}

if (!process.argv.includes("--structure-only")) {
  verifyMutations();
  verifyTimingEvidence();
}
verifyNoRetries();

if (errors.length > 0) throw new Error(`Contract-proof verification failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
process.stdout.write(`[contracts] verified ${discovered.length} executable tests across ${contracts.size} contracts and four boundaries\n`);

function discover(file, output) {
  const sourceText = readFileSync(path.join(root, file), "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (isProhibitedTestModifier(node.expression)) errors.push(`${file}:${line}: skipped, todo, or exclusive tests are prohibited`);
      if (ts.isIdentifier(node.expression) && ["test", "it"].includes(node.expression.text)) errors.push(`${file}:${line}: use contractTest(contractId, title, ...)`);
      if (ts.isIdentifier(node.expression) && node.expression.text === "contractTest") {
        const contractIds = staticContractIds(node.arguments[0]);
        const title = staticString(node.arguments[1]);
        if (contractIds.length === 0) errors.push(`${file}:${line}: contractTest requires literal contract ids`);
        if (!title) errors.push(`${file}:${line}: contractTest requires a literal title`);
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument) && argument.properties.some((property) =>
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ["skip", "todo", "only"].includes(property.name.text)
          )) errors.push(`${file}:${line}: skipped, todo, or exclusive tests are prohibited`);
        }
        if (contractIds.length > 0 && title) output.push({ file, line, contractIds, test: title, boundary: boundaryFor(file, sourceText) });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function verifyMutations() {
  const specs = new Map((mutations.mutations ?? []).map((item) => [item.id, item]));
  const results = new Map((evidence.evidence ?? []).map((item) => [item.id, item]));
  for (const contract of registry.contracts.filter((item) => item.risk === "critical")) {
    for (const mutationId of contract.mutations) {
      const spec = specs.get(mutationId);
      const result = results.get(mutationId);
      if (!spec) { errors.push(`${contract.id}: missing mutation spec ${mutationId}`); continue; }
      if (spec.contractId !== contract.id) errors.push(`${mutationId}: mutation contract is ${spec.contractId}, expected ${contract.id}`);
      if (!result || result.result !== "killed") { errors.push(`${mutationId}: missing killed-mutation evidence`); continue; }
      if (result.sourceSha256 !== sha256(spec.target)) errors.push(`${mutationId}: production source changed since mutation evidence`);
      const testHash = createHash("sha256");
      for (const file of spec.testFiles) testHash.update(readFileSync(path.join(root, file)));
      if (result.testsSha256 !== testHash.digest("hex")) errors.push(`${mutationId}: owning proof changed since mutation evidence`);
    }
  }
}

function verifyTimingEvidence() {
  const timingFile = process.env.KESTREL_CONTRACT_TIMINGS;
  if (!timingFile || !existsSync(timingFile)) return;
  const observed = new Set();
  for (const line of readFileSync(timingFile, "utf8").split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    observed.add(item.contractId);
  }
  for (const contract of registry.contracts.filter((item) => !item.releaseOnly)) {
    if (!observed.has(contract.id)) errors.push(`${contract.id}: no runtime timing evidence`);
  }
}

function verifyNoRetries() {
  const files = execFileSync("git", ["ls-files", "-z", ".github/workflows/*", "**/*playwright*.config.ts"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bretries\s*:\s*([^,\n}]+)/gu)) if (match[1]?.trim() !== "0") errors.push(`${file}: retries must be zero`);
  }
}

function boundaryFor(file, source) {
  if (file.includes("/tests/product/")) return "chromium";
  if (file.endsWith(".postgres.test.ts")) return "postgres";
  if (/^tests\/(?:integration|smoke|ops|e2e)\//u.test(file) || file === "tests/unit/local-core-api.test.ts") return "process";
  if (/from ["']node:(?:child_process|net|http|https|readline)["']|\b(?:spawn|spawnSync|execFile|execFileSync|createServer)\s*\(/u.test(source)) return "process";
  return "hermetic";
}

function trackedTestFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
    .filter((file) => /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.ops\.ts)$/u.test(file))
    .filter((file) => existsSync(path.join(root, file)) && !file.startsWith("apps/desktop/resources/") && !file.includes("/.external/"));
}

function staticContractIds(node) {
  if (node && ts.isStringLiteral(node)) return [node.text];
  if (node && ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)) return node.elements.map((item) => item.text);
  return [];
}

function staticString(node) { return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined; }
function isProhibitedTestModifier(node) { return ts.isPropertyAccessExpression(node) && ["skip", "todo", "only"].includes(node.name.text) && ts.isIdentifier(node.expression) && ["test", "it", "contractTest"].includes(node.expression.text); }
function readJson(file) { return JSON.parse(readFileSync(path.join(root, file), "utf8")); }
function sha256(file) { return createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"); }
