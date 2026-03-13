"use client";

import { useEffect } from "react";

export function MiniAppReady() {
  useEffect(() => {
    let cancelled = false;

    async function notifyReady() {
      try {
        const { sdk } = await import("@farcaster/miniapp-sdk");
        const inMiniApp = await sdk.isInMiniApp();
        if (!inMiniApp || cancelled) {
          return;
        }

        await sdk.actions.ready();
      } catch {
        // Ignore ready failures outside supported mini app hosts.
      }
    }

    void notifyReady();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
