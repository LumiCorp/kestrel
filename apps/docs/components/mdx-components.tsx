import Link from "next/link";
import type React from "react";
import type { ComponentPropsWithoutRef } from "react";

import { CodeBlock } from "@/components/CodeBlock";
import { DOCS_RELEASE } from "@/lib/release";

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
  return <CodeBlock {...props} />;
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

function DocsImage(props: ComponentPropsWithoutRef<"img">) {
  return (
    <img
      {...props}
      alt={props.alt ?? ""}
      className={`doc-product-image ${props.className ?? ""}`.trim()}
    />
  );
}

interface CalloutProps {
  tone?: "note" | "warning" | "checkpoint";
  title?: string;
  children: React.ReactNode;
}

function Callout({ tone = "note", title, children }: CalloutProps) {
  return (
    <aside className={`doc-callout doc-callout-${tone}`}>
      {title ? <strong className="doc-callout-title">{title}</strong> : null}
      <div className="doc-callout-body">{children}</div>
    </aside>
  );
}

function Outcome({ children }: { children: React.ReactNode }) {
  return (
    <aside className="doc-outcome">
      <strong>What success looks like</strong>
      <div>{children}</div>
    </aside>
  );
}

interface ProductFigureProps {
  src: string;
  alt: string;
  caption: string;
}

function ProductFigure({ src, alt, caption }: ProductFigureProps) {
  return (
    <figure className="product-figure">
      <img className="doc-product-image" src={src} alt={alt} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function ReleaseCompatibilityTable() {
  return (
    <table>
      <thead><tr><th>Surface</th><th>Compatible line</th><th>Contract note</th></tr></thead>
      <tbody>
        {DOCS_RELEASE.compatibility.map(([surface, note]) => (
          <tr key={surface}><td>{surface}</td><td><code>{DOCS_RELEASE.version}</code></td><td>{note}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function ReleaseStatusTable() {
  return (
    <table>
      <thead><tr><th>Surface</th><th>Documented line</th><th>Channel</th></tr></thead>
      <tbody>
        {DOCS_RELEASE.compatibility.map(([surface]) => (
          <tr key={surface}><td>{surface}</td><td><code>{DOCS_RELEASE.version}</code></td><td>{DOCS_RELEASE.channel}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function DesktopDownload() {
  const access = DOCS_RELEASE.productAccess.desktop;
  return (
    <aside className="download-panel">
      <div>
        <span className="download-panel-kicker">Kestrel Desktop {DOCS_RELEASE.version}</span>
        <strong>Download for {access.supportedPlatforms.join(", ")}</strong>
        <p>{access.trustNote}</p>
      </div>
      <a href={access.downloadUrl}>Download Kestrel Desktop</a>
    </aside>
  );
}

function KestrelOneAccess() {
  return (
    <Callout title="Invitation required">
      <p>{DOCS_RELEASE.productAccess.kestrelOne.accessNote}</p>
    </Callout>
  );
}

interface GuideNoteProps {
  step?: string;
  title?: string;
  children?: React.ReactNode;
}

function GuideNote(props: GuideNoteProps) {
  const { step, title = "Guide note", children } = props;
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
  img: DocsImage,
  Callout,
  Outcome,
  ProductFigure,
  GuideNote,
  ReleaseCompatibilityTable,
  ReleaseStatusTable,
  DesktopDownload,
  KestrelOneAccess,
};
