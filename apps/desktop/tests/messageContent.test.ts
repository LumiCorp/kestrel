import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageContent } from "../renderer/src/MessageContent.js";

test("assistant messages render Markdown through Streamdown", () => {
  const html = renderToStaticMarkup(React.createElement(MessageContent, {
    messageRole: "assistant",
    text: "**Important**\n\n- first\n- second\n\n`inline code`",
  }));

  assert.match(html, /message-body-markdown/u);
  assert.match(html, /data-streamdown="strong"/u);
  assert.match(html, /data-streamdown="unordered-list"/u);
  assert.match(html, /data-streamdown="inline-code"/u);
});

test("user messages remain literal text", () => {
  const html = renderToStaticMarkup(React.createElement(MessageContent, {
    messageRole: "user",
    text: "**literal user text**",
  }));

  assert.match(html, /message-body-plain/u);
  assert.match(html, /\*\*literal user text\*\*/u);
  assert.doesNotMatch(html, /data-streamdown/u);
});
