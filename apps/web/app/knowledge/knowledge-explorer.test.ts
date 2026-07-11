import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKnowledgeExplorerItems,
  type DocumentRecord,
  emptySourceForm,
  filterKnowledgeExplorerItems,
  getKnowledgeExplorerItemDetails,
  getKnowledgeExplorerItemName,
  getKnowledgeExplorerItemTypeValue,
  getSourceForm,
  type SourceRecord,
} from "./knowledge-explorer";

function createSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "source-1",
    type: "github",
    label: "source-one",
    repo: "owner/source-one",
    branch: "main",
    updatedAt: "2026-03-19T10:00:00.000Z",
    ...overrides,
  };
}

function createDocument(
  overrides: Partial<DocumentRecord> = {}
): DocumentRecord {
  return {
    id: "document-1",
    uploaderUserId: "user-1",
    filename: "document-one.pdf",
    originalFilename: "document-one.pdf",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    status: "ready",
    chunkCount: 12,
    createdAt: "2026-03-19T09:00:00.000Z",
    updatedAt: "2026-03-19T09:30:00.000Z",
    ...overrides,
  };
}

test("buildKnowledgeExplorerItems mixes sources and documents in descending activity order", () => {
  const source = createSource({
    id: "source-recent",
    label: "source-recent",
    updatedAt: "2026-03-19T12:00:00.000Z",
  });
  const document = createDocument({
    id: "document-with-run",
    filename: "document-with-run.pdf",
    updatedAt: "2026-03-19T08:00:00.000Z",
    latestRun: {
      id: "run-1",
      stage: "embed",
      status: "completed",
      attemptCount: 1,
      updatedAt: "2026-03-19T13:00:00.000Z",
    },
  });
  const olderSource = createSource({
    id: "source-older",
    label: "source-older",
    updatedAt: "2026-03-19T07:00:00.000Z",
  });

  const items = buildKnowledgeExplorerItems({
    sources: [source, olderSource],
    documents: [document],
  });

  assert.deepEqual(
    items.map((item) => [item.kind, item.item.id]),
    [
      ["document", "document-with-run"],
      ["source", "source-recent"],
      ["source", "source-older"],
    ]
  );
});

test("buildKnowledgeExplorerItems falls back to document updatedAt when there is no latest run", () => {
  const items = buildKnowledgeExplorerItems({
    sources: [
      createSource({ id: "source-1", updatedAt: "2026-03-19T09:00:00.000Z" }),
    ],
    documents: [
      createDocument({
        id: "document-1",
        updatedAt: "2026-03-19T11:00:00.000Z",
        latestRun: null,
      }),
    ],
  });

  assert.equal(items[0]?.kind, "document");
  assert.equal(items[0]?.item.id, "document-1");
});

test("getSourceForm resets to the default create state and normalizes edit values", () => {
  assert.deepEqual(getSourceForm(), emptySourceForm);
  assert.deepEqual(
    getSourceForm(
      createSource({
        id: "youtube-source",
        type: "youtube",
        label: "channel-alpha",
        repo: null,
        branch: null,
        channelId: "UC1234567890123456789012",
        handle: "@alpha",
      })
    ),
    {
      id: "youtube-source",
      type: "youtube",
      label: "channel-alpha",
      repo: "",
      branch: "main",
      channelId: "UC1234567890123456789012",
      handle: "@alpha",
    }
  );
});

test("knowledge explorer helpers normalize mixed source and document rows for the table", () => {
  const items = buildKnowledgeExplorerItems({
    sources: [
      createSource({
        id: "source-1",
        label: "repo-alpha",
        repo: "acme/repo-alpha",
        branch: "develop",
      }),
    ],
    documents: [
      createDocument({
        id: "document-1",
        title: "Quarterly Plan",
        originalFilename: "quarterly-plan.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ],
  });

  const document = items.find((item) => item.item.id === "document-1");
  const source = items.find((item) => item.item.id === "source-1");

  assert.ok(document);
  assert.ok(source);

  assert.equal(getKnowledgeExplorerItemTypeValue(document), "document");
  assert.equal(getKnowledgeExplorerItemName(document), "Quarterly Plan");
  assert.match(
    getKnowledgeExplorerItemDetails(document),
    /quarterly-plan\.xlsx/
  );

  assert.equal(getKnowledgeExplorerItemTypeValue(source), "github");
  assert.equal(getKnowledgeExplorerItemName(source), "repo-alpha");
  assert.equal(
    getKnowledgeExplorerItemDetails(source),
    "acme/repo-alpha @ develop"
  );
});

test("filterKnowledgeExplorerItems supports compact grid column filters", () => {
  const items = buildKnowledgeExplorerItems({
    sources: [
      createSource({
        id: "source-github",
        type: "github",
        label: "repo-alpha",
        repo: "acme/repo-alpha",
      }),
      createSource({
        id: "source-youtube",
        type: "youtube",
        label: "channel-beta",
        repo: null,
        branch: null,
        channelId: "UC1234567890123456789012",
      }),
    ],
    documents: [
      createDocument({
        id: "document-ready",
        title: "Ready Plan",
        status: "ready",
        originalFilename: "ready-plan.pdf",
      }),
      createDocument({
        id: "document-failed",
        title: "Failed Report",
        status: "failed",
        originalFilename: "failed-report.pdf",
      }),
    ],
  });

  assert.deepEqual(
    filterKnowledgeExplorerItems(items, {
      type: "github",
      name: "",
      details: "",
      status: "all",
    }).map((item) => item.item.id),
    ["source-github"]
  );

  assert.deepEqual(
    filterKnowledgeExplorerItems(items, {
      type: "all",
      name: "report",
      details: "",
      status: "failed",
    }).map((item) => item.item.id),
    ["document-failed"]
  );

  assert.deepEqual(
    filterKnowledgeExplorerItems(items, {
      type: "source",
      name: "",
      details: "uc1234567890123456789012",
      status: "all",
    }).map((item) => item.item.id),
    ["source-youtube"]
  );
});
