"use client";

import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { CustomNavBar } from "@/components/custom-nav-bar";
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
      <header className="app-shell__top" style={{ padding: '20px', background: 'transparent' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <div className="segmented-control" style={{ width: 'auto', gap: '0' }}>
            <Link
              href="/markets"
              className={`segmented-control__item ${pathname === "/markets" ? "segmented-control__item--active" : ""}`}
              style={{ width: '106.5px' }}
            >
              Markets
            </Link>
            <Link
              href="/feed"
              className={`segmented-control__item ${pathname === "/feed" ? "segmented-control__item--active" : ""}`}
              style={{ width: '106.5px' }}
            >
              Feed
            </Link>
          </div>

          <div className="segmented-control" style={{ width: 'auto' }}>
            <Link
              href="/profile"
              className={`segmented-control__item ${pathname === "/profile" ? "segmented-control__item--active" : ""}`}
              style={{ width: '106.5px', color: 'white' }}
            >
              {isConnected ? "Profile" : "Connect"}
            </Link>
          </div>
        </div>
      </header>

      <section className={`app-shell__content${scrollContent ? " app-shell__content--scroll" : ""}`}>
        {children}
      </section>

      {pathname !== "/feed" && <CustomNavBar />}
    </main>
  );
}
