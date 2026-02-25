import { AppShell } from "@/components/app-shell";
import { MarketsBrowser } from "@/components/markets-browser";

export default function MarketsPage() {
  return (
    <AppShell title="Market Explorer" subtitle="Search and compare active markets" scrollContent>
      <MarketsBrowser />
    </AppShell>
  );
}
