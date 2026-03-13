import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "@/app/api/trade/intent/route";
import { readCachedDiscoveryAddresses } from "@/lib/portfolio/discovery-cache";

const TEST_WALLET = "0x1111111111111111111111111111111111111111";
const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "API_RATE_LIMIT_ENABLED",
  "TRADE_AUTH_REQUIRED",
  "BETA_MODE",
  "REDIS_URL",
  "LIMITLESS_TRADE_CONTRACT_ADDRESS",
  "LIMITLESS_SELL_CONTRACT_ADDRESS",
  "LIMITLESS_SELL_FUNCTION_SIGNATURE",
  "LIMITLESS_SELL_ARG_MAP",
  "USDC_DECIMALS",
  "TRADE_MIN_USDC",
  "TRADE_MAX_USDC"
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  envSnapshot.set(key, process.env[key]);
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/trade/intent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  process.env.API_RATE_LIMIT_ENABLED = "false";
  process.env.TRADE_AUTH_REQUIRED = "false";
  process.env.BETA_MODE = "false";
  process.env.REDIS_URL = "";
  process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS = "0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5";
  delete process.env.LIMITLESS_SELL_CONTRACT_ADDRESS;
  process.env.LIMITLESS_SELL_FUNCTION_SIGNATURE = "sellShares(bytes32,bool,uint256)";
  process.env.LIMITLESS_SELL_ARG_MAP = "market,side,amount";
  process.env.USDC_DECIMALS = "6";
  process.env.TRADE_MIN_USDC = "1";
  process.env.TRADE_MAX_USDC = "1000";

  (globalThis as { __apiRateLimitStore?: unknown }).__apiRateLimitStore = undefined;
  (globalThis as { __pmMiniappPositionsDiscoveryCache?: unknown }).__pmMiniappPositionsDiscoveryCache =
    undefined;
  (globalThis as { __marketIndexer_v2?: { start: () => Promise<void>; getSnapshot: () => Promise<null> } }).__marketIndexer_v2 =
    {
      start: async () => {},
      getSnapshot: async () => null
    };

  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/portfolio/") && url.includes("/positions")) {
      return Response.json({
        clob: [
          {
            market: {
              id: "market-1",
              slug: "btc-up",
              title: "BTC up?",
              status: "open",
              collateral: { decimals: 6 }
            },
            positions: {
              yes: {
                cost: "5000000",
                marketValue: "5000000",
                unrealizedPnl: "0",
                realisedPnl: "0"
              }
            },
            tokensBalance: {
              yes: "7000000"
            }
          }
        ]
      });
    }

    throw new Error(`Unexpected fetch call in test: ${url}`);
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = envSnapshot.get(key);
    if (previous === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = previous;
  }

  (globalThis as { __marketIndexer_v2?: unknown }).__marketIndexer_v2 = undefined;
  (globalThis as { __apiRateLimitStore?: unknown }).__apiRateLimitStore = undefined;
  (globalThis as { __pmMiniappPositionsDiscoveryCache?: unknown }).__pmMiniappPositionsDiscoveryCache =
    undefined;
  globalThis.fetch = ORIGINAL_FETCH;
});

test("sell action rejects requests without expectedPrice", { concurrency: false }, async () => {
  const request = buildRequest({
    action: "sell",
    marketId: "btc-up",
    side: "yes",
    amountUsdc: "10",
    walletAddress: TEST_WALLET
  });

  const response = await POST(request);
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.equal(body.error, "expectedPrice is required for sell actions");
});

test("sell action clamps amountUsdc to active position market value", { concurrency: false }, async () => {
  const request = buildRequest({
    action: "sell",
    marketId: "btc-up",
    side: "yes",
    amountUsdc: "10",
    expectedPrice: 0.61,
    maxSlippageBps: 200,
    walletAddress: TEST_WALLET
  });

  const response = await POST(request);
  const body = (await response.json()) as {
    mode?: string;
    meta?: {
      action?: string;
      amountUsdc?: string;
      amountUnits?: string;
    };
  };

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mode, "onchain");
  assert.equal(body.meta?.action, "sell");
  assert.equal(body.meta?.amountUsdc, "5");
  assert.equal(body.meta?.amountUnits, "5000000");
});

test("sell action does not fall back to an arbitrary position with the same side", { concurrency: false }, async () => {
  const request = buildRequest({
    action: "sell",
    marketId: "eth-up",
    side: "yes",
    amountUsdc: "1",
    expectedPrice: 0.61,
    maxSlippageBps: 200,
    walletAddress: TEST_WALLET
  });

  const response = await POST(request);
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 409);
  assert.equal(body.error, "No active position found for this market/side.");
});

test("buy action persists the market FPMM in the discovery cache", { concurrency: false }, async () => {
  const fpmmAddress = "0x2222222222222222222222222222222222222222";

  (globalThis as {
    __marketIndexer_v2?: { start: () => Promise<void>; getSnapshot: () => Promise<unknown> };
  }).__marketIndexer_v2 = {
    start: async () => {},
    getSnapshot: async () => ({
      updatedAt: "2026-03-13T12:00:00.000Z",
      markets: [
        {
          id: "market-claimable",
          slug: "market-claimable",
          title: "Claimable later market",
          yesPrice: 0.62,
          noPrice: 0.38,
          status: "open",
          source: "limitless",
          tradeVenue: {
            venueExchange: fpmmAddress,
            marketRef: "market-claimable"
          }
        }
      ]
    })
  };

  const request = buildRequest({
    action: "buy",
    marketId: "market-claimable",
    side: "yes",
    amountUsdc: "5",
    expectedPrice: 0.62,
    walletAddress: TEST_WALLET
  });

  const response = await POST(request);
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(
    await readCachedDiscoveryAddresses(TEST_WALLET, null),
    [fpmmAddress.toLowerCase()]
  );
});

test("redeem action resolves conditionId from the market endpoint and builds CT calldata", { concurrency: false }, async () => {
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/portfolio/") && url.includes("/positions")) {
      return Response.json({
        clob: [
          {
            market: {
              id: "0x91d3fee86321a6f50b719b8368cf62de44b8e510",
              slug: "will-opinions-daily-trading-volume-decrease-on-mar-4-vs-mar-3-1772575556256",
              title: "Will Opinion's daily trading volume decrease on Mar 4 vs Mar 3?",
              status: "resolved",
              winning_index: 0,
              collateral: { decimals: 6 }
            },
            tokensBalance: {
              yes: "151683"
            },
            positions: {
              yes: {
                cost: "1000000",
                marketValue: "151683",
                unrealizedPnl: "0",
                realisedPnl: "0"
              }
            }
          }
        ]
      });
    }

    if (url.includes("/markets/0x91d3fee86321a6f50b719b8368cf62de44b8e510")) {
      return Response.json({
        address: "0x91d3fee86321a6f50b719b8368cf62de44b8e510",
        slug: "will-opinions-daily-trading-volume-decrease-on-mar-4-vs-mar-3-1772575556256",
        title: "Will Opinion's daily trading volume decrease on Mar 4 vs Mar 3?",
        conditionId: "0xdf85d39c37aec82fc3a96ffb44ebc1dcb4fa0346ccb42c3adca2b7c9eeef8718"
      });
    }

    throw new Error(`Unexpected fetch call in redeem test: ${url}`);
  };

  const request = buildRequest({
    action: "redeem",
    marketId: "0x91d3fee86321a6f50b719b8368cf62de44b8e510",
    side: "yes",
    amountUsdc: "0.151683",
    walletAddress: TEST_WALLET
  });

  const response = await POST(request);
  const body = (await response.json()) as {
    error?: string;
    mode?: string;
    calls?: Array<{ to?: string; data?: string }>;
  };

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mode, "onchain");
  assert.equal(body.calls?.[0]?.to, "0xC9c98965297Bc527861c898329Ee280632B76e18");
  assert.equal(
    body.calls?.[0]?.data,
    "0x01b7037c000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000000000df85d39c37aec82fc3a96ffb44ebc1dcb4fa0346ccb42c3adca2b7c9eeef87180000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002"
  );
});
