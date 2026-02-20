"use client";

import { useEffect, useState } from "react";
import { Market } from "@/lib/market-types";
import { useTradeExecutor } from "@/lib/trade/use-trade-executor";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatCompactNumber(value?: number) {
  if (value === undefined) {
    return "-";
  }

  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatCountdown(endsAt: string | undefined, nowMs: number) {
  if (!endsAt) {
    return "No deadline";
  }

  const diffMs = new Date(endsAt).getTime() - nowMs;
  if (diffMs <= 0) {
    return "Closing";
  }

  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  return `${minutes}m ${seconds}s left`;
}

export function MarketCard({ market, isActive }: { market: Market; isActive: boolean }) {
  const [amountUsdc, setAmountUsdc] = useState("5");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const { executeTrade, isBusy, isConnected, state, statusLabel, isBatchWaiting } = useTradeExecutor();

  useEffect(() => {
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

  async function onTrade(side: "yes" | "no") {
    await executeTrade({
      marketId: market.id,
      side,
      amountUsdc
    });
  }

  return (
    <article className="feed-card" data-active={isActive ? "true" : "false"}>
      <p className="feed-card__status">{market.status.toUpperCase()} · {formatCountdown(market.endsAt, nowMs)}</p>
      <h2 className="feed-card__title">{market.title}</h2>

      <div className="feed-card__meta">
        <span>Market ID: {market.id}</span>
        <span>Vol 24h: {formatCompactNumber(market.volume24h)}</span>
      </div>

      <section className="feed-card__price" aria-label="Yes and no prices">
        <div className="price-row">
          <span className="price-label">Yes</span>
          <strong className="price-value--up">{formatPercent(market.yesPrice)}</strong>
        </div>
        <div className="price-row">
          <span className="price-label">No</span>
          <strong className="price-value--down">{formatPercent(market.noPrice)}</strong>
        </div>
      </section>

      <section className="trade-box" aria-label="Trade actions">
        <label className="trade-box__label" htmlFor={`amount-${market.id}`}>
          Size (USDC)
        </label>
        <input
          id={`amount-${market.id}`}
          className="trade-box__input"
          inputMode="decimal"
          value={amountUsdc}
          onChange={(event) => setAmountUsdc(event.target.value)}
          disabled={isBusy}
        />

        <div className="trade-box__actions">
          <button
            type="button"
            className="trade-btn trade-btn--yes"
            onClick={() => onTrade("yes")}
            disabled={isBusy || !isConnected}
          >
            Buy Yes
          </button>
          <button
            type="button"
            className="trade-btn trade-btn--no"
            onClick={() => onTrade("no")}
            disabled={isBusy || !isConnected}
          >
            Buy No
          </button>
        </div>

        <p className={`trade-box__status trade-box__status--${state.status}`}>
          {statusLabel}
          {isBatchWaiting ? " (awaiting batch receipt)" : ""}
        </p>
      </section>
    </article>
  );
}
