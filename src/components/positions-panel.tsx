"use client";

import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import { useAccount } from "wagmi";
import { useCallback, useEffect, useMemo, useState } from "react";

const REFRESH_EVENT_NAME = "positions:refresh";

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

export function PositionsPanel() {
  const { address } = useAccount();
  const { user, isAuthenticated } = useMiniAppAuth();
  const account = user?.address ?? address ?? null;
  const [snapshot, setSnapshot] = useState<PortfolioPositionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account || !isAuthenticated) {
      setSnapshot(null);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`/api/portfolio/positions?account=${account}`, {
        cache: "no-store",
        credentials: "include"
      });
      const body = (await response.json().catch(() => null)) as
        | PortfolioPositionsSnapshot
        | { error?: string }
        | null;

      if (!response.ok || !body || ("error" in body && body.error)) {
        const message =
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : `Failed to load positions (${response.status})`;
        throw new Error(message);
      }

      setSnapshot(body as PortfolioPositionsSnapshot);
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load positions";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [account, isAuthenticated]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!account || !isAuthenticated) {
      return;
    }

    const timer = setInterval(() => {
      void load();
    }, 20_000);

    const onRefresh = () => {
      void load();
    };

    window.addEventListener(REFRESH_EVENT_NAME, onRefresh);

    return () => {
      clearInterval(timer);
      window.removeEventListener(REFRESH_EVENT_NAME, onRefresh);
    };
  }, [account, isAuthenticated, load]);

  const topActive = useMemo(() => snapshot?.active.slice(0, 3) ?? [], [snapshot?.active]);
  const claimableCount = snapshot?.settled.filter((item) => item.claimable).length ?? 0;

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
        <button type="button" onClick={() => void load()} disabled={loading} className="positions-panel__refresh">
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

      {topActive.length > 0 ? (
        <ul className="positions-panel__list">
          {topActive.map((position) => (
            <li key={position.id} className="positions-panel__item">
              <div>
                <p>{position.marketTitle}</p>
                <span className={`positions-panel__side positions-panel__side--${position.side}`}>
                  {position.side.toUpperCase()}
                </span>
              </div>
              <div>
                <p>{formatUsd(position.marketValueUsdc)}</p>
                <span>PnL {formatUsd(position.unrealizedPnlUsdc)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="positions-panel__hint">No active positions yet.</p>
      )}

      <p className="positions-panel__footer">
        Settled positions: <strong>{snapshot?.settled.length ?? 0}</strong>
        {claimableCount > 0 ? (
          <>
            {" "}
            • claimable: <strong>{claimableCount}</strong>
          </>
        ) : null}
      </p>
    </section>
  );
}
