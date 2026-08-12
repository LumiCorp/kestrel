CREATE TABLE IF NOT EXISTS "signup_access_codes" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" text NOT NULL,
  "code_hint" text NOT NULL,
  "label" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "max_redemptions" integer NOT NULL,
  "expires_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "signup_access_codes_max_redemptions_check" CHECK ("max_redemptions" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "signup_access_codes_hash_idx"
  ON "signup_access_codes" ("code_hash");
CREATE INDEX IF NOT EXISTS "signup_access_codes_enabled_idx"
  ON "signup_access_codes" ("enabled", "expires_at");

CREATE TABLE IF NOT EXISTS "signup_access_code_redemptions" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "access_code_id" text NOT NULL REFERENCES "signup_access_codes"("id") ON DELETE restrict,
  "normalized_email" text NOT NULL,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "reservation_expires_at" timestamp with time zone NOT NULL,
  "redeemed_at" timestamp with time zone,
  "onboarding_completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "signup_access_code_redemptions_email_idx"
  ON "signup_access_code_redemptions" ("normalized_email");
CREATE UNIQUE INDEX IF NOT EXISTS "signup_access_code_redemptions_user_idx"
  ON "signup_access_code_redemptions" ("user_id") WHERE "user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "signup_access_code_redemptions_code_idx"
  ON "signup_access_code_redemptions" ("access_code_id", "redeemed_at", "reservation_expires_at");

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "signup_access_code_redemption_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "user_signup_access_code_redemption_idx"
  ON "user" ("signup_access_code_redemption_id")
  WHERE "signup_access_code_redemption_id" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_signup_access_code_redemption_fk'
      AND conrelid = '"user"'::regclass
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT "user_signup_access_code_redemption_fk"
      FOREIGN KEY ("signup_access_code_redemption_id")
      REFERENCES "signup_access_code_redemptions"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION bind_signup_access_code_redemption_on_user_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_redemption_id text;
BEGIN
  IF NEW."signup_access_code_redemption_id" IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE "signup_access_code_redemptions"
  SET
    "user_id" = NEW."id",
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."signup_access_code_redemption_id"
    AND "normalized_email" = lower(btrim(NEW."email"))
    AND "user_id" IS NULL
    AND "redeemed_at" IS NULL
    AND "reservation_expires_at" > CURRENT_TIMESTAMP
  RETURNING "id" INTO bound_redemption_id;

  IF bound_redemption_id IS NULL THEN
    RAISE EXCEPTION 'signup access code reservation cannot be bound'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'user_signup_access_code_reservation_binding_check';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bind_signup_access_code_redemption_after_user_insert
  ON "user";
CREATE TRIGGER bind_signup_access_code_redemption_after_user_insert
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION bind_signup_access_code_redemption_on_user_insert();

CREATE OR REPLACE FUNCTION redeem_signup_access_code_on_email_verification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_redemption "signup_access_code_redemptions"%ROWTYPE;
BEGIN
  IF OLD."emailVerified" IS FALSE
    AND NEW."emailVerified" IS TRUE
    AND NEW."signup_access_code_redemption_id" IS NOT NULL THEN
    SELECT *
    INTO linked_redemption
    FROM "signup_access_code_redemptions"
    WHERE "id" = NEW."signup_access_code_redemption_id"
      AND "user_id" = NEW."id"
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE LOG 'Kestrel signup verification redemption ownership check failed for user %', NEW."id";
      RAISE EXCEPTION 'signup access code ownership is inconsistent'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'user_signup_access_code_redemption_ownership_check';
    END IF;

    IF linked_redemption."redeemed_at" IS NULL THEN
      IF linked_redemption."normalized_email" <> lower(btrim(NEW."email")) THEN
        RAISE EXCEPTION 'signup access code verification email is inconsistent'
          USING
            ERRCODE = '23514',
            CONSTRAINT = 'user_signup_access_code_verification_email_check';
      END IF;

      IF linked_redemption."reservation_expires_at" > CURRENT_TIMESTAMP THEN
        UPDATE "signup_access_code_redemptions"
        SET
          "redeemed_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = linked_redemption."id";
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS redeem_signup_access_code_after_email_verification
  ON "user";
CREATE TRIGGER redeem_signup_access_code_after_email_verification
AFTER UPDATE OF "emailVerified" ON "user"
FOR EACH ROW
EXECUTE FUNCTION redeem_signup_access_code_on_email_verification();
