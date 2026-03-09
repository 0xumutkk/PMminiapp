import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fetchPublicPortfolioPositions } from "@/lib/portfolio/limitless-portfolio";

const TEST_ACCOUNT = "0x1111111111111111111111111111111111111111";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LIMITLESS_BASE_URL = process.env.LIMITLESS_API_BASE_URL;

beforeEach(() => {
  process.env.LIMITLESS_API_BASE_URL = "https://api.limitless.exchange";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_LIMITLESS_BASE_URL === undefined) {
    delete process.env.LIMITLESS_API_BASE_URL;
  } else {
    process.env.LIMITLESS_API_BASE_URL = ORIGINAL_LIMITLESS_BASE_URL;
  }
});

test("claimable is true only for winning settled side with positive side token balance", async () => {
  globalThis.fetch = async () =>
    Response.json({
      clob: [
        {
          market: {
            id: "m-1",
            slug: "market-1",
            title: "Market 1",
            status: "resolved",
            winning_index: 0,
            position_ids: ["111", "222"],
            collateral: { decimals: 6 }
          },
          tokensBalance: {
            yes: "1000000",
            no: "1000000"
          },
          positions: {
            yes: {
              cost: "5000000",
              marketValue: "1000000",
              unrealizedPnl: "0",
              realisedPnl: "0"
            },
            no: {
              cost: "3000000",
              marketValue: "900000",
              unrealizedPnl: "0",
              realisedPnl: "0"
            }
          }
        }
      ]
    });

  const snapshot = await fetchPublicPortfolioPositions(TEST_ACCOUNT);
  const yes = snapshot.settled.find((item) => item.side === "yes");
  const no = snapshot.settled.find((item) => item.side === "no");

  assert.equal(yes?.claimable, true);
  assert.equal(no?.claimable, false);
  assert.equal(snapshot.totals.claimableUsdc, "1");
});

test("claimable stays false when upstream does not provide a redeemability signal", async () => {
  globalThis.fetch = async () =>
    Response.json({
      clob: [
        {
          market: {
            id: "m-2",
            slug: "market-2",
            title: "Market 2",
            status: "closed",
            collateral: { decimals: 6 }
          },
          positions: {
            yes: {
              cost: "2000000",
              marketValue: "1500000",
              unrealizedPnl: "0",
              realisedPnl: "0"
            }
          }
        }
      ]
    });

  const snapshot = await fetchPublicPortfolioPositions(TEST_ACCOUNT);
  const yes = snapshot.settled.find((item) => item.side === "yes");

  assert.equal(yes?.claimable, false);
  assert.equal(snapshot.totals.claimableUsdc, "0");
});

test("current API latestTrade fields are mapped onto active positions", async () => {
  globalThis.fetch = async () =>
    Response.json({
      clob: [
        {
          market: {
            id: 123,
            slug: "market-3",
            title: "Market 3",
            status: "FUNDED",
            closed: false,
            expirationDate: "2026-03-09T14:00:00.000Z",
            collateral: { decimals: 6 }
          },
          latestTrade: {
            latestYesPrice: 0.62,
            latestNoPrice: 0.38
          },
          tokensBalance: {
            yes: "2500000"
          },
          positions: {
            yes: {
              cost: "1500000",
              marketValue: "1550000",
              unrealizedPnl: "50000",
              realisedPnl: "0"
            }
          }
        }
      ]
    });

  const snapshot = await fetchPublicPortfolioPositions(TEST_ACCOUNT);
  const yes = snapshot.active.find((item) => item.side === "yes");

  assert.equal(yes?.currentPrice, 0.62);
  assert.equal(yes?.endsAt, "2026-03-09T14:00:00.000Z");
});

test("active positions derive pnl from worth and cost when upstream pnl drifts", async () => {
  globalThis.fetch = async () =>
    Response.json({
      clob: [
        {
          market: {
            id: "m-3b",
            slug: "market-3b",
            title: "Market 3B",
            status: "FUNDED",
            closed: false,
            collateral: { decimals: 6 }
          },
          latestTrade: {
            latestYesPrice: 0.62
          },
          tokensBalance: {
            yes: "2500000"
          },
          positions: {
            yes: {
              cost: "1500000",
              marketValue: "1550000",
              unrealizedPnl: "-250000",
              realisedPnl: "0"
            }
          }
        }
      ]
    });

  const snapshot = await fetchPublicPortfolioPositions(TEST_ACCOUNT);
  const yes = snapshot.active.find((item) => item.side === "yes");

  assert.equal(yes?.marketValueUsdc, "1.55");
  assert.equal(yes?.costUsdc, "1.5");
  assert.equal(yes?.unrealizedPnlUsdc, "0.05");
  assert.equal(snapshot.totals.unrealizedPnlUsdc, "0.05");
});

test("claimable supports winningOutcomeIndex and position-id keyed balances", async () => {
  globalThis.fetch = async () =>
    Response.json({
      clob: [
        {
          market: {
            id: "m-4",
            slug: "market-4",
            title: "Market 4",
            status: "resolved",
            closed: true,
            winningOutcomeIndex: 1,
            yesPositionId: "111",
            noPositionId: "222",
            collateral: { decimals: 6 }
          },
          tokensBalance: {
            "222": "1000000"
          },
          positions: {
            no: {
              cost: "3000000",
              marketValue: "1000000",
              unrealizedPnl: "0",
              realisedPnl: "0"
            }
          }
        }
      ]
    });

  const snapshot = await fetchPublicPortfolioPositions(TEST_ACCOUNT);
  const no = snapshot.settled.find((item) => item.side === "no");

  assert.equal(no?.claimable, true);
  assert.equal(snapshot.totals.claimableUsdc, "1");
});

test("active positions use market value and current price when raw token balance is under-scaled", async () => {
  globalThis.fetch = async () =>
    Response.json({
      clob: [
        {
          market: {
            id: 59724,
            slug: "market-5",
            title: "Market 5",
            status: "FUNDED",
            closed: false,
            deadline: "2026-03-09T18:00:00.000Z",
            collateral: { decimals: 6 }
          },
          latestTrade: {
            latestYesPrice: 0.01,
            latestNoPrice: 0.99
          },
          tokensBalance: {
            yes: "81270"
          },
          positions: {
            yes: {
              cost: "9915",
              marketValue: "239910",
              unrealizedPnl: "229995",
              realisedPnl: "0"
            }
          }
        }
      ]
    });

  const snapshot = await fetchPublicPortfolioPositions(TEST_ACCOUNT);
  const yes = snapshot.active.find((item) => item.side === "yes");

  assert.equal(snapshot.active.length, 1);
  assert.equal(yes?.marketValueUsdc, "0.23991");
  assert.equal(yes?.tokenBalance, "23.991");
  assert.equal(snapshot.totals.activeMarketValueUsdc, "0.23991");
});
