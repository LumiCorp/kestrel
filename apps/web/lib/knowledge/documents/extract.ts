import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { read, utils } from "xlsx";
import {
  getDirectRuntimeConfig,
  warnIfPlaceholderRuntimeConfig,
} from "@/lib/ai/surface-policy";
import type { ExtractedDocumentBlock } from "./chunk";
import { normalizeMediaType, stripMarkup } from "./shared";

export type ExtractKnowledgeDocumentResult = {
  title: string | null;
  pageCount: number | null;
  blocks: ExtractedDocumentBlock[];
  metadata: Record<string, unknown>;
  warnings: string[];
};

const TRAILING_SLASHES_REGEX = /\/+$/;
const PPTX_SLIDE_FILE_REGEX = /^ppt\/slides\/slide\d+\.xml$/;
const PPTX_TEXT_REGEX = /<a:t>([\s\S]*?)<\/a:t>/g;
const NULL_BYTE_CHARACTER = "\u0000";

async function extractTextFromImageWithVision(
  buffer: Buffer,
  mediaType: string
) {
  const config = getDirectRuntimeConfig("ocr");
  warnIfPlaceholderRuntimeConfig(config);

  if (!config.apiKey) {
    return { text: "", warning: "ocr_not_configured" };
  }

  const response = await fetch(
    `${config.baseURL.replace(TRAILING_SLASHES_REGEX, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract all readable text from this document image. Return only the extracted text. Preserve meaningful line breaks.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mediaType};base64,${buffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      text: "",
      warning: `ocr_failed:${body || response.statusText}`,
    };
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?:
          | string
          | Array<{
              type?: string;
              text?: string;
            }>;
      };
    }>;
  };

  const content = json.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? [])
          .map((part) => part.text ?? "")
          .join("\n")
          .trim();

  return {
    text,
    warning: text ? null : "ocr_empty",
  };
}

async function extractPdf(
  buffer: Buffer
): Promise<ExtractKnowledgeDocumentResult> {
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  await parser.destroy().catch(() => {
    // Best-effort cleanup for parser resources.
  });
  const text = parsed.text?.trim() ?? "";
  const warnings = text.length < 80 ? ["pdf_text_sparse"] : [];

  return {
    title: null,
    pageCount: parsed.total ?? null,
    blocks: text
      ? [
          {
            text,
            metadata: {
              source: "pdf",
            },
          },
        ]
      : [],
    metadata: {
      source: "pdf",
    },
    warnings,
  };
}

async function extractDocx(
  buffer: Buffer
): Promise<ExtractKnowledgeDocumentResult> {
  const result = await mammoth.extractRawText({ buffer });
  return {
    title: null,
    pageCount: null,
    blocks: result.value.trim()
      ? [{ text: result.value.trim(), metadata: { source: "docx" } }]
      : [],
    metadata: {
      messages: result.messages,
    },
    warnings: result.messages.map((message) => message.message),
  };
}

function extractXlsx(buffer: Buffer): ExtractKnowledgeDocumentResult {
  const workbook = read(buffer, { type: "buffer" });
  const blocks: ExtractedDocumentBlock[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    });

    const text = rows
      .map((row) =>
        row.filter((cell) => cell !== null && cell !== "").join(" | ")
      )
      .filter(Boolean)
      .join("\n");

    if (!text) {
      continue;
    }

    blocks.push({
      text,
      sectionTitle: sheetName,
      metadata: {
        sheetName,
        source: "xlsx",
      },
    });
  }

  return {
    title: null,
    pageCount: workbook.SheetNames.length,
    blocks,
    metadata: {
      sheets: workbook.SheetNames,
    },
    warnings: blocks.length === 0 ? ["spreadsheet_empty"] : [],
  };
}

async function extractPptx(
  buffer: Buffer
): Promise<ExtractKnowledgeDocumentResult> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => PPTX_SLIDE_FILE_REGEX.test(name))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true })
    );

  const blocks: ExtractedDocumentBlock[] = [];

  for (const [index, slideName] of slideNames.entries()) {
    const xml = await zip.file(slideName)?.async("string");
    if (!xml) {
      continue;
    }

    const textMatches = Array.from(xml.matchAll(PPTX_TEXT_REGEX))
      .map((match) => stripMarkup(match[1] ?? ""))
      .filter(Boolean);

    if (!textMatches.length) {
      continue;
    }

    blocks.push({
      text: textMatches.join("\n"),
      pageNumber: index + 1,
      sectionTitle: `Slide ${index + 1}`,
      metadata: {
        slideName,
        source: "pptx",
      },
    });
  }

  return {
    title: null,
    pageCount: slideNames.length,
    blocks,
    metadata: {
      slideCount: slideNames.length,
    },
    warnings: blocks.length === 0 ? ["presentation_empty"] : [],
  };
}

function extractUtf8Text(buffer: Buffer) {
  return buffer.toString("utf8").replaceAll(NULL_BYTE_CHARACTER, "").trim();
}

function extractHtmlText(buffer: Buffer) {
  return stripMarkup(extractUtf8Text(buffer));
}

export async function extractKnowledgeDocument(input: {
  buffer: Buffer;
  filename: string;
  mediaType: string;
}): Promise<ExtractKnowledgeDocumentResult> {
  const mediaType = normalizeMediaType(input.mediaType, input.filename);

  if (mediaType === "application/pdf") {
    return extractPdf(input.buffer);
  }

  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocx(input.buffer);
  }

  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return extractXlsx(input.buffer);
  }

  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return extractPptx(input.buffer);
  }

  if (
    mediaType === "text/plain" ||
    mediaType === "text/markdown" ||
    mediaType === "text/csv" ||
    mediaType === "application/json" ||
    mediaType === "application/yaml" ||
    mediaType === "text/yaml" ||
    mediaType === "application/x-yaml"
  ) {
    const text = extractUtf8Text(input.buffer);
    return {
      title: null,
      pageCount: null,
      blocks: text ? [{ text, metadata: { source: mediaType } }] : [],
      metadata: {
        source: mediaType,
      },
      warnings: text ? [] : ["document_empty"],
    };
  }

  if (mediaType === "text/html") {
    const text = extractHtmlText(input.buffer);
    return {
      title: null,
      pageCount: null,
      blocks: text ? [{ text, metadata: { source: mediaType } }] : [],
      metadata: {
        source: mediaType,
      },
      warnings: text ? [] : ["document_empty"],
    };
  }

  if (mediaType.startsWith("image/")) {
    const ocr = await extractTextFromImageWithVision(input.buffer, mediaType);
    return {
      title: null,
      pageCount: 1,
      blocks: ocr.text ? [{ text: ocr.text, pageNumber: 1 }] : [],
      metadata: {
        source: mediaType,
      },
      warnings: ocr.warning ? [ocr.warning] : [],
    };
  }

  throw new Error(`Unsupported document media type: ${mediaType}`);
}
