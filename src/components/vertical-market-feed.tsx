"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarketSnapshot } from "@/lib/market-types";
import { MarketCard } from "@/components/market-card";

type FeedState = {
  loading: boolean;
  error: string | null;
  snapshot: MarketSnapshot | null;
};

const WINDOW_RADIUS = 2;

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

export function VerticalMarketFeed() {
  const [state, setState] = useState<FeedState>({
    loading: true,
    error: null,
    snapshot: null
  });

  const [activeIndex, setActiveIndex] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(680);

  const containerRef = useRef<HTMLElement | null>(null);
  const elementMapRef = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateHeight = () => {
      const next = container.clientHeight;
      if (next > 0) {
        setViewportHeight(next);
      }
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(container);

    window.addEventListener("resize", updateHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateHeight);
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

    load().catch(() => {
      // no-op
    });

    connectStream();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      disconnectStream();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const markets = useMemo(() => state.snapshot?.markets ?? [], [state.snapshot]);
  const itemHeight = Math.max(1, viewportHeight);

  useEffect(() => {
    if (activeIndex > markets.length - 1) {
      setActiveIndex(Math.max(0, markets.length - 1));
    }
  }, [activeIndex, markets.length]);

  const startIndex = Math.max(0, activeIndex - WINDOW_RADIUS);
  const endIndex = Math.min(markets.length, activeIndex + WINDOW_RADIUS + 1);

  const topPad = startIndex * itemHeight;
  const bottomPad = Math.max(0, (markets.length - endIndex) * itemHeight);

  const visibleMarkets = useMemo(() => markets.slice(startIndex, endIndex), [endIndex, markets, startIndex]);

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
  }, [endIndex, startIndex, visibleMarkets.length]);

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
    <section className="feed" aria-live="polite" ref={containerRef} onScroll={handleScroll}>
      <div aria-hidden style={{ height: topPad }} />

      {visibleMarkets.map((market, offset) => {
        const index = startIndex + offset;

        return (
          <div
            key={`${market.id}-${index}`}
            className="feed-card-slot"
            data-index={index}
            ref={setObservedNode(index)}
            style={{ height: itemHeight }}
          >
            <MarketCard market={market} isActive={index === activeIndex} />
          </div>
        );
      })}

      <div aria-hidden style={{ height: bottomPad }} />
    </section>
  );
}
