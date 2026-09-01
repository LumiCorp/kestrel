# Move Google Workspace connections and actions to the Kestrel One broker

## Useful outcome

Kestrel One users can connect Gmail, Google Calendar, or both through the Platform-owned Google registration and use the completed personal productivity behavior without a static Google provider environment configuration.

The slice preserves Gmail restricted-data controls, exact external-write approval, attachment handling, and Calendar paging while moving the connection and hosted token boundary to the new broker.

## What changes

Move the hosted Google connection flow, Gmail runtime actions, Google Calendar runtime actions, and Gmail approval preparation from Better Auth access-token reads to the hosted personal authorization broker.

The connection experience must allow Calendar-only, Gmail-only, or combined selection. It must request only selected-pack scopes, record actual grants, and preserve Calendar when a user declines or later loses Gmail consent. Gmail reads remain fail-closed on the selected restricted-data model route. Gmail attachment import and outgoing Thread-file handling retain their current file safety contract. Calendar collection actions retain authenticated continuation cursors. Gmail and Calendar writes continue to require the exact existing approval binding and must not retry an unknown provider outcome.

## Requirements and delivery context

- Build on the shared broker from issue 02; do not add Google-specific token storage or a parallel authorization path.
- Preserve the canonical operation descriptors, provider result shapes, opaque provider identities, safe audit identities, and existing Project attachment rules.
- Keep Gmail `gmail.readonly` and `gmail.send` narrow. Keep existing Calendar scopes. Do not add Drive or Gmail modify, compose, or full-mail scopes.
- Preserve approved Gmail disclosure, processor and retention requirements, restricted-data model admission, and independent fallback-route qualification.
- Preserve one-time, payload-bound approvals for Gmail send/reply and Calendar create/update/delete, including Thread-file re-resolution and hash checking.
- Outlook, Desktop, Drive, and Google Chat are out of scope.

## Done when

- A Kestrel One user can connect or reconnect Google through the broker, select Gmail and Calendar independently, and see actual grants and pack-specific health.
- Gmail search, message and thread reads, attachment import, approved send and reply, and Google Calendar reads and CRUD use broker-resolved hosted tokens.
- Gmail eligibility fails closed for an ineligible model route, while Calendar remains available when its own eligibility is satisfied.
- A Gmail or Calendar write cannot reach Google without its exact approval and reports created, partial, failed, or unknown outcome truthfully.
- Automated tests cover pack isolation, scope and model-admission gates, cursor binding, file binding, approval binding, token refresh, and normalized provider failures.
- No hosted Google connection or runtime action depends on the static Google provider environment configuration after this issue lands.

## Depends on

- [02 — Add Kestrel One hosted personal authorization broker](02-add-hosted-personal-authorization-broker.md)
