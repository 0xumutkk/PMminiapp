"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketSnapshot } from "@/lib/market-types";
import { MarketCard } from "@/components/market-card";

type FeedState = {
  loading: boolean;
  error: string | null;
  snapshot: MarketSnapshot | null;
};

const WINDOW_RADIUS = 3;

function sortSnapshot(snapshot: MarketSnapshot): MarketSnapshot {
  return {
    ...snapshot,
    markets: [...snapshot.markets].sort((a, b) => {
      if (!a.endsAt || !b.endsAt) {
        return 0;
      }
      return new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime();
    })
  };
}

type VerticalMarketFeedProps = {
  initialSnapshot?: MarketSnapshot | null;
  startAtMarketId?: string | null;
};

export function VerticalMarketFeed({ initialSnapshot = null, startAtMarketId = null }: VerticalMarketFeedProps) {
  const [state, setState] = useState<FeedState>({
    loading: initialSnapshot === null,
    error: null,
    snapshot: initialSnapshot
  });

  const [activeIndex, setActiveIndex] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(680);
  const startAppliedRef = useRef(false);

  const containerRef = useRef<HTMLElement | null>(null);
  const elementMapRef = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateHeight = () => {
      // Prefer visualViewport.height (correct on iOS when browser chrome hides)
      // Fall back to container.clientHeight as the shell constrains it anyway.
      const vvh = window.visualViewport?.height;
      const next = vvh && vvh > 0 ? Math.floor(vvh) : container.clientHeight;
      if (next > 0) {
        setViewportHeight(next);
      }
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(container);

    window.addEventListener("resize", updateHeight);
    window.visualViewport?.addEventListener("resize", updateHeight);
    window.visualViewport?.addEventListener("scroll", updateHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateHeight);
      window.visualViewport?.removeEventListener("resize", updateHeight);
      window.visualViewport?.removeEventListener("scroll", updateHeight);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stream: EventSource | null = null;

    const load = async () => {
      try {
        const response = await fetch("/api/markets", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load markets");
        }

        const snapshot = (await response.json()) as MarketSnapshot;
        if (!cancelled) {
          setState({ loading: false, error: null, snapshot: sortSnapshot(snapshot) });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Unknown error";
          setState({ loading: false, error: message, snapshot: null });
        }
      }
    };

    const connectStream = () => {
      if (stream || document.visibilityState === "hidden") {
        return;
      }

      stream = new EventSource("/api/markets/stream");

      stream.onmessage = (event) => {
        if (cancelled) {
          return;
        }

        try {
          const snapshot = JSON.parse(event.data) as MarketSnapshot;
          if (snapshot.markets.length === 0) {
            return;
          }

          setState({ loading: false, error: null, snapshot: sortSnapshot(snapshot) });
        } catch {
          // Ignore malformed updates.
        }
      };

      stream.onerror = () => {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: previous.snapshot ? null : "Realtime stream disconnected"
          }));
        }

        if (stream) {
          stream.close();
          stream = null;
        }
      };
    };

    const disconnectStream = () => {
      if (!stream) {
        return;
      }

      stream.close();
      stream = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        disconnectStream();
        return;
      }

      connectStream();
    };

    if (!initialSnapshot) {
      load().catch(() => {
        // no-op
      });
    }

    connectStream();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      disconnectStream();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [initialSnapshot]);

  const markets = useMemo(() => state.snapshot?.markets ?? [], [state.snapshot]);
  const itemHeight = Math.max(1, viewportHeight);

  useEffect(() => {
    if (activeIndex > markets.length - 1) {
      setActiveIndex(Math.max(0, markets.length - 1));
    }
  }, [activeIndex, markets.length]);

  // Jump to the startAt market once markets are loaded.
  useEffect(() => {
    if (startAppliedRef.current || !startAtMarketId || markets.length === 0) return;
    const idx = markets.findIndex((m) => m.id === startAtMarketId);
    if (idx >= 0) {
      startAppliedRef.current = true;
      setActiveIndex(idx);
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: idx * itemHeight, behavior: "auto" });
      });
    }
  }, [markets, startAtMarketId, itemHeight]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const scrollIndex = Math.round(container.scrollTop / itemHeight);
    if (Number.isFinite(scrollIndex) && scrollIndex >= 0 && scrollIndex < markets.length) {
      setActiveIndex(scrollIndex);
    }
  }, [itemHeight, markets.length]);



  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.6) {
            continue;
          }

          const indexAttr = entry.target.getAttribute("data-index");
          if (!indexAttr) {
            continue;
          }

          const parsedIndex = Number(indexAttr);
          if (Number.isInteger(parsedIndex)) {
            setActiveIndex(parsedIndex);
          }
        }
      },
      {
        root: container,
        threshold: [0.6]
      }
    );

    for (const [, element] of elementMapRef.current) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
    };
  }, [markets.length]);

  const setObservedNode = useCallback(
    (index: number) => (node: HTMLElement | null) => {
      if (!node) {
        elementMapRef.current.delete(index);
        return;
      }

      elementMapRef.current.set(index, node);
    },
    []
  );

  if (state.loading) {
    return <section className="feed-loading">Loading markets...</section>;
  }

  if (state.error && !state.snapshot) {
    return <section className="feed-error">{state.error}</section>;
  }

  if (!state.snapshot || state.snapshot.markets.length === 0) {
    return <section className="feed-empty">No active markets right now.</section>;
  }

  return (
    <section
      className="feed"
      aria-live="polite"
      ref={containerRef}
      onScroll={handleScroll}
    >
      {markets.map((market, index) => {
        const isVisible = Math.abs(index - activeIndex) <= WINDOW_RADIUS + 1;

        return (
          <div
            key={`${market.id}-${index}`}
            className="feed-card-slot"
            data-index={index}
            ref={setObservedNode(index)}
            style={{ height: itemHeight }}
          >
            {isVisible && <MarketCard market={market} isActive={index === activeIndex} />}
          </div>
        );
      })}
    </section>
  );
}
