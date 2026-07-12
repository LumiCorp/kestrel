"use client";

import { usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";
import useSWR from "swr";
import type { UIArtifact } from "@/components/artifact";

export const initialArtifactData: UIArtifact = {
  documentId: "init",
  content: "",
  kind: "text",
  title: "",
  status: "idle",
  isVisible: false,
  boundingBox: {
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  },
};

type Selector<T> = (state: UIArtifact) => T;

function getArtifactScopeKey(pathname: string | null) {
  if (pathname === "/threads") {
    return "chat:index";
  }

  const chatMatch = pathname?.match(/^\/threads\/([^/?#]+)/);
  if (chatMatch) {
    return `chat:${chatMatch[1]}`;
  }

  return `route:${pathname ?? "unknown"}`;
}

function getArtifactStateKey(scopeKey: string) {
  return `artifact:${scopeKey}`;
}

function getArtifactMetadataKey(scopeKey: string, documentId: string) {
  return `artifact-metadata:${scopeKey}:${documentId}`;
}

function useResolvedArtifactScopeKey(scopeKey?: string) {
  const pathname = usePathname();

  return scopeKey ?? getArtifactScopeKey(pathname);
}

export function useArtifactSelector<Selected>(
  selector: Selector<Selected>,
  scopeKey?: string
) {
  const resolvedScopeKey = useResolvedArtifactScopeKey(scopeKey);
  const { data: localArtifact } = useSWR<UIArtifact>(
    getArtifactStateKey(resolvedScopeKey),
    null,
    {
      fallbackData: initialArtifactData,
    }
  );

  const selectedValue = useMemo(() => {
    if (!localArtifact) {
      return selector(initialArtifactData);
    }
    return selector(localArtifact);
  }, [localArtifact, selector]);

  return selectedValue;
}

export function useArtifact(scopeKey?: string) {
  const resolvedScopeKey = useResolvedArtifactScopeKey(scopeKey);
  const artifactStateKey = getArtifactStateKey(resolvedScopeKey);
  const { data: localArtifact, mutate: setLocalArtifact } = useSWR<UIArtifact>(
    artifactStateKey,
    null,
    {
      fallbackData: initialArtifactData,
    }
  );

  const artifact = useMemo(() => {
    if (!localArtifact) {
      return initialArtifactData;
    }
    return localArtifact;
  }, [localArtifact]);

  const setArtifact = useCallback(
    (updaterFn: UIArtifact | ((currentArtifact: UIArtifact) => UIArtifact)) => {
      setLocalArtifact((currentArtifact) => {
        const artifactToUpdate = currentArtifact || initialArtifactData;

        if (typeof updaterFn === "function") {
          return updaterFn(artifactToUpdate);
        }

        return updaterFn;
      });
    },
    [setLocalArtifact]
  );

  const resetArtifact = useCallback(() => {
    setLocalArtifact(initialArtifactData, { revalidate: false });
  }, [setLocalArtifact]);

  const { data: localArtifactMetadata, mutate: setLocalArtifactMetadata } =
    useSWR<unknown>(
      () =>
        artifact.documentId && artifact.documentId !== "init"
          ? getArtifactMetadataKey(resolvedScopeKey, artifact.documentId)
          : null,
      null,
      {
        fallbackData: null,
      }
    );

  return useMemo(
    () => ({
      artifact,
      setArtifact,
      metadata: localArtifactMetadata,
      setMetadata: setLocalArtifactMetadata,
      resetArtifact,
    }),
    [
      artifact,
      setArtifact,
      localArtifactMetadata,
      setLocalArtifactMetadata,
      resetArtifact,
    ]
  );
}
