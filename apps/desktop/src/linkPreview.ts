import { promises as dns } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import sharp from "sharp";
import {
  assertPublicResolvedAddresses,
  normalizeMcpResolutionHostname,
  type McpResolvedAddress,
} from "@kestrel/mcp-security";
import type {
  DesktopLinkPreviewAvailable,
  DesktopLinkPreviewInput,
  DesktopLinkPreviewResult,
  DesktopLinkPreviewUnavailableReason,
} from "./contracts.js";

const MAX_PREVIEWS = 4;
const MAX_INPUT_URL_LENGTH = 4_096;
const MAX_HTML_BYTES = 512 * 1_024;
const MAX_IMAGE_BYTES = 2 * 1_024 * 1_024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_DIMENSION = 8_192;
const MAX_THUMBNAIL_WIDTH = 640;
const MAX_THUMBNAIL_HEIGHT = 360;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 8_000;
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 15 * 60 * 1_000;
const MAX_CACHE_BYTES = 32 * 1_024 * 1_024;
const USER_AGENT = "KestrelDesktop/0.8 LinkPreview";

type ResolvedAddress = McpResolvedAddress;
type ResolveAddresses = (hostname: string) => Promise<ResolvedAddress[]>;

interface ResourceResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface ResourceRequest {
  url: URL;
  pinned: ResolvedAddress;
  headers: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
}

type RequestResource = (input: ResourceRequest) => Promise<ResourceResponse>;
type NormalizeImage = (
  resource: FetchedResource,
  timeoutMs: number,
) => Promise<string | undefined>;

interface FetchedResource extends ResourceResponse {
  finalUrl: URL;
}

interface LinkPreviewServiceOptions {
  now?: (() => number) | undefined;
  resolve?: ResolveAddresses | undefined;
  request?: RequestResource | undefined;
  normalizeImage?: NormalizeImage | undefined;
}

interface CacheEntry {
  result: DesktopLinkPreviewResult;
  expiresAt: number;
  bytes: number;
}

class LinkPreviewError extends Error {
  constructor(readonly reason: DesktopLinkPreviewUnavailableReason) {
    super(reason);
  }
}

export function parseDesktopLinkPreviewInput(
  value: unknown,
): DesktopLinkPreviewInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("desktop.getLinkPreviews requires an object input.");
  }
  const record = value as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => key !== "urls");
  if (unknownFields.length > 0) {
    throw new Error(
      `desktop.getLinkPreviews does not support '${unknownFields[0]}'.`,
    );
  }
  if (
    !Array.isArray(record.urls) ||
    record.urls.length < 1 ||
    record.urls.length > MAX_PREVIEWS
  ) {
    throw new Error("desktop.getLinkPreviews requires from 1 to 4 URLs.");
  }
  const urls = record.urls.map((value, index) => {
    if (typeof value !== "string" || value.length > MAX_INPUT_URL_LENGTH) {
      throw new Error(`desktop.getLinkPreviews.urls[${index}] is invalid.`);
    }
    const url = parseCredentialFreeHttpUrl(value);
    if (!url) {
      throw new Error(
        `desktop.getLinkPreviews.urls[${index}] must be a credential-free http(s) URL.`,
      );
    }
    return url.href;
  });
  if (new Set(urls).size !== urls.length) {
    throw new Error("desktop.getLinkPreviews URLs must be unique.");
  }
  return { urls };
}

export class LinkPreviewService {
  readonly #now: () => number;
  readonly #resolve: ResolveAddresses;
  readonly #request: RequestResource;
  readonly #normalizeImage: NormalizeImage;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<DesktopLinkPreviewResult>>();
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  #cacheBytes = 0;

  constructor(options: LinkPreviewServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#resolve = options.resolve ?? resolveAddresses;
    this.#request = options.request ?? requestPinnedResource;
    this.#normalizeImage = options.normalizeImage ?? toSafeImageDataUrl;
  }

  async getPreviews(
    input: DesktopLinkPreviewInput,
  ): Promise<DesktopLinkPreviewResult[]> {
    return Promise.all(input.urls.map(async (url) => await this.#getPreview(url)));
  }

  async #getPreview(requestedUrl: string): Promise<DesktopLinkPreviewResult> {
    const cached = this.#readCache(requestedUrl);
    if (cached) return cached;
    const existing = this.#inflight.get(requestedUrl);
    if (existing) return await existing;
    const pending = this.#withPermit(async () => await this.#loadPreview(requestedUrl));
    this.#inflight.set(requestedUrl, pending);
    try {
      const result = await pending;
      this.#writeCache(requestedUrl, result);
      return result;
    } finally {
      this.#inflight.delete(requestedUrl);
    }
  }

  async #loadPreview(requestedUrl: string): Promise<DesktopLinkPreviewResult> {
    const url = parseCredentialFreeHttpUrl(requestedUrl);
    if (!url) return unavailable(requestedUrl, "unsupported");
    const deadline = this.#now() + TOTAL_TIMEOUT_MS;
    try {
      const document = await fetchPublicResource({
        url,
        accept: "text/html,application/xhtml+xml;q=0.9",
        maxBytes: MAX_HTML_BYTES,
        deadline,
        now: this.#now,
        resolve: this.#resolve,
        request: this.#request,
      });
      const contentType = readContentType(document.headers);
      if (
        contentType !== "text/html" &&
        contentType !== "application/xhtml+xml"
      ) {
        return unavailable(requestedUrl, "non_html");
      }
      const metadata = parseLinkPreviewMetadata(
        document.body.toString("utf8"),
        document.finalUrl,
      );
      if (!metadata) return unavailable(requestedUrl, "missing_metadata");
      let imageDataUrl: string | undefined;
      if (metadata.imageUrl) {
        try {
          const image = await fetchPublicResource({
            url: metadata.imageUrl,
            accept: "image/webp,image/png,image/jpeg;q=0.9",
            maxBytes: MAX_IMAGE_BYTES,
            deadline,
            now: this.#now,
            resolve: this.#resolve,
            request: this.#request,
          });
          const imageRemaining = deadline - this.#now();
          if (imageRemaining > 0) {
            imageDataUrl = await withTimeout(
              this.#normalizeImage(image, imageRemaining),
              imageRemaining,
            );
            if (this.#now() >= deadline) imageDataUrl = undefined;
          }
        } catch {
          imageDataUrl = undefined;
        }
      }
      return {
        status: "available",
        requestedUrl,
        finalUrl: document.finalUrl.href,
        title: metadata.title,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.siteName ? { siteName: metadata.siteName } : {}),
        ...(metadata.canonicalUrl
          ? { canonicalUrl: metadata.canonicalUrl.href }
          : {}),
        ...(imageDataUrl ? { imageDataUrl } : {}),
      };
    } catch (error) {
      return unavailable(requestedUrl, classifyPreviewError(error));
    }
  }

  async #withPermit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= MAX_PREVIEWS) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }

  #readCache(url: string): DesktopLinkPreviewResult | undefined {
    const entry = this.#cache.get(url);
    if (!entry) return;
    if (entry.expiresAt <= this.#now()) {
      this.#cache.delete(url);
      this.#cacheBytes -= entry.bytes;
      return;
    }
    this.#cache.delete(url);
    this.#cache.set(url, entry);
    return entry.result;
  }

  #writeCache(url: string, result: DesktopLinkPreviewResult): void {
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > MAX_CACHE_BYTES) return;
    const previous = this.#cache.get(url);
    if (previous) this.#cacheBytes -= previous.bytes;
    this.#cache.delete(url);
    this.#cache.set(url, {
      result,
      bytes,
      expiresAt:
        this.#now() +
        (result.status === "available" ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
    });
    this.#cacheBytes += bytes;
    while (this.#cacheBytes > MAX_CACHE_BYTES) {
      const oldest = this.#cache.entries().next().value as
        | [string, CacheEntry]
        | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#cacheBytes -= oldest[1].bytes;
    }
  }
}

export interface ParsedLinkPreviewMetadata {
  title: string;
  description?: string | undefined;
  siteName?: string | undefined;
  canonicalUrl?: URL | undefined;
  imageUrl?: URL | undefined;
}

export function parseLinkPreviewMetadata(
  html: string,
  documentUrl: URL,
): ParsedLinkPreviewMetadata | undefined {
  const document = parse(html);
  const metadata = new Map<string, string>();
  let htmlTitle: string | undefined;
  let canonicalHref: string | undefined;
  walkHtml(document, (node) => {
    if (!("tagName" in node)) return;
    const tagName = node.tagName.toLowerCase();
    if (tagName === "title" && htmlTitle === undefined) {
      htmlTitle = normalizeText(readNodeText(node), 240);
      return;
    }
    const attributes = new Map(
      node.attrs.map((attribute) => [
        attribute.name.toLowerCase(),
        attribute.value,
      ]),
    );
    if (tagName === "meta") {
      const key = (
        attributes.get("property") ?? attributes.get("name")
      )?.toLowerCase();
      const content = attributes.get("content");
      if (key && content && !metadata.has(key)) metadata.set(key, content);
    }
    if (
      tagName === "link" &&
      canonicalHref === undefined &&
      attributes
        .get("rel")
        ?.toLowerCase()
        .split(/\s+/u)
        .includes("canonical")
    ) {
      canonicalHref = attributes.get("href");
    }
  });
  const title = normalizeText(
    metadata.get("og:title") ?? metadata.get("twitter:title") ?? htmlTitle,
    240,
  );
  if (!title) return;
  const description = normalizeText(
    metadata.get("og:description") ??
      metadata.get("twitter:description") ??
      metadata.get("description"),
    500,
  );
  const siteName = normalizeText(metadata.get("og:site_name"), 120);
  const canonicalUrl = resolveMetadataUrl(canonicalHref, documentUrl);
  const imageUrl = resolveMetadataUrl(
    metadata.get("og:image:secure_url") ??
      metadata.get("og:image") ??
      metadata.get("twitter:image"),
    documentUrl,
  );
  return {
    title,
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

async function fetchPublicResource(input: {
  url: URL;
  accept: string;
  maxBytes: number;
  deadline: number;
  now: () => number;
  resolve: ResolveAddresses;
  request: RequestResource;
}): Promise<FetchedResource> {
  let current = input.url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remaining = input.deadline - input.now();
    if (remaining <= 0) throw new LinkPreviewError("timeout");
    const addresses = await withTimeout(
      input.resolve(normalizeMcpResolutionHostname(current.hostname)),
      Math.min(REQUEST_TIMEOUT_MS, remaining),
    )
      .catch((error: unknown) => {
        if (error instanceof LinkPreviewError) throw error;
        throw new LinkPreviewError(
          isAbortError(error) ? "timeout" : "network",
        );
      });
    try {
      assertPublicResolvedAddresses(addresses);
    } catch {
      throw new LinkPreviewError("blocked");
    }
    const pinned = addresses[0];
    if (!pinned) throw new LinkPreviewError("network");
    const requestRemaining = input.deadline - input.now();
    if (requestRemaining <= 0) throw new LinkPreviewError("timeout");
    const response = await input
      .request({
        url: current,
        pinned,
        maxBytes: input.maxBytes,
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, requestRemaining),
        headers: {
          accept: input.accept,
          "accept-language": "en-US,en;q=0.8",
          "user-agent": USER_AGENT,
        },
      })
      .catch((error: unknown) => {
        if (error instanceof LinkPreviewError) throw error;
        throw new LinkPreviewError(
          isAbortError(error) ? "timeout" : "network",
        );
      });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirects === MAX_REDIRECTS) {
        throw new LinkPreviewError("network");
      }
      const redirected = parseCredentialFreeHttpUrl(location, current);
      if (!redirected) throw new LinkPreviewError("blocked");
      current = redirected;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new LinkPreviewError("network");
    }
    return { ...response, finalUrl: current };
  }
  throw new LinkPreviewError("network");
}

export async function requestPinnedResource(
  input: ResourceRequest,
): Promise<ResourceResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const dispatcher = new Agent({
    maxRedirections: 0,
    connect: {
      lookup: createPinnedLookup(input.pinned),
    },
  });
  let completed = false;
  try {
    const response = await undiciFetch(input.url, {
      method: "GET",
      headers: input.headers,
      redirect: "manual",
      dispatcher,
      signal: controller.signal,
    });
    const body = await readLimitedBody(
      response.body as unknown as ReadableStream<Uint8Array> | null,
      input.maxBytes,
      () => controller.abort(),
    );
    completed = true;
    return {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers.entries()].map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
      body,
    };
  } catch (error) {
    controller.abort();
    if (error instanceof LinkPreviewError) throw error;
    if (isAbortError(error)) throw new LinkPreviewError("timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (completed) {
      await dispatcher.close();
    } else {
      await dispatcher.destroy().catch(() => undefined);
    }
  }
}

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  abort: () => void,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.byteLength;
      if (size > maxBytes) {
        abort();
        void reader.cancel("Link preview response exceeded its byte limit.")
          .catch(() => undefined);
        throw new LinkPreviewError("oversized");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function toSafeImageDataUrl(
  resource: FetchedResource,
  timeoutMs = TOTAL_TIMEOUT_MS,
): Promise<string | undefined> {
  const contentType = readContentType(resource.headers);
  const expectedFormat = contentType === "image/jpeg"
    ? "jpeg"
    : contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
        ? "webp"
        : undefined;
  if (!expectedFormat) return;
  try {
    const image = sharp(resource.body, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
    const metadata = await image.metadata();
    if (
      metadata.format !== expectedFormat ||
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > MAX_IMAGE_DIMENSION ||
      metadata.height > MAX_IMAGE_DIMENSION ||
      (metadata.pages ?? 1) !== 1
    ) {
      return;
    }
    const normalized = await image
      .rotate()
      .resize({
        width: MAX_THUMBNAIL_WIDTH,
        height: MAX_THUMBNAIL_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();
    return `data:image/webp;base64,${normalized.toString("base64")}`;
  } catch {
    return;
  }
}

function readContentType(headers: Record<string, string>): string {
  return (headers["content-type"] ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
}

function unavailable(
  requestedUrl: string,
  reason: DesktopLinkPreviewUnavailableReason,
): DesktopLinkPreviewResult {
  return { status: "unavailable", requestedUrl, reason };
}

function classifyPreviewError(
  error: unknown,
): DesktopLinkPreviewUnavailableReason {
  if (error instanceof LinkPreviewError) return error.reason;
  return isAbortError(error) ? "timeout" : "network";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("Link preview request timed out.", "AbortError"),
            ),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseCredentialFreeHttpUrl(
  value: string,
  base?: URL,
): URL | undefined {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return;
    }
    return url;
  } catch {
    return;
  }
}

function resolveMetadataUrl(value: string | undefined, base: URL): URL | undefined {
  if (!value) return;
  return parseCredentialFreeHttpUrl(value.trim(), base);
}

function normalizeText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return;
  return normalized.slice(0, maxLength);
}

function walkHtml(
  node: DefaultTreeAdapterMap["node"],
  visit: (node: DefaultTreeAdapterMap["node"]) => void,
): void {
  visit(node);
  if (!("childNodes" in node)) return;
  for (const child of node.childNodes) walkHtml(child, visit);
}

function readNodeText(node: DefaultTreeAdapterMap["node"]): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(readNodeText).join("");
}

async function resolveAddresses(hostname: string): Promise<ResolvedAddress[]> {
  return (await dns.lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => {
      if (entry.family !== 4 && entry.family !== 6) {
        throw new Error("Link preview resolved to an unsupported address.");
      }
      return { address: entry.address, family: entry.family };
    },
  );
}

export function createPinnedLookup(pinned: ResolvedAddress) {
  return (
    _hostname: string,
    options: { all?: boolean | undefined },
    callback: (
      error: NodeJS.ErrnoException | null,
      address:
        | string
        | Array<{ address: string; family: 4 | 6 }>,
      family?: 4 | 6,
    ) => void,
  ): void => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

export type {
  FetchedResource,
  RequestResource,
  ResourceRequest,
  ResourceResponse,
};
