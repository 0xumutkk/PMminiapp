"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import type { MarketSnapshot } from "@/lib/market-types";
import {
  CATEGORY_FILTER_OPTIONS,
  inferMarketCategoryId,
  marketCategoryLabel,
  type MarketCategoryFilter
} from "@/lib/market-category";
import { useQuery } from "@tanstack/react-query";

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

async function fetchMarketsSnapshot(): Promise<MarketSnapshot> {
  const response = await fetch("/api/markets", {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to load markets (${response.status})`);
  }

  return (await response.json()) as MarketSnapshot;
}

export function MarketsBrowser() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [activeCategory, setActiveCategory] = useState<MarketCategoryFilter>("all");

  const marketsQuery = useQuery({
    queryKey: ["markets", "snapshot"],
    queryFn: fetchMarketsSnapshot
  });

  const markets = useMemo(
    () => sortByEndingSoon(marketsQuery.data?.markets ?? []),
    [marketsQuery.data?.markets]
  );

  const availableCategories = useMemo(() => {
    const set = new Set<MarketCategoryFilter>(["all"]);
    for (const market of markets) {
      set.add(inferMarketCategoryId(market.title));
    }

    return CATEGORY_FILTER_OPTIONS.filter((option) => set.has(option.id));
  }, [markets]);

  const filteredMarkets = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();

    return markets.filter((market) => {
      const matchesQuery = !text || market.title.toLowerCase().includes(text);
      const matchesCategory =
        activeCategory === "all" || inferMarketCategoryId(market.title) === activeCategory;
      return matchesQuery && matchesCategory;
    });
  }, [activeCategory, deferredQuery, markets]);

  if (marketsQuery.isLoading) {
    return <p className="state-text">Loading markets...</p>;
  }

  if (marketsQuery.error) {
    const message = marketsQuery.error instanceof Error ? marketsQuery.error.message : "Unknown error";
    return <p className="state-text state-text--error">{message}</p>;
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

      <div className="category-filters" role="tablist" aria-label="Market categories">
        {availableCategories.map((category) => {
          const selected = category.id === activeCategory;
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`category-filters__item${selected ? " category-filters__item--active" : ""}`}
              onClick={() => setActiveCategory(category.id)}
            >
              {category.label}
            </button>
          );
        })}
      </div>

      <div className="market-list">
        {filteredMarkets.map((market) => (
          <Link
            key={market.id}
            href={`/feed?startAt=${encodeURIComponent(market.id)}`}
            className="market-list__link"
          >
            <article className="market-list__item">
              <p className="market-list__title">{market.title}</p>
              <p className="market-list__meta">
                <span className="chip chip--category">{marketCategoryLabel(inferMarketCategoryId(market.title))}</span>
                <span className="chip chip--yes">YES {formatPercent(market.yesPrice)}</span>
                <span className="chip chip--no">NO {formatPercent(market.noPrice)}</span>
                <span>Ends {formatEndsAt(market.endsAt)}</span>
              </p>
            </article>
          </Link>
        ))}

        {filteredMarkets.length === 0 ? <p className="state-text">No matches found.</p> : null}
      </div>
    </div>
  );
}
