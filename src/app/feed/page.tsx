import { AppShell } from "@/components/app-shell";
import { VerticalMarketFeed } from "@/components/vertical-market-feed";

export default function FeedPage() {
  return (
    <AppShell title="Pulse Markets">
      <VerticalMarketFeed />
    </AppShell>
  );
}
