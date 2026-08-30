import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

const AUTHORITY_VERSION = "kestrel-dev-shell-bootstrap-v2";
const OWNER_ENTRY = "owner";
const NEXT_OWNER_ENTRY = "next-owner";
export type DevShellBootstrapAuthorityFaultPhase = "publication_prepared" | "cleanup_claimed" | "cleanup_quarantined" | "transfer_claimed" | "transfer_prepared";
type FaultHook = (phase: DevShellBootstrapAuthorityFaultPhase) => void | Promise<void>;
interface Owner { pid: number; token: string; evidence: string }
interface NormalState { kind: "normal"; owner: Owner }
interface ClaimedState { kind: "claimed"; owner: Owner; claimant: Owner; claimEntry: string; nextOwner?: Owner | undefined }
type State = { kind: "missing" } | { kind: "invalid" } | { kind: "transient" } | NormalState | ClaimedState;
type OwnerReadResult =
  | { kind: "owner"; owner: Owner }
  | { kind: "invalid" }
  | { kind: "transient" };

export interface DevShellBootstrapAuthorityLease {
  readonly ownerPid: number;
  readonly ownerToken: string;
  verify(): Promise<boolean>;
  transferTo(input: { ownerPid: number; ownerToken: string; faultHook?: FaultHook | undefined }): Promise<boolean>;
  release(input?: { faultHook?: FaultHook | undefined }): Promise<boolean>;
}
export type DevShellBootstrapAuthorityResult =
  | { status: "acquired"; lease: DevShellBootstrapAuthorityLease }
  | { status: "unavailable"; reason: "invalid_owner_evidence" | "wait_timeout"; ownerPid?: number | undefined };

export function createDevShellBootstrapAuthorityToken(): string { return randomUUID(); }

export function parseDevShellBootstrapAuthorityEvidence(evidence: string): { pid: number; token: string } | undefined {
  const match = evidence.match(/^kestrel-dev-shell-bootstrap-v2:([1-9][0-9]*):([A-Za-z0-9_-]+)$/u);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== match[1]) return undefined;
  return { pid, token: match[2]! };
}

export async function acquireDevShellBootstrapAuthority(input: {
  authorityPath: string; ownerToken: string; timeoutMs: number; pollIntervalMs: number;
  ownerPid?: number | undefined; faultHook?: FaultHook | undefined;
}): Promise<DevShellBootstrapAuthorityResult> {
  const claimant = createOwner(input.ownerPid ?? process.pid, input.ownerToken);
  if (claimant === undefined) return { status: "unavailable", reason: "invalid_owner_evidence" };
  const deadline = Date.now() + input.timeoutMs;
  await mkdir(path.dirname(input.authorityPath), { recursive: true });
  while (true) {
    const state = await readState(input.authorityPath);
    if (state.kind === "missing") {
      if (await publish(input.authorityPath, claimant, input.faultHook)) return createLease(input.authorityPath, claimant);
      continue;
    }
    if (state.kind === "invalid") return { status: "unavailable", reason: "invalid_owner_evidence" };
    if (state.kind === "transient") {
      if (Date.now() >= deadline) return { status: "unavailable", reason: "wait_timeout" };
      await wait(input.pollIntervalMs); continue;
    }
    if (state.kind === "claimed") {
      if (!isPidRunning(state.claimant.pid)) {
        await recoverClaim(input.authorityPath, state, claimant);
        continue;
      }
      if (Date.now() >= deadline) return { status: "unavailable", reason: "wait_timeout", ownerPid: state.claimant.pid };
      await wait(input.pollIntervalMs); continue;
    }
    if (!isPidRunning(state.owner.pid)) {
      if (await claim(input.authorityPath, state.owner, claimant)) await quarantine(input.authorityPath, claimant);
      continue;
    }
    if (Date.now() >= deadline) return { status: "unavailable", reason: "wait_timeout", ownerPid: state.owner.pid };
    await wait(input.pollIntervalMs);
  }
}

export async function verifyDevShellBootstrapAuthority(input: { authorityPath: string; ownerToken: string; ownerPid?: number | undefined }): Promise<boolean> {
  const expected = createOwner(input.ownerPid ?? process.pid, input.ownerToken);
  if (expected === undefined) return false;
  const state = await readState(input.authorityPath);
  return state.kind === "normal" && state.owner.evidence === expected.evidence;
}

export async function releaseDevShellBootstrapAuthority(input: { authorityPath: string; ownerToken: string; ownerPid?: number | undefined; faultHook?: FaultHook | undefined }): Promise<boolean> {
  const owner = createOwner(input.ownerPid ?? process.pid, input.ownerToken);
  return owner !== undefined && release(input.authorityPath, owner, input.faultHook);
}

function createLease(authorityPath: string, initial: Owner): DevShellBootstrapAuthorityResult {
  let owner = initial;
  return { status: "acquired", lease: {
    get ownerPid() { return owner.pid; }, get ownerToken() { return owner.token; },
    async verify() {
      return verifyDevShellBootstrapAuthority({
        authorityPath,
        ownerPid: owner.pid,
        ownerToken: owner.token,
      });
    },
    async transferTo(input) {
      const next = createOwner(input.ownerPid, input.ownerToken);
      if (next === undefined) return false;
      const result = await transfer(authorityPath, owner, next, input.faultHook);
      if (result) owner = next;
      return result;
    },
    async release(input) { return release(authorityPath, owner, input?.faultHook); },
  } };
}

async function publish(authorityPath: string, owner: Owner, hook?: FaultHook): Promise<boolean> {
  const prepared = `${authorityPath}.publish-${owner.pid}-${owner.token}-${randomUUID()}`;
  await mkdir(prepared); await symlink(owner.evidence, path.join(prepared, OWNER_ENTRY));
  await hook?.("publication_prepared");
  if ((await readState(authorityPath)).kind !== "missing") { await rm(prepared, { recursive: true, force: true }); return false; }
  try { await rename(prepared, authorityPath); return true; }
  catch (error) {
    await rm(prepared, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(code(error) ?? "")) return false;
    throw error;
  }
}

async function transfer(authorityPath: string, expected: Owner, next: Owner, hook?: FaultHook): Promise<boolean> {
  if (!(await claim(authorityPath, expected, expected))) return false;
  await hook?.("transfer_claimed");
  const claimPath = path.join(authorityPath, claimName(expected));
  const nextPath = path.join(authorityPath, NEXT_OWNER_ENTRY);
  await symlink(next.evidence, nextPath); await hook?.("transfer_prepared");
  await rename(nextPath, claimPath); await rename(claimPath, path.join(authorityPath, OWNER_ENTRY));
  return true;
}

async function release(authorityPath: string, expected: Owner, hook?: FaultHook): Promise<boolean> {
  const state = await readState(authorityPath);
  if (state.kind === "missing") return true;
  if (state.kind === "claimed") {
    return state.claimant.evidence === expected.evidence
      ? quarantine(authorityPath, expected, hook)
      : false;
  }
  if (state.kind !== "normal" || state.owner.evidence !== expected.evidence) return false;
  if (!(await claim(authorityPath, expected, expected))) return false;
  await hook?.("cleanup_claimed");
  return quarantine(authorityPath, expected, hook);
}

async function claim(authorityPath: string, expected: Owner, claimant: Owner): Promise<boolean> {
  const state = await readState(authorityPath);
  if (state.kind !== "normal" || state.owner.evidence !== expected.evidence) return false;
  try { await rename(path.join(authorityPath, OWNER_ENTRY), path.join(authorityPath, claimName(claimant))); return true; }
  catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}

async function recoverClaim(authorityPath: string, state: ClaimedState, claimant: Owner): Promise<void> {
  const oldPath = path.join(authorityPath, state.claimEntry);
  const newPath = path.join(authorityPath, claimName(claimant));
  try { await rename(oldPath, newPath); } catch (error) { if (code(error) === "ENOENT") return; throw error; }
  const current = await readState(authorityPath);
  if (current.kind !== "claimed" || current.claimEntry !== claimName(claimant)) return;
  if (current.nextOwner !== undefined) {
    await rename(path.join(authorityPath, NEXT_OWNER_ENTRY), newPath);
    await rename(newPath, path.join(authorityPath, OWNER_ENTRY)); return;
  }
  if (isPidRunning(current.owner.pid)) { await rename(newPath, path.join(authorityPath, OWNER_ENTRY)); return; }
  await quarantine(authorityPath, claimant);
}

async function quarantine(authorityPath: string, claimant: Owner, hook?: FaultHook): Promise<boolean> {
  const state = await readState(authorityPath);
  if (state.kind !== "claimed" || state.claimEntry !== claimName(claimant)) return false;
  const destination = `${authorityPath}.released-${claimant.pid}-${claimant.token}-${randomUUID()}`;
  try { await rename(authorityPath, destination); } catch (error) { if (code(error) === "ENOENT") return false; throw error; }
  await hook?.("cleanup_quarantined");
  await rm(destination, { recursive: true, force: true }); return true;
}

async function readState(authorityPath: string): Promise<State> {
  return readStateOnce(authorityPath);
}

async function readStateOnce(authorityPath: string): Promise<State> {
  try {
    if (!(await lstat(authorityPath)).isDirectory()) return { kind: "invalid" };
    const entries = await readdir(authorityPath);
    const claims = entries.filter((entry) => entry.startsWith("claim--"));
    if (entries.length === 1 && entries[0] === OWNER_ENTRY) {
      const result = await readOwner(path.join(authorityPath, OWNER_ENTRY));
      return result.kind === "owner"
        ? { kind: "normal", owner: result.owner }
        : result;
    }
    if (claims.length === 1 && entries.every((entry) => entry === claims[0] || entry === NEXT_OWNER_ENTRY)) {
      const claimant = parseClaimName(claims[0]!);
      const ownerResult = await readOwner(path.join(authorityPath, claims[0]!));
      const nextOwnerResult = entries.includes(NEXT_OWNER_ENTRY)
        ? await readOwner(path.join(authorityPath, NEXT_OWNER_ENTRY))
        : undefined;
      if (ownerResult.kind === "transient" || nextOwnerResult?.kind === "transient") {
        return { kind: "transient" };
      }
      if (!claimant || ownerResult.kind !== "owner" || nextOwnerResult?.kind === "invalid") {
        return { kind: "invalid" };
      }
      return {
        kind: "claimed",
        owner: ownerResult.owner,
        claimant,
        claimEntry: claims[0]!,
        ...(nextOwnerResult?.kind === "owner" ? { nextOwner: nextOwnerResult.owner } : {}),
      };
    }
    return { kind: "invalid" };
  } catch (error) { return code(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" }; }
}

async function readOwner(entryPath: string): Promise<OwnerReadResult> {
  try {
    const [stats, evidence] = await Promise.all([lstat(entryPath), readlink(entryPath)]);
    if (!stats.isSymbolicLink()) return { kind: "invalid" };
    const parsed = parseDevShellBootstrapAuthorityEvidence(evidence);
    return parsed
      ? { kind: "owner", owner: { ...parsed, evidence } }
      : { kind: "invalid" };
  } catch (error) {
    return code(error) === "ENOENT"
      ? { kind: "transient" }
      : { kind: "invalid" };
  }
}
function createOwner(pid: number, token: string): Owner | undefined {
  const evidence = `${AUTHORITY_VERSION}:${pid}:${token}`;
  const parsed = parseDevShellBootstrapAuthorityEvidence(evidence);
  return parsed ? { ...parsed, evidence } : undefined;
}
function claimName(owner: Owner): string { return `claim--${owner.pid}--${owner.token}`; }
function parseClaimName(value: string): Owner | undefined {
  const match = value.match(/^claim--([1-9][0-9]*)--([A-Za-z0-9_-]+)$/u);
  return match ? createOwner(Number(match[1]), match[2]!) : undefined;
}
function isPidRunning(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return code(error) === "EPERM"; } }
function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined; }
async function wait(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }
