import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { contractTest } from "../contract-test.js";

const databaseUrl = process.env.KESTREL_PRODUCT_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "KESTREL_PRODUCT_DATABASE_URL is required for product tests.",
  );
}

const sql = postgres(databaseUrl, { max: 1 });
const password = "invitation-test-password";

type InvitationFixture = {
  id: string;
  organizationId: string;
  organizationName: string;
};

test.afterAll(async () => {
  await sql.end({ timeout: 0 });
});

contractTest(
  "web.organization-invitations",
  "new recipients create an invited account, explicitly join, and land in the organization",
  async ({ page }) => {
    const email = uniqueEmail("new-recipient");
    const invitation = await seedInvitation({ email, role: "member" });

    await createAccountFromInvitation(page, invitation.id, email);
    await expect(
      page.getByText(`Welcome to ${invitation.organizationName}`),
    ).toBeVisible();
    await expect(page.getByText("You joined as member.")).toBeVisible();

    await expectMembership({
      email,
      organizationId: invitation.organizationId,
      role: "member",
    });
    await expectNoProjectMembership(email);
  },
);

contractTest(
  "web.organization-invitations",
  "existing invited users sign in through the invitation link before joining",
  async ({ page }) => {
    const email = uniqueEmail("existing-recipient");
    const registration = await seedInvitation({ email, role: "member" });
    await createAccountFromInvitation(page, registration.id, email, {
      join: false,
    });
    await signOut(page);

    const invitation = await seedInvitation({ email, role: "admin" });
    await page.goto(invitationPath(invitation.id));
    await page.getByRole("link", { name: "Sign in" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await expect(
      page.getByRole("button", { name: "Join organization" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Join organization" }).click();

    await expect(page).toHaveURL(/\/welcome$/u);
    await expectMembership({
      email,
      organizationId: invitation.organizationId,
      role: "admin",
    });
    await expectNoProjectMembership(email);
  },
);

contractTest(
  "web.organization-invitations",
  "wrong accounts, declines, expired invitations, and revoked invitations do not create membership",
  async ({ page }) => {
    const email = uniqueEmail("recipient");
    const registration = await seedInvitation({ email, role: "member" });
    await createAccountFromInvitation(page, registration.id, email, {
      join: false,
    });

    const wrongAccount = uniqueEmail("wrong-account");
    const wrongRegistration = await seedInvitation({
      email: wrongAccount,
      role: "member",
    });
    await signOut(page);
    await createAccountFromInvitation(
      page,
      wrongRegistration.id,
      wrongAccount,
      {
        join: false,
      },
    );

    const wrongAccountInvitation = await seedInvitation({
      email,
      role: "member",
    });
    await page.goto(invitationPath(wrongAccountInvitation.id));
    await expect(page.getByText("Invitation Error")).toBeVisible();
    await expect(
      page.getByText(wrongAccountInvitation.organizationName),
    ).toHaveCount(0);
    await expectMembershipCount({
      email,
      organizationId: wrongAccountInvitation.organizationId,
      count: 0,
    });

    await page.getByRole("link", { name: "Switch account" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await expect(
      page.getByRole("button", { name: "Join organization" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByText("Invitation Declined")).toBeVisible();
    await expectInvitationStatus(wrongAccountInvitation.id, "rejected");
    await expectMembershipCount({
      email,
      organizationId: wrongAccountInvitation.organizationId,
      count: 0,
    });

    const expired = await seedInvitation({
      email,
      expiresAt: new Date(Date.now() - 60_000),
      role: "member",
    });
    await page.goto(invitationPath(expired.id));
    await expect(page.getByText("Invitation Error")).toBeVisible();
    await expectMembershipCount({
      email,
      organizationId: expired.organizationId,
      count: 0,
    });

    const revoked = await seedInvitation({
      email,
      role: "member",
      status: "canceled",
    });
    await page.goto(invitationPath(revoked.id));
    await expect(page.getByText("Invitation Error")).toBeVisible();
    await expectMembershipCount({
      email,
      organizationId: revoked.organizationId,
      count: 0,
    });
  },
);

async function createAccountFromInvitation(
  page: Page,
  invitationId: string,
  email: string,
  options: { join?: boolean } = {},
) {
  await page.goto(invitationPath(invitationId));
  await expect(
    page.getByText("Sign in or create an account to review this invitation."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Create account" }).click();
  await page.getByLabel("First name").fill("Invited");
  await page.getByLabel("Last name").fill("Member");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(
    page.getByRole("button", { name: "Join organization" }),
  ).toBeVisible();

  if (options.join !== false) {
    await page.getByRole("button", { name: "Join organization" }).click();
    await expect(page).toHaveURL(/\/welcome$/u);
  }
}

async function signOut(page: Page) {
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/auth/sign-out", { method: "POST" });
    return { ok: result.ok, status: result.status };
  });
  expect(response).toMatchObject({ ok: true });
}

async function seedInvitation(input: {
  email: string;
  role: "admin" | "member";
  status?: "canceled" | "pending";
  expiresAt?: Date;
}): Promise<InvitationFixture> {
  const [inviter] = await sql<
    Array<{ organizationId: string; organizationName: string; userId: string }>
  >`
    SELECT
      member."organizationId" AS "organizationId",
      organization.name AS "organizationName",
      "user".id AS "userId"
    FROM "member"
    INNER JOIN "organization" ON "organization".id = member."organizationId"
    INNER JOIN "user" ON "user".id = member."userId"
    WHERE "user".email = 'admin@dev.local'
      AND member.role = 'admin'
    LIMIT 1
  `;
  if (!inviter) {
    throw new Error("The product fixture admin organization is unavailable.");
  }

  const id = randomUUID();
  const now = new Date();
  await sql`
    INSERT INTO "invitation" (
      "id", "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId"
    ) VALUES (
      ${id}, ${inviter.organizationId}, ${input.email}, ${input.role}, ${input.status ?? "pending"},
      ${input.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)}, ${now}, ${inviter.userId}
    )
  `;
  return {
    id,
    organizationId: inviter.organizationId,
    organizationName: inviter.organizationName,
  };
}

async function expectMembership(input: {
  email: string;
  organizationId: string;
  role: string;
}) {
  const rows = await sql<Array<{ role: string }>>`
    SELECT member.role
    FROM "member"
    INNER JOIN "user" ON "user".id = member."userId"
    WHERE "user".email = ${input.email}
      AND member."organizationId" = ${input.organizationId}
  `;
  expect(rows).toEqual([{ role: input.role }]);
}

async function expectMembershipCount(input: {
  email: string;
  organizationId: string;
  count: number;
}) {
  const [row] = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS count
    FROM "member"
    INNER JOIN "user" ON "user".id = member."userId"
    WHERE "user".email = ${input.email}
      AND member."organizationId" = ${input.organizationId}
  `;
  expect(Number(row?.count ?? "0")).toBe(input.count);
}

async function expectNoProjectMembership(email: string) {
  const [row] = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS count
    FROM "project_members"
    INNER JOIN "member" ON "member".id = "project_members"."organization_member_id"
    INNER JOIN "user" ON "user".id = "member"."userId"
    WHERE "user".email = ${email}
  `;
  expect(Number(row?.count ?? "0")).toBe(0);
}

async function expectInvitationStatus(id: string, status: string) {
  const [row] = await sql<Array<{ status: string }>>`
    SELECT status FROM "invitation" WHERE id = ${id}
  `;
  expect(row?.status).toBe(status);
}

function invitationPath(id: string) {
  return `/accept-invitation/${id}`;
}

function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID()}@example.test`;
}
