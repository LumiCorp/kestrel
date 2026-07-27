import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(root, "migrations/0054_desktop_environments.sql"),
  "utf8",
);
const journal = fs.readFileSync(
  path.join(root, "migrations/meta/_journal.json"),
  "utf8",
);

contractTest(
  "web.hermetic",
  "Desktop Environments extend the provider boundary without weakening Fly identity",
  () => {
    assert.match(
      migration,
      /ADD COLUMN "provider" text DEFAULT 'fly' NOT NULL/u,
    );
    assert.match(
      migration,
      /CHECK \("provider" IN \('fly', 'desktop'\)\)/u,
    );
    assert.match(migration, /CREATE TABLE "desktop_environment_connections"/u);
    assert.match(
      migration,
      /CREATE TABLE "desktop_environment_workspace_catalog"/u,
    );
    assert.match(migration, /CREATE TABLE "desktop_environment_commands"/u);
    assert.match(
      migration,
      /CREATE TABLE "desktop_user_authorization_codes"/u,
    );
    assert.match(migration, /CREATE TABLE "desktop_user_credentials"/u);
    assert.match(migration, /"advertised_models" jsonb/u);
    assert.match(
      migration,
      /CREATE TABLE "desktop_environment_command_events"/u,
    );
    assert.match(migration, /"encryption_public_key" text NOT NULL/u);
    assert.match(
      migration,
      /CREATE TABLE "workspace_preview_access_tokens"/u,
    );
    assert.match(
      migration,
      /ADD COLUMN "target_provider" text DEFAULT 'fly' NOT NULL/u,
    );
    assert.match(migration, /"source_type" IN \('blank', 'github', 'desktop'\)/u);
    assert.match(journal, /0054_desktop_environments/u);
  },
);
