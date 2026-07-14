import { spawn } from "node:child_process";

import {
  parseLocalCoreCredentialId,
  parseLocalCoreCredentialSecret,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStore,
} from "./credentialStore.js";

export const MACOS_SECURITY_EXECUTABLE = "/usr/bin/security";
export const KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE =
  "com.kestrel.local-core.credentials";
export const MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const MACOS_SECURITY_INTERACTIVE_MAX_LINE_BYTES = 4_095;

export type MacosKeychainOperation = "read" | "write" | "delete" | "inspect";

export interface MacosSecurityCommandInput {
  executable: typeof MACOS_SECURITY_EXECUTABLE;
  args: readonly string[];
  stdin?: string | undefined;
}

export interface MacosSecurityCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type MacosSecurityCommandRunner = (
  input: MacosSecurityCommandInput,
) => Promise<MacosSecurityCommandResult>;

export interface MacosKeychainCredentialStoreOptions {
  runCommand?: MacosSecurityCommandRunner | undefined;
}

export class MacosKeychainCredentialStoreError extends Error {
  readonly code = "LOCAL_CORE_KEYCHAIN_OPERATION_FAILED";
  readonly backend = "macos_keychain" as const;
  readonly operation: MacosKeychainOperation;
  readonly credentialId: LocalCoreCredentialId;
  readonly exitCode: number | undefined;

  constructor(input: {
    operation: MacosKeychainOperation;
    credentialId: LocalCoreCredentialId;
    exitCode?: number | undefined;
  }) {
    super(
      `Local Core could not ${describeOperation(input.operation)} credential '${input.credentialId}' in macOS Keychain.`,
    );
    this.name = "MacosKeychainCredentialStoreError";
    this.operation = input.operation;
    this.credentialId = input.credentialId;
    this.exitCode = input.exitCode;
  }
}

/**
 * Stores Local Core credentials as generic-password items in the user's
 * default macOS Keychain. There is deliberately no filesystem fallback.
 */
export class MacosKeychainCredentialStore implements LocalCoreCredentialStore {
  readonly backend = "macos_keychain" as const;
  readonly available = true;
  readonly #runCommand: MacosSecurityCommandRunner;

  constructor(options: MacosKeychainCredentialStoreOptions = {}) {
    this.#runCommand = options.runCommand ?? runMacosSecurityCommand;
  }

  async get(id: LocalCoreCredentialId): Promise<string | undefined> {
    const credentialId = parseLocalCoreCredentialId(id);
    const result = await this.#execute({
      operation: "read",
      credentialId,
      args: [
        "find-generic-password",
        "-s",
        KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE,
        "-a",
        credentialId,
        "-w",
      ],
    });
    if (isMacosKeychainItemNotFound(result)) {
      return undefined;
    }
    this.#assertSucceeded("read", credentialId, result);
    try {
      return parseLocalCoreCredentialSecret(stripTerminalLineBreak(result.stdout));
    } catch {
      throw new MacosKeychainCredentialStoreError({
        operation: "read",
        credentialId,
        exitCode: result.exitCode,
      });
    }
  }

  async set(id: LocalCoreCredentialId, secret: string): Promise<void> {
    const credentialId = parseLocalCoreCredentialId(id);
    const credentialSecret = parseLocalCoreCredentialSecret(secret);
    const interactiveCommand = buildMacosKeychainWriteCommand(
      credentialId,
      credentialSecret,
    );
    const result = await this.#execute({
      operation: "write",
      credentialId,
      args: ["-i"],
      stdin: interactiveCommand,
    });
    this.#assertSucceeded("write", credentialId, result);
  }

  async delete(id: LocalCoreCredentialId): Promise<boolean> {
    const credentialId = parseLocalCoreCredentialId(id);
    const result = await this.#execute({
      operation: "delete",
      credentialId,
      args: [
        "delete-generic-password",
        "-s",
        KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE,
        "-a",
        credentialId,
      ],
    });
    if (isMacosKeychainItemNotFound(result)) {
      return false;
    }
    this.#assertSucceeded("delete", credentialId, result);
    return true;
  }

  async has(id: LocalCoreCredentialId): Promise<boolean> {
    const credentialId = parseLocalCoreCredentialId(id);
    const result = await this.#execute({
      operation: "inspect",
      credentialId,
      args: [
        "find-generic-password",
        "-s",
        KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE,
        "-a",
        credentialId,
      ],
    });
    if (isMacosKeychainItemNotFound(result)) {
      return false;
    }
    this.#assertSucceeded("inspect", credentialId, result);
    return true;
  }

  async #execute(input: {
    operation: MacosKeychainOperation;
    credentialId: LocalCoreCredentialId;
    args: readonly string[];
    stdin?: string | undefined;
  }): Promise<MacosSecurityCommandResult> {
    try {
      const result = await this.#runCommand({
        executable: MACOS_SECURITY_EXECUTABLE,
        args: input.args,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      });
      if (
        typeof result !== "object"
        || result === null
        || Number.isInteger(result.exitCode) === false
        || typeof result.stdout !== "string"
        || typeof result.stderr !== "string"
      ) {
        throw new Error("Invalid macOS security command result.");
      }
      return result;
    } catch {
      throw new MacosKeychainCredentialStoreError({
        operation: input.operation,
        credentialId: input.credentialId,
      });
    }
  }

  #assertSucceeded(
    operation: MacosKeychainOperation,
    credentialId: LocalCoreCredentialId,
    result: MacosSecurityCommandResult,
  ): void {
    if (result.exitCode !== 0) {
      throw new MacosKeychainCredentialStoreError({
        operation,
        credentialId,
        exitCode: result.exitCode,
      });
    }
  }
}

export function isMacosKeychainItemNotFound(
  result: Pick<MacosSecurityCommandResult, "exitCode">,
): boolean {
  return result.exitCode === MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE;
}

async function runMacosSecurityCommand(
  input: MacosSecurityCommandInput,
): Promise<MacosSecurityCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // The process exit result remains authoritative when it closes stdin early.
    });
    child.once("error", (error) => {
      if (settled === false) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode) => {
      if (settled === false) {
        settled = true;
        resolve({
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        });
      }
    });

    child.stdin.end(input.stdin ?? "", "utf8");
  });
}

function stripTerminalLineBreak(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}

function buildMacosKeychainWriteCommand(
  credentialId: LocalCoreCredentialId,
  secret: string,
): string {
  // A trailing `-w` invokes getpass(3), which reads from the terminal rather
  // than stdin. Interactive mode accepts commands on stdin, and `-X` keeps an
  // exact UTF-8 value in that channel without needing shell quoting.
  const encodedSecret = Buffer.from(secret, "utf8").toString("hex");
  const command = [
    "add-generic-password",
    "-U",
    "-s",
    KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE,
    "-a",
    credentialId,
    "-X",
    encodedSecret,
  ].join(" ");
  const inputLine = `${command}\n`;
  if (Buffer.byteLength(inputLine, "utf8") > MACOS_SECURITY_INTERACTIVE_MAX_LINE_BYTES) {
    throw new MacosKeychainCredentialStoreError({
      operation: "write",
      credentialId,
    });
  }
  return inputLine;
}

function describeOperation(operation: MacosKeychainOperation): string {
  if (operation === "read") {
    return "read";
  }
  if (operation === "write") {
    return "write";
  }
  if (operation === "delete") {
    return "delete";
  }
  return "inspect";
}
