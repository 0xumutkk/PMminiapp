import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { VerticalMarketFeed } from "@/components/vertical-market-feed";
import { WalletStatus } from "@/components/wallet-status";

export default function HomePage() {
  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Base Mini App</p>
          <h1>Pulse Markets</h1>
          <MiniAppContextBadge />
        </div>
        <WalletStatus />
      </header>
      <VerticalMarketFeed />
    </main>
  );
}
