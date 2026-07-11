# SDK

Kestrel One standardizes on a canonical chat, knowledge, and runtime API family.

## Core chat endpoints

- `/api/chats`
- `/api/chats/[id]`
- `/api/chats/[id]/share`
- `/api/chats/[id]/stream`
- `/api/upload/[chatId]`
- `/api/files/[...pathname]`
- `/api/messages/[id]/feedback`
- `/api/messages/[id]/speech`
- `/api/shared/[token]`

## Knowledge endpoints

- `/api/sources`
- `/api/sources/[id]`
- `/api/sources/ocr`
- `/api/sync`
- `/api/sync/[source]`
- `/api/knowledge/documents`
- `/api/knowledge/documents/[id]`
- `/api/knowledge/documents/[id]/reindex`
- `/api/knowledge/documents/[id]/download`
- `/api/knowledge/documents/promote`
- `/api/knowledge/documents/search`
- `/api/snapshot/status`
- `/api/snapshot/config`
- `/api/snapshot/sync`

## Runtime and configuration endpoints

- `/api/agent-config`
- `/api/agent-config/public`
- `/api/tools/runtime`
- `/api/sandbox/shell`
- `/api/sandbox/snapshot`
- `/api/stats`
- `/api/stats/me`
- `/api/stats/usage`

## Integration guidance

- Use the app session flow for browser requests.
- Treat all knowledge, snapshot, runtime, and admin calls as active-organization scoped.
- Use `/api/agent-config/public` for client-side org configuration reads; keep `/api/agent-config` for admin/config mutation flows.
- Prefer these canonical routes instead of legacy chatbot shims or older compatibility endpoints.
