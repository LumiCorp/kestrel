import JSZip from "jszip";
import mammoth from "mammoth";
import { read, utils } from "xlsx";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { Worker } from "node:worker_threads";

export const DEFAULT_ATTACHMENT_EXTRACTED_TEXT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_PROCESSOR_INPUT_BYTES = 100 * 1024 * 1024;

const MAX_OFFICE_ARCHIVE_ENTRIES = 5000;
const MAX_OFFICE_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_OFFICE_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_OFFICE_ARCHIVE_COMPRESSION_RATIO = 200;

export interface AttachmentTextExtraction {
  text: string;
  truncated: boolean;
  warnings: string[];
}

export async function extractAttachmentTextIsolated(input: {
  buffer: Buffer;
  filename: string;
  mediaType: string;
  maxTextBytes?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<AttachmentTextExtraction> {
  if (input.buffer.byteLength > MAX_ATTACHMENT_PROCESSOR_INPUT_BYTES) {
    throw new Error("Attachment processor input exceeds the 100 MiB limit.");
  }
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    // The extractor owns its worker runtime. Hosting platforms may start the
    // parent with flags that Node explicitly rejects for Worker instances.
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  const timeoutMs = input.timeoutMs ?? 30_000;
  return await new Promise<AttachmentTextExtraction>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      operation();
    };
    timer = setTimeout(() => finish(() => reject(new Error("Attachment extraction timed out."))), timeoutMs);
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`Attachment extraction worker exited with code ${code}.`)));
    });
    worker.once("message", (message: unknown) => {
      const record = typeof message === "object" && message !== null ? message as Record<string, unknown> : undefined;
      if (record?.ok !== true) {
        finish(() => reject(new Error(typeof record?.error === "string" ? record.error : "Attachment extraction failed.")));
        return;
      }
      const result = record.result as AttachmentTextExtraction | undefined;
      if (
        result === undefined
        || typeof result.text !== "string"
        || typeof result.truncated !== "boolean"
        || Array.isArray(result.warnings) === false
        || result.warnings.some((warning) => typeof warning !== "string")
      ) {
        finish(() => reject(new Error("Attachment extraction worker returned an invalid result.")));
        return;
      }
      finish(() => resolve(result));
    });
    worker.postMessage({
      buffer: input.buffer,
      filename: input.filename,
      mediaType: input.mediaType,
      ...(input.maxTextBytes !== undefined ? { maxTextBytes: input.maxTextBytes } : {}),
    });
  });
}

const EXTRACTABLE_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/yaml",
]);

export function isAttachmentTextExtractable(mediaType: string): boolean {
  return mediaType.startsWith("text/") || EXTRACTABLE_MEDIA_TYPES.has(mediaType);
}

export async function extractAttachmentText(input: {
  buffer: Buffer;
  filename: string;
  mediaType: string;
  maxTextBytes?: number | undefined;
}): Promise<AttachmentTextExtraction> {
  if (input.buffer.byteLength > MAX_ATTACHMENT_PROCESSOR_INPUT_BYTES) {
    throw new Error("Attachment processor input exceeds the 100 MiB limit.");
  }
  const mediaType = input.mediaType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  let text = "";
  const warnings: string[] = [];
  if (mediaType === "application/pdf") {
    const { PDFParse, pdfJsRoot } = await loadPdfParser();
    const parser = new PDFParse({
      data: input.buffer,
      cMapUrl: `${join(pdfJsRoot, "cmaps")}${sep}`,
      cMapPacked: true,
      standardFontDataUrl: `${join(pdfJsRoot, "standard_fonts")}${sep}`,
      wasmUrl: `${join(pdfJsRoot, "wasm")}${sep}`,
    });
    try {
      const parsed = await parser.getText();
      text = parsed.pages
        .map((page) => page.text.trim())
        .filter(Boolean)
        .join("\n\n");
      if (text.length > 0 && text.length < 80) warnings.push("pdf_text_sparse");
    } finally {
      await parser.destroy().catch(() => {});
    }
  } else if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    await assertSafeOfficeArchive(input.buffer);
    const result = await mammoth.extractRawText({ buffer: input.buffer });
    text = result.value.trim();
    warnings.push(...result.messages.map((message) => message.message));
  } else if (mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    await assertSafeOfficeArchive(input.buffer);
    const workbook = read(input.buffer, { type: "buffer" });
    text = workbook.SheetNames.flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return [];
      const rows = utils.sheet_to_json<Array<string | number | null>>(sheet, {
        header: 1,
        blankrows: false,
        raw: false,
      });
      const rendered = rows.map((row) => row.filter((cell) => cell !== null && cell !== "").join(" | "))
        .filter(Boolean)
        .join("\n");
      return rendered ? [`# ${sheetName}\n${rendered}`] : [];
    }).join("\n\n");
  } else if (mediaType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const zip = await JSZip.loadAsync(input.buffer);
    assertSafeLoadedOfficeArchive(zip);
    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const slideText: string[] = [];
    for (const [index, slide] of slides.entries()) {
      const xml = await zip.file(slide)?.async("string");
      const lines = xml ? Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu))
        .map((match) => decodeXml(match[1] ?? "").trim())
        .filter(Boolean) : [];
      if (lines.length > 0) slideText.push(`# Slide ${index + 1}\n${lines.join("\n")}`);
    }
    text = slideText.join("\n\n");
  } else if (mediaType === "text/html") {
    text = input.buffer.toString("utf8").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
  } else if (isAttachmentTextExtractable(mediaType)) {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.buffer).replaceAll("\u0000", "").trim();
  } else {
    throw new Error(`No attachment text extractor is registered for '${mediaType}'.`);
  }
  const maxBytes = input.maxTextBytes ?? DEFAULT_ATTACHMENT_EXTRACTED_TEXT_BYTES;
  const bytes = Buffer.from(text, "utf8");
  return {
    text: bytes.subarray(0, maxBytes).toString("utf8"),
    truncated: bytes.byteLength > maxBytes,
    warnings,
  };
}

let pdfRuntimePromise: ReturnType<typeof initializePdfRuntime> | undefined;

async function initializePdfRuntime() {
  const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
  const runtimeGlobals = globalThis as unknown as Record<string, unknown>;
  runtimeGlobals.DOMMatrix ??= DOMMatrix;
  runtimeGlobals.ImageData ??= ImageData;
  runtimeGlobals.Path2D ??= Path2D;
  const [{ PDFParse }, { getPath }] = await Promise.all([
    import("pdf-parse"),
    import("pdf-parse/worker"),
  ]);
  PDFParse.setWorker(getPath());
  const require = createRequire(import.meta.url);
  const pdfJsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  return { PDFParse, pdfJsRoot };
}

async function loadPdfParser() {
  pdfRuntimePromise ??= initializePdfRuntime();
  try {
    return await pdfRuntimePromise;
  } catch (error) {
    pdfRuntimePromise = undefined;
    throw error;
  }
}

async function assertSafeOfficeArchive(buffer: Buffer): Promise<void> {
  assertSafeLoadedOfficeArchive(await JSZip.loadAsync(buffer));
}

function assertSafeLoadedOfficeArchive(zip: JSZip): void {
  const entries = Object.values(zip.files).filter((entry) => entry.dir === false);
  if (entries.length > MAX_OFFICE_ARCHIVE_ENTRIES) {
    throw new Error("Office document contains too many archive entries.");
  }
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const metadata = (entry as unknown as {
      _data?: { compressedSize?: number; uncompressedSize?: number } | undefined;
    })._data;
    const compressedBytes = metadata?.compressedSize;
    const uncompressedBytes = metadata?.uncompressedSize;
    if (
      typeof compressedBytes !== "number"
      || typeof uncompressedBytes !== "number"
      || Number.isSafeInteger(compressedBytes) === false
      || Number.isSafeInteger(uncompressedBytes) === false
      || compressedBytes < 0
      || uncompressedBytes < 0
    ) {
      throw new Error("Office document archive metadata is invalid.");
    }
    if (uncompressedBytes > MAX_OFFICE_ARCHIVE_ENTRY_BYTES) {
      throw new Error("Office document archive entry exceeds the extraction limit.");
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > MAX_OFFICE_ARCHIVE_TOTAL_BYTES) {
      throw new Error("Office document expands beyond the extraction limit.");
    }
    if (
      uncompressedBytes > 0
      && uncompressedBytes / Math.max(1, compressedBytes) > MAX_OFFICE_ARCHIVE_COMPRESSION_RATIO
    ) {
      throw new Error("Office document compression ratio exceeds the extraction limit.");
    }
  }
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}
