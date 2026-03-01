"use client";

import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { useTradeExecutor } from "@/lib/trade/use-trade-executor";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_EVENT_NAME = "positions:refresh";
const DEFAULT_SELL_MAX_SLIPPAGE_BPS = 200;

type ActivePosition = PortfolioPositionsSnapshot["active"][number];

function formatUsd(raw: string) {
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
  // Fast path: on-chain positions carry the current price directly.
  const embeddedPrice = parseProbability(position.currentPrice);
  if (embeddedPrice !== null) {
    return embeddedPrice;
  }

  // Slow path: look up current price from the market API.
  const candidates = [...new Set([position.marketSlug, position.marketId].filter((item) => item.length > 0))];

  for (const marketId of candidates) {
    const response = await fetch(`/api/markets/${encodeURIComponent(marketId)}`, {
      cache: "no-store",
      credentials: "include"
    });
    const body = (await response.json().catch(() => null)) as
      | {
        yesPrice?: unknown;
        noPrice?: unknown;
        error?: string;
      }
      | null;

    if (!response.ok || !body || (typeof body.error === "string" && body.error.length > 0)) {
      continue;
    }

    const expectedPrice = parseProbability(position.side === "yes" ? body.yesPrice : body.noPrice);
    if (expectedPrice !== null) {
      return expectedPrice;
    }
  }

  throw new Error("Could not resolve current market price for sell. Please refresh and try again.");
}

export function PositionsPanel() {
  const { executeIntent, isBusy, isConnected, state, statusLabel } = useTradeExecutor();
  const { account, isAuthenticated, snapshot, loading, error: queryError, refetch } = usePortfolioPositions();
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const router = useRouter();
  const error = interactionError ?? queryError;

  useEffect(() => {
    if (!account || !isAuthenticated) {
      return;
    }

    const onRefresh = () => {
      void refetch();
    };

    window.addEventListener(REFRESH_EVENT_NAME, onRefresh);

    return () => {
      window.removeEventListener(REFRESH_EVENT_NAME, onRefresh);
    };
  }, [account, isAuthenticated, refetch]);

  const activePositions = useMemo(() => snapshot?.active ?? [], [snapshot?.active]);
  const claimableSettledPositions = useMemo(
    () => snapshot?.settled.filter((item) => item.claimable) ?? [],
    [snapshot?.settled]
  );
  const claimableCount = snapshot?.settled.filter((item) => item.claimable).length ?? 0;

  const onSell = useCallback(
    async (position: ActivePosition) => {
      if (!isConnected || !account) {
        return;
      }

      setActiveActionId(position.id);
      const amountUsdc = Number(position.marketValueUsdc) > 0 ? position.marketValueUsdc : "1";
      try {
        setInteractionError(null);
        const expectedPrice = await resolveSellExpectedPrice(position);
        await executeIntent({
          action: "sell",
          marketId: position.marketSlug || position.marketId,
          side: position.side,
          amountUsdc,
          expectedPrice,
          maxSlippageBps: DEFAULT_SELL_MAX_SLIPPAGE_BPS
        });
      } catch (sellError) {
        const message = sellError instanceof Error ? sellError.message : "Sell request failed";
        setInteractionError(message);
      } finally {
        setActiveActionId(null);
      }
    },
    [account, executeIntent, isConnected]
  );

  const onRedeem = useCallback(
    async (position: PortfolioPositionsSnapshot["settled"][number]) => {
      if (!isConnected || !account) {
        return;
      }

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
    },
    [account, executeIntent, isConnected]
  );

  if (!isAuthenticated || !account) {
    return (
      <section className="positions-panel">
        <p className="positions-panel__hint">Sign in to track your positions and claimable settlements.</p>
      </section>
    );
  }

  return (
    <section className="positions-panel" aria-live="polite">
      <header className="positions-panel__head">
        <p className="positions-panel__title">My Positions</p>
        <button type="button" onClick={() => void refetch()} disabled={loading} className="positions-panel__refresh">
          {loading ? "Updating..." : "Refresh"}
        </button>
      </header>

      {error ? <p className="positions-panel__error">{error}</p> : null}

      <div className="positions-panel__stats">
        <div>
          <span>Active value</span>
          <strong>{formatUsd(snapshot?.totals.activeMarketValueUsdc ?? "0")}</strong>
        </div>
        <div>
          <span>Unrealized PnL</span>
          <strong>{formatUsd(snapshot?.totals.unrealizedPnlUsdc ?? "0")}</strong>
        </div>
        <div>
          <span>Claimable</span>
          <strong>{formatUsd(snapshot?.totals.claimableUsdc ?? "0")}</strong>
        </div>
      </div>

      {activePositions.length > 0 ? (
        <ul className="positions-panel__list">
          {activePositions.map((position) => (
            <li key={position.id} className="positions-panel__item">
              <div className="positions-panel__item-main">
                <p
                  className="positions-panel__market-link"
                  onClick={() => {
                    const feedId = position.marketSlug || position.marketId;
                    router.push(`/feed?startAt=${encodeURIComponent(feedId)}`);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {position.marketTitle}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className={`positions-panel__side positions-panel__side--${position.side}`}>
                    {position.side.toUpperCase()}
                  </span>
                  <span style={{ fontSize: "13px", color: "var(--text-hint)" }}>
                    {Number(position.tokenBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} Shares
                  </span>
                </div>
              </div>
              <div className="positions-panel__item-actions">
                <p>{formatUsd(position.marketValueUsdc)}</p>
                <span>PnL {formatUsd(position.unrealizedPnlUsdc)}</span>
                <button
                  type="button"
                  className="positions-panel__action positions-panel__action--sell"
                  onClick={() => void onSell(position)}
                  disabled={!isConnected || isBusy || activeActionId === position.id}
                >
                  {activeActionId === position.id ? "Selling..." : "Sell"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="positions-panel__hint">No active positions yet.</p>
      )}

      {claimableSettledPositions.length > 0 ? (
        <>
          <p className="positions-panel__section-title">Claimable settlements</p>
          <ul className="positions-panel__list">
            {claimableSettledPositions.map((position) => (
              <li key={position.id} className="positions-panel__item">
                <div className="positions-panel__item-main">
                  <p>{position.marketTitle}</p>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className={`positions-panel__side positions-panel__side--${position.side}`}>
                      {position.side.toUpperCase()}
                    </span>
                    <span style={{ fontSize: "13px", color: "var(--text-hint)" }}>
                      {Number(position.tokenBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} Shares
                    </span>
                  </div>
                </div>
                <div className="positions-panel__item-actions">
                  <p>{formatUsd(position.marketValueUsdc)}</p>
                  <span>Settled payout</span>
                  <button
                    type="button"
                    className="positions-panel__action positions-panel__action--redeem"
                    onClick={() => void onRedeem(position)}
                    disabled={!isConnected || isBusy || activeActionId === position.id}
                  >
                    {activeActionId === position.id ? "Redeeming..." : "Redeem"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="positions-panel__footer">
        Settled positions: <strong>{snapshot?.settled.length ?? 0}</strong>
        {claimableCount > 0 ? (
          <>
            {" "}
            • claimable: <strong>{claimableCount}</strong>
          </>
        ) : null}
      </p>
      {!isConnected ? <p className="positions-panel__hint">Connect wallet to sell or redeem positions.</p> : null}
      <p className={`trade-status trade-status--${state.status}`}>{statusLabel}</p>
    </section>
  );
}
