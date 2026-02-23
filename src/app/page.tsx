import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { VerticalMarketFeed } from "@/components/vertical-market-feed";
import { WalletStatus } from "@/components/wallet-status";

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 10.6L12 3l9 7.6V21h-6.2v-6.4h-5.6V21H3z" />
    </svg>
  );
}

function FeedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 4h16v16H4z" />
      <path d="M9 8l8 4-8 4z" fill="#05070d" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M7 3h10v3.5A5 5 0 0 1 12 11 5 5 0 0 1 7 6.5z" />
      <path d="M9.2 11.2V14H6.6v2.4h10.8V14h-2.6v-2.8z" />
      <path d="M7 5H4.3A2.3 2.3 0 0 0 7 8.6zM17 5h2.7A2.3 2.3 0 0 1 17 8.6z" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 12a4.4 4.4 0 1 0-4.4-4.4A4.4 4.4 0 0 0 12 12zM4 20a7.4 7.4 0 0 1 16 0z" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <main className="page">
      <header className="miniapp-shell">
        <div className="miniapp-shell__identity">
          <p className="miniapp-shell__title">Pulse Markets</p>
          <MiniAppContextBadge />
        </div>
        <WalletStatus />
      </header>

      <VerticalMarketFeed />

      <nav className="bottom-nav" aria-label="Primary navigation">
        <button className="bottom-nav__item" type="button" aria-current="false">
          <HomeIcon />
          <span>Home</span>
        </button>
        <button className="bottom-nav__item bottom-nav__item--active" type="button" aria-current="page">
          <FeedIcon />
          <span>Feed</span>
        </button>
        <button className="bottom-nav__fab" type="button" aria-label="Create market">
          <PlusIcon />
        </button>
        <button className="bottom-nav__item" type="button" aria-current="false">
          <TrophyIcon />
          <span>Ranking</span>
        </button>
        <button className="bottom-nav__item" type="button" aria-current="false">
          <ProfileIcon />
          <span>Profile</span>
        </button>
      </nav>
    </main>
  );
}
