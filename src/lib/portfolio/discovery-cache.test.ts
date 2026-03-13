import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  appendCachedDiscoveryAddresses,
  extractDiscoveryAddressesFromSnapshot,
  readCachedDiscoveryAddresses
} from "@/lib/portfolio/discovery-cache";
import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";

const ACCOUNT = "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc";
const ADDRESS_ONE = "0x1111111111111111111111111111111111111111";
const ADDRESS_TWO = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  (globalThis as { __pmMiniappPositionsDiscoveryCache?: unknown }).__pmMiniappPositionsDiscoveryCache =
    undefined;
});

test("appendCachedDiscoveryAddresses preserves previously discovered markets", async () => {
  await appendCachedDiscoveryAddresses(ACCOUNT, [ADDRESS_ONE, ADDRESS_TWO], null);
  await appendCachedDiscoveryAddresses(ACCOUNT, [ADDRESS_ONE], null);

  assert.deepEqual(
    await readCachedDiscoveryAddresses(ACCOUNT, null),
    [ADDRESS_ONE.toLowerCase(), ADDRESS_TWO.toLowerCase()]
  );
});

test("extractDiscoveryAddressesFromSnapshot returns only address-backed positions", () => {
  const snapshot: PortfolioPositionsSnapshot = {
    account: ACCOUNT,
    fetchedAt: "2026-03-13T12:00:00.000Z",
    active: [
      {
        id: `${ADDRESS_ONE}:yes`,
        marketId: ADDRESS_ONE,
        marketSlug: "address-backed-active",
        marketTitle: "Address Backed Active",
        side: "yes",
        status: "active",
        costUsdc: "1",
        marketValueUsdc: "1",
        unrealizedPnlUsdc: "0",
        realizedPnlUsdc: "0",
        claimable: false,
        tokenBalance: "1"
      }
    ],
    settled: [
      {
        id: "slug-only:no",
        marketId: "slug-only",
        marketSlug: "slug-only",
        marketTitle: "Slug Only",
        side: "no",
        status: "settled",
        costUsdc: "1",
        marketValueUsdc: "0",
        unrealizedPnlUsdc: "0",
        realizedPnlUsdc: "0",
        claimable: false,
        tokenBalance: "0"
      },
      {
        id: `${ADDRESS_TWO}:no`,
        marketId: ADDRESS_TWO,
        marketSlug: "address-backed-settled",
        marketTitle: "Address Backed Settled",
        side: "no",
        status: "settled",
        costUsdc: "1",
        marketValueUsdc: "1",
        unrealizedPnlUsdc: "0",
        realizedPnlUsdc: "0",
        claimable: true,
        tokenBalance: "1"
      }
    ],
    totals: {
      activeMarketValueUsdc: "1",
      unrealizedPnlUsdc: "0",
      claimableUsdc: "1"
    }
  };

  assert.deepEqual(extractDiscoveryAddressesFromSnapshot(snapshot), [
    ADDRESS_ONE.toLowerCase(),
    ADDRESS_TWO.toLowerCase()
  ]);
});
