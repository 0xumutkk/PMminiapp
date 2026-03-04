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
import { getMarketVibe } from "@/lib/vibe-utils";
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

function formatCompactNumber(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "0";
  }

  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return value.toFixed(0);
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
    // If not loaded yet, just show the core ones
    if (markets.length === 0) return CATEGORY_FILTER_OPTIONS.filter(o => ["all", "crypto", "politics"].includes(o.id));

    const set = new Set<MarketCategoryFilter>(["all"]);
    for (const market of markets) {
      set.add(inferMarketCategoryId(market.title, market.categories, market.tags));
    }

    return CATEGORY_FILTER_OPTIONS.filter((option) => set.has(option.id));
  }, [markets]);

  const filteredMarkets = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();

    return markets.filter((market) => {
      const matchesQuery = !text || market.title.toLowerCase().includes(text);
      const matchesCategory =
        activeCategory === "all" || inferMarketCategoryId(market.title, market.categories, market.tags) === activeCategory;
      return matchesQuery && matchesCategory;
    });
  }, [activeCategory, deferredQuery, markets]);

  return (
    <div className="market-browser">
      {/* Search Bar - Always Visible */}
      <div className="explore-search-bar">
        <div className="explore-search-bar__inset" />
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M14.1667 14.1667L17.5 17.5M15.8333 9.16667C15.8333 12.8486 12.8486 15.8333 9.16667 15.8333C5.48477 15.8333 2.5 12.8486 2.5 9.16667C2.5 5.48477 5.48477 2.5 9.16667 2.5C12.8486 2.5 15.8333 5.48477 15.8333 9.16667Z" stroke="rgba(255,255,255,0.3)" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="SEARCH MARKETS..."
        />
      </div>

      {/* Categories - Always Visible */}
      <div className="explore-categories">
        {availableCategories.map((category) => {
          const selected = category.id === activeCategory;
          return (
            <button
              key={category.id}
              className={`explore-category-chip ${selected ? 'explore-category-chip--active' : ''}`}
              onClick={() => setActiveCategory(category.id)}
            >
              {category.label}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: '20px' }}>
        {marketsQuery.isLoading ? (
          <p className="state-text">Loading markets...</p>
        ) : marketsQuery.error ? (
          <p className="state-text state-text--error">
            {marketsQuery.error instanceof Error ? marketsQuery.error.message : "Unknown error"}
          </p>
        ) : filteredMarkets.length === 0 ? (
          <p className="state-text">No matches found.</p>
        ) : (
          filteredMarkets.map((market) => (
            <Link
              key={market.id}
              href={`/feed?startAt=${encodeURIComponent(market.id)}`}
              className="explore-card"
            >
              <div className="explore-card__inset-shadow" />
              <div className="explore-card__header">
                <img
                  src={market.imageUrl || "/icon.png"}
                  className="explore-card__token"
                  alt=""
                />
                <div className="explore-card__title-row">
                  <h3 className="explore-card__title">{market.title}</h3>
                  <span className="explore-card__prob">{formatPercent(market.yesPrice)}</span>
                </div>
              </div>

              <div className="explore-card__stats">
                <div className="explore-card__trending">
                  <span>{marketCategoryLabel(inferMarketCategoryId(market.title, market.categories, market.tags))}</span>
                </div>

                <div className="explore-card__stat-pill">
                  <span className="explore-card__stat-label">Ends In</span>
                  <span className="explore-card__stat-value">{formatEndsAt(market.endsAt)}</span>
                </div>

                <div className="explore-card__stat-pill">
                  <span className="explore-card__stat-label">Volume</span>
                  <span className="explore-card__stat-value">${formatCompactNumber(market.volume24h)}</span>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
