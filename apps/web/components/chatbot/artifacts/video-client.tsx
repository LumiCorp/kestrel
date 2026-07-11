import { Artifact } from "@/components/create-artifact";
import { VideoEditor } from "@/components/video-editor";

export const videoArtifact = new Artifact({
  kind: "video",
  description: "Useful for video generation",
  onStreamPart: () => {},
  content: VideoEditor,
  actions: [],
  toolbar: [],
});
