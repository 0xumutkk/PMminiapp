"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Market } from "@/lib/market-types";
import { useTradeExecutor } from "@/lib/trade/use-trade-executor";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatCompactNumber(value?: number) {
  if (value === undefined || !Number.isFinite(value)) {
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

function inferTopic(title: string) {
  const text = title.toLowerCase();

  if (/(alien|ufo|nasa|space|science)/.test(text)) {
    return "Science";
  }

  if (/(election|president|policy|senate|government|war)/.test(text)) {
    return "Politics";
  }

  if (/(bitcoin|eth|crypto|solana|token)/.test(text)) {
    return "Crypto";
  }

  if (/(nfl|nba|soccer|football|final|cup)/.test(text)) {
    return "Sports";
  }

  if (/(epstein|conspiracy|mystery|secret|cover-up)/.test(text)) {
    return "Conspiracy";
  }

  return "Trending";
}

function hashSeed(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function getBackdropStyle(marketId: string, topic: string): CSSProperties {
  const seed = hashSeed(`${topic}-${marketId}`);
  const hueA = seed % 360;
  const hueB = (hueA + 44) % 360;
  const hueC = (hueA + 156) % 360;

  return {
    backgroundImage: [
      `radial-gradient(90% 75% at 16% 20%, hsla(${hueA} 85% 60% / 0.52) 0%, transparent 68%)`,
      `radial-gradient(65% 55% at 82% 32%, hsla(${hueB} 88% 55% / 0.36) 0%, transparent 70%)`,
      `radial-gradient(95% 85% at 50% 100%, hsla(${hueC} 88% 44% / 0.3) 0%, transparent 70%)`,
      "linear-gradient(170deg, #0d142a 0%, #090d19 46%, #05070f 100%)"
    ].join(", ")
  };
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

function FlameIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M13.9 2.5c.6 3-1.6 4.3-3 5.9-1.3 1.4-1.8 2.5-1.8 4a4 4 0 1 0 8 0c0-4.3-2.2-6-3.2-9.9z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 20.5l-1.2-1.1C6.2 15.3 3.2 12.6 3.2 9.1A4.1 4.1 0 0 1 7.4 5a4.7 4.7 0 0 1 4.6 2.8A4.7 4.7 0 0 1 16.6 5a4.1 4.1 0 0 1 4.2 4.1c0 3.5-3 6.2-7.6 10.3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9.2L4 21V7a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9 8l8-4v16l-8-4v-3.5H3.5a1.5 1.5 0 0 1 0-3H9z" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.8L5 21V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" />
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

export function MarketCard({ market, isActive }: { market: Market; isActive: boolean }) {
  const [amountUsdc, setAmountUsdc] = useState("5");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showConfirmed, setShowConfirmed] = useState(false);
  const [lastTradeSide, setLastTradeSide] = useState<"yes" | "no">("yes");

  const { executeTrade, isBusy, isConnected, state, statusLabel, isBatchWaiting } = useTradeExecutor();

  const topic = useMemo(() => inferTopic(market.title), [market.title]);
  const backdropStyle = useMemo(() => getBackdropStyle(market.id, topic), [market.id, topic]);

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

  useEffect(() => {
    if (state.status !== "confirmed") {
      return;
    }

    setShowConfirmed(true);
    const timeout = setTimeout(() => {
      setShowConfirmed(false);
    }, 2200);

    return () => {
      clearTimeout(timeout);
    };
  }, [state.status]);

  async function onTrade(side: "yes" | "no") {
    setLastTradeSide(side);
    await executeTrade({
      marketId: market.id,
      side,
      amountUsdc
    });
  }

  const volume = market.volume24h ?? 0;
  const likeCount = formatCompactNumber(Math.max(2_300, volume * 34));
  const commentCount = formatCompactNumber(Math.max(900, volume * 11));
  const shareCount = formatCompactNumber(Math.max(400, volume * 5.2));
  const participants = formatCompactNumber(Math.max(4_100, volume * 23));

  const tradeStatusText = !isConnected
    ? "Connect wallet to place a bet."
    : `${statusLabel}${isBatchWaiting ? " (awaiting batch receipt)" : ""}`;
  const amountNumber = Number(amountUsdc);
  const displayAmount = Number.isFinite(amountNumber) && amountNumber > 0 ? amountNumber : 0;

  return (
    <article className="market-card" data-active={isActive ? "true" : "false"}>
      <div className="market-card__bg" style={backdropStyle} aria-hidden />
      <div className="market-card__veil" aria-hidden />

      <header className="market-card__top-controls">
        <button type="button" className="icon-btn" aria-label="Notifications">
          <BellIcon />
        </button>
        <div className="topic-pill">
          <EyeIcon />
          <span>{topic}</span>
        </div>
        <span className="source-pill">BASE</span>
      </header>

      <aside className="market-side-actions" aria-label="Engagement actions">
        <div className="side-hot">
          <FlameIcon />
          <span>HOT</span>
        </div>
        <div className="side-action">
          <HeartIcon />
          <span>{likeCount}</span>
        </div>
        <div className="side-action">
          <MessageIcon />
          <span>{commentCount}</span>
        </div>
        <div className="side-action">
          <ShareIcon />
          <span>{shareCount}</span>
        </div>
        <div className="side-action">
          <BookmarkIcon />
          <span>Save</span>
        </div>
      </aside>

      <section className="market-card__content">
        <span className="trend-pill">
          <TrendIcon />
          TRENDING
        </span>

        <h2 className="market-card__title">{market.title}</h2>

        <div className="market-card__meta-row">
          <span className="yes-pill">{formatPercent(market.yesPrice)} YES</span>
          <span className="meta-item">
            <ClockIcon />
            {formatCountdown(market.endsAt, nowMs)}
          </span>
          <span className="meta-item">
            <UsersIcon />
            {participants}
          </span>
        </div>

        <label className="stake-control" htmlFor={`amount-${market.id}`}>
          <span>Stake</span>
          <input
            id={`amount-${market.id}`}
            inputMode="decimal"
            value={amountUsdc}
            onChange={(event) => setAmountUsdc(event.target.value)}
            disabled={isBusy}
            aria-label="Trade size in USDC"
          />
          <span>USDC</span>
        </label>

        <div className="vote-actions">
          <button
            type="button"
            className="vote-btn vote-btn--yes"
            onClick={() => onTrade("yes")}
            disabled={isBusy || !isConnected}
          >
            <CheckIcon />
            YES · {formatPercent(market.yesPrice)}
          </button>
          <button
            type="button"
            className="vote-btn vote-btn--no"
            onClick={() => onTrade("no")}
            disabled={isBusy || !isConnected}
          >
            <CloseIcon />
            NO · {formatPercent(market.noPrice)}
          </button>
        </div>

        <p className={`trade-status trade-status--${state.status}`}>{tradeStatusText}</p>
      </section>

      {showConfirmed ? (
        <div className="trade-confirm-overlay" aria-live="polite">
          <span className="trade-confirm-overlay__icon">
            <CheckIcon />
          </span>
          <p>BET CONFIRMED</p>
          <strong>${displayAmount.toLocaleString("en-US")}</strong>
          <span className="trade-confirm-overlay__result" data-side={lastTradeSide}>
            You bet {lastTradeSide.toUpperCase()}
          </span>
        </div>
      ) : null}
    </article>
  );
}
