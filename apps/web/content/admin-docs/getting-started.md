# Getting Started

Kestrel One combines chat, knowledge management, and admin tooling in one Next.js runtime.

## Local bootstrap

1. Start the full local stack with `pnpm dev:all`.
2. Verify infra and app health with `pnpm smoke:local`.
3. Run the checked-in knowledge RAG fixture suite with `pnpm test:knowledge-rag:unit`.

## Default local admin

- `pnpm dev:all` seeds a local-only admin account for development.
- Default email: `admin@dev.local`
- Organization: `Dev-org`
- Password is controlled by `DEV_ADMIN_PASSWORD`; avoid reusing local seed credentials outside development.
- Browser auto-login is only enabled on localhost when `DEV_AUTH_BYPASS=true`.
- The canonical local app URL is `http://127.0.0.1:43103`.

## Key surfaces

- `/chat` for the primary chat workspace
- `/knowledge` for source management and sync workflows
- `/settings/organization/members` and `/settings/organization/billing` for organization membership and billing
- `/admin` for operational controls, policy, stats, configuration, and Stripe diagnostics
