import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const allowedSharedKestrelPackages = new Set(["@kestrel/mcp-security"]);
const failures: string[] = [];
let dependencies: Record<string, string> = {};

async function main(): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(path.join(appRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const requiredPackage of [
    "@kestrel-agents/next",
    "@kestrel-agents/sdk",
  ]) {
    if (packageJson.dependencies?.[requiredPackage] === undefined) {
      failures.push(
        `${requiredPackage} must be a direct production dependency.`,
      );
    }
  }

  for (const [name, version] of Object.entries(dependencies)) {
    if (name !== "kestrel" && name.startsWith("@kestrel-agents/") === false) {
      continue;
    }
    if (/^(?:workspace|file|link|portal|git|https?):/u.test(version)) {
      failures.push(`${name} must use a released version, found '${version}'.`);
      continue;
    }
    if (
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        version,
      ) === false
    ) {
      failures.push(`${name} must use an exact version, found '${version}'.`);
    }
  }

  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (/pnpm\s+(?:--filter|-F)\s+@?kestrel/iu.test(command)) {
      failures.push(
        `script '${name}' builds or runs a sibling Kestrel workspace package.`,
      );
    }
  }

  for (const filePath of await listSourceFiles(appRoot)) {
    const source = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(filePath),
    );
    for (const specifier of readModuleSpecifiers(sourceFile)) {
      validateModuleSpecifier(filePath, specifier);
    }
  }

  const config = ts.readConfigFile(
    path.join(appRoot, "tsconfig.json"),
    ts.sys.readFile,
  );
  if (config.error !== undefined) {
    failures.push(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  } else {
    const paths = config.config?.compilerOptions?.paths as
      | Record<string, string[]>
      | undefined;
    for (const [alias, targets] of Object.entries(paths ?? {})) {
      for (const target of targets) {
        const resolved = path.resolve(appRoot, target.replace(/\*.*$/u, ""));
        if (isWithinApp(resolved) === false) {
          failures.push(
            `tsconfig path '${alias}' escapes Kestrel One: ${target}`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Kestrel One public-package boundary check failed:\n${failures
        .sort()
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    );
  }

  process.stdout.write("Kestrel One public-package boundary check passed.\n");
}

void main();

function validateModuleSpecifier(filePath: string, specifier: string): void {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(filePath), specifier);
    if (isWithinApp(resolved) === false) {
      failures.push(
        `${path.relative(appRoot, filePath)} imports outside Kestrel One: ${specifier}`,
      );
    }
    return;
  }
  if (path.isAbsolute(specifier)) {
    failures.push(
      `${path.relative(appRoot, filePath)} uses an absolute import: ${specifier}`,
    );
    return;
  }
  if (specifier.startsWith("@kestrel/")) {
    if (allowedSharedKestrelPackages.has(specifier)) {
      return;
    }
    failures.push(
      `${path.relative(appRoot, filePath)} imports another Kestrel product: ${specifier}`,
    );
    return;
  }
  const packageName = readKestrelPackageName(specifier);
  if (packageName === undefined) {
    return;
  }
  if (dependencies[packageName] === undefined) {
    failures.push(
      `${path.relative(appRoot, filePath)} imports undeclared Kestrel package '${packageName}'.`,
    );
  }
  if (/\/(?:dist|src)(?:\/|$)/u.test(specifier)) {
    failures.push(
      `${path.relative(appRoot, filePath)} bypasses public package exports: ${specifier}`,
    );
  }
}

function readKestrelPackageName(specifier: string): string | undefined {
  if (specifier === "kestrel" || specifier.startsWith("kestrel/")) {
    return "kestrel";
  }
  if (specifier.startsWith("@kestrel-agents/") === false) {
    return undefined;
  }
  const [scope, name] = specifier.split("/");
  return name === undefined ? undefined : `${scope}/${name}`;
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      files.push(...(await listSourceFiles(path.join(directory, entry.name))));
      continue;
    }
    if (
      entry.isFile() &&
      sourceExtensions.has(path.extname(entry.name).toLowerCase())
    ) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function readModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (/\.[cm]?js$/u.test(filePath)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isWithinApp(targetPath: string): boolean {
  const relative = path.relative(appRoot, targetPath);
  return (
    relative.length === 0 ||
    (relative.startsWith("..") === false && path.isAbsolute(relative) === false)
  );
}
