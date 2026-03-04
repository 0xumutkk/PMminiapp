"use client";

import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
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

function parseProbability(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return null;
  }

  return parsed;
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

export function PositionsPanel() {
  const { executeIntent, isBusy, isConnected, state, statusLabel } = useTradeExecutor();
  const { account, isAuthenticated, snapshot, loading, error: queryError, refetch } = usePortfolioPositions();
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const error = interactionError ?? queryError;

  useEffect(() => {
    if (!account || !isAuthenticated) return;
    const onRefresh = () => { void refetch(); };
    window.addEventListener(REFRESH_EVENT_NAME, onRefresh);
    return () => { window.removeEventListener(REFRESH_EVENT_NAME, onRefresh); };
  }, [account, isAuthenticated, refetch]);

  const activePositions = useMemo(() => snapshot?.active ?? [], [snapshot?.active]);
  const claimableSettledPositions = useMemo(() => snapshot?.settled.filter((item) => item.claimable) ?? [], [snapshot?.settled]);

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

  return (
    <section className="positions-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {error && <p style={{ color: '#dc2626', fontSize: '12px', padding: '0 4px' }}>{error}</p>}

      {activePositions.length > 0 ? (
        activePositions.map((position) => {
          const prob = parseProbability(position.currentPrice);
          const probText = prob ? `${(prob * 100).toFixed(1)}%` : "--";
          const isRedPnL = Number(position.unrealizedPnlUsdc) < 0;

          return (
            <div key={position.id} className="positionDetailCard">
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
                      <span className="posVal valGreen">{formatUsd(position.marketValueUsdc)}</span>
                    </div>
                    <div className="statBox">
                      <span className="posLabel">PNL</span>
                      <span className={`posVal ${isRedPnL ? 'valRed' : 'valGreen'}`}>
                        {isRedPnL ? '' : '+'}{formatUsd(position.unrealizedPnlUsdc)}
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
                  onClick={() => void onSell(position)}
                  disabled={!isConnected || isBusy || activeActionId === position.id}
                >
                  {activeActionId === position.id ? "Selling..." : "Cash Out"}
                </button>
              </div>
            </div>
          );
        })
      ) : (
        <p style={{ opacity: 0.6, fontSize: '13px', padding: '12px 4px' }}>No active positions yet.</p>
      )}

      {claimableSettledPositions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p className="posLabel" style={{ paddingLeft: '4px' }}>Claimable settlements</p>
          {claimableSettledPositions.map((position) => (
            <div key={position.id} className="positionDetailCard">
              <div className="posContent">
                <header className="posHeader">
                  <div className="marketAvatar" style={{ background: '#0bd52d', color: '#000' }}>💰</div>
                  <div className="marketTitleBlock">
                    <span className="marketName">{position.marketTitle}</span>
                  </div>
                </header>
                <div className="statBox">
                  <p className="posLabel">Payout</p>
                  <p className="posVal valGreen">{formatUsd(position.marketValueUsdc)}</p>
                </div>
              </div>
              <div className="actionArea">
                <button
                  type="button"
                  className="cashOutBtn"
                  onClick={() => void onRedeem(position)}
                  disabled={!isConnected || isBusy || activeActionId === position.id}
                >
                  {activeActionId === position.id ? "Redeeming..." : "Redeem Now"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
