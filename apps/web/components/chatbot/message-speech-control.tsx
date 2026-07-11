"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocalStorage } from "usehooks-ts";
import { Action } from "./elements/actions";
import { LoaderIcon, PlayIcon, StopIcon } from "./icons";

type SpeechPayload = {
  audioUrl: string;
  modelId: string;
  voice: string;
  assetId: string;
};

export function MessageSpeechControl({
  messageId,
  autoPlay = false,
  languageModelId,
}: {
  messageId: string;
  autoPlay?: boolean;
  languageModelId?: string;
}) {
  const [enabled] = useLocalStorage("chat-autoplay-tts", false);
  const shouldAutoPlay = autoPlay && enabled;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [payload, setPayload] = useState<SpeechPayload | null>(null);
  const hasAutoPlayed = useRef(false);

  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    []
  );

  const play = async () => {
    try {
      setIsLoading(true);

      const resolvedPayload =
        payload ??
        ((await fetch(`/api/messages/${messageId}/speech`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ languageModelId }),
        }).then(async (response) => {
          const json = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              json.error || "Speech playback is not available for this message."
            );
          }
          return json as SpeechPayload;
        })) as SpeechPayload);

      setPayload(resolvedPayload);

      if (!audioRef.current) {
        audioRef.current = new Audio(resolvedPayload.audioUrl);
        audioRef.current.onended = () => setIsPlaying(false);
        audioRef.current.onpause = () => setIsPlaying(false);
        audioRef.current.onplay = () => setIsPlaying(true);
      } else if (audioRef.current.src !== resolvedPayload.audioUrl) {
        audioRef.current.src = resolvedPayload.audioUrl;
      }

      await audioRef.current.play();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Speech playback failed for this message."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const stop = () => {
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
    setIsPlaying(false);
  };

  useEffect(() => {
    if (!shouldAutoPlay || hasAutoPlayed.current) {
      return;
    }

    hasAutoPlayed.current = true;
    void play();
  }, [shouldAutoPlay]);

  if (isLoading) {
    return (
      <Action disabled tooltip="Generating speech">
        <div className="animate-spin">
          <LoaderIcon />
        </div>
      </Action>
    );
  }

  if (isPlaying) {
    return (
      <Action onClick={stop} tooltip="Stop audio">
        <StopIcon />
      </Action>
    );
  }

  return (
    <Action onClick={() => void play()} tooltip="Play audio">
      <PlayIcon />
    </Action>
  );
}
