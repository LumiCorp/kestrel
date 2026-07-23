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

- `/api/knowledge/documents`
- `/api/knowledge/documents/[id]`
- `/api/knowledge/documents/[id]/reindex`
- `/api/knowledge/documents/[id]/download`
- `/api/knowledge/documents/promote`
- `/api/knowledge/documents/search`

## Runtime and configuration endpoints

- `/api/organization/agent-config`
- `/api/organization/agent-config/public`
- `/api/runtime/apps`
- `/api/stats`
- `/api/stats/me`
- `/api/stats/usage`

## Integration guidance

- Use the app session flow for browser requests.
- Treat all knowledge, runtime, and admin calls as active-organization scoped.
- Use `/api/organization/agent-config/public` for client-side organization configuration reads; use `/api/organization/agent-config` for Organization Admin mutations.
- Prefer these canonical routes instead of legacy chatbot shims or older compatibility endpoints.
