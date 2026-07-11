import test from "node:test";
import assert from "node:assert/strict";

import React from "react";

import { BubbleMessage } from "../../cli/ink/components/BubbleMessage.js";
import { theme } from "../../cli/ink/theme/tokens.js";

test("BubbleMessage renders user headers with neutral emphasis", () => {
  const user = BubbleMessage({
    role: "user",
    lines: ["hello"],
    reasoning: false,
    meta: "12:00",
    selected: false,
    highlightedRun: false,
    attention: false,
    width: 42,
  });

  const children = React.Children.toArray(user.props.children) as Array<React.ReactElement<{ color?: string }>>;
  assert.equal(children[0]?.props.color, theme.text);
});

test("BubbleMessage renders selected assistant headers with neutral emphasis", () => {
  const assistant = BubbleMessage({
    role: "assistant",
    lines: ["hi"],
    reasoning: false,
    meta: "12:01",
    selected: true,
    highlightedRun: true,
    attention: false,
    width: 42,
  });

  const children = React.Children.toArray(assistant.props.children) as Array<React.ReactElement<{ color?: string }>>;
  assert.equal(children[0]?.props.color, theme.text);
});

test("BubbleMessage keeps system cards muted", () => {
  const system = BubbleMessage({
    role: "system",
    lines: ["notice"],
    reasoning: false,
    meta: "12:02",
    selected: false,
    highlightedRun: false,
    attention: false,
    width: 42,
  });

  const children = React.Children.toArray(system.props.children) as Array<React.ReactElement<{ color?: string }>>;
  assert.equal(children[1]?.props.color, theme.muted);
});

test("BubbleMessage renders attention system rows with warning emphasis", () => {
  const system = BubbleMessage({
    role: "system",
    lines: ["Waiting for your reply.", "Which workspace should I inspect?"],
    reasoning: false,
    meta: "12:02",
    selected: false,
    highlightedRun: false,
    attention: true,
    width: 42,
  });

  const children = React.Children.toArray(system.props.children) as Array<React.ReactElement<{ color?: string }>>;
  assert.equal(children[1]?.props.color, theme.warn);
  assert.equal(children[2]?.props.color, theme.warn);
});

test("BubbleMessage renders assistant reasoning rows as muted entries", () => {
  const reasoning = BubbleMessage({
    role: "assistant",
    lines: ["Evaluating next best tool."],
    reasoning: true,
    meta: "12:03",
    selected: false,
    highlightedRun: false,
    attention: false,
    width: 42,
  });

  const children = React.Children.toArray(reasoning.props.children) as Array<
    React.ReactElement<{ color?: string; children?: React.ReactNode }>
  >;
  assert.equal(children[0]?.props.color, theme.muted);
  assert.equal(String(children[0]?.props.children).includes("AGENT (REASONING)"), true);
});
