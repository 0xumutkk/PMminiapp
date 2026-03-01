"use client";

import { MarketSnapshot } from "@/lib/market-types";
import { VerticalMarketFeed } from "@/components/vertical-market-feed";
import { useSearchParams } from "next/navigation";

type FeedPageClientProps = {
  initialSnapshot: MarketSnapshot | null;
};

export function FeedPageClient({ initialSnapshot }: FeedPageClientProps) {
  const searchParams = useSearchParams();
  const startAt = searchParams.get("startAt");

  return (
    <VerticalMarketFeed
      initialSnapshot={initialSnapshot}
      startAtMarketId={startAt}
    />
  );
}
