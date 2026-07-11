# Documentation Review: 2026-03-24

Reviewed Markdown docs in the repository and evaluated staleness against the current codebase and route surface. This workspace does not currently expose a `.git` root, so staleness was judged from code-to-doc alignment rather than commit history.

## Inventory

| Document | Category | Staleness | Notes |
| --- | --- | --- | --- |
| `README.md` | Root/product overview | Needs update | Mostly current, but parts of the API inventory lag the actual route surface. |
| `docs/knowledge-library-user-guide.md` | User guide | Current | Matches the current knowledge document workflow and limits. |
| `content/admin-docs/admin-mode.md` | Admin reference | Current | Policy and org-scoping description match the current auth model. |
| `content/admin-docs/api-keys.md` | Admin reference | Current | Behavior matches the org-scoped admin API key implementation. |
| `content/admin-docs/discord-bot.md` | Admin reference | Current | Route examples and guild binding workflow align with the current tools surface. |
| `content/admin-docs/getting-started.md` | Admin reference | Current | Local bootstrap, seeded admin defaults, and key surfaces are accurate. |
| `content/admin-docs/github-bot.md` | Admin reference | Current | Current webhook path and source/snapshot flow still match implementation. |
| `content/admin-docs/knowledge-library.md` | Admin reference | Current | Storage, queue, runtime, and troubleshooting details match the current pipeline. |
| `content/admin-docs/sdk.md` | Admin reference | Needs update | Canonical endpoint list is now too narrow for the current chat/knowledge/tooling API surface. |
| `docs/plans/2026-03-17-ascii-hero-design.md` | Historical design note | Current as archive | Dated by design; reads like an implementation note, not live product docs. |
| `docs/plans/2026-03-18-compose-local-dev-design.md` | Historical design note | Current as archive | Still aligns with the implemented local-dev model. |
| `docs/plans/2026-03-19-readme-branding-design.md` | Historical design note | Current as archive | Pure branding rationale; no live-doc drift to fix. |
| `docs/plans/2026-03-19-tools-control-plane-design.md` | Historical design note | Current as archive | Design intent matches the current Admin Tools direction. |
| `docs/plans/2026-03-20-chat-suggestion-catalog-design.md` | Historical design note | Current as archive | Remains a valid historical design document. |
| `tests/fixtures/knowledge-rag/README.md` | Test fixture doc | Current | Still accurately describes fixture generation and purpose. |
| `tests/fixtures/knowledge-rag/knowledge-runbook.md` | Test fixture doc | Current | Fixture content is intentionally minimal and consistent with the corpus. |

## Doc-by-doc report

- `README.md`
  Update the canonical API section to reflect the current route model. Replace the generic `/api/sandbox` entry with `/api/sandbox/shell` and `/api/sandbox/snapshot`, and consider whether `/api/chats/[id]/stream`, `/api/messages/[id]/speech`, and `/api/tools/runtime` now belong in the supported surface.
- `docs/knowledge-library-user-guide.md`
  No update needed. The upload types, promotion flow, statuses, and 32 MB limit match the current knowledge document implementation.
- `content/admin-docs/admin-mode.md`
  No update needed. The admin auth plus `ADMIN_USER_IDS` override and active-organization scoping are still accurate.
- `content/admin-docs/api-keys.md`
  No update needed. The document correctly describes org-scoped key creation, one-time secret return, hashing at rest, and revoke/delete behavior.
- `content/admin-docs/discord-bot.md`
  No update needed. The Discord interactions path, gateway activation flow, and guild binding model are aligned with the current runtime.
- `content/admin-docs/getting-started.md`
  No update needed. Local bootstrap commands, seeded defaults, and the main product surfaces are current.
- `content/admin-docs/github-bot.md`
  No update needed. The GitHub source-sync-snapshot flow and webhook guidance still fit the codebase.
- `content/admin-docs/knowledge-library.md`
  No update needed. The document correctly reflects MinIO-backed storage, `pg-boss` ingestion, runtime diagnostics, and permissions.
- `content/admin-docs/sdk.md`
  Expand this doc so it reflects the actual canonical integration surface. It should at least mention the knowledge document endpoints and likely the public agent-config, chat stream, and tool runtime routes if external consumers are expected to use them.
- `docs/plans/2026-03-17-ascii-hero-design.md`
  No content update needed. If desired, add a short archival marker so readers do not confuse it with a live requirements doc.
- `docs/plans/2026-03-18-compose-local-dev-design.md`
  No content update needed. This is a historical design note and still matches the implemented local-dev approach.
- `docs/plans/2026-03-19-readme-branding-design.md`
  No content update needed. It is intentionally historical and still corresponds to the current README branding.
- `docs/plans/2026-03-19-tools-control-plane-design.md`
  No content update needed. If this folder is meant to hold finalized historical designs, an archival banner would make that clearer.
- `docs/plans/2026-03-20-chat-suggestion-catalog-design.md`
  No content update needed. Treat it as design history rather than live product documentation.
- `tests/fixtures/knowledge-rag/README.md`
  No update needed. The fixture generation note still matches the current test setup.
- `tests/fixtures/knowledge-rag/knowledge-runbook.md`
  No update needed. This appears to be intentional fixture content rather than repo documentation.

## Priority follow-ups

1. Update `README.md` so the public API inventory does not mislead readers about the sandbox and chat route surface.
2. Expand `content/admin-docs/sdk.md` so it covers the current knowledge and runtime endpoints rather than only the older core subset.
3. Decide whether `docs/plans/` should be explicitly marked as archival to avoid readers treating design notes as live docs.
