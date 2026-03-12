import test from "node:test";
import assert from "node:assert/strict";
import type { PortfolioPositionsSnapshot } from "./limitless-portfolio";
import {
  createOptimisticPortfolioSnapshot,
  mergeOptimisticPortfolioBuys,
  type StoredOptimisticPortfolioBuy
} from "./optimistic-portfolio";

const ACCOUNT = "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc" as const;

function createBuy(overrides: Partial<StoredOptimisticPortfolioBuy> = {}): StoredOptimisticPortfolioBuy {
  return {
    id: "buy-1",
    account: ACCOUNT,
    marketId: "galatasaray-wins",
    marketTitle: "Galatasaray wins",
    side: "yes",
    amountUsdc: "10",
    executionPrice: 0.5,
    confirmedAt: "2026-03-12T12:00:00.000Z",
    expiresAt: "2026-03-12T12:30:00.000Z",
    ...overrides
  };
}

function createSnapshot(): PortfolioPositionsSnapshot {
  return createOptimisticPortfolioSnapshot(ACCOUNT);
}

test("mergeOptimisticPortfolioBuys surfaces a confirmed buy as an active position", () => {
  const snapshot = mergeOptimisticPortfolioBuys(createSnapshot(), [createBuy()]);

  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0]?.marketTitle, "Galatasaray wins");
  assert.equal(snapshot.active[0]?.tokenBalance, "20");
  assert.equal(snapshot.totals.activeMarketValueUsdc, "10");
});

test("mergeOptimisticPortfolioBuys does not duplicate a buy already present in the live snapshot", () => {
  const base = createSnapshot();
  base.active.push({
    id: "live-1",
    marketId: "0x123",
    marketSlug: "galatasaray-wins",
    marketTitle: "Galatasaray wins",
    side: "yes",
    status: "active",
    costUsdc: "10",
    marketValueUsdc: "11",
    unrealizedPnlUsdc: "1",
    realizedPnlUsdc: "0",
    claimable: false,
    tokenBalance: "19",
    currentPrice: 0.55,
    hasVerifiedPricing: true
  });

  const snapshot = mergeOptimisticPortfolioBuys(base, [createBuy()]);

  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0]?.id, "live-1");
});

test("mergeOptimisticPortfolioBuys aggregates multiple pending buys for the same market side", () => {
  const snapshot = mergeOptimisticPortfolioBuys(createSnapshot(), [
    createBuy(),
    createBuy({
      id: "buy-2",
      amountUsdc: "5",
      confirmedAt: "2026-03-12T12:05:00.000Z"
    })
  ]);

  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0]?.costUsdc, "15");
  assert.equal(snapshot.active[0]?.tokenBalance, "30");
});
