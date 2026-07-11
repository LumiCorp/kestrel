---
id: adr-project-scoped-full-auto-card-threads
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-01
depends_on:
  - ../../CONTEXT.md
  - ../../src/project/contracts.ts
  - ../../src/project/board.ts
  - ../../cli/runtime/KestrelChatRuntime.ts
---

# Project-scoped full-auto card threads

See also: [Docs index](../index.md).

Autopilot and Co-pilot card execution create assigned implementation and testing threads that run in `build` interaction mode with the `full_auto` act submode. These threads may bypass runtime approval prompts, but only inside the Project's configured tool and resource scope. This keeps card execution useful without expanding project permissions, and makes the autonomy grant explicit through Project Autopilot confirmation or a per-card Co-pilot start prompt.
