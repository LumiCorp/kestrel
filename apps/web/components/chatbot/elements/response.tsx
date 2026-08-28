"use client";

import { useEffect, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ResponseProps = ComponentProps<typeof Streamdown>;

type LinkSafetyModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  url: string;
};

function PortaledLinkSafetyModal({
  isOpen,
  onClose,
  onConfirm,
  url,
}: LinkSafetyModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/35 p-4 backdrop-blur-[2px]"
      data-streamdown="link-safety-dialog"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-describedby="external-link-description"
        aria-labelledby="external-link-title"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="space-y-1">
          <h2 className="font-semibold text-lg" id="external-link-title">
            Open external link?
          </h2>
          <p
            className="text-muted-foreground text-sm"
            id="external-link-description"
          >
            Check the destination before continuing.
          </p>
        </div>
        <div className="mt-4 break-all rounded-lg border bg-muted/45 px-3 py-2.5 font-mono text-xs">
          {url}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={onConfirm} type="button">
            Continue
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Response({
  className,
  children,
  linkSafety,
  ...props
}: ResponseProps) {
  return (
    <Streamdown
      className={cn(
        "size-full max-w-none text-[15px] text-foreground leading-7",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_p]:my-3 [&_p]:break-words",
        "[&_h1]:mt-7 [&_h1]:mb-3 [&_h1]:font-semibold [&_h1]:text-2xl [&_h1]:tracking-tight",
        "[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:font-semibold [&_h2]:text-xl [&_h2]:tracking-tight",
        "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-semibold [&_h3]:text-base [&_h3]:tracking-tight",
        "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-medium [&_h4]:text-sm [&_h4]:uppercase [&_h4]:tracking-[0.12em]",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6",
        "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6",
        "[&_li]:pl-1",
        "[&_blockquote]:my-4 [&_blockquote]:border-primary/25 [&_blockquote]:border-l-2 [&_blockquote]:bg-muted/35 [&_blockquote]:px-4 [&_blockquote]:py-2.5 [&_blockquote]:italic",
        "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary/80",
        "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-lg [&_table]:border",
        "[&_thead]:bg-muted/60",
        "[&_th]:border-b [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-sm",
        "[&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-sm",
        "[&_hr]:my-6 [&_hr]:border-border",
        "[&_sup]:text-[10px]",
        "[&_code]:whitespace-pre-wrap [&_code]:break-words [&_code]:rounded-[0.35rem] [&_code]:bg-muted/70 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]",
        "[&_pre]:my-4 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:bg-muted/65 [&_pre]:p-4 [&_pre]:shadow-sm",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px] [&_pre_code]:leading-6",
        "[&_section[data-footnotes]]:mt-6 [&_section[data-footnotes]]:border-t [&_section[data-footnotes]]:pt-4",
        "[&_section[data-footnotes]]:text-muted-foreground [&_section[data-footnotes]_li]:text-sm [&_section[data-footnotes]_ol]:my-2 [&_section[data-footnotes]_p]:my-2",
        className
      )}
      linkSafety={
        linkSafety === undefined
          ? { enabled: true, renderModal: PortaledLinkSafetyModal }
          : {
              ...linkSafety,
              renderModal:
                linkSafety.renderModal ?? PortaledLinkSafetyModal,
            }
      }
      {...props}
    >
      {children}
    </Streamdown>
  );
}
