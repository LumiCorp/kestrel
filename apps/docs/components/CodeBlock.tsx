"use client";

import { type ComponentPropsWithoutRef, useRef, useState } from "react";

type CodeBlockProps = ComponentPropsWithoutRef<"pre"> & {
  "data-language"?: string;
};

const languageNames: Record<string, string> = {
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  md: "Markdown",
  markdown: "Markdown",
  text: "Text",
  txt: "Text",
};

function copyWithSelectionFallback(text: string) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  return copied;
}

export function CodeBlock({ children, className, "data-language": language = "text", ...props }: CodeBlockProps) {
  const codeRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const languageLabel = languageNames[language.toLowerCase()] ?? language;

  async function copy() {
    const text = codeRef.current?.innerText ?? "";
    if (!text) return;

    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = copyWithSelectionFallback(text);
    }

    if (!copied) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span>{languageLabel}</span>
        <button type="button" onClick={() => void copy()} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        {...props}
        ref={codeRef}
        data-language={language}
        className={`doc-pre ${className ?? ""}`.trim()}
      >
        {children}
      </pre>
    </div>
  );
}
