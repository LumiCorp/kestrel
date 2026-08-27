import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailTriggerInputSchema,
  emailTriggerRevisionInputSchema,
  updateEmailTriggerInputSchema,
} from "./contracts";

test("Email Trigger write contracts reject public mode and configurable owners", () => {
  const requiredCreate = {
    name: "Invoice intake",
    modelId: "openrouter/example",
  };
  assert.equal(
    createEmailTriggerInputSchema.safeParse({
      ...requiredCreate,
      accessMode: "public",
    }).success,
    false,
  );
  assert.equal(
    createEmailTriggerInputSchema.safeParse({
      ...requiredCreate,
      executionOwnerUserId: "another-user",
    }).success,
    false,
  );
  assert.equal(
    updateEmailTriggerInputSchema.safeParse({
      expectedRevision: 1,
      accessMode: "public",
    }).success,
    false,
  );
  assert.equal(
    updateEmailTriggerInputSchema.safeParse({
      expectedRevision: 1,
      executionOwnerUserId: "another-user",
    }).success,
    false,
  );
  assert.equal(
    emailTriggerRevisionInputSchema.safeParse({
      expectedRevision: 1,
      accessMode: "public",
    }).success,
    false,
  );
});

test("Email Trigger write contracts preserve exact claimed-From language and revisions", () => {
  const parsed = createEmailTriggerInputSchema.parse({
    name: " Support ",
    modelId: "openrouter/example",
    claimedFromFilter: " support@example.test ",
  });
  assert.equal(parsed.name, "Support");
  assert.equal(parsed.claimedFromFilter, "support@example.test");
  assert.equal(
    updateEmailTriggerInputSchema.safeParse({ expectedRevision: 0, enabled: false }).success,
    false,
  );
  assert.equal(
    updateEmailTriggerInputSchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );
});
