# Admin Mode

Admin routes are protected by the app auth layer plus the `ADMIN_USER_IDS` override.

## Policy model

- Browser sessions still come from the app auth flow only.
- Admin pages require a signed-in admin and an active organization.
- Admin APIs return structured `401` or `403` errors when policy checks fail.

## Org scoping

Kestrel One keeps global admin access, but knowledge, stats, sandbox, snapshot, and API-key data are scoped to the active organization.

Switch organizations from the shared sidebar to inspect another workspace.
