-- Legacy rows could have been stored before provider-specific tenant and issuer
-- validation became an authority boundary. Keep the submitted value for an
-- administrator to correct, but disable it and advance its revision so it
-- cannot remain an authorization source.
UPDATE "platform_oauth_registrations"
SET
  "enabled" = false,
  "revision" = "revision" + 1,
  "updated_at" = now()
WHERE (
  "provider" = 'google_workspace'
  AND (
    "client_id" IS NULL
    OR "client_id" ~ '[[:space:]]'
    OR "tenant_or_issuer" IS NOT NULL
  )
)
OR (
  "provider" = 'microsoft_365'
  AND (
    "client_id" IS NULL
    OR "client_id" ~ '[[:space:]]'
    OR (
      "tenant_or_issuer" IS NOT NULL
      AND (
        lower("tenant_or_issuer") <> 'organizations'
        AND "tenant_or_issuer" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
  )
);
