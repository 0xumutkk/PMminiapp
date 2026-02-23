"use client";

import { useEffect, useRef } from "react";
import { useMiniKit } from "@coinbase/onchainkit/minikit";

export function useMiniAppReady() {
  const { setMiniAppReady } = useMiniKit();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) {
      return;
    }

    attemptedRef.current = true;
    void (async () => {
      try {
        await setMiniAppReady();
      } catch {
        // Safe fallback: app can still run in a standard browser.
      }
    })();
  }, [setMiniAppReady]);
}

export const useFarcasterReady = useMiniAppReady;
