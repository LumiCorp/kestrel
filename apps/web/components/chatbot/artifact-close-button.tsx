import { memo } from "react";
import { useArtifact } from "@/hooks/use-artifact";
import { CrossIcon } from "./icons";
import { Button } from "./ui/button";

function PureArtifactCloseButton() {
  const { artifact, resetArtifact, setArtifact, setMetadata } = useArtifact();

  return (
    <Button
      className="h-fit p-2 hover:bg-muted"
      data-testid="artifact-close-button"
      onClick={() => {
        if (artifact.status === "streaming") {
          setArtifact((currentArtifact) => ({
            ...currentArtifact,
            isVisible: false,
          }));
        } else {
          resetArtifact();
          setMetadata(null);
        }
      }}
      variant="outline"
    >
      <CrossIcon size={18} />
    </Button>
  );
}

export const ArtifactCloseButton = memo(PureArtifactCloseButton, () => true);
