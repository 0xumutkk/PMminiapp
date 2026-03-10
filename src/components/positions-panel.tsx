"use client";

import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import { filterVisibleActivePositions } from "@/lib/portfolio/visible-active-positions";
import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { useTradeExecutor } from "@/lib/trade/use-trade-executor";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_EVENT_NAME = "positions:refresh";
const DEFAULT_SELL_MAX_SLIPPAGE_BPS = 200;

type ActivePosition = PortfolioPositionsSnapshot["active"][number];

function formatUsd(raw: string | number) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return "$0.00";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatOptionalUsd(raw: string | number, enabled: boolean) {
  return enabled ? formatUsd(raw) : "--";
}

function parseProbability(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return null;
  }

  return parsed;
}

function buildFeedHref(marketId: string) {
  const params = new URLSearchParams({ startAt: marketId });
  return `/feed?${params.toString()}`;
}

async function resolveSellExpectedPrice(position: ActivePosition) {
  const embeddedPrice = parseProbability(position.currentPrice);
  if (embeddedPrice !== null) return embeddedPrice;

  const candidates = [...new Set([position.marketSlug, position.marketId].filter((item) => item.length > 0))];
  for (const marketId of candidates) {
    const response = await fetch(`/api/markets/${encodeURIComponent(marketId)}`, { cache: "no-store", credentials: "include" });
    const body = (await response.json().catch(() => null));
    if (!response.ok || !body || body.error) continue;
    const expectedPrice = parseProbability(position.side === "yes" ? body.yesPrice : body.noPrice);
    if (expectedPrice !== null) return expectedPrice;
  }
  throw new Error("Could not resolve current market price for sell.");
}

interface PositionsPanelProps {
  filter?: "active" | "closed" | "redeem";
}

export function PositionsPanel({ filter = "active" }: PositionsPanelProps) {
  const { executeIntent, isBusy, isConnected, state, statusLabel } = useTradeExecutor();
  const { account, isAuthenticated, snapshot, loading, error: queryError, refetch } = usePortfolioPositions();
  const router = useRouter();
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const error = interactionError ?? queryError;

  useEffect(() => {
    if (!account || !isAuthenticated) return;
    const onRefresh = () => { void refetch(); };
    window.addEventListener(REFRESH_EVENT_NAME, onRefresh);
    return () => { window.removeEventListener(REFRESH_EVENT_NAME, onRefresh); };
  }, [account, isAuthenticated, refetch]);

  const activePositions = useMemo(
    () => filterVisibleActivePositions(snapshot?.active ?? [], snapshot?.settled ?? []),
    [snapshot?.active, snapshot?.settled]
  );
  const closedPositions = useMemo(() => snapshot?.settled.filter((item) => !item.claimable) ?? [], [snapshot?.settled]);
  const claimableSettledPositions = useMemo(() => snapshot?.settled.filter((item) => item.claimable) ?? [], [snapshot?.settled]);

  useEffect(() => {
    if (!loading && activePositions.length > 0 && typeof window !== 'undefined') {
      const hash = window.location.hash;
      if (hash && hash.startsWith('#market-')) {
        // Wait a tick for DOM to be stable
        const timer = setTimeout(() => {
          const el = document.getElementById(hash.slice(1));
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Add a temporary highlight effect
            el.style.transition = 'background-color 0.5s ease';
            const originalBg = el.style.backgroundColor;
            el.style.backgroundColor = 'rgba(11, 213, 45, 0.1)';
            setTimeout(() => {
              el.style.backgroundColor = originalBg;
            }, 2000);
          }
        }, 300);
        return () => clearTimeout(timer);
      }
    }
  }, [loading, activePositions, filter]);

  const onSell = useCallback(async (position: ActivePosition) => {
    if (!isConnected || !account) return;
    setActiveActionId(position.id);
    try {
      setInteractionError(null);
      const expectedPrice = await resolveSellExpectedPrice(position);
      await executeIntent({
        action: "sell",
        marketId: position.marketSlug || position.marketId,
        side: position.side,
        amountUsdc: Number(position.marketValueUsdc) > 0 ? position.marketValueUsdc : "1",
        expectedPrice,
        maxSlippageBps: DEFAULT_SELL_MAX_SLIPPAGE_BPS
      });
    } catch (e) {
      setInteractionError(e instanceof Error ? e.message : "Sell failed");
    } finally {
      setActiveActionId(null);
    }
  }, [account, executeIntent, isConnected]);

  const onRedeem = useCallback(async (position: PortfolioPositionsSnapshot["settled"][number]) => {
    if (!isConnected || !account) return;
    setActiveActionId(position.id);
    try {
      await executeIntent({
        action: "redeem",
        marketId: position.marketSlug || position.marketId,
        side: position.side,
        amountUsdc: position.marketValueUsdc
      });
    } finally {
      setActiveActionId(null);
    }
  }, [account, executeIntent, isConnected]);

  if (!isAuthenticated || !account) return null;

  if (filter === "active") {
    return (
      <section className="positions-panel" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {error && <p style={{ color: '#dc2626', fontSize: '12px', padding: '0 4px' }}>{error}</p>}
        {activePositions.length > 0 ? (
          activePositions.map((position) => {
            const prob = parseProbability(position.currentPrice);
            const probText = prob ? `${(prob * 100).toFixed(1)}%` : "--";
            const isRedPnL = Number(position.unrealizedPnlUsdc) < 0;
            const hasVerifiedPricing = position.hasVerifiedPricing === true;

            return (
              <div
                key={position.id}
                id={`market-${position.marketId}`}
                className="positionDetailCard"
                style={{ cursor: 'pointer' }}
                onClick={() => router.push(buildFeedHref(position.marketSlug || position.marketId) as any)}
              >
                <div className="posContent">
                  <header className="posHeader">
                    <div className="marketAvatar">
                      {position.side === 'yes' ? '👍' : '👎'}
                    </div>
                    <div className="marketTitleBlock">
                      <span className="marketName">{position.marketTitle}</span>
                      <span className="marketProb">{probText}</span>
                    </div>
                  </header>

                  <div className="posStatsGrid">
                    <div className="statRow">
                      <div className="statBox">
                        <span className="posLabel">Worth</span>
                        <span className="posVal valGreen">{formatOptionalUsd(position.marketValueUsdc, hasVerifiedPricing)}</span>
                      </div>
                      <div className="statBox">
                        <span className="posLabel">PNL</span>
                        <span className={`posVal ${isRedPnL ? 'valRed' : 'valGreen'}`}>
                          {hasVerifiedPricing ? `${isRedPnL ? '' : '+'}${formatUsd(position.unrealizedPnlUsdc)}` : "--"}
                        </span>
                      </div>
                    </div>
                    <div className="statRow">
                      <div className="statBox">
                        <span className="posLabel">Holdings</span>
                        <span className="posVal valWhite">
                          {Number(position.tokenBalance).toLocaleString()} {position.side.toUpperCase()} Shares
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="actionArea">
                  <button
                    type="button"
                    className="cashOutBtn"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onSell(position);
                    }}
                    disabled={!isConnected || isBusy || activeActionId === position.id}
                  >
                    {activeActionId === position.id ? "Selling..." : "Cash Out"}
                  </button>
                </div>
              </div>
            )
          })
        ) : (
          <p style={{ opacity: 0.6, fontSize: '13px', padding: '12px 4px' }}>No active positions yet.</p>
        )}
      </section>
    );
  }

  // ── CLOSED (kaybedilen, zaten çekilmiş veya satılmış) ─────────────────────────────
  if (filter === "closed") {
    return (
      <section className="positions-panel" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {error && <p style={{ color: '#dc2626', fontSize: '12px', padding: '0 4px' }}>{error}</p>}
        {closedPositions.length > 0 ? (
          closedPositions.map((position) => {
            const isRedeemed = Number(position.currentPrice) > 0 && Number(position.tokenBalance) === 0 && position.status === "settled" && !(position as any).isSold;
            const isSold = (position as any).isSold;
            const isLost = !isRedeemed && !isSold && Number(position.currentPrice) === 0;

            const badgeColor = isRedeemed ? '#0bd52d' : isSold ? '#fc0' : '#ff3b6b';
            const badgeBg = isRedeemed ? 'rgba(11, 213, 45, 0.15)' : isSold ? 'rgba(255, 204, 0, 0.15)' : 'rgba(255, 59, 107, 0.15)';
            const badgeLabel = isRedeemed ? 'RECLAIMED ✓' : isSold ? 'CASHED OUT ⟲' : 'LOST ✗';

            const realizedPnlNum = Number(position.realizedPnlUsdc) || 0;
            const isRedRealizedPnl = realizedPnlNum <= 0;

            return (
              <div key={position.id} className="positionDetailCard" style={{ borderColor: isRedeemed ? 'rgba(11, 213, 45, 0.2)' : isSold ? 'rgba(255, 204, 0, 0.2)' : 'rgba(255, 59, 107, 0.2)' }}>
                <div className="posContent">
                  <header className="posHeader">
                    <div className="marketAvatar" style={{
                      background: isRedeemed ? 'rgba(11, 213, 45, 0.1)' : isSold ? 'rgba(255, 204, 0, 0.1)' : 'rgba(255, 59, 107, 0.1)',
                      borderColor: badgeColor
                    }}>
                      {isRedeemed ? '🏆' : isSold ? '💰' : (position.side === 'yes' ? '👍' : '👎')}
                    </div>
                    <div className="marketTitleBlock">
                      <span className="marketName">{position.marketTitle}</span>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        {position.endsAt && (
                          <span style={{
                            fontSize: '10px',
                            color: 'rgba(255,255,255,0.4)',
                            fontWeight: '700',
                            marginRight: '4px'
                          }}>
                            Ended {new Date(position.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                        <span style={{
                          fontSize: '11px',
                          fontWeight: '700',
                          padding: '3px 8px',
                          borderRadius: '999px',
                          background: badgeBg,
                          color: badgeColor,
                          border: `1px solid ${badgeColor}4D`
                        }}>
                          {badgeLabel}
                        </span>
                      </div>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textAlign: 'right' }}>{position.side.toUpperCase()}</span>
                    </div>
                  </header>
                  <div className="posStatsGrid">
                    <div className="statRow">
                      <div className="statBox">
                        <span className="posLabel">Result</span>
                        <span className="posVal" style={{ color: badgeColor }}>
                          {isRedeemed ? 'Won' : isSold ? 'Sold' : 'Lost'}
                        </span>
                      </div>
                      <div className="statBox">
                        <span className="posLabel">PNL</span>
                        <span className={`posVal ${isRedRealizedPnl ? (realizedPnlNum === 0 ? 'valWhite' : 'valRed') : 'valGreen'}`}>
                          {realizedPnlNum > 0 ? '+' : ''}{formatUsd(position.realizedPnlUsdc)}
                        </span>
                      </div>
                      <div className="statBox">
                        <span className="posLabel">{isSold ? 'Sold' : 'Holdings'}</span>
                        <span className="posVal valWhite" style={{ fontSize: '14px' }}>
                          {Number(position.tokenBalance).toLocaleString()} Shares
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="actionArea">
                  <div className={isRedeemed ? "wonBtn" : isSold ? "soldBtn" : "lostBtn"}>
                    <span>{isRedeemed ? "Winnings Collected" : isSold ? "Position Sold" : "Position Closed — Better Luck Next Time"}</span>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <p style={{ opacity: 0.6, fontSize: '13px', padding: '12px 4px' }}>No history yet.</p>
        )}
      </section>
    );
  }

  // ── READY TO REDEEM (kazanılan – claimable) ─────────────────────────────
  return (
    <section className="positions-panel" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {error && <p style={{ color: '#dc2626', fontSize: '12px', padding: '0 4px' }}>{error}</p>}
      {claimableSettledPositions.length > 0 ? (
        claimableSettledPositions.map((position) => (
          <div key={position.id} className="positionDetailCard" style={{ borderColor: 'rgba(11, 213, 45, 0.3)' }}>
            <div className="posContent">
              <header className="posHeader">
                <div className="marketAvatar" style={{ background: 'rgba(11, 213, 45, 0.1)', borderColor: 'rgba(11, 213, 45, 0.3)' }}>
                  🏆
                </div>
                <div className="marketTitleBlock">
                  <span className="marketName">{position.marketTitle}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      {position.endsAt && (
                        <span style={{
                          fontSize: '10px',
                          color: 'rgba(255,255,255,0.4)',
                          fontWeight: '700',
                          marginRight: '4px'
                        }}>
                          Ended {new Date(position.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                      <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '999px', background: 'rgba(11, 213, 45, 0.15)', color: '#0bd52d', border: '1px solid rgba(11, 213, 45, 0.3)' }}>
                        WON ✓
                      </span>
                    </div>
                    <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>{position.side.toUpperCase()}</span>
                  </div>
                </div>
              </header>
              <div className="posStatsGrid">
                <div className="statRow">
                  <div className="statBox">
                    <span className="posLabel">Return</span>
                    <span className="posVal valGreen">{formatUsd(position.marketValueUsdc)}</span>
                  </div>
                  <div className="statBox">
                    <span className="posLabel">Holdings</span>
                    <span className="posVal valWhite" style={{ fontSize: '14px' }}>
                      {Number(position.tokenBalance).toLocaleString()} Shares
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="actionArea">
              <button
                type="button"
                className="redeemBtn"
                onClick={() => void onRedeem(position)}
                disabled={!isConnected || isBusy || activeActionId === position.id}
              >
                {activeActionId === position.id ? "Redeeming..." : "Redeem Winnings"}
              </button>
            </div>
          </div>
        ))
      ) : (
        <p style={{ opacity: 0.6, fontSize: '13px', padding: '12px 4px' }}>Nothing ready to redeem.</p>
      )}
    </section>
  );
}
