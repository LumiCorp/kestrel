import { Check, Copy, ExternalLink, X } from "lucide-react";
import React, {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Streamdown,
  defaultRehypePlugins,
  type Components,
} from "streamdown";
import { describeConversationLink } from "@kestrel-agents/conversation";
import type {
  DesktopLinkPreviewResult,
} from "../../src/contracts";

interface MessageContentProps {
  messageRole: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean | undefined;
}

interface SafeLinkRequest {
  url: string;
  observedUrl?: string | undefined;
}

interface HastNode {
  type?: string | undefined;
  tagName?: string | undefined;
  value?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  children?: HastNode[] | undefined;
}

const PREVIEW_ATTRIBUTE = "data-kestrel-link-preview";
const MAX_PREVIEW_CARDS = 4;

const previewRehypePlugins = [
  ...Object.values(defaultRehypePlugins),
  rehypeStandaloneLinkPreviews,
];

export function MessageContent({
  messageRole,
  text,
  streaming = false,
}: MessageContentProps) {
  const [safeLink, setSafeLink] = useState<SafeLinkRequest>();
  const closeSafeLink = useCallback(() => setSafeLink(undefined), []);
  const components = useMemo<Components>(() => {
    const LinkRenderer = ({
      node: _node,
      children,
      href,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & {
      node?: unknown;
      [PREVIEW_ATTRIBUTE]?: string | undefined;
    }) => {
      const destination = href ? describeConversationLink(href) : undefined;
      if (!destination) return <span>{children}</span>;
      if (!streaming && props[PREVIEW_ATTRIBUTE] === "true") {
        return (
          <LinkPreviewCard
            url={destination.url}
            onOpen={(request) => setSafeLink(request)}
          />
        );
      }
      const {
        [PREVIEW_ATTRIBUTE]: _preview,
        target: _target,
        onClick: _onClick,
        onAuxClick: _onAuxClick,
        ...anchorProps
      } = props;
      const requestConfirmation = () => {
        setSafeLink({ url: destination.url });
      };
      return (
        <a
          {...anchorProps}
          data-streamdown="link"
          href={destination.url}
          onClick={(event) => {
            event.preventDefault();
            requestConfirmation();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            requestConfirmation();
          }}
        >
          {children}
        </a>
      );
    };
    const ParagraphRenderer = ({
      node: _node,
      children,
      ...props
    }: HTMLAttributes<HTMLParagraphElement> & { node?: unknown }) => {
      const meaningful = Children.toArray(children).filter(
        (child) => typeof child !== "string" || child.trim().length > 0,
      );
      const onlyChild = meaningful[0];
      if (
        meaningful.length === 1 &&
        isValidElement(onlyChild) &&
        onlyChild.type === LinkRenderer &&
        (onlyChild.props as Record<string, unknown>)[PREVIEW_ATTRIBUTE] === "true"
      ) {
        return <>{onlyChild}</>;
      }
      return <p {...props}>{children}</p>;
    };
    return { a: LinkRenderer, p: ParagraphRenderer };
  }, [streaming]);

  if (messageRole !== "assistant") {
    return <div className="message-body message-body-plain">{text}</div>;
  }

  return (
    <>
      <Streamdown
        className="message-body message-body-markdown"
        components={components}
        controls={false}
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        rehypePlugins={previewRehypePlugins}
        linkSafety={{ enabled: false }}
      >
        {text}
      </Streamdown>
      <ExternalLinkSafetyDialog
        request={safeLink}
        onClose={closeSafeLink}
      />
    </>
  );
}

function LinkPreviewCard({
  url,
  onOpen,
}: {
  url: string;
  onOpen: (request: SafeLinkRequest) => void;
}) {
  const destination = describeConversationLink(url);
  const [result, setResult] = useState<
    DesktopLinkPreviewResult | "loading"
  >(() => (shouldFetchPreview(url) ? "loading" : {
    status: "unavailable",
    requestedUrl: url,
    reason: "blocked",
  }));
  const [copied, setCopied] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (!shouldFetchPreview(url)) return;
    let active = true;
    void window.kestrelDesktop
      .getLinkPreviews({ urls: [url] })
      .then((results) => {
        const preview = results[0];
        if (active && preview) setResult(preview);
      })
      .catch(() => {
        if (active) {
          setResult({
            status: "unavailable",
            requestedUrl: url,
            reason: "network",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [url]);

  useEffect(() => {
    setImageFailed(false);
  }, [previewImageUrl(result)]);

  if (!destination) return null;
  const preview = result !== "loading" && result.status === "available"
    ? result
    : undefined;
  const finalDestination = preview
    ? describeConversationLink(preview.finalUrl)
    : undefined;
  const observedUrl =
    preview && preview.finalUrl !== url ? preview.finalUrl : undefined;
  const title = preview?.title ?? destination.hostname;
  const description = preview?.description ?? destination.destination;
  const siteName =
    preview?.siteName ?? finalDestination?.hostname ?? destination.hostname;
  const open = () => onOpen({ url, ...(observedUrl ? { observedUrl } : {}) });

  return (
    <article
      className={`link-preview-card ${result === "loading" ? "is-loading" : "is-ready"}`}
      data-link-preview-status={result === "loading" ? "loading" : result.status}
    >
      <button
        className="link-preview-main"
        type="button"
        aria-label={`Open ${title} from ${siteName}`}
        onClick={open}
      >
        <span className="link-preview-thumbnail" aria-hidden="true">
          {preview?.imageDataUrl && !imageFailed ? (
            <img
              alt=""
              src={preview.imageDataUrl}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span>{result === "loading" ? "" : destination.hostname.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="link-preview-copy">
          <span className="link-preview-site">{siteName}</span>
          <strong>{title}</strong>
          <span className="link-preview-description">{description}</span>
        </span>
        <ExternalLink className="link-preview-external" size={16} />
      </button>
      <div className="link-preview-actions">
        {copyError ? (
          <span className="link-preview-action-error" role="alert">
            {copyError}
          </span>
        ) : null}
        <button
          type="button"
          disabled={copyPending}
          onClick={async () => {
            setCopyPending(true);
            setCopyError(undefined);
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              setCopied(false);
              setCopyError("Copy failed");
            } finally {
              setCopyPending(false);
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copyPending ? "Copying" : copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={open}>
          <ExternalLink size={13} />
          Open
        </button>
      </div>
    </article>
  );
}

function ExternalLinkSafetyDialog({
  request,
  onClose,
}: {
  request: SafeLinkRequest | undefined;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [openPending, setOpenPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const destination = request
    ? describeConversationLink(request.url)
    : undefined;
  const observedDestination = request?.observedUrl
    ? describeConversationLink(request.observedUrl)
    : undefined;

  useEffect(() => {
    setCopied(false);
    setCopyPending(false);
    setOpenPending(false);
    setActionError(undefined);
    if (!destination) return;
    const priorFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const priorBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      const initialFocus = dialogRef.current?.querySelector<HTMLElement>(
        "[data-initial-focus]",
      );
      (initialFocus ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = priorBodyOverflow;
      priorFocus?.focus({ preventScroll: true });
    };
  }, [destination?.url, onClose]);

  if (!destination) return null;
  return createPortal(
    <div
      className="external-link-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="external-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Open external link"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
          ) ?? [])];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <span className="external-link-dialog-icon">
            <ExternalLink size={18} />
          </span>
          <div>
            <strong>Open external destination?</strong>
            <span>This link will open in your default browser.</span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close link dialog"
            data-initial-focus
            ref={closeButtonRef}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="external-link-destination">
          <strong>{destination.hostname}</strong>
          <span>{destination.destination}</span>
          <code>{destination.url}</code>
          {observedDestination && observedDestination.url !== destination.url ? (
            <div className="external-link-observed">
              <strong>Observed preview destination</strong>
              <code>{observedDestination.url}</code>
            </div>
          ) : null}
        </div>
        {actionError ? (
          <div className="external-link-dialog-error" role="alert">
            {actionError}
          </div>
        ) : null}
        <footer>
          <button
            type="button"
            disabled={copyPending || openPending}
            onClick={async () => {
              closeButtonRef.current?.focus();
              setCopyPending(true);
              setActionError(undefined);
              try {
                await navigator.clipboard.writeText(destination.url);
                setCopied(true);
              } catch {
                setCopied(false);
                setActionError("Kestrel could not copy this link. Try again.");
              } finally {
                setCopyPending(false);
              }
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copyPending ? "Copying" : copied ? "Copied" : "Copy link"}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={copyPending || openPending}
            onClick={async () => {
              closeButtonRef.current?.focus();
              setOpenPending(true);
              setActionError(undefined);
              try {
                await window.kestrelDesktop.openExternal(destination.url);
                onClose();
              } catch {
                setActionError(
                  "Kestrel could not open this link in your browser. Try again.",
                );
                setOpenPending(false);
              }
            }}
          >
            <ExternalLink size={15} />
            {openPending ? "Opening" : "Open in browser"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function previewImageUrl(
  result: DesktopLinkPreviewResult | "loading",
): string | undefined {
  return result !== "loading" && result.status === "available"
    ? result.imageDataUrl
    : undefined;
}

function rehypeStandaloneLinkPreviews() {
  return (tree: unknown) => {
    const seen = new Set<string>();
    let count = 0;
    walkHast(tree as HastNode, (node) => {
      if (node.tagName !== "p" || !node.children) return;
      const meaningful = node.children.filter(
        (child) => child.type !== "text" || (child.value?.trim().length ?? 0) > 0,
      );
      if (meaningful.length !== 1) return;
      const link = meaningful[0];
      if (link?.tagName !== "a") return;
      const href = readHastHref(link);
      if (!href || !isUrlLabel(readHastText(link), href) || seen.has(href)) return;
      seen.add(href);
      if (count >= MAX_PREVIEW_CARDS) return;
      count += 1;
      link.properties ??= {};
      link.properties[PREVIEW_ATTRIBUTE] = "true";
    });
  };
}

function walkHast(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkHast(child, visit);
}

function readHastHref(node: HastNode): string | undefined {
  const href = node.properties?.href;
  return typeof href === "string" ? href : undefined;
}

function readHastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(readHastText).join("");
}

function isUrlLabel(label: string, href: string): boolean {
  try {
    const labeledUrl = new URL(label.trim());
    const destination = new URL(href);
    return (
      (labeledUrl.protocol === "http:" || labeledUrl.protocol === "https:") &&
      labeledUrl.href === destination.href
    );
  } catch {
    return false;
  }
}

function shouldFetchPreview(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return !(
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname)
    );
  } catch {
    return false;
  }
}

export type { MessageContentProps };
