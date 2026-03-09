/**
 * On-chain portfolio reader for Limitless AMM markets.
 *
 * When the Limitless portfolio API does not recognise a wallet address
 * (returns 404 "User not found"), we fall back to reading ERC-1155 position
 * token balances directly from the ConditionalTokens contract on Base.
 *
 * IMPORTANT: The positionIds returned by the Limitless markets API may not
 * match the actual ERC-1155 token IDs used by a given FPMM contract — the
 * same "question" can have multiple FPMM instances with different conditionIds.
 * We therefore derive positionIds directly from each FPMM's conditionIds(0)
 * call rather than trusting the API-supplied positionIds.
 *
 * Architecture:
 *   1. For each FPMM, call conditionalTokens() + conditionIds(0) + collateralToken()
 *   2. Derive YES/NO positionIds via CT.getCollectionId / CT.getPositionId
 *   3. Multicall balanceOf(wallet, positionId) for every YES and NO
 *   4. Return TrackedPosition entries for every non-zero balance
 */

import { createPublicClient, fallback, http, parseAbi, isAddress } from "viem";
import { base } from "viem/chains";
import type { PortfolioPositionsSnapshot, TrackedPosition } from "./limitless-portfolio";

const FPMM_ABI = parseAbi([
    "function conditionalTokens() view returns (address)",
    "function conditionIds(uint256 index) view returns (bytes32)",
    "function collateralToken() view returns (address)"
]);

const CT_ABI = parseAbi([
    "function balanceOf(address account, uint256 id) view returns (uint256)",
    "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
    "function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)",
    "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
    "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)"
]);

/** Minimal market info needed to check on-chain balances. */
export type AmmMarketRef = {
    id: string;
    slug: string;
    title: string;
    contractAddress: string;
    /**
     * Optional API-supplied positionIds. We still compute them from the FPMM
     * itself for correctness, but keep this field for structural compatibility.
     */
    positionIds?: [string, string];
    yesPrice?: number;
    noPrice?: number;
    fromHistory?: boolean;
    endsAt?: string;
    status?: string;
    expired?: boolean;
    winningOutcomeIndex?: 0 | 1 | null;
};

export type PositionCostBasisEntry = {
    costUsdc: string;
    /**
     * Total shares acquired for the recorded cost basis.
     * When current balance is lower (partial sell), we scale the
     * remaining cost basis proportionally.
     */
    tokenAmount?: string;
};

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const CT_ADDRESS = "0xC9c98965297Bc527861c898329Ee280632B76e18";
const CT_ADDRESS_LOWER = CT_ADDRESS.toLowerCase();

function createViemClient() {
    const rpcUrls = [
        process.env.NEXT_PUBLIC_BASE_RPC_URL,
        "https://base-rpc.publicnode.com",
        "https://base.drpc.org",
        "https://mainnet.base.org"
    ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);

    const transports = rpcUrls.map((url) => http(url, {
        retryCount: 0,
        timeout: 4_000
    }));

    return createPublicClient({
        chain: base,
        transport: transports.length === 1 ? transports[0] : fallback(transports)
    });
}

/**
 * Fetch FPMM contract addresses from the wallet's ERC-1155 transfer history
 * via Blockscout. These are the contracts that sent CT tokens to the wallet
 * — each represents a market where the user has (or had) a position.
 */
export async function fetchFpmmAddressesFromHistory(account: string): Promise<string[]> {
    try {
        const fpmmAddresses = new Set<string>();
        const mintTxHashes = new Set<string>();
        const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

        let nextPageParams: string | null = null;
        for (let page = 0; page < 3; page++) {
            const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=to&type=ERC-1155`;
            const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
            const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
            if (!response.ok) break;
            const payload = (await response.json()) as { items?: unknown[]; next_page_params?: Record<string, unknown> | null };
            const items = Array.isArray(payload.items) ? payload.items : [];
            for (const item of items) {
                if (typeof item !== "object" || item === null) continue;
                const r = item as Record<string, unknown>;
                if (r.token_type !== "ERC-1155") continue;
                const token = r.token as Record<string, unknown> | undefined;
                if (typeof token?.address_hash !== "string" || token.address_hash.toLowerCase() !== CT_ADDRESS_LOWER) continue;
                const from = r.from as Record<string, unknown> | undefined;
                const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
                if (fromHash && fromHash !== ZERO_ADDRESS && isAddress(fromHash)) {
                    fpmmAddresses.add(fromHash);
                } else if (!fromHash || fromHash === ZERO_ADDRESS) {
                    const txHash = typeof r.tx_hash === "string" ? r.tx_hash : undefined;
                    if (txHash) mintTxHashes.add(txHash);
                }
            }
            if (payload.next_page_params && typeof payload.next_page_params === "object") {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(payload.next_page_params)) {
                    if (v !== null && v !== undefined) params.set(k, String(v));
                }
                nextPageParams = params.toString();
            } else {
                break;
            }
        }

        // For mint transfers (from=0x0 / splitPosition), resolve FPMM via transaction lookup
        const txsToResolve = Array.from(mintTxHashes).slice(0, 10);
        await Promise.all(
            txsToResolve.map(async (txHash) => {
                try {
                    const txUrl = `https://base.blockscout.com/api/v2/transactions/${txHash}`;
                    const txResp = await fetch(txUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
                    if (!txResp.ok) return;
                    const tx = (await txResp.json()) as Record<string, unknown>;
                    const toRecord = tx.to as Record<string, unknown> | undefined;
                    const toHash = typeof toRecord?.hash === "string" ? toRecord.hash : undefined;
                    if (toHash && isAddress(toHash)) fpmmAddresses.add(toHash.toLowerCase());
                } catch { /* non-fatal */ }
            })
        );

        return Array.from(fpmmAddresses);
    } catch {
        return [];
    }
}


// Cache: fpmmAddress → { ctAddress, conditionId, yesPositionId, noPositionId }
const fpmmCache = new Map<string, { ctAddress: `0x${string}`; conditionId: `0x${string}`; yesId: bigint; noId: bigint }>();

async function getFpmmPositionIds(
    fpmmAddress: `0x${string}`,
    client: ReturnType<typeof createViemClient>
): Promise<{ ctAddress: `0x${string}`; conditionId: `0x${string}`; yesId: bigint; noId: bigint } | null> {
    const cached = fpmmCache.get(fpmmAddress);
    if (cached) return cached;

    try {
        // Fetch ct address, conditionId, and collateral in one multicall
        const [ctResult, condResult, collResult] = await client.multicall({
            contracts: [
                { address: fpmmAddress, abi: FPMM_ABI, functionName: "conditionalTokens" },
                { address: fpmmAddress, abi: FPMM_ABI, functionName: "conditionIds", args: [0n] },
                { address: fpmmAddress, abi: FPMM_ABI, functionName: "collateralToken" }
            ],
            allowFailure: true
        });

        if (ctResult.status !== "success" || condResult.status !== "success" || collResult.status !== "success") {
            return null;
        }

        const ct = ctResult.result as `0x${string}`;
        const conditionId = condResult.result as `0x${string}`;
        const collateral = collResult.result as `0x${string}`;

        // Derive collection IDs: YES = indexSet 1, NO = indexSet 2
        const [yesCollResult, noCollResult] = await client.multicall({
            contracts: [
                { address: ct, abi: CT_ABI, functionName: "getCollectionId", args: [ZERO_BYTES32, conditionId, 1n] },
                { address: ct, abi: CT_ABI, functionName: "getCollectionId", args: [ZERO_BYTES32, conditionId, 2n] }
            ],
            allowFailure: true
        });

        if (yesCollResult.status !== "success" || noCollResult.status !== "success") {
            return null;
        }

        const yesColl = yesCollResult.result as `0x${string}`;
        const noColl = noCollResult.result as `0x${string}`;

        // Derive position IDs
        const [yesPosResult, noPosResult] = await client.multicall({
            contracts: [
                { address: ct, abi: CT_ABI, functionName: "getPositionId", args: [collateral, yesColl] },
                { address: ct, abi: CT_ABI, functionName: "getPositionId", args: [collateral, noColl] }
            ],
            allowFailure: true
        });

        if (yesPosResult.status !== "success" || noPosResult.status !== "success") {
            return null;
        }

        const entry = {
            ctAddress: ct,
            conditionId: conditionId as `0x${string}`,
            yesId: yesPosResult.result as bigint,
            noId: noPosResult.result as bigint
        };
        fpmmCache.set(fpmmAddress, entry);
        return entry;
    } catch {
        return null;
    }
}

export async function getConditionalTokensAddress(
    fpmmAddress: `0x${string}`
): Promise<`0x${string}`> {
    const client = createViemClient();
    const result = await client.readContract({
        address: fpmmAddress,
        abi: FPMM_ABI,
        functionName: "conditionalTokens"
    });
    return result;
}

function emptySnapshot(account: `0x${string}`): PortfolioPositionsSnapshot {
    return {
        account,
        fetchedAt: new Date().toISOString(),
        active: [],
        settled: [],
        totals: {
            activeMarketValueUsdc: "0",
            unrealizedPnlUsdc: "0",
            claimableUsdc: "0"
        }
    };
}

function formatUsdc(value: number): string {
    return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function isVerifiedActivePrice(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function multicallInChunks(
    client: ReturnType<typeof createViemClient>,
    contracts: readonly unknown[],
    chunkSize = 40
) {
    const results: Array<{ status: string; result?: unknown }> = [];

    for (let index = 0; index < contracts.length; index += chunkSize) {
        const chunk = contracts.slice(index, index + chunkSize) as Parameters<typeof client.multicall>[0]["contracts"];
        const chunkResults = await client.multicall({
            contracts: chunk,
            allowFailure: true
        });
        results.push(...(chunkResults as Array<{ status: string; result?: unknown }>));
    }

    return results;
}

async function resolveMarketsWithIds(
    client: ReturnType<typeof createViemClient>,
    markets: AmmMarketRef[],
    chunkSize = 4
) {
    const resolved: Array<{
        market: AmmMarketRef;
        ids: { ctAddress: `0x${string}`; conditionId: `0x${string}`; yesId: bigint; noId: bigint } | null;
    }> = [];

    for (let index = 0; index < markets.length; index += chunkSize) {
        const chunk = markets.slice(index, index + chunkSize);
        const chunkResolved = await Promise.all(
            chunk.map(async (market) => ({
                market,
                ids: await getFpmmPositionIds(market.contractAddress as `0x${string}`, client)
            }))
        );
        resolved.push(...chunkResolved);
    }

    return resolved;
}

function resolveCostBasisEntry(
    costBasisMap: Record<string, PositionCostBasisEntry>,
    market: AmmMarketRef,
    side: "yes" | "no"
): PositionCostBasisEntry | null {
    const contractAddress = market.contractAddress.toLowerCase();
    const marketId = market.id.toLowerCase();
    const marketSlug = market.slug.toLowerCase();

    return (
        costBasisMap[`${contractAddress}:${side}`]
        ?? costBasisMap[`${marketId}:${side}`]
        ?? costBasisMap[`${marketSlug}:${side}`]
        ?? null
    );
}

function computeRemainingCostUsdc(
    entry: PositionCostBasisEntry | null,
    currentShares: number
): string | null {
    if (!entry) {
        return null;
    }

    const totalCost = Number(entry.costUsdc);
    if (!Number.isFinite(totalCost)) {
        return null;
    }

    const totalShares = entry.tokenAmount ? Number(entry.tokenAmount) : Number.NaN;
    if (Number.isFinite(totalShares) && totalShares > 0) {
        if (!(currentShares > 0)) {
            return "0";
        }

        const ratio = Math.min(currentShares / totalShares, 1);
        return formatUsdc(totalCost * ratio);
    }

    return formatUsdc(totalCost);
}

export async function fetchOnchainAmmPositions(
    walletAddress: `0x${string}`,
    markets: AmmMarketRef[],
    costBasisMap: Record<string, PositionCostBasisEntry> = {}
): Promise<PortfolioPositionsSnapshot> {
    const validMarkets = markets.filter((m) => isAddress(m.contractAddress));

    if (validMarkets.length === 0) {
        return emptySnapshot(walletAddress);
    }

    const client = createViemClient();

    // Resolve position IDs for each FPMM from chain (not from API positionIds)
    const resolved = await resolveMarketsWithIds(client, validMarkets);

    const withIds = resolved.filter((r) => r.ids !== null) as Array<{
        market: AmmMarketRef;
        ids: { ctAddress: `0x${string}`; conditionId: `0x${string}`; yesId: bigint; noId: bigint };
    }>;

    if (withIds.length === 0) {
        return emptySnapshot(walletAddress);
    }

    // Batch balanceOf calls — 2 per market (YES + NO)
    const contracts = withIds.flatMap(({ ids }) => [
        {
            address: ids.ctAddress,
            abi: CT_ABI,
            functionName: "balanceOf" as const,
            args: [walletAddress, ids.yesId] as const
        },
        {
            address: ids.ctAddress,
            abi: CT_ABI,
            functionName: "balanceOf" as const,
            args: [walletAddress, ids.noId] as const
        }
    ]);

    let results: Array<{ status: string; result?: unknown }>;
    try {
        results = await multicallInChunks(client, contracts);
    } catch {
        return emptySnapshot(walletAddress);
    }

    const SHARES_SCALE = 1e6;
    const positions: TrackedPosition[] = [];

    // Check payout status for each market's conditionId (is it resolved?)
    const payoutContracts = withIds.map(({ ids }) => ({
        address: ids.ctAddress,
        abi: CT_ABI,
        functionName: "payoutDenominator" as const,
        args: [ids.conditionId] as const
    }));

    let payoutResults: Array<{ status: string; result?: unknown }> = [];
    try {
        payoutResults = await multicallInChunks(client, payoutContracts);
    } catch { /* non-fatal */ }

    // For resolved markets, get payout numerators for YES (index 0) and NO (index 1)
    const payoutNumeratorContracts = withIds.flatMap(({ ids }) => [
        { address: ids.ctAddress, abi: CT_ABI, functionName: "payoutNumerators" as const, args: [ids.conditionId, 0n] as const },
        { address: ids.ctAddress, abi: CT_ABI, functionName: "payoutNumerators" as const, args: [ids.conditionId, 1n] as const }
    ]);

    let numeratorResults: Array<{ status: string; result?: unknown }> = [];
    try {
        numeratorResults = await multicallInChunks(client, payoutNumeratorContracts);
    } catch { /* non-fatal */ }

    for (let i = 0; i < withIds.length; i++) {
        const { market } = withIds[i];
        const yesResult = results[i * 2];
        const noResult = results[i * 2 + 1];

        // Determine if market is resolved
        type McEntry = { status: string; result: unknown };
        const payoutDenomEntry = payoutResults[i] as McEntry | undefined;
        const payoutDenom = payoutDenomEntry?.status === "success" ? BigInt(String(payoutDenomEntry.result)) : 0n;
        const isResolved = payoutDenom > 0n;

        // Payout numerators: YES = index 0, NO = index 1
        const yesNumEntry = numeratorResults[i * 2] as McEntry | undefined;
        const noNumEntry = numeratorResults[i * 2 + 1] as McEntry | undefined;
        const yesNumerator = yesNumEntry?.status === "success" ? BigInt(String(yesNumEntry.result)) : 0n;
        const noNumerator = noNumEntry?.status === "success" ? BigInt(String(noNumEntry.result)) : 0n;

        const sides: Array<{ result: McEntry; side: "yes" | "no"; price: number | undefined; outcomeIndex: 0 | 1 }> = [
            { result: yesResult as McEntry, side: "yes", price: market.yesPrice, outcomeIndex: 0 },
            { result: noResult as McEntry, side: "no", price: market.noPrice, outcomeIndex: 1 }
        ];

        for (const { result, side, price, outcomeIndex } of sides) {
            if (result.status !== "success") continue;

            const balance = BigInt(String(result.result));
            const shares = Number(balance) / SHARES_SCALE;

            const costBasisEntry = resolveCostBasisEntry(costBasisMap, market, side);
            const actualCost = computeRemainingCostUsdc(costBasisEntry, shares);

            if (isResolved) {
                // Settled market: value = tokens × (payout numerator / denominator)
                const numerator = outcomeIndex === 0 ? yesNumerator : noNumerator;
                const payoutRatio = Number(numerator) / Number(payoutDenom);
                const redeemableUsdcNum = shares * payoutRatio;
                const redeemableUsdc = formatUsdc(redeemableUsdcNum);
                const isWinner = numerator > 0n;

                // Zero-balance settled history must come from transfer history, not inferred on-chain.
                if (balance <= 0n) continue;

                // Calculate PNL based on real cost or default to 0
                const costNum = actualCost ? Number(actualCost) : 0;
                const pnlNum = redeemableUsdcNum - costNum;
                // Avoid displaying extremely large negative PNLs if cost basis was completely misaligned
                const pnlUsdc = actualCost ? formatUsdc(pnlNum) : "0";

                positions.push({
                    id: `${market.id}:${side}`,
                    marketId: market.id,
                    marketSlug: market.slug,
                    marketTitle: market.title,
                    side,
                    status: "settled",
                    costUsdc: actualCost || "0", // Use true cost or 0
                    marketValueUsdc: redeemableUsdc,
                    unrealizedPnlUsdc: "0",
                    realizedPnlUsdc: pnlUsdc,    // Show accurate Realized PNL for closed positions
                    claimable: isWinner && balance > 0n,
                    tokenBalance: formatUsdc(shares),
                    currentPrice: payoutRatio,
                    hasVerifiedPricing: true,
                    endsAt: market.endsAt
                });
            } else {
                if (balance <= 0n) continue;

                const hasVerifiedPrice = isVerifiedActivePrice(price);
                const valueNum = hasVerifiedPrice ? shares * price : 0;

                // Calculate unrealized PNL
                const costNum = actualCost ? Number(actualCost) : 0;
                const pnlNum = valueNum - costNum;
                const pnlUsdc = actualCost && hasVerifiedPrice ? formatUsdc(pnlNum) : "0";

                positions.push({
                    id: `${market.id}:${side}`,
                    marketId: market.id,
                    marketSlug: market.slug,
                    marketTitle: market.title,
                    side,
                    status: "active",
                    costUsdc: actualCost || "0",
                    marketValueUsdc: hasVerifiedPrice ? formatUsdc(valueNum) : "0",
                    unrealizedPnlUsdc: pnlUsdc,
                    realizedPnlUsdc: "0",
                    claimable: false,
                    tokenBalance: formatUsdc(shares),
                    currentPrice: hasVerifiedPrice ? price : undefined,
                    hasVerifiedPricing: hasVerifiedPrice,
                    endsAt: market.endsAt
                });
            }
        }
    }

    const active = positions.filter(
        (p) => p.status === "active" && (Number(p.marketValueUsdc) > 0 || Number(p.tokenBalance) > 0)
    );
    const settled = positions.filter((p) => p.status === "settled");
    const totalActiveValue = active.reduce((sum, p) => sum + Number(p.marketValueUsdc), 0);
    const totalClaimable = settled.filter((p) => p.claimable).reduce((sum, p) => sum + Number(p.marketValueUsdc), 0);

    return {
        account: walletAddress,
        fetchedAt: new Date().toISOString(),
        active,
        settled,
        totals: {
            activeMarketValueUsdc: formatUsdc(totalActiveValue),
            unrealizedPnlUsdc: formatUsdc(active.reduce((sum, p) => sum + Number(p.unrealizedPnlUsdc), 0)),
            claimableUsdc: formatUsdc(totalClaimable)
        }
    };
}
