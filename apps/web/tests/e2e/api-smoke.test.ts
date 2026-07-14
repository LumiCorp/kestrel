import { expect, test } from "@playwright/test";

const baseUrl = process.env.UNIFIED_BASE_URL || "http://127.0.0.1:43103";

test.describe("API smoke checks", () => {
  test("health endpoint is reachable", async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/health`);
    await expect.soft(response).toBeOK();
    const payload = await response.json();
    expect(payload.status).toBeDefined();
    expect(payload.checks).toBeDefined();
  });

  test("sources endpoint requires auth", async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/sources`);
    expect(response.status()).toBe(401);
  });

  test("stats/me requires auth", async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/stats/me`);
    expect(response.status()).toBe(401);
  });

  test("Apps endpoint requires auth", async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/apps`);
    expect(response.status()).toBe(401);
  });

  test("legacy admin tools endpoint is removed", async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/admin/tools`);
    expect(response.status()).toBe(404);
  });

  test("webhook platform route rejects invalid platforms", async ({
    request,
  }) => {
    const response = await request.post(
      `${baseUrl}/api/webhooks/not-a-platform`,
      {
        data: {},
      }
    );
    expect(response.status()).toBe(400);
  });
});
