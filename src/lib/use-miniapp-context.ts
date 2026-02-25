"use client";

import { useEffect, useState } from "react";
import { getMiniAppContext, isLikelyMiniAppHost } from "@/lib/miniapp-sdk-safe";

type MiniAppContext = {
  user?: {
    fid?: number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
  };
  client?: {
    clientFid?: number;
    added?: boolean;
  };
};

type RawMiniAppContext = {
  user?: {
    fid?: number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
  };
  client?: {
    clientFid?: number;
    added?: boolean;
  };
};

function mapContext(rawContext: RawMiniAppContext | null): MiniAppContext | null {
  if (!rawContext) {
    return null;
  }

  return {
    user: {
      fid: rawContext.user?.fid,
      username: rawContext.user?.username,
      displayName: rawContext.user?.displayName,
      pfpUrl: rawContext.user?.pfpUrl
    },
    client: {
      clientFid: rawContext.client?.clientFid,
      added: rawContext.client?.added
    }
  };
}

export function useMiniAppContext() {
  const [context, setContext] = useState<MiniAppContext | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isLikelyMiniAppHost()) {
      setContext(null);
      setLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    const fallbackTimer = setTimeout(() => {
      if (!cancelled) {
        setLoaded(true);
      }
    }, 1_200);

    async function loadContext() {
      try {
        const rawContext = (await getMiniAppContext(1_200)) as RawMiniAppContext | null;
        if (cancelled) {
          return;
        }

        setContext(mapContext(rawContext));
        setLoaded(true);
      } catch {
        if (cancelled) {
          return;
        }

        setContext(null);
        setLoaded(true);
      }
    }

    void loadContext();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, []);

  return {
    context,
    loaded,
    inMiniAppHost: Boolean(context),
    isLikelyMiniAppHost: isLikelyMiniAppHost()
  };
}
