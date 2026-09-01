# Allow and remember personal browser domains

## Useful outcome

A person can call `browser.request_grant` for an active Browser Session and approve one canonical public domain once. Kestrel applies it before the tool returns and remembers it for future eligible Projects in the same Environment. A destination already authorized by Environment policy or a personal grant returns `already_allowed` without an approval.

The person can list and revoke personal domains. Environment policy is the ceiling. Project policy can narrow public access but cannot add authority. This slice delivers the remembered-domain scenario in the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Resolve QA and public authority separately. QA authority contains only the exact trusted target for the active QA session. Public authority contains Environment-configured entries and the person's active remembered domains after Environment and Project restrictions. The effective allowlist is the union. A personal grant can never create loopback or private-network authority.
- Store validated Environment Browser settings in `environment_app_capability_grants.settings`: enabled modes, whether personal grants may be created, canonical preconfigured public domains, and public-domain restrictions. Store Project narrowing in `project_app_capability_policies.settings`: a subset of enabled modes, an optional personal-grants disable, and additional domain restrictions. Resolve those restrictions against each person's grants without exposing the personal list to administrators. A Project setting can remove but never create effective authority.
- Represent a public grant as one normalized HTTPS apex with `includeSubdomains: true` and port 443. The apex is the registrable tenant boundary computed with the Public Suffix List, including private suffixes. The approval UI must say “apex and subdomains”; a display string such as `*.example.com` must not imply that the apex is excluded.
- Normalize Internationalized Domain Names, trailing dots, schemes, default ports, and redirects before comparison. Reject non-HTTPS public destinations, non-443 public ports, public suffixes, IP-literal wildcards, private/LAN/link-local/metadata/reserved addresses, credentials in URLs, and policy-forbidden destinations.
- Require `sessionId` and `destination` for `browser.request_grant`. Canonicalization must discard path, query, fragment, username, and password before durable approval or audit data is built.
- Prepare grant authority before the engine commits an approval wait. If the canonical domain is effective, return `{status: "already_allowed", canonicalDomain, allowlistRevision}`. If policy forbids it, return the stable blocked failure without an interaction. Otherwise create one allow-and-remember approval showing the canonical domain, person, Environment, immediate session effect, and future-session effect.
- Add a hosted personal-domain record uniquely keyed by authenticated user, Environment, and canonical domain. Persist approval identity, provenance, timestamps, current personal revision, and revocation state. Do not use `remembered_tool_approvals` as storage.
- Key the Desktop equivalent by the signed-in Kestrel account, Environment, and canonical domain. Partition the versioned Desktop settings format by the identity owned by `src/localCore/kestrelOneAccount.ts`. Signing out or changing account/Environment must stop applying the previous partition.
- Do not include Project ID in remembered-grant identity. A Project only narrows whether an active personal domain is effective.
- Treat a Project as eligible for a remembered domain only when the Browser App and operator mode are enabled, Environment policy permits that domain and personal grants, and Project policy does not remove the domain or disable personal grants. QA mode never makes a Project eligible for a personal grant.
- Lock and resolve the approval through the existing interaction-decision transaction. Approval and active remembered-record creation are one transaction and one exact effect. A retry returns the existing record. Denial creates no record and changes no revision.
- Maintain a personal-domain revision per user and Environment. Define the session's effective revision as a deterministic fingerprint of Environment policy, Project policy, trusted QA authority, and the personal revision. Any input change produces a new effective revision.
- Call the session policy-adoption method on `BrowserServicePort` before grant or revocation reports success. Issue 02 proves this with the fake revision subscriber. Issues 03 and 05 must prove their real proxies installed the revision.
- On revocation, every later browser-generated request must use the new revision, including requests initiated by an already loaded page. Close existing WebSocket, EventSource, worker, and other long-lived connections whose destination is no longer effective.
- Let the signed-in person list and revoke only their domains. Environment and Project administrators can edit policy but cannot list another person's grants, page data, screenshots, credentials, or takeover data.

## Requirements and delivery context

Issue 01 supplies `browser.request_grant`, `BrowserSessionV1`, and the fake host. Hosted settings and persistence are owned by `apps/web/drizzle/schema.ts`, `apps/web/lib/apps/contracts.ts`, `apps/web/lib/apps/service.ts`, `apps/web/lib/apps/project-service.ts`, their routes/components, and a registered migration under `apps/web/lib/db/migrations/`.

`agents/reference-react/src/steps/acter/policyGates.ts`, `src/engine/RuntimeIO.ts`, and `tools/runtime/UnifiedToolRegistry.ts` own preparation before an approval wait. `apps/web/lib/turns/store.ts` is the atomic interaction-decision owner and pattern. Reuse its lock and authority validation without reusing its Thread-lifetime approval table.

Desktop persistence is owned by `apps/desktop/src/settingsStore.ts`, its settings-version migration, `src/desktopShell/contracts.ts`, and the preload/settings UI projection. Do not place grants in Project files, an unpartitioned machine-global list, or a browser profile.

Add tests for the exact effective-authority formula, apex-plus-subdomains behavior, private suffix tenants, IDNs, HTTPS/443, redirects, idempotency, denial, atomicity, revocation, live-connection closure, cross-Project reuse, cross-user/Environment isolation, account switch, settings authorization, pre-wait bypass, revision adoption, and redaction. Run focused suites, `pnpm validate`, and `pnpm validate:postgres`.

## Done when

- A new eligible domain produces one approval with the canonical apex, subdomain effect, person, and Environment scope.
- Approval creates one personal record and returns only after the fake active session has installed the new effective revision.
- A retry, later Thread, or eligible Project uses the grant without another approval. A different user or Environment cannot use it.
- An Environment-configured or remembered domain returns `already_allowed` without an approval or duplicate record.
- Project settings can remove effective authority but cannot create it. QA authority does not create a personal grant.
- Denial changes nothing. Revocation blocks later requests and closes no-longer-authorized long-lived connections while preserving past results and artifacts.
- Public suffixes, cross-tenant private suffixes, non-HTTPS or non-443 public destinations, IP wildcards, and private or reserved targets cannot become grants.
- Settings preserve user privacy and the Environment-ceiling/Project-narrowing hierarchy.
- Focused coverage, `pnpm validate`, and `pnpm validate:postgres` pass.

## Depends on

- [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md)
