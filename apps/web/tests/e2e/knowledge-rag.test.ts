import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type FixtureManifest = {
  corpusVersion: number;
  fixtures: Array<{
    filename: string;
    mediaType: string;
    query: string;
    anchor: string;
    notes: string;
  }>;
};

const fixtureRoot = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "knowledge-rag"
);
const fixtureManifest = JSON.parse(
  readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8")
) as FixtureManifest;

async function fetchDocuments(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/knowledge/documents", {
      cache: "no-store",
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  });
}

async function waitForFixtureDocuments(page: import("@playwright/test").Page) {
  await expect
    .poll(
      async () => {
        const result = await fetchDocuments(page);
        if (result.status !== 200) {
          return `status:${result.status}`;
        }

        const documents = result.body.documents as Array<{
          filename: string;
          status: string;
          latestRun?: { status?: string | null };
        }>;

        const fixtureStates = fixtureManifest.fixtures.map((fixture) => {
          const document = documents.find(
            (entry) => entry.filename === fixture.filename
          );
          if (!document) {
            return `${fixture.filename}:missing`;
          }

          if (!["ready", "partial"].includes(document.status)) {
            return `${fixture.filename}:${document.status}`;
          }

          if (
            document.latestRun?.status &&
            !["completed", "queued", "running"].includes(
              document.latestRun.status
            )
          ) {
            return `${fixture.filename}:run-${document.latestRun.status}`;
          }

          return `${fixture.filename}:ok`;
        });

        return fixtureStates.every((state) => state.endsWith(":ok"))
          ? "ready"
          : fixtureStates.join("|");
      },
      {
        timeout: 120_000,
        intervals: [1000, 2000, 3000],
      }
    )
    .toBe("ready");

  return fetchDocuments(page);
}

async function searchDocuments(
  page: import("@playwright/test").Page,
  query: string
) {
  return page.evaluate(async (value) => {
    const response = await fetch(
      `/api/knowledge/documents/search?q=${encodeURIComponent(value)}`,
      {
        cache: "no-store",
      }
    );

    return {
      status: response.status,
      body: await response.json(),
    };
  }, query);
}

async function uploadFixtureCorpus(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Upload" }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(
      fixtureManifest.fixtures.map((fixture) =>
        path.join(fixtureRoot, fixture.filename)
      )
    );
  await page.getByRole("button", { name: "Upload To Knowledge" }).click();
}

async function streamChatResponse(
  page: import("@playwright/test").Page,
  input: {
    chatId: string;
    messageId: string;
    prompt: string;
  }
) {
  return page.evaluate(async ({ chatId, messageId, prompt }) => {
    const response = await fetch(`/api/chats/${chatId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            id: messageId,
            role: "user",
            parts: [
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let body = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        body += decoder.decode(value, { stream: true });
      }

      body += decoder.decode();
    }

    return {
      status: response.status,
      body,
    };
  }, input);
}

test.describe("Knowledge RAG fixture corpus", () => {
  test("fixture corpus uploads, indexes, and is searchable through document retrieval", async ({
    page,
  }) => {
    await page.goto("/knowledge");
    await uploadFixtureCorpus(page);

    const documentsResult = await waitForFixtureDocuments(page);
    expect(documentsResult.status).toBe(200);

    const indexedDocuments = documentsResult.body.documents as Array<{
      id: string;
      filename: string;
      mediaType: string;
    }>;

    for (const fixture of fixtureManifest.fixtures) {
      const indexed = indexedDocuments.find(
        (document) => document.filename === fixture.filename
      );

      expect(indexed, `${fixture.filename} should be indexed`).toBeDefined();
      expect(indexed?.mediaType).toBe(fixture.mediaType);

      const searchResult = await searchDocuments(page, fixture.query);
      expect(searchResult.status).toBe(200);
      expect(searchResult.body.count).toBeGreaterThan(0);
      expect(searchResult.body.results[0]?.filename).toBe(fixture.filename);
      expect(JSON.stringify(searchResult.body.results[0] ?? {})).toContain(
        fixture.anchor
      );
    }
  });

  test("re-uploading the same fixture does not create duplicate knowledge documents", async ({
    page,
  }) => {
    const fixture = fixtureManifest.fixtures[0];
    if (!fixture) {
      throw new Error("Fixture manifest is empty");
    }

    await page.goto("/knowledge");

    const countDocumentsByFilename = async () => {
      const result = await fetchDocuments(page);
      const documents = result.body.documents as Array<{ filename: string }>;
      return documents.filter(
        (document) => document.filename === fixture.filename
      ).length;
    };

    await page.getByRole("button", { name: "Upload" }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(fixtureRoot, fixture.filename));
    await page.getByRole("button", { name: "Upload To Knowledge" }).click();
    await waitForFixtureDocuments(page);
    const firstCount = await countDocumentsByFilename();

    await page.getByRole("button", { name: "Upload" }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(fixtureRoot, fixture.filename));
    await page.getByRole("button", { name: "Upload To Knowledge" }).click();

    await expect
      .poll(async () => countDocumentsByFilename(), {
        timeout: 30_000,
        intervals: [1000, 2000],
      })
      .toBe(firstCount);
  });

  test("tool-using chat completes after document search without Responses API errors", async ({
    page,
  }) => {
    await page.goto("/knowledge");
    await uploadFixtureCorpus(page);
    await waitForFixtureDocuments(page);

    const result = await streamChatResponse(page, {
      chatId: `chat-rag-${Date.now()}`,
      messageId: `msg-rag-${Date.now()}`,
      prompt: "What is the markdown anchor for the knowledge runbook?",
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain('"tool-output-available"');
    expect(result.body).toContain('"finishReason":"stop"');
    expect(result.body).not.toContain("Invalid Responses API request");
  });
});
