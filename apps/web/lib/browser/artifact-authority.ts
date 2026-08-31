import { createPublicKey } from "node:crypto";
import { CONVERSATION_ATTACHMENT_MAX_FILE_BYTES } from "@kestrel-agents/conversation";
import {
  BROWSER_AUTHORIZED_ARTIFACT_VERSION,
  type BrowserArtifactAuthorizationRequestV1,
  type BrowserAuthorizedArtifactV1,
} from "../../../../src/browser/contracts.js";
import {
  deriveHostedBrowserArtifactId,
  issueHostedBrowserArtifactUploadCapability,
  verifyHostedBrowserArtifactUploadCapability,
  type HostedBrowserArtifactIdentityV1,
} from "../../../../src/browser/hostedArtifactCapability.js";
import type { HostedBrowserOriginAuthority } from "./store";

const ARTIFACT_CAPABILITY_MS = 60_000;

export interface HostedBrowserArtifactFileV1 {
  id: string;
  organizationId: string;
  uploaderUserId: string | null;
  filename: string;
  declaredMediaType: string | null;
  detectedMediaType: string | null;
  sizeBytes: number;
  sha256: string | null;
  lifecycleState: "draft" | "ready" | "quarantined" | "failed" | "deleted";
}

export interface HostedBrowserArtifactFilePort {
  reconcileDownloads?(): Promise<void>;
  initialize(input: {
    fileId: string;
    threadId: string;
    organizationId: string;
    userId: string;
    filename: string;
    sizeBytes: number;
    declaredMediaType: "image/png";
  }): Promise<HostedBrowserArtifactFileV1>;
  upload(input: {
    fileId: string;
    threadId: string;
    organizationId: string;
    userId: string;
    body: ReadableStream<Uint8Array> | null;
    contentLength: number;
    expectedSha256: string;
  }): Promise<HostedBrowserArtifactFileV1>;
  read(input: {
    fileId: string;
    threadId: string;
    organizationId: string;
    userId: string;
  }): Promise<HostedBrowserArtifactFileV1>;
  stageDownload?(input: {
    operationId: string; organizationId: string; threadId: string; userId: string;
    sessionId: string; generation: number; pendingDownloadId: string;
    filename: string; declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
    body: NodeJS.ReadableStream;
  }): Promise<void>;
  reserveDownload?(input: {
    operationId: string; organizationId: string; threadId: string; userId: string;
    sessionId: string; generation: number; pendingDownloadId: string;
    filename: string; declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<"reserved" | "in_progress" | "staged" | "promoted">;
  cancelDownload?(input: {
    operationId: string; organizationId: string; threadId: string; userId: string;
    sessionId: string; generation: number; pendingDownloadId: string;
    filename: string; declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<void>;
  commitDownload?(input: {
    operationId: string; organizationId: string; threadId: string; userId: string;
    sessionId: string; generation: number; pendingDownloadId: string;
    filename: string; declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<HostedBrowserArtifactFileV1>;
  readDownloadPromotion?(input: {
    operationId: string; fileId: string; organizationId: string; threadId: string;
    userId: string; sessionId: string; generation: number;
  }): Promise<HostedBrowserArtifactFileV1 | undefined>;
}

export interface HostedBrowserArtifactUploadInstructionV1 {
  version: "hosted_browser_artifact_upload_instruction_v1";
  artifactId: string;
  artifactKind: "browser-screenshot";
  uploadPath: string;
  capability: string;
  byteLength: number;
  sha256: string;
  expiresAt: string;
}

export class HostedBrowserArtifactAuthority {
  readonly #publicKeyPem: string;
  readonly #downloadReconciliation: Promise<void>;

  constructor(private readonly options: {
    files: HostedBrowserArtifactFilePort;
    privateKeyPem: string;
    now?: (() => Date) | undefined;
  }) {
    this.#publicKeyPem = createPublicKey(options.privateKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();
    this.#downloadReconciliation = options.files.reconcileDownloads?.() ?? Promise.resolve();
    void this.#downloadReconciliation.catch(() => {});
  }

  async prepareScreenshotUpload(input: {
    origin: HostedBrowserOriginAuthority;
    sessionId: string;
    generation: number;
    callId: string;
    byteLength: number;
    sha256: string;
  }): Promise<HostedBrowserArtifactUploadInstructionV1> {
    const identity = this.#identity(input);
    this.#assertSize(identity.byteLength);
    const artifactId = deriveHostedBrowserArtifactId(identity);
    const filename = `browser-screenshot-${artifactId.slice(-16)}.png`;
    let file: HostedBrowserArtifactFileV1;
    try {
      file = await this.options.files.initialize({
        fileId: artifactId,
        threadId: identity.threadId,
        organizationId: identity.organizationId,
        userId: identity.userId,
        filename,
        sizeBytes: identity.byteLength,
        declaredMediaType: "image/png",
      });
    } catch (error) {
      try {
        file = await this.options.files.read({
          fileId: artifactId,
          threadId: identity.threadId,
          organizationId: identity.organizationId,
          userId: identity.userId,
        });
      } catch {
        throw error;
      }
    }
    if (
      file.id !== artifactId ||
      file.organizationId !== identity.organizationId ||
      file.uploaderUserId !== identity.userId ||
      file.filename !== filename ||
      file.sizeBytes !== identity.byteLength ||
      file.declaredMediaType !== "image/png" ||
      file.lifecycleState !== "draft"
    ) {
      throw new Error("BROWSER_ARTIFACT_AUTHORITY_INVALID");
    }
    const expiresAt = new Date(
      this.#now().getTime() + ARTIFACT_CAPABILITY_MS,
    ).toISOString();
    const issued = issueHostedBrowserArtifactUploadCapability({
      identity,
      expiresAt,
      privateKeyPem: this.options.privateKeyPem,
      now: this.#now(),
    });
    return {
      version: "hosted_browser_artifact_upload_instruction_v1",
      artifactId,
      artifactKind: "browser-screenshot",
      uploadPath:
        `/api/runtime/browser-artifacts/${encodeURIComponent(artifactId)}`,
      capability: issued.token,
      byteLength: identity.byteLength,
      sha256: identity.sha256,
      expiresAt,
    };
  }

  async upload(input: {
    token: string;
    fileId: string;
    body: ReadableStream<Uint8Array> | null;
    contentLength: number;
  }): Promise<HostedBrowserArtifactFileV1> {
    const claims = verifyHostedBrowserArtifactUploadCapability({
      token: input.token,
      publicKeyPem: this.#publicKeyPem,
      now: this.#now(),
    });
    this.#assertSize(claims.byteLength);
    if (
      input.fileId !== claims.artifactId ||
      input.contentLength !== claims.byteLength
    ) {
      throw new Error("BROWSER_ARTIFACT_AUTHORITY_INVALID");
    }
    const uploaded = await this.options.files.upload({
      fileId: claims.artifactId,
      threadId: claims.threadId,
      organizationId: claims.organizationId,
      userId: claims.userId,
      body: input.body,
      contentLength: claims.byteLength,
      expectedSha256: claims.sha256,
    });
    this.#assertReadyFile(uploaded, claims);
    return uploaded;
  }

  async stageDownload(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
    body: NodeJS.ReadableStream;
  }): Promise<void> {
    await this.#downloadReconciliation;
    if (!this.options.files.stageDownload) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
    await this.options.files.stageDownload({
      operationId: input.operationId,
      organizationId: input.origin.organizationId,
      threadId: input.origin.threadId,
      userId: input.origin.userId,
      sessionId: input.sessionId,
      generation: input.generation,
      pendingDownloadId: input.pendingDownloadId,
      filename: input.filename,
      declaredMediaType: input.declaredMediaType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      expiresAt: input.expiresAt,
      body: input.body,
    });
  }

  async reserveDownload(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<"reserved" | "in_progress" | "staged" | "promoted"> {
    await this.#downloadReconciliation;
    if (!this.options.files.reserveDownload) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
    return await this.options.files.reserveDownload({
      ...input,
      organizationId: input.origin.organizationId,
      threadId: input.origin.threadId,
      userId: input.origin.userId,
    });
  }

  async cancelDownload(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<void> {
    await this.#downloadReconciliation;
    if (!this.options.files.cancelDownload) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
    await this.options.files.cancelDownload({
      ...input,
      organizationId: input.origin.organizationId,
      threadId: input.origin.threadId,
      userId: input.origin.userId,
    });
  }

  async commitDownload(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<BrowserAuthorizedArtifactV1> {
    await this.#downloadReconciliation;
    if (!this.options.files.commitDownload) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
    const file = await this.options.files.commitDownload({
      operationId: input.operationId,
      organizationId: input.origin.organizationId,
      threadId: input.origin.threadId,
      userId: input.origin.userId,
      sessionId: input.sessionId,
      generation: input.generation,
      pendingDownloadId: input.pendingDownloadId,
      filename: input.filename,
      declaredMediaType: input.declaredMediaType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      expiresAt: input.expiresAt,
    });
    if (
      file.organizationId !== input.origin.organizationId ||
      file.uploaderUserId !== input.origin.userId ||
      file.filename !== input.filename ||
      file.sizeBytes !== input.sizeBytes ||
      file.sha256 !== input.sha256 ||
      file.lifecycleState !== "ready"
    ) throw new Error("BROWSER_ARTIFACT_AUTHORITY_INVALID");
    return {
      version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
      id: file.id,
      title: file.filename,
      kind: "browser-download",
      mediaType: file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
      bytes: file.sizeBytes,
      sha256: input.sha256,
    };
  }

  /**
   * Canonicalizes screenshot bytes already carried by the bounded App relay.
   * This follows the same draft -> ready, single-use authority path as the
   * direct upload route; the relay never becomes a second artifact store.
   */
  async canonicalizeRelayedScreenshot(input: {
    origin: HostedBrowserOriginAuthority;
    sessionId: string;
    generation: number;
    callId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<BrowserAuthorizedArtifactV1> {
    const instruction = await this.prepareScreenshotUpload({
      origin: input.origin,
      sessionId: input.sessionId,
      generation: input.generation,
      callId: input.callId,
      byteLength: input.bytes.byteLength,
      sha256: input.sha256,
    });
    const copied = Uint8Array.from(input.bytes);
    await this.upload({
      token: instruction.capability,
      fileId: instruction.artifactId,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copied);
          controller.close();
        },
      }),
      contentLength: copied.byteLength,
    });
    const authorized = await this.authorize({
      version: "browser_artifact_authorization_v1",
      runId: input.origin.runId,
      threadId: input.origin.threadId,
      callId: input.callId,
      toolName: "browser.capture",
      sessionId: input.sessionId,
      artifactId: instruction.artifactId,
      artifactKind: "browser-screenshot",
      origin: input.origin,
      generation: input.generation,
    });
    if (!authorized) throw new Error("BROWSER_ARTIFACT_AUTHORITY_INVALID");
    return authorized;
  }

  async authorize(input: BrowserArtifactAuthorizationRequestV1 & {
    origin: HostedBrowserOriginAuthority;
    generation: number;
  }): Promise<BrowserAuthorizedArtifactV1 | undefined> {
    if (input.toolName === "browser.download" && input.artifactKind === "browser-download") {
      if (!this.options.files.readDownloadPromotion) return;
      let file: HostedBrowserArtifactFileV1;
      try {
        const promoted = await this.options.files.readDownloadPromotion({
          operationId: input.callId,
          fileId: input.artifactId,
          threadId: input.threadId,
          organizationId: input.origin.organizationId,
          userId: input.origin.userId,
          sessionId: input.sessionId,
          generation: input.generation,
        });
        if (!promoted) return;
        file = promoted;
      } catch {
        return;
      }
      if (!(file.sha256 && file.lifecycleState === "ready")) return;
      return {
        version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
        id: file.id,
        title: file.filename,
        kind: "browser-download",
        url: `/api/files/${encodeURIComponent(file.id)}/content`,
        mediaType: file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
        bytes: file.sizeBytes,
        sha256: file.sha256,
      };
    }
    if (
      input.toolName !== "browser.capture" ||
      input.artifactKind !== "browser-screenshot"
    ) return;
    let file: HostedBrowserArtifactFileV1;
    try {
      file = await this.options.files.read({
        fileId: input.artifactId,
        threadId: input.threadId,
        organizationId: input.origin.organizationId,
        userId: input.origin.userId,
      });
    } catch {
      return;
    }
    if (!(file.sha256 && file.lifecycleState === "ready")) return;
    const identity = this.#identity({
      origin: input.origin,
      sessionId: input.sessionId,
      generation: input.generation,
      callId: input.callId,
      byteLength: file.sizeBytes,
      sha256: file.sha256,
    });
    if (deriveHostedBrowserArtifactId(identity) !== input.artifactId) return;
    try {
      this.#assertReadyFile(file, {
        ...identity,
        artifactId: input.artifactId,
      });
    } catch {
      return;
    }
    return {
      version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
      id: file.id,
      title: "Browser screenshot",
      kind: "browser-screenshot",
      url: `/api/files/${encodeURIComponent(file.id)}/content`,
      mediaType: "image/png",
      bytes: file.sizeBytes,
      sha256: file.sha256,
    };
  }

  #identity(input: {
    origin: HostedBrowserOriginAuthority;
    sessionId: string;
    generation: number;
    callId: string;
    byteLength: number;
    sha256: string;
  }): HostedBrowserArtifactIdentityV1 {
    return {
      organizationId: input.origin.organizationId,
      userId: input.origin.userId,
      threadId: input.origin.threadId,
      runId: input.origin.runId,
      sessionId: input.sessionId,
      generation: input.generation,
      callId: input.callId,
      artifactKind: "browser-screenshot",
      byteLength: input.byteLength,
      sha256: input.sha256,
    };
  }

  #assertReadyFile(
    file: HostedBrowserArtifactFileV1,
    claims: {
      artifactId: string;
      organizationId: string;
      userId: string;
      byteLength: number;
      sha256: string;
    },
  ): void {
    if (
      file.id !== claims.artifactId ||
      file.organizationId !== claims.organizationId ||
      file.uploaderUserId !== claims.userId ||
      file.filename !== `browser-screenshot-${file.id.slice(-16)}.png` ||
      file.declaredMediaType !== "image/png" ||
      file.lifecycleState !== "ready" ||
      file.sizeBytes !== claims.byteLength ||
      file.sha256 !== claims.sha256 ||
      file.detectedMediaType !== "image/png"
    ) {
      throw new Error("BROWSER_ARTIFACT_AUTHORITY_INVALID");
    }
  }

  #assertSize(byteLength: number): void {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES
    ) {
      throw new Error("BROWSER_ARTIFACT_TOO_LARGE");
    }
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
