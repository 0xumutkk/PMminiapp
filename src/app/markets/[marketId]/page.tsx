import { AppShell } from "@/components/app-shell";
import { MarketDetailView } from "@/components/market-detail-view";

type MarketDetailPageProps = {
  params: Promise<{
    marketId: string;
  }>;
};

export default async function MarketDetailPage({ params }: MarketDetailPageProps) {
  const { marketId } = await params;

  return (
    <AppShell title="Market View" subtitle="Feed-style market preview">
      <MarketDetailView marketId={marketId} />
    </AppShell>
  );
}
