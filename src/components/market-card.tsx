"use client";

import { useEffect, useMemo, useState, useCallback, type CSSProperties } from "react";
import { useAccount } from "wagmi";
import { getMarketVibe } from "@/lib/vibe-utils";
import { Market } from "@/lib/market-types";
import { useTradeExecutor } from "@/lib/trade/use-trade-executor";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import Link from "next/link";

import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { useTokenPrice } from "@/lib/crypto-price";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatCompactNumber(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "0";
  }

  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return value.toFixed(0);
}

function formatCountdown(endsAt: string | undefined, nowMs: number) {
  if (!endsAt) {
    return "No deadline";
  }

  const diffMs = new Date(endsAt).getTime() - nowMs;
  if (diffMs <= 0) {
    return "Closing";
  }

  const days = Math.floor(diffMs / 86_400_000);
  if (days > 0) {
    return `${days}d`;
  }

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours > 0) {
    return `${hours}h`;
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${Math.max(1, Math.floor(diffMs / 1000))}s`;
}


function hashSeed(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}


function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path
        d="M15 17h4l-1.6-1.8a2 2 0 0 1-.5-1.3V11a5 5 0 0 0-10 0v2.9a2 2 0 0 1-.5 1.3L4.8 17h4.1m2.1 0v1.2a1.1 1.1 0 1 0 2.2 0V17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path
        d="M2.2 12s3.6-6 9.8-6 9.8 6 9.8 6-3.6 6-9.8 6-9.8-6-9.8-6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}


function TrendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 17h16M6 14l4-4 4 3 4-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="6" cy="14" r="1.2" />
      <circle cx="10" cy="10" r="1.2" />
      <circle cx="14" cy="13" r="1.2" />
      <circle cx="18" cy="7" r="1.2" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.6v4.7l3.4 2.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="8" cy="9.2" r="3" />
      <circle cx="16.6" cy="10.2" r="2.4" />
      <path d="M3.8 19.5a4.8 4.8 0 0 1 8.4-2.9 4.8 4.8 0 0 1 8 .6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M7.8 12.3l2.7 2.9 5.9-6.4" fill="none" stroke="#08120d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="#18060c" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}



function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden style={{ width: 16, height: 16 }}>
      <path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden style={{ width: 16, height: 16 }}>
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatTxHash(hash: string) {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

export function MarketCard({ market, isActive }: { market: Market; isActive: boolean }) {
  const [amountUsdc, setAmountUsdc] = useState("5");
  const [nowMs, setNowMs] = useState(0);
  const [isMounted, setIsMounted] = useState(false);
  const maxSlippageBps = 200;
  const [busySince, setBusySince] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [bgLoaded, setBgLoaded] = useState(false);

  const { executeTrade, resetTradeState, isBusy, isConnected, state, statusLabel } = useTradeExecutor();
  const { isAuthenticated, status: authStatus, signIn, error: authError } = useMiniAppAuth();
  const { snapshot } = usePortfolioPositions();
  const vibe = useMemo(() => getMarketVibe(market.title, market.id, market.categories, market.tags), [market.title, market.id, market.categories, market.tags]);
  const { base, quote, price } = useTokenPrice(market.title, vibe.label.toLowerCase());

  const userPosition = useMemo(() => {
    if (!snapshot || !isAuthenticated || !isConnected) return null;
    const venueAddr = market.tradeVenue?.venueExchange?.toLowerCase();

    return snapshot.active.find(p =>
      p.marketSlug === market.id ||
      p.marketId === market.id ||
      (venueAddr && p.marketId.toLowerCase() === venueAddr)
    );
  }, [snapshot, market.id, market.tradeVenue?.venueExchange, isAuthenticated, isConnected]);


  const adjustStake = useCallback((delta: number) => {
    setAmountUsdc((prev) => {
      let current = Number(prev);
      if (Number.isNaN(current)) current = 0;
      const next = Math.max(1, current + delta);
      return next.toString();
    });
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
    setIsMounted(true);
    if (!isActive) {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [isActive]);

  useEffect(() => {
    const inProgress =
      state.status === "preparing" || state.status === "awaiting_signature" || state.status === "submitted";

    if (inProgress && busySince === null) {
      setBusySince(Date.now());
      return;
    }

    if (!inProgress && busySince !== null) {
      setBusySince(null);
    }
  }, [busySince, state.status]);

  useEffect(() => {
    const minShares = market.minTradeShares;
    if (!minShares) {
      return;
    }
    // Pre-fill with the YES minimum as a sensible default
    const minUsdc = minShares * market.yesPrice;
    setAmountUsdc((current) => {
      const parsed = Number(current);
      if (!Number.isFinite(parsed) || parsed < minUsdc) {
        return String(Number(minUsdc.toFixed(2)));
      }
      return current;
    });
  }, [market.id, market.minTradeShares, market.yesPrice]);

  async function onTrade(side: "yes" | "no") {
    const parsedAmount = Number(amountUsdc);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setLocalError("Enter a valid stake amount.");
      return;
    }

    if (market.minTradeShares) {
      const price = side === "yes" ? market.yesPrice : market.noPrice;
      const minUsdc = market.minTradeShares * price;
      if (parsedAmount < minUsdc) {
        setLocalError(
          `Minimum stake for ${side.toUpperCase()} is ${minUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC.`
        );
        return;
      }
    }

    setLocalError(null);
    await executeTrade({
      marketId: market.id,
      marketTitle: market.title,
      side,
      amountUsdc,
      expectedPrice: side === "yes" ? market.yesPrice : market.noPrice,
      maxSlippageBps
    });
  }

  const volume = market.volume ?? (market as any).volume24h ?? 0;
  const latestTxHash = state.txHashes[state.txHashes.length - 1] ?? null;
  const txExplorerUrl = latestTxHash ? `https://basescan.org/tx/${latestTxHash}` : null;
  const busyMs = busySince ? Date.now() - busySince : 0;
  const isStuck = isBusy && busySince !== null && busyMs > 25_000;
  const showProgressNotice =
    isConnected &&
    isAuthenticated &&
    (state.status === "preparing" || state.status === "awaiting_signature" || state.status === "submitted");

  const tradeStatusText = !isConnected
    ? "Connect wallet to place a bet."
    : !isAuthenticated
      ? authStatus === "loading"
        ? "Checking sign-in..."
        : authStatus === "authenticating"
          ? "Signing in..."
          : "Sign in to place a bet."
      : localError
        ? localError
        : state.status === "failed"
          ? state.error ?? "Trade failed"
          : "";




  return (
    <article className="market-card" data-active={isActive ? "true" : "false"} data-vibe={vibe.label.toLowerCase()}>
      <div
        className="market-card__bg"
        aria-hidden
        style={{
          background: `linear-gradient(135deg, ${vibe.colors[0]} 0%, ${vibe.colors[1]} 50%, ${vibe.colors[2]} 100%)`,
        }}
      >
        <img
          src={vibe.bgImageUrl}
          className="market-card__category-bg"
          alt=""
          loading="lazy"
          onLoad={() => setBgLoaded(true)}
          style={{
            opacity: bgLoaded ? 1 : 0,
            transition: 'opacity 0.8s ease-in-out',
            filter: 'none', // Strictly no filters as requested
          }}
        />
      </div>
      <div className="market-card__veil" aria-hidden />

      {price !== null && (
        <div className="market-card__price-badge">
          <div className="market-card__price-dot" />
          <span>
            {base}/{quote}: {price.toLocaleString(undefined, {
              maximumFractionDigits: quote === "USD" || quote === "USDT" || quote === "EUR" ? 2 : 0
            })} {quote}
          </span>
        </div>
      )}

      <section className="market-card__content">
        <div className="market-card__meta-row">
          <span className="trend-pill">{vibe.label}</span>
          <span className="percent-pill">{formatPercent(market.yesPrice)}</span>
          <span className="top-meta-chip">Ends {formatCountdown(market.endsAt, nowMs)}</span>
        </div>

        <h2 className="market-card__title">{market.title}</h2>

        {userPosition && (
          <div className="market-card__position-badge">
            <span className={`pos-badge-side pos-badge-side--${userPosition.side}`}>
              {userPosition.side === 'yes' ? '👍' : '👎'} {userPosition.side.toUpperCase()}
            </span>
            <span className="pos-badge-value">
              {Number(userPosition.tokenBalance).toLocaleString()} shares · ${Number(userPosition.marketValueUsdc).toFixed(2)}
            </span>
          </div>
        )}

        <div className="stake-presets" style={{ marginTop: '16px', marginBottom: '16px' }}>
          <div className="stake-pill">
            <span className="stake-pill__label">Stake</span>
            <div className="stake-pill__input-container">
              <span>$</span>
              <input
                type="number"
                value={amountUsdc}
                onChange={(e) => setAmountUsdc(e.target.value)}
              />
            </div>
            <div className="stake-pill__controls">
              <button
                type="button"
                className="stake-pill__btn"
                onClick={() => adjustStake(-1)}
              >
                -
              </button>
              <div className="stake-pill__divider" />
              <button
                type="button"
                className="stake-pill__btn"
                onClick={() => adjustStake(1)}
              >
                +
              </button>
            </div>
          </div>
          {[5, 50, 100].map((preset) => (
            <button
              key={preset}
              type="button"
              className={`stake-preset-btn ${amountUsdc === preset.toString() ? 'stake-preset-btn--active' : ''}`}
              onClick={() => setAmountUsdc(preset.toString())}
              disabled={isBusy}
            >
              ${preset}
            </button>
          ))}
        </div>

        {isConnected && authStatus !== "loading" && !isAuthenticated ? (
          <button
            type="button"
            className="market-auth-btn"
            onClick={() => void signIn()}
            disabled={authStatus === "authenticating"}
            style={{ width: '100%', marginBottom: '12px' }}
          >
            {authStatus === "authenticating" ? "Signing in..." : "Sign in to trade"}
          </button>
        ) : null}

        <div className="vote-actions">
          <button
            type="button"
            className="vote-btn vote-btn--yes"
            onClick={() => void onTrade("yes")}
            disabled={isBusy || !isConnected || !isAuthenticated}
          >
            Yes {formatPercent(market.yesPrice)}
          </button>
          <button
            type="button"
            className="vote-btn vote-btn--no"
            onClick={() => void onTrade("no")}
            disabled={isBusy || !isConnected || !isAuthenticated}
          >
            No {formatPercent(market.noPrice)}
          </button>
        </div>

        {showProgressNotice ? (
          <div className={`trade-notice trade-notice--${state.status}`} role="status" aria-live="polite">
            <div className="trade-notice__header">
              <span className="trade-notice__title">
                {state.status === "failed" ? "Trade Failed" : "Processing Trade"}
              </span>
              <span className="trade-notice__detail">{statusLabel}</span>
            </div>

            {txExplorerUrl && (
              <a
                className="trade-notice__tx-link"
                href={txExplorerUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                View on BaseScan ↗
              </a>
            )}

            <div className="trade-notice__actions">
              <button
                className="trade-notice__link"
                style={{ opacity: 0.2, cursor: 'not-allowed' }}
                disabled
              >
                View on Profile
              </button>
              <button
                type="button"
                className="trade-notice__dismiss"
                onClick={() => resetTradeState()}
              >
                {state.status === "failed" ? "Close" : "Dismiss"}
              </button>
            </div>
          </div>
        ) : null}

        {isConnected && isAuthenticated && state.status === "confirmed" ? (
          <div className={`trade-notice trade-notice--${state.status}`} role="status" aria-live="polite">
            <div className="trade-notice__header">
              <span className="trade-notice__title">Success!</span>
              <span className="trade-notice__detail">Your trade was confirmed on Base.</span>
            </div>

            {txExplorerUrl && (
              <a
                className="trade-notice__tx-link"
                href={txExplorerUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{ marginTop: '-4px' }}
              >
                View on BaseScan ↗
              </a>
            )}

            <div className="trade-notice__actions">
              <Link
                href={`/profile#market-${market.id}`}
                className="trade-notice__link"
                onClick={() => resetTradeState()}
              >
                View on Profile
              </Link>
              <button
                type="button"
                className="trade-notice__dismiss"
                onClick={() => resetTradeState()}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

      </section>
    </article>
  );
}
