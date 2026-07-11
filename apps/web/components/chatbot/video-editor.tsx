import cn from "classnames";
import { LoaderIcon } from "./icons";

export function VideoEditor({
  title,
  content,
  status,
  isInline,
}: {
  title: string;
  content: string;
  status: string;
  isInline: boolean;
}) {
  return (
    <div
      className={cn("flex w-full items-center justify-center", {
        "h-[calc(100dvh-60px)]": !isInline,
        "h-[220px] p-2": isInline,
      })}
    >
      {status === "streaming" ? (
        <div className="flex flex-row items-center gap-4">
          <div className="animate-spin">
            <LoaderIcon />
          </div>
          <div>Generating Video...</div>
        </div>
      ) : (
        <video
          className="h-full max-h-full w-full rounded-xl bg-black object-contain"
          controls={true}
          playsInline={true}
          src={content}
          title={title}
        />
      )}
    </div>
  );
}
