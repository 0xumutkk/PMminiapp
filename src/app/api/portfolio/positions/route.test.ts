import assert from "node:assert/strict";
import { before, test } from "node:test";
import type {
  PortfolioPositionsSnapshot,
  TrackedPosition
} from "@/lib/portfolio/limitless-portfolio";

type TestHelpers = {
  stabilizeSnapshotWithCache: (
    snapshot: PortfolioPositionsSnapshot,
    cachedSnapshot: PortfolioPositionsSnapshot | null
  ) => PortfolioPositionsSnapshot;
  mergeHistoricalSettledPositions: (
    snapshot: PortfolioPositionsSnapshot | null,
    account: `0x${string}`,
    historicalSettled: TrackedPosition[]
  ) => PortfolioPositionsSnapshot;
};

let testHelpers: TestHelpers;

before(async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  await import("@/app/api/portfolio/positions/route");
  const helpers = (globalThis as {
    __positionsRouteTestHelpers?: TestHelpers;
  }).__positionsRouteTestHelpers;

  if (!helpers) {
    throw new Error("Positions route test helpers were not initialized.");
  }

  testHelpers = helpers;
});

const ACCOUNT = "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc";
const MARKET_ID = "0x91d3fee86321a6f50b719b8368cf62de44b8e510";
const MARKET_SLUG = "will-opinions-daily-trading-volume-decrease-on-mar-4-vs-mar-3-1772575556256";
const MARKET_TITLE = "Will Opinion's daily trading volume decrease on Mar 4 vs Mar 3?";

function buildSettledPosition(overrides: Partial<TrackedPosition>): TrackedPosition {
  return {
    id: `${MARKET_ID}:yes`,
    marketId: MARKET_ID,
    marketSlug: MARKET_SLUG,
    marketTitle: MARKET_TITLE,
    side: "yes",
    status: "settled",
    costUsdc: "1",
    marketValueUsdc: "0",
    unrealizedPnlUsdc: "0",
    realizedPnlUsdc: "0",
    claimable: false,
    tokenBalance: "0",
    ...overrides
  };
}

function buildSnapshot(settled: TrackedPosition[]): PortfolioPositionsSnapshot {
  return {
    account: ACCOUNT,
    fetchedAt: "2026-03-12T12:00:00.000Z",
    active: [],
    settled,
    totals: {
      activeMarketValueUsdc: "0",
      unrealizedPnlUsdc: "0",
      claimableUsdc: settled
        .filter((item) => item.claimable)
        .reduce((sum, item) => sum + Number(item.marketValueUsdc), 0)
        .toFixed(6)
        .replace(/\.?0+$/, "") || "0"
    }
  };
}

test("stabilizeSnapshotWithCache does not hydrate sold exit history into claimable redeem rows", () => {
  const liveClaimable = buildSettledPosition({
    id: `${MARKET_ID}:yes`,
    claimable: true,
    marketValueUsdc: "0.151683",
    tokenBalance: "0.151683"
  });
  const liveExit = buildSettledPosition({
    id: `${MARKET_ID}:yes:exit`,
    marketValueUsdc: "0.810283",
    isSold: true
  });
  const cachedClaimable = buildSettledPosition({
    id: `${MARKET_ID}:yes`,
    claimable: true,
    marketValueUsdc: "0.151683",
    tokenBalance: "0.151683"
  });

  const result = testHelpers.stabilizeSnapshotWithCache(
    buildSnapshot([liveClaimable, liveExit]),
    buildSnapshot([cachedClaimable])
  );

  const claimableRows = result.settled.filter((item) => item.claimable);
  assert.equal(claimableRows.length, 1);
  assert.equal(claimableRows[0]?.id, `${MARKET_ID}:yes`);
  assert.equal(claimableRows[0]?.marketValueUsdc, "0.151683");
  assert.equal(claimableRows[0]?.tokenBalance, "0.151683");

  const exitRow = result.settled.find((item) => item.id === `${MARKET_ID}:yes:exit`);
  assert.ok(exitRow);
  assert.equal(exitRow.claimable, false);
  assert.equal(exitRow.marketValueUsdc, "0.810283");
  assert.equal(exitRow.tokenBalance, "0");
  assert.equal(exitRow.isSold, true);
});

test("mergeHistoricalSettledPositions keeps sold exits separate from claimable settled positions", () => {
  const liveClaimable = buildSettledPosition({
    id: `${MARKET_ID}:yes`,
    claimable: true,
    marketValueUsdc: "0.151683",
    tokenBalance: "0.151683"
  });
  const historicalExit = buildSettledPosition({
    id: `${MARKET_ID}:yes:exit`,
    marketValueUsdc: "0.810283",
    isSold: true
  });

  const result = testHelpers.mergeHistoricalSettledPositions(
    buildSnapshot([liveClaimable]),
    ACCOUNT,
    [historicalExit]
  );

  const claimableRows = result.settled.filter((item) => item.claimable);
  assert.equal(claimableRows.length, 1);
  assert.equal(claimableRows[0]?.id, `${MARKET_ID}:yes`);
  assert.equal(claimableRows[0]?.marketValueUsdc, "0.151683");

  const exitRow = result.settled.find((item) => item.id === `${MARKET_ID}:yes:exit`);
  assert.ok(exitRow);
  assert.equal(exitRow.claimable, false);
  assert.equal(exitRow.marketValueUsdc, "0.810283");
  assert.equal(exitRow.isSold, true);
});
