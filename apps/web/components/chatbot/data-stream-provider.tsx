"use client";

import type { DataUIPart } from "ai";
import { usePathname } from "next/navigation";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { CustomUIDataTypes } from "@/lib/types";

type DataStreamContextValue = {
  streams: Record<string, DataUIPart<CustomUIDataTypes>[]>;
  setStreams: React.Dispatch<
    React.SetStateAction<Record<string, DataUIPart<CustomUIDataTypes>[]>>
  >;
};

const DataStreamContext = createContext<DataStreamContextValue | null>(null);

export function DataStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [streams, setStreams] = useState<
    Record<string, DataUIPart<CustomUIDataTypes>[]>
  >({});

  const value = useMemo(() => ({ streams, setStreams }), [streams]);

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

function getDataStreamScopeKey(pathname: string | null) {
  if (pathname === "/threads") {
    return "chat:index";
  }

  const chatMatch = pathname?.match(/^\/threads\/([^/?#]+)/);
  if (chatMatch) {
    return `chat:${chatMatch[1]}`;
  }

  return `route:${pathname ?? "unknown"}`;
}

export function useDataStream(scopeKey?: string) {
  const context = useContext(DataStreamContext);
  const pathname = usePathname();
  if (!context) {
    throw new Error("useDataStream must be used within a DataStreamProvider");
  }

  const resolvedScopeKey = scopeKey ?? getDataStreamScopeKey(pathname);
  const dataStream = context.streams[resolvedScopeKey] ?? [];

  const setDataStream = useCallback<
    React.Dispatch<React.SetStateAction<DataUIPart<CustomUIDataTypes>[]>>
  >(
    (updater) => {
      context.setStreams((currentStreams) => {
        const currentDataStream = currentStreams[resolvedScopeKey] ?? [];
        const nextDataStream =
          typeof updater === "function" ? updater(currentDataStream) : updater;

        if (nextDataStream.length === 0) {
          const { [resolvedScopeKey]: _removed, ...remainingStreams } =
            currentStreams;
          return remainingStreams;
        }

        return {
          ...currentStreams,
          [resolvedScopeKey]: nextDataStream,
        };
      });
    },
    [context, resolvedScopeKey]
  );

  return {
    dataStream,
    setDataStream,
  };
}
