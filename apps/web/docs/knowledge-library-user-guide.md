# Knowledge Library User Guide

The Knowledge Library lets your organization upload shared files and use them in chat alongside the existing GitHub and YouTube knowledge sources.

## What you can upload

- PDF files
- Word, Excel, and PowerPoint `.docx`, `.xlsx`, and `.pptx`
- Text, Markdown, CSV, JSON, YAML, and HTML
- Images for best-effort OCR

## Uploading from the Knowledge page

1. Open `/knowledge`.
2. Click **Upload** in the header and select one or more files.
3. Wait for each file to appear in the **Knowledge Explorer**.
4. Watch the document status until it becomes `ready` or `partial`.

Status meanings:

- `uploaded`: the file is stored and queued
- `processing`: extraction or embedding is running
- `ready`: searchable in chat
- `partial`: searchable with warnings
- `failed`: stored, but indexing did not complete

## Promoting a chat attachment

When you attach a supported file in chat, the UI can offer **Chat + Knowledge**.

- `Chat only` keeps the file private to the current conversation.
- `Chat + Knowledge` adds the attachment to the shared Knowledge Library for the active organization.

Only the person who uploaded the chat attachment can promote it into shared knowledge.

## Using documents in chat

- Ask questions naturally.
- The assistant can use document retrieval automatically for uploaded files.
- Answers should include citations or reference links when matching documents are found.
- Opening a citation downloads or renders the original stored file through an app-owned route.

## Reindexing and deletion

- Uploaders can reindex or delete their own documents.
- Admins can reindex or delete any document in the active organization.
- Reindexing keeps the original file and reruns extraction, chunking, and embeddings.

## Limits and expectations

- Uploads larger than 32 MB are rejected by the direct Knowledge upload endpoint.
- Images use best-effort OCR.
- Some files may finish as `partial` if text extraction is incomplete.
- Duplicate uploads may be deduplicated against an existing document in the same organization.
