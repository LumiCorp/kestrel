import Image from "next/image";
import type { Attachment } from "@/lib/types";
import { Loader } from "./elements/loader";
import { CrossSmallIcon } from "./icons";
import { Button } from "./ui/button";

export const PreviewAttachment = ({
  attachment,
  isUploading = false,
  onRemove,
  onRetry,
}: {
  attachment: Attachment;
  isUploading?: boolean;
  onRemove?: () => void;
  onRetry?: () => void;
}) => {
  const { name, url, contentType } = attachment;

  const preview = contentType?.startsWith("image") && url ? (
    <Image
      alt={name ?? "An image attachment"}
      className="size-full object-cover"
      height={64}
      src={url}
      width={64}
    />
  ) : (
    <div className="flex size-full items-center justify-center text-muted-foreground text-xs">
      File
    </div>
  );

  return (
    <div
      className="group relative size-16 overflow-hidden rounded-lg border bg-muted"
      data-testid="input-attachment-preview"
    >
      {url && !onRemove ? (
        <a aria-label={`Download ${name}`} className="block size-full" href={url}>
          {preview}
        </a>
      ) : preview}

      {isUploading && !onRetry && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/50"
          data-testid="input-attachment-loader"
        >
          <Loader size={16} />
          {onRemove ? (
            <Button
              aria-label={`Cancel upload of ${name}`}
              className="absolute top-0.5 right-0.5 size-4 rounded-full p-0"
              onClick={onRemove}
              size="sm"
              variant="destructive"
            >
              <CrossSmallIcon size={8} />
            </Button>
          ) : null}
        </div>
      )}

      {onRetry ? (
        <Button
          aria-label={`Retry upload of ${name}`}
          className="absolute inset-0 size-full rounded-none bg-black/60 text-[10px] text-white"
          onClick={onRetry}
          size="sm"
          variant="ghost"
        >
          Retry
        </Button>
      ) : null}

      {!isUploading && attachment.status !== "ready" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-1 text-center text-[10px] text-white">
          {attachment.status === "quarantined" ? "Quarantined" : "Unavailable"}
        </div>
      ) : null}

      {onRemove && !isUploading && (
        <Button
          className="absolute top-0.5 right-0.5 size-4 rounded-full p-0 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={onRemove}
          size="sm"
          variant="destructive"
        >
          <CrossSmallIcon size={8} />
        </Button>
      )}

      <div className="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-black/80 to-transparent px-1 py-0.5 text-[10px] text-white">
        {name}
      </div>
    </div>
  );
};
