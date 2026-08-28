-- Rows written before identity validation became an authority boundary must
-- remain inspectable but cannot remain enabled provider authority.
UPDATE "platform_oauth_registrations"
SET
  "enabled" = false,
  "revision" = "revision" + 1,
  "updated_at" = now()
WHERE
  "client_id" IS NULL
  OR "client_id" = ''
  OR "client_id" ~ '[[:space:]]'
  OR (
    "provider" = 'google_workspace'
    AND "tenant_or_issuer" IS NOT NULL
  )
  OR (
    "provider" = 'microsoft_365'
    AND "tenant_or_issuer" IS NOT NULL
    AND (
      "tenant_or_issuer" = ''
      OR "tenant_or_issuer" ~ '[[:space:]]'
      OR (
        lower("tenant_or_issuer") <> 'organizations'
        AND "tenant_or_issuer" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
  );
