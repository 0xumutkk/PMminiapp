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
