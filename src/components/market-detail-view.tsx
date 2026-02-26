"use client";

import { useQuery } from "@tanstack/react-query";
import type { Market } from "@/lib/market-types";
import { MarketCard } from "@/components/market-card";

type MarketDetailViewProps = {
  marketId: string;
};

async function fetchMarketById(marketId: string): Promise<Market> {
  const response = await fetch(`/api/markets/${encodeURIComponent(marketId)}`, {
    cache: "no-store"
  });

  const body = (await response.json().catch(() => null)) as Market | { error?: string } | null;
  if (!response.ok || !body || ("error" in body && body.error)) {
    const message =
      body && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to load market (${response.status})`;
    throw new Error(message);
  }

  return body as Market;
}

export function MarketDetailView({ marketId }: MarketDetailViewProps) {
  const marketQuery = useQuery({
    queryKey: ["markets", "detail", marketId],
    queryFn: () => fetchMarketById(marketId)
  });

  if (marketQuery.isLoading) {
    return <p className="state-text">Loading market...</p>;
  }

  if (marketQuery.error || !marketQuery.data) {
    const message = marketQuery.error instanceof Error ? marketQuery.error.message : "Market not found.";
    return <p className="state-text state-text--error">{message}</p>;
  }

  return (
    <div className="market-preview">
      <MarketCard market={marketQuery.data} isActive />
    </div>
  );
}
