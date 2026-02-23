"use client";

import { useEffect, useMemo, useState } from "react";
import { useMiniKit } from "@coinbase/onchainkit/minikit";

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

export function useMiniAppContext() {
  const { context: rawContext } = useMiniKit();
  const [loaded, setLoaded] = useState(false);
  const context: MiniAppContext | null = useMemo(() => {
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
        clientFid: rawContext.client.clientFid,
        added: rawContext.client.added
      }
    };
  }, [rawContext]);

  useEffect(() => {
    if (context) {
      setLoaded(true);
      return;
    }

    const timer = setTimeout(() => {
      setLoaded(true);
    }, 500);

    return () => {
      clearTimeout(timer);
    };
  }, [context]);

  return {
    context,
    loaded,
    inMiniAppHost: Boolean(context)
  };
}
