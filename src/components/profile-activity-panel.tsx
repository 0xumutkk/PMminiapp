"use client";

import { usePortfolioPositions } from "@/lib/portfolio/use-portfolio-positions";
import { useMemo } from "react";

type ActivityItem = {
  id: string;
  title: string;
  detail: string;
  meta: string;
  priority: number;
};

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

function buildPriority(raw: string) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

export function ProfileActivityPanel() {
  const { account, isAuthenticated, snapshot, loading, error } = usePortfolioPositions();

  const items = useMemo<ActivityItem[]>(() => {
    if (!snapshot) {
      return [];
    }

    const activeItems = snapshot.active.map((position) => ({
      id: `active:${position.id}`,
      title: "Open position",
      detail: position.marketTitle,
      meta: `${position.side.toUpperCase()} · Value ${formatUsd(position.marketValueUsdc)} · PnL ${formatUsd(position.unrealizedPnlUsdc)}`,
      priority: buildPriority(position.marketValueUsdc)
    }));

    const settledItems = snapshot.settled.map((position) => ({
      id: `settled:${position.id}`,
      title: position.claimable ? "Claimable settlement" : "Settled position",
      detail: position.marketTitle,
      meta: `${position.side.toUpperCase()} · Payout ${formatUsd(position.marketValueUsdc)}`,
      priority: buildPriority(position.marketValueUsdc)
    }));

    return [...activeItems, ...settledItems].sort((left, right) => right.priority - left.priority).slice(0, 8);
  }, [snapshot]);

  if (!isAuthenticated || !account) {
    return <p className="activity-item__empty">Sign in to view your market activity.</p>;
  }

  if (loading && !snapshot) {
    return <p className="activity-item__empty">Loading activity...</p>;
  }

  if (error) {
    return <p className="activity-item__error">{error}</p>;
  }

  if (items.length === 0) {
    return <p className="activity-item__empty">No market activity yet.</p>;
  }

  return (
    <div className="activity-list">
      {items.map((item) => (
        <article key={item.id} className="activity-item">
          <p className="activity-item__title">{item.title}</p>
          <p className="activity-item__detail">{item.detail}</p>
          <p className="activity-item__meta">{item.meta}</p>
        </article>
      ))}
    </div>
  );
}
