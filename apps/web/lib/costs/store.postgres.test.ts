import assert from "node:assert/strict";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

contractTest(
  "web.postgres",
  "cost pricing preserves precedence, effective dates, revisions, and retry idempotency",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");
    const [{ resetDbRuntimeForTests }, costs, dashboard] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("./dashboard"),
    ]);
    const sql = postgres(databaseUrl, { max: 1 });
    const suffix = crypto.randomUUID();
    const userId = `cost-user-${suffix}`;
    const organizationId = `cost-org-${suffix}`;
    const platformRateId = `cost-platform-rate-${suffix}`;
    const occurredAt = new Date("2026-07-22T12:00:00Z");

    context.after(async () => {
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await sql`DELETE FROM "cost_rate_cards" WHERE "id" = ${platformRateId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Cost User', ${`${userId}@example.test`}, true, now(), now()
      )
    `;
    await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Cost Org', ${`cost-org-${suffix}`}, now())
    `;
    await sql`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES (${`member-${suffix}`}, ${organizationId}, ${userId}, 'member', now())
    `;
    assert.deepEqual(await costs.getOrganizationDashboardSettings(organizationId), {
      costVisibility: "all_members",
    });
    await sql`
      INSERT INTO "cost_rate_cards" (
        "id", "organization_id", "category", "provider", "service", "meter",
        "unit", "rate_kind", "unit_price_usd", "provenance", "effective_from"
      ) VALUES (
        ${platformRateId}, NULL, 'services', 'test-provider', 'search', 'request',
        'invocation', 'unit', 2, 'published', '2026-01-01T00:00:00Z'
      )
    `;
    const override = await costs.createOrganizationRateCard({
      organizationId,
      actorUserId: userId,
      rate: {
        category: "services",
        provider: "test-provider",
        service: "search",
        meter: "request",
        unit: "invocation",
        rateKind: "unit",
        unitPriceUsd: 1,
        provenance: "contract",
        effectiveFrom: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const first = await costs.recordUsageEvent({
      organizationId,
      actorUserId: userId,
      category: "services",
      provider: "test-provider",
      service: "search",
      meter: "request",
      quantity: 3,
      unit: "invocation",
      sourceKind: "test",
      sourceId: "same-retry",
      occurredAt,
    });
    await costs.recordUsageEvent({
      organizationId,
      actorUserId: userId,
      category: "services",
      provider: "test-provider",
      service: "search",
      meter: "request",
      quantity: 3,
      unit: "invocation",
      sourceKind: "test",
      sourceId: "same-retry",
      occurredAt,
    });
    await costs.priceUsageEvent(first.id);
    const [priced] = await sql`
      SELECT "amount_usd", "rate_card_id", "revision"
      FROM "organization_cost_entries"
      WHERE "usage_event_id" = ${first.id} AND "is_current" = true
    `;
    assert.equal(Number(priced?.amount_usd), 3);
    assert.equal(priced?.rate_card_id, override.id);
    assert.equal(priced?.revision, 1);
    const [eventCount] = await sql`
      SELECT count(*)::int AS count FROM "organization_usage_events"
      WHERE "organization_id" = ${organizationId} AND "source_id" = 'same-retry'
    `;
    assert.equal(eventCount?.count, 1);

    const concurrent = await costs.recordUsageEvent({
      organizationId,
      actorUserId: userId,
      category: "services",
      provider: "test-provider",
      service: "search",
      meter: "request",
      quantity: 2,
      unit: "invocation",
      sourceKind: "test",
      sourceId: "concurrent-pricing",
      occurredAt,
    });
    await Promise.all([
      costs.priceUsageEvent(concurrent.id),
      costs.priceUsageEvent(concurrent.id),
    ]);
    const [concurrentCosts] = await sql`
      SELECT count(*)::int AS revisions,
             count(*) FILTER (WHERE "is_current" = true)::int AS current
      FROM "organization_cost_entries"
      WHERE "usage_event_id" = ${concurrent.id}
    `;
    assert.equal(concurrentCosts?.revisions, 1);
    assert.equal(concurrentCosts?.current, 1);

    const reported = await costs.recordUsageEvent({
      organizationId,
      category: "managed_compute",
      provider: "runpod",
      service: "endpoint",
      meter: "billing_bucket",
      quantity: 1000,
      unit: "millisecond",
      reportedAmountUsd: 4.25,
      sourceKind: "test",
      sourceId: "reported",
      occurredAt,
    });
    await costs.priceUsageEvent(reported.id);
    const [reportedCost] = await sql`
      SELECT "amount_usd", "pricing_basis" FROM "organization_cost_entries"
      WHERE "usage_event_id" = ${reported.id} AND "is_current" = true
    `;
    assert.equal(Number(reportedCost?.amount_usd), 4.25);
    assert.equal(reportedCost?.pricing_basis, "provider_reported");

    await costs.saveOrganizationDashboardSettings({
      organizationId,
      actorUserId: userId,
      costVisibility: "admins_only",
    });
    const memberSnapshot = await dashboard.getOrganizationDashboardSnapshot({
      organization: { id: organizationId, name: "Cost Org" },
      userId,
      isOrganizationAdmin: false,
      range: "90d",
      now: new Date("2026-07-23T00:00:00Z"),
    });
    assert.equal(memberSnapshot.costsVisible, false);
    assert.equal(memberSnapshot.totals.amountUsd, null);
    assert.equal(memberSnapshot.totals.deltaPercent, null);
    assert.deepEqual(memberSnapshot.basisBreakdown, []);
    assert.ok(memberSnapshot.categories.every((category) => category.amountUsd === null));
    assert.ok(memberSnapshot.daily.every((day) => day.services === null));
    assert.deepEqual(memberSnapshot.people, []);
    assert.deepEqual(memberSnapshot.projects, []);
    assert.equal(memberSnapshot.totals.serviceInvocations, 5);
    assert.equal(
      memberSnapshot.sourceFreshness.find(
        (source) => source.source === "test-provider · test"
      )?.lastUpdatedAt,
      occurredAt.toISOString()
    );
  }
);
