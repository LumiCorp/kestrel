"use client";

import { type ReactNode, useRef, useState } from "react";

export function CodeBlock({ children }: { children: ReactNode }) {
  const codeRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = codeRef.current?.innerText ?? "";
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span>Code</span>
        <button type="button" onClick={() => void copy()} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={codeRef} className="doc-pre">{children}</pre>
    </div>
  );
}
