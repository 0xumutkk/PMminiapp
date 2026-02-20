"use client";

import { useEffect } from "react";

export function useFarcasterReady() {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { sdk } = await import("@farcaster/frame-sdk");
        if (!cancelled) {
          await sdk.actions.ready();
        }
      } catch {
        // Safe fallback: app can still run in a standard browser.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
