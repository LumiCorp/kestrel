import Link from "next/link";
import React from "react";
import type { ComponentPropsWithoutRef } from "react";

import { CodeBlock } from "@/components/CodeBlock";

function Paragraph(props: ComponentPropsWithoutRef<"p">) {
  return <p {...props} className={`doc-paragraph ${props.className ?? ""}`.trim()} />;
}

function Heading2(props: ComponentPropsWithoutRef<"h2">) {
  return <h2 {...props} className={`doc-heading doc-heading-2 ${props.className ?? ""}`.trim()} />;
}

function Heading3(props: ComponentPropsWithoutRef<"h3">) {
  return <h3 {...props} className={`doc-heading doc-heading-3 ${props.className ?? ""}`.trim()} />;
}

function Blockquote(props: ComponentPropsWithoutRef<"blockquote">) {
  return <blockquote {...props} className={`doc-callout ${props.className ?? ""}`.trim()} />;
}

function Pre(props: ComponentPropsWithoutRef<"pre">) {
  return <CodeBlock>{props.children}</CodeBlock>;
}

function InlineCode(props: ComponentPropsWithoutRef<"code">) {
  return <code {...props} className={`doc-inline-code ${props.className ?? ""}`.trim()} />;
}

function Anchor(props: ComponentPropsWithoutRef<"a">) {
  const href = props.href ?? "";
  const className = `doc-link ${props.className ?? ""}`.trim();

  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {props.children}
      </Link>
    );
  }

  return <a {...props} className={className} />;
}

interface WorkspaceCopilotDemoProps {
  step?: string;
  title?: string;
  children?: React.ReactNode;
}

function WorkspaceCopilotDemo(props: WorkspaceCopilotDemoProps) {
  const { step, title = "Used in the Workspace Copilot demo", children } = props;
  return (
    <aside className="workspace-demo-callout">
      <div className="workspace-demo-kicker">{step ?? "Canonical example"}</div>
      <h3 className="workspace-demo-title">{title}</h3>
      {children ? <div className="workspace-demo-body">{children}</div> : null}
    </aside>
  );
}

export const mdxComponents = {
  p: Paragraph,
  h2: Heading2,
  h3: Heading3,
  blockquote: Blockquote,
  pre: Pre,
  code: InlineCode,
  a: Anchor,
  WorkspaceCopilotDemo,
};
