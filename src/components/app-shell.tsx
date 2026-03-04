"use client";

import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { WalletStatusSlot } from "@/components/wallet-status-slot";

type AppShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scrollContent?: boolean;
};

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAccount } from "wagmi";

export function AppShell({ title, subtitle, children, scrollContent = false }: AppShellProps) {
  const pathname = usePathname();
  const { isConnected } = useAccount();

  return (
    <main className="app-shell">
      <header className="app-shell__top">
        <div style={{ width: '100%', height: '54px' }} /> {/* Status bar space */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          width: '100%',
          alignItems: 'center',
          padding: '0 20px',
          height: '84px'
        }}>
          <div className="segmented-control">
            <Link
              href="/markets"
              className={`segmented-control__item ${pathname === "/markets" ? "segmented-control__item--active" : ""}`}
            >
              Markets
            </Link>
            <Link
              href="/feed"
              className={`segmented-control__item ${pathname === "/feed" ? "segmented-control__item--active" : ""}`}
            >
              Feed
            </Link>
          </div>

          <div className="segmented-control">
            <Link
              href="/profile"
              className={`segmented-control__item ${pathname === "/profile" ? "segmented-control__item--active" : ""}`}
            >
              {isConnected ? "Profile" : "Connect"}
            </Link>
          </div>
        </div>
      </header>

      <section className={`app-shell__content${scrollContent ? " app-shell__content--scroll" : ""}`}>
        {children}
      </section>
    </main>
  );
}
