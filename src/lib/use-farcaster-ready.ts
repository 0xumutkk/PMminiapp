"use client";

import { useEffect, useRef } from "react";
import { isLikelyMiniAppHost, markMiniAppReady } from "@/lib/miniapp-sdk-safe";

export function useMiniAppReady() {
  const readyRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (readyRef.current) {
      return;
    }

    if (!isLikelyMiniAppHost()) {
      readyRef.current = true;
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    async function attemptReady(attempt = 0, maxAttempts = 120) {
      if (cancelled || readyRef.current || inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;
      try {
        const ready = await markMiniAppReady();
        if (!ready) {
          return;
        }
        readyRef.current = true;
        return;
      } finally {
        inFlightRef.current = false;
      }

      if (attempt >= maxAttempts) {
        return;
      }

      retryTimer = setTimeout(() => {
        void attemptReady(attempt + 1, maxAttempts);
      }, 500);
    }

    const triggerReady = () => {
      if (cancelled || readyRef.current) {
        return;
      }

      void attemptReady(0, 120);
    };

    triggerReady();

    // Tunnel/dev mode can delay bridge startup. Re-try on visibility/focus.
    const onFocus = () => triggerReady();
    const onPageShow = () => triggerReady();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        triggerReady();
      }
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);

    heartbeatTimer = setInterval(() => {
      triggerReady();
    }, 2_000);

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

export const useFarcasterReady = useMiniAppReady;
