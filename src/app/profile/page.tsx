"use client";

import { AppShell } from "@/components/app-shell";
import { PositionsPanel } from "@/components/positions-panel";
import { WalletStatusSlot } from "@/components/wallet-status-slot";
import { ProfileGuard } from "@/components/profile-guard";
import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { filterVisibleActivePositions } from "@/lib/portfolio/visible-active-positions";
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
  const [subView, setSubView] = React.useState<"active" | "closed" | "redeem">("active");
  const { snapshot, loading: positionsLoading, refetch: refetchPositions } = usePortfolioPositions();
  const { address } = useAccount();

  const { data: usdcBalance, isLoading: balanceLoading, refetch: refetchBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
  });

  const [isPulling, setIsPulling] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [pullDistance, setPullDistance] = React.useState(0);
  const startY = React.useRef(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const runRefresh = React.useCallback(async () => {
    if (isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    try {
      await Promise.all([
        refetchPositions(),
        refetchBalance(),
        new Promise((resolve) => setTimeout(resolve, 800))
      ]);
    } catch (err) {
      console.error("Refresh failed", err);
    } finally {
      setIsRefreshing(false);
      setPullDistance(0);
    }
  }, [isRefreshing, refetchBalance, refetchPositions]);

  const handleTouchStart = (e: React.TouchEvent) => {
    // Use container's scrollTop if possible, fallback to window.scrollY
    const scrollTop = containerRef.current?.closest('.app-shell__content')?.scrollTop ?? window.scrollY;
    if (scrollTop <= 1) {
      startY.current = e.touches[0].clientY;
      setIsPulling(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isPulling || isRefreshing) return;
    const y = e.touches[0].clientY;
    const distance = y - startY.current;

    // Only pull if moving downwards
    if (distance > 0) {
      // Damping effect
      setPullDistance(Math.min(distance * 0.4, 100));
    } else {
      setPullDistance(0);
    }
  };

  const handleTouchEnd = async () => {
    if (!isPulling) return;
    setIsPulling(false);

    if (pullDistance > 60) {
      setPullDistance(50); // Snap to loading height
      await runRefresh();
    } else {
      setPullDistance(0);
    }
  };

  const positionsValue = Number(snapshot?.totals.activeMarketValueUsdc ?? 0);
  const usdcValue = Number(usdcBalance?.formatted ?? 0);
  const totalNetWorth = positionsValue + usdcValue;

  const netWorthFormatted = formatUsd(totalNetWorth);
  const [dollars, cents] = netWorthFormatted.split('.');

  const claimableCount = snapshot?.settled.filter(s => s.claimable).length ?? 0;
  const closedCount = snapshot?.settled.filter(s => !s.claimable).length ?? 0;
  const activeCount = filterVisibleActivePositions(snapshot?.active ?? [], snapshot?.settled ?? []).length;

  return (
    <div
      ref={containerRef}
      className="profileHub"
      style={{
        paddingTop: '80px',
        transform: `translateY(${pullDistance}px)`,
        transition: isPulling ? 'none' : 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        minHeight: '100%',
        willChange: 'transform'
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull to refresh indicator */}
      {(pullDistance > 0 || isRefreshing) && (
        <div style={{
          position: 'absolute',
          top: '-40px',
          left: '0',
          right: '0',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '40px',
          opacity: Math.min(pullDistance / 50, 1),
          transform: `scale(${Math.min(pullDistance / 50, 1)})`,
          transition: isPulling ? 'none' : 'all 0.3s ease',
        }}>
          {isRefreshing ? (
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff', animation: 'blink 1.4s infinite cubic-bezier(0.2, 0.8, 0.2, 1) both' }}></div>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff', animation: 'blink 1.4s infinite cubic-bezier(0.2, 0.8, 0.2, 1) both', animationDelay: '0.2s' }}></div>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff', animation: 'blink 1.4s infinite cubic-bezier(0.2, 0.8, 0.2, 1) both', animationDelay: '0.4s' }}></div>
            </div>
          ) : (
            <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.7)', fontWeight: 'bold' }}>
              {pullDistance > 60 ? '↓ Release to Refresh' : '↓ Pull to Refresh'}
            </span>
          )}
        </div>
      )}

      {/* Net Worth Card (Figma 127:3710) */}
      <section className="netWorthCard" style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => { void runRefresh(); }}
          disabled={isRefreshing}
          aria-label="Refresh profile balances"
          style={{
            position: 'absolute',
            top: '14px',
            right: '14px',
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(255,255,255,0.06)',
            color: 'rgba(255,255,255,0.92)',
            borderRadius: '999px',
            padding: '8px 12px',
            fontSize: '12px',
            fontWeight: '700',
            lineHeight: 1,
            cursor: isRefreshing ? 'default' : 'pointer',
            opacity: isRefreshing ? 0.6 : 1
          }}
        >
          {isRefreshing ? 'Refreshing' : 'Refresh'}
        </button>
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
                {claimableCount > 0
                  ? `${claimableCount} markets to redeem · ${closedCount} lost`
                  : closedCount > 0
                    ? `${closedCount} closed positions — view history`
                    : 'No settled positions yet'
                }
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

      {/* Nav Tabs (2+1 kolumlu) */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch' }}>
        {/* Sol: 2 küçük buton üst üste */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div
            className={`statCard ${subView === 'active' ? 'statCardSelected' : ''}`}
            style={{ flex: 'unset', padding: '10px 12px', gap: '4px' }}
            onClick={() => setSubView('active')}
          >
            <span className="statCardLabel">Active Positions</span>
            <span className="statCardValue" style={{ fontSize: '15px' }}>{activeCount}</span>
          </div>
          <div
            className={`statCard ${subView === 'closed' ? 'statCardSelected' : ''}`}
            style={{ flex: 'unset', padding: '10px 12px', gap: '4px' }}
            onClick={() => setSubView('closed')}
          >
            <span className="statCardLabel">History</span>
            <span className="statCardValue" style={{ fontSize: '15px' }}>{closedCount}</span>
          </div>
        </div>

        {/* Sağ: tek büyük Ready to Redeem butonu */}
        <div
          className={`statCard ${subView === 'redeem' ? 'statCardSelected' : ''}`}
          style={{ flex: 1, position: 'relative' }}
          onClick={() => setSubView('redeem')}
        >
          {claimableCount > 0 && (
            <span style={{
              position: 'absolute',
              top: '10px',
              right: '10px',
              background: '#0bd52d',
              color: '#000',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: '800',
              padding: '2px 7px',
              lineHeight: '1.4'
            }}>{claimableCount}</span>
          )}
          <span className="statCardLabel">Ready to{`\n`}Redeem</span>
          <span className="statCardValue" style={{ color: claimableCount > 0 ? '#0bd52d' : undefined }}>
            {formatUsd(snapshot?.totals.claimableUsdc ?? 0)}
          </span>
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
