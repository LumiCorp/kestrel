import test from "node:test";
import assert from "node:assert/strict";

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

test("standalone URL paragraphs render compact preview cards", () => {
  const html = renderToStaticMarkup(React.createElement(MessageContent, {
    messageRole: "assistant",
    text: "https://example.com/story",
  }));

  assert.match(html, /link-preview-card/u);
  assert.match(html, /data-link-preview-status="loading"/u);
});

test("named and prose-embedded links remain inline", () => {
  const html = renderToStaticMarkup(React.createElement(MessageContent, {
    messageRole: "assistant",
    text: "Read [the report](https://example.com/report) and https://example.com/context here.",
  }));

  assert.doesNotMatch(html, /link-preview-card/u);
  assert.match(html, /data-streamdown="link"/u);
  assert.doesNotMatch(html, /target="_blank"/u);
});

test("only the first four unique standalone URLs become cards", () => {
  const html = renderToStaticMarkup(React.createElement(MessageContent, {
    messageRole: "assistant",
    text: [1, 2, 3, 4, 5].map((index) => `https://example.com/${index}`).join("\n\n"),
  }));

  assert.equal((html.match(/link-preview-card/g) ?? []).length, 4);
  assert.match(html, />https:\/\/example\.com\/5</u);
});

test("streaming assistant output does not mount preview cards", () => {
  const html = renderToStaticMarkup(React.createElement(MessageContent, {
    messageRole: "assistant",
    text: "https://example.com/story",
    streaming: true,
  }));

  assert.doesNotMatch(html, /link-preview-card/u);
  assert.match(html, /data-streamdown="link"/u);
});
