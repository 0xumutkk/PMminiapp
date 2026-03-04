"use client";

import { AppShell } from "@/components/app-shell";
import { ProfileActivityPanel } from "@/components/profile-activity-panel";
import { PositionsPanel } from "@/components/positions-panel";
import { WalletStatusSlot } from "@/components/wallet-status-slot";
import { ProfileGuard } from "@/components/profile-guard";
import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { useSearchParams } from "next/navigation";
import { useAccount, useBalance } from "wagmi";
import Link from "next/link";
import React, { Suspense } from "react";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

function formatUsd(raw: string | number) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function ProfileContent() {
  const searchParams = useSearchParams();
  const activeView = searchParams?.get("view") === "activity" ? "activity" : "portfolio";
  const { snapshot, loading: positionsLoading } = usePortfolioPositions();
  const { address } = useAccount();

  const { data: usdcBalance, isLoading: balanceLoading } = useBalance({
    address,
    token: USDC_ADDRESS,
  });

  const positionsValue = Number(snapshot?.totals.activeMarketValueUsdc ?? 0);
  const usdcValue = Number(usdcBalance?.formatted ?? 0);
  const totalNetWorth = positionsValue + usdcValue;

  const netWorthFormatted = formatUsd(totalNetWorth);
  const [dollars, cents] = netWorthFormatted.split('.');

  const claimableCount = snapshot?.settled.filter(s => s.claimable).length ?? 0;
  const activeCount = snapshot?.active.length ?? 0;

  return (
    <div className="profileHub" style={{ paddingTop: '140px' }}>
      {/* Header Area */}
      <div className="heroTopSection">
        <span className="controlCenterText">Control Center</span>
        <WalletStatusSlot />
      </div>

      {/* Net Worth Card (Figma 127:3710) */}
      <section className="netWorthCard">
        <div className="netWorthTop">
          <span className="netWorthLabel">Net Worth</span>
          <h1 className="netWorthValue">
            {positionsLoading ? "$..." : dollars}<span className="netWorthDecimals">{cents ? `.${cents}` : ''}</span>
          </h1>
        </div>

        <div className="netWorthStats">
          <div className="statItem">
            <span className="statLabel">Positions</span>
            <span className="statValue">
              {positionsLoading ? "$..." : formatUsd(positionsValue)}
            </span>
          </div>
          <div className="divider" />
          <div className="statItem">
            <span className="statLabel">USDC</span>
            <span className="statValue">
              {balanceLoading ? "$..." : formatUsd(usdcValue)}
            </span>
          </div>
        </div>
      </section>

      <nav className="profileSwitch" aria-label="Profile sections">
        <Link
          href="/profile?view=portfolio"
          className={`profileSwitchItem ${activeView === "portfolio" ? 'profileSwitchItemActive' : ""}`}
        >
          Positions
        </Link>
        <Link
          href="/profile?view=activity"
          className={`profileSwitchItem ${activeView === "activity" ? 'profileSwitchItemActive' : ""}`}
        >
          Activity
        </Link>
      </nav>

      {/* Status Row (Figma 127:3726) */}
      <div className="claimRow">
        <div className="claimCard claimCardFull">
          <span className="claimLabel">Claimable: {positionsLoading ? "$..." : formatUsd(snapshot?.totals.claimableUsdc ?? 0)}</span>
          <span className="claimValue">
            {claimableCount} markets to redeem
          </span>
        </div>
      </div>

      <div className="claimRow">
        <div className={`statCard ${activeCount > 0 ? 'statCardActive' : ''}`}>
          <span className="statCardLabel">Active Markets</span>
          <span className="statCardValue">{activeCount}</span>
        </div>
        <div className="statCard" style={{ opacity: claimableCount > 0 ? 1 : 0.6 }}>
          <span className="statCardLabel">Ready To Redeem</span>
          <span className="statCardValue">{claimableCount}</span>
        </div>
      </div>

      {activeView === "portfolio" ? (
        <PositionsPanel />
      ) : (
        <ProfileActivityPanel />
      )}
    </div>
  );
}

export default function ProfilePage() {
  return (
    <AppShell title="Profile" subtitle="Mobile trading cockpit" scrollContent>
      <ProfileGuard>
        <Suspense fallback={<div className="profileHub" style={{ paddingTop: '140px' }}><div className="netWorthCard">Loading...</div></div>}>
          <ProfileContent />
        </Suspense>
      </ProfileGuard>
    </AppShell>
  );
}
