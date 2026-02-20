import { VerticalMarketFeed } from "@/components/vertical-market-feed";
import { WalletStatus } from "@/components/wallet-status";

export default function HomePage() {
  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Farcaster Mini App</p>
          <h1>Pulse Markets</h1>
        </div>
        <WalletStatus />
      </header>
      <VerticalMarketFeed />
    </main>
  );
}
