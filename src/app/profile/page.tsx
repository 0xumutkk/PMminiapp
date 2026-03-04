"use client";

import { AppShell } from "@/components/app-shell";
import { PositionsPanel } from "@/components/positions-panel";
import { WalletStatusSlot } from "@/components/wallet-status-slot";
import { ProfileGuard } from "@/components/profile-guard";
import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { useAccount, useBalance } from "wagmi";
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
  const [subView, setSubView] = React.useState<"active" | "redeem">("active");
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
    <div className="profileHub" style={{ paddingTop: '110px' }}>
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

      <div className="profileSwitch">
        <div className="profileSwitchItem profileSwitchItemActive">
          Positions
        </div>
      </div>

      {/* Status Row (Figma 127:3726) */}
      <div className="claimRow">
        <div className="claimCard claimCardFull">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span className="claimLabel">Claimable: {positionsLoading ? "$..." : formatUsd(snapshot?.totals.claimableUsdc ?? 0)}</span>
              <span className="claimValue">
                {claimableCount} markets to redeem
              </span>
            </div>
            {claimableCount > 0 && subView !== 'redeem' && (
              <button
                onClick={() => setSubView('redeem')}
                className="redeemViewBtn"
                style={{
                  background: '#0bd52d',
                  color: '#000',
                  border: 'none',
                  borderRadius: '12px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                View
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="claimRow">
        <div
          className={`statCard ${subView === 'active' ? 'statCardSelected' : ''}`}
          onClick={() => setSubView('active')}
        >
          <span className="statCardLabel">Active Markets</span>
          <span className="statCardValue">{activeCount}</span>
        </div>
        <div
          className={`statCard ${subView === 'redeem' ? 'statCardSelected' : ''}`}
          onClick={() => setSubView('redeem')}
        >
          <span className="statCardLabel">Ready To Redeem</span>
          <span className="statCardValue">{claimableCount}</span>
        </div>
      </div>

      <PositionsPanel filter={subView} />
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
