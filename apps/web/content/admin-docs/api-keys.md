# API Keys

The admin API-key feature stores app-owned keys for service or integration workflows.

## Behavior

- Keys are created inside the active organization.
- Secrets are hashed at rest.
- The plaintext token is only returned once at creation time.
- Revoking a key deletes it from the admin key store.

## Recommended practice

- Use descriptive names tied to the integration or environment.
- Prefer short expiration windows for temporary workflows.
- Rotate keys after any suspected exposure.
