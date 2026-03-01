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

export function AppShell({ title, subtitle, children, scrollContent = false }: AppShellProps) {
  const pathname = usePathname();

  return (
    <main className="app-shell">
      <header className="app-shell__top">
        <div className="segmented-control">
          <Link href="/markets" className={`segmented-control__item ${pathname === "/markets" ? "segmented-control__item--active" : ""}`}>
            Markets
          </Link>
          <Link href="/feed" className={`segmented-control__item ${pathname === "/feed" ? "segmented-control__item--active" : ""}`}>
            Feed
          </Link>
        </div>

        <div className="segmented-control">
          <Link href="/profile" className={`segmented-control__item ${pathname === "/profile" ? "segmented-control__item--active" : ""}`}>
            Profile
          </Link>
        </div>
      </header>

      <section className={`app-shell__content${scrollContent ? " app-shell__content--scroll" : ""}`}>
        {children}
      </section>

      {pathname !== "/feed" && <CustomNavBar />}
    </main>
  );
}
