"use client";

import { useEffect, useMemo, useState } from "react";
import type { MarketSnapshot } from "@/lib/market-types";

type FetchState = {
  loading: boolean;
  error: string | null;
  snapshot: MarketSnapshot | null;
};

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatEndsAt(value?: string) {
  if (!value) {
    return "No deadline";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "No deadline";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function sortByEndingSoon(markets: MarketSnapshot["markets"]) {
  return [...markets].sort((left, right) => {
    const leftTs = left.endsAt ? Date.parse(left.endsAt) : Number.MAX_SAFE_INTEGER;
    const rightTs = right.endsAt ? Date.parse(right.endsAt) : Number.MAX_SAFE_INTEGER;
    return leftTs - rightTs;
  });
}

export function MarketsBrowser() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<FetchState>({
    loading: true,
    error: null,
    snapshot: null
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/markets", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load markets (${response.status})`);
        }

        const snapshot = (await response.json()) as MarketSnapshot;
        if (!cancelled) {
          setState({
            loading: false,
            error: null,
            snapshot: {
              ...snapshot,
              markets: sortByEndingSoon(snapshot.markets)
            }
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            error: error instanceof Error ? error.message : "Unknown error",
            snapshot: null
          });
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredMarkets = useMemo(() => {
    const markets = state.snapshot?.markets ?? [];
    const text = query.trim().toLowerCase();
    if (!text) {
      return markets;
    }

    return markets.filter((market) => market.title.toLowerCase().includes(text));
  }, [query, state.snapshot?.markets]);

  if (state.loading) {
    return <p className="state-text">Loading markets...</p>;
  }

  if (state.error) {
    return <p className="state-text state-text--error">{state.error}</p>;
  }

  return (
    <div className="market-browser">
      <label className="field-group" htmlFor="market-search">
        <span>Search markets</span>
        <input
          id="market-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try: election, bitcoin, policy..."
        />
      </label>

      <div className="market-list">
        {filteredMarkets.map((market) => (
          <article key={market.id} className="market-list__item">
            <p className="market-list__title">{market.title}</p>
            <p className="market-list__meta">
              <span className="chip chip--yes">YES {formatPercent(market.yesPrice)}</span>
              <span className="chip chip--no">NO {formatPercent(market.noPrice)}</span>
              <span>Ends {formatEndsAt(market.endsAt)}</span>
            </p>
          </article>
        ))}

        {filteredMarkets.length === 0 ? <p className="state-text">No matches found.</p> : null}
      </div>
    </div>
  );
}
