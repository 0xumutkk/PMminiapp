import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { FeedPageClient } from "@/components/feed-page-client";
import { getMarketIndexer } from "@/lib/indexer";
import type { MarketSnapshot } from "@/lib/market-types";

export const dynamic = "force-dynamic";

async function loadInitialSnapshot(): Promise<MarketSnapshot | null> {
  try {
    const indexer = await getMarketIndexer();
    const snapshot = await indexer.getSnapshot();
    return snapshot ?? null;
  } catch {
    return null;
  }
}

export default async function FeedPage() {
  const initialSnapshot = await loadInitialSnapshot();

  return (
    <AppShell title="Swipen">
      <Suspense fallback={<section className="feed-loading">Loading markets...</section>}>
        <FeedPageClient initialSnapshot={initialSnapshot} />
      </Suspense>
    </AppShell>
  );
}
