import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { POST } from "@/app/api/trade/intent/route";

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
  (globalThis as { __marketIndexer?: { start: () => Promise<void>; getSnapshot: () => Promise<null> } }).__marketIndexer =
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

  (globalThis as { __marketIndexer?: unknown }).__marketIndexer = undefined;
  (globalThis as { __apiRateLimitStore?: unknown }).__apiRateLimitStore = undefined;
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
