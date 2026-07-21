import assert from "node:assert/strict";

import React from "react";

import { BubbleMessage } from "../../cli/ink/components/BubbleMessage.js";
import { contractTest } from "../helpers/contract-test.js";


function childText(node: React.ReactNode): string {
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => childText(entry)).join("");
  }
  if (React.isValidElement(node)) {
    return childText(node.props.children);
  }
  return "";
}

contractTest("runtime.hermetic", "BubbleMessage renders flat transcript rows with full-width header and body lines", () => {
  const bubble = BubbleMessage({
    role: "assistant",
    lines: ["hello", "world"],
    reasoning: false,
    meta: "13:10:34",
    selected: false,
    highlightedRun: false,
    width: 40,
  });

  const children = React.Children.toArray(bubble.props.children) as Array<React.ReactElement>;
  const header = childText(children[0]?.props.children);
  const firstLine = childText(children[1]?.props.children);
  const secondLine = childText(children[2]?.props.children);
  assert.match(header, /^ {2}<< AGENT · 13:10:34$/);
  assert.equal(firstLine, "<< hello");
  assert.equal(secondLine, "   world");
});
