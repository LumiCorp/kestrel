"use client";

import { Streamdown } from "streamdown";

export function AdminDocContent({ content }: { content: string }) {
  return (
    <div className="rounded-2xl border bg-card p-6">
      <div className="prose prose-slate dark:prose-invert max-w-none">
        <Streamdown>{content}</Streamdown>
      </div>
    </div>
  );
}
