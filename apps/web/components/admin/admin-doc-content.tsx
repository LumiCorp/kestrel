"use client";

import type { ComponentProps, ReactNode } from "react";
import { Streamdown } from "streamdown";

function textFromChildren(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(textFromChildren).join("");
  }
  if (children && typeof children === "object" && "props" in children) {
    return textFromChildren(
      (children as { props?: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

function headingId(children: ReactNode) {
  return textFromChildren(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "");
}

function AnchorHeading({
  as: Heading,
  children,
  node: _node,
  ...props
}: ComponentProps<"h2"> & { as: "h2" | "h3"; node?: unknown }) {
  const id = headingId(children);
  return (
    <Heading id={id} {...props}>
      <a className="scroll-mt-20 no-underline hover:underline" href={`#${id}`}>
        {children}
      </a>
    </Heading>
  );
}

const ADMIN_DOC_COMPONENTS: NonNullable<
  ComponentProps<typeof Streamdown>["components"]
> = {
  h2: (props) => <AnchorHeading as="h2" {...props} />,
  h3: (props) => <AnchorHeading as="h3" {...props} />,
};

export function AdminDocContent({ content }: { content: string }) {
  return (
    <div className="prose prose-slate dark:prose-invert max-w-none border-t pt-6">
      <Streamdown components={ADMIN_DOC_COMPONENTS}>{content}</Streamdown>
    </div>
  );
}
