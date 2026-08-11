import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEditedMessageParts,
  hasEditedMessageContent,
} from "./message-editor-model";

test("editing replaces text once while preserving non-text parts in order", () => {
  const parts = buildEditedMessageParts(
    [
      {
        type: "file",
        filename: "notes.txt",
        mediaType: "text/plain",
        url: "https://example.test/notes.txt",
      },
      { type: "text", text: "Old" },
      { type: "text", text: " text" },
    ],
    "Updated text"
  );

  assert.deepEqual(parts, [
    {
      type: "file",
      filename: "notes.txt",
      mediaType: "text/plain",
      url: "https://example.test/notes.txt",
    },
    { type: "text", text: "Updated text" },
  ]);
});

test("empty edited text is valid only when non-text content remains", () => {
  assert.equal(hasEditedMessageContent([{ type: "text", text: "Old" }], " "), false);
  assert.equal(
    hasEditedMessageContent(
      [
        {
          type: "file",
          filename: "notes.txt",
          mediaType: "text/plain",
          url: "https://example.test/notes.txt",
        },
        { type: "text", text: "Old" },
      ],
      ""
    ),
    true
  );
});
