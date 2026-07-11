---
id: composer-multimodal-followups-2026-05-13
domain: web
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../../AGENTS.md
  - ../../apps/web/app/_components/thread/ThreadComposer.tsx
  - ../../apps/web/lib/server/composerAttachments.ts
  - ../../src/kestrel/contracts.ts
---

# Composer Multimodal, Draft, History, Follow-Up, Approval, And Dictation Design

See also: [Plans index](../PLANS.md).

## Scope

This slice extends the hardened web/desktop `ThreadComposer` without changing the app shell. It adds local draft attachments, durable composer drafts, prompt history, FIFO busy follow-ups with inline steering, compact approval/checkpoint rows, and dictation duration polish.

Out of scope for v1: PDFs, Office documents, folders, audio attachments, permanent attachment libraries, command ranking changes, fuzzy matching, model-name capability guessing, and silent fallback behavior.

## Attachments

Attachments are local, thread-scoped files stored under:

`${KESTREL_HOME}/composer-attachments/<threadId>/<attachmentId>/`

The web API owns upload, preview, and deletion:

- `POST /api/kchat/attachments` accepts multipart `threadId` plus `file`.
- `GET /api/kchat/attachments/:attachmentId?threadId=...` serves preview/download.
- `DELETE /api/kchat/attachments/:attachmentId?threadId=...` removes unsent draft files.

Metadata records include `attachmentId`, `threadId`, `filename`, `mimeType`, `sizeBytes`, `sha256`, `kind`, `createdAt`, and `status`.

Supported v1 files:

- Images: PNG, JPEG, WebP, max 10 MB each.
- Text/code: `text/*`, Markdown, JSON, JS/TS/TSX/JSX, CSS, HTML, YAML, logs, plain UTF-8 files, max 1 MB each.
- Draft cap: 8 attachments and 25 MB total.

Images are hydrated as base64 model image parts only after submit/control acceptance. Text/code files are hydrated as bounded UTF-8 text context with metadata.

## Model Contract

`ModelMessage.content` supports either legacy `string` content or internal multimodal parts:

- `{ type: "text"; text: string }`
- `{ type: "image"; mimeType: string; data: string }`

OpenAI, OpenRouter, and Anthropic mappers translate these parts to provider-native image content. Text-only requests keep the string path.

Image submit and steer are gated by `profile.modelCapabilities.visionInputEnabled === true`. The default is `false`; unsupported image attempts are rejected before clearing draft text or attachments.

## Composer State

Draft persistence uses `kchat:web:composer-drafts:v1` and stores per-thread draft text, attachment draft metadata, queued follow-ups, and update time. Prompt history uses `kchat:web:prompt-history:v1`, with current-thread prompts ranked before same-workspace prompts.

Prompt history records accepted normal submits, queued follow-ups, and steered follow-ups. The picker opens from the plus menu and from `ArrowUp` when the composer is empty.

## Busy Follow-Ups

When the agent is busy, submit stages a FIFO follow-up row instead of rejecting the operator. The composer clears immediately, preserving the fast-submit feel.

Each queued row shows prompt preview, attachment names, `Steer`, and delete. `Steer` sends `operator.control action: "steer"` with text and attachment refs, preserving the existing next-execution-boundary semantics. Untouched rows auto-submit one at a time when the thread becomes available.

## Approval And Checkpoint Rows

Approval and checkpoint states render as compact composer-integrated rows with optional notes. Approval notes are transported in the approval/deny reply text. Checkpoint notes are included on the control message where supported and mirrored in the local transcript.

## Dictation

Dictation still inserts directly into the composer. Provider order remains native `SpeechRecognition`/`webkitSpeechRecognition` first, then `MediaRecorder` plus `/api/kchat/transcribe`. The UI adds visible listening duration and clearer recorder transition status without changing transcription routing.
