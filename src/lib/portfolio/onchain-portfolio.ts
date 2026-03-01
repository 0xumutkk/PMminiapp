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

import { createPublicClient, http, parseAbi, isAddress } from "viem";
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
    yesPrice: number;
    noPrice: number;
};

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const CT_ADDRESS = "0xC9c98965297Bc527861c898329Ee280632B76e18";

function createViemClient() {
    const rpcUrl =
        process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";
    return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

/**
 * Fetch FPMM contract addresses from the wallet's ERC-1155 transfer history
 * via Blockscout. These are the contracts that sent CT tokens to the wallet
 * — each represents a market where the user has (or had) a position.
 */
export async function fetchFpmmAddressesFromHistory(account: string): Promise<string[]> {
    try {
        const url = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=to`;
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) return [];
        const payload = (await response.json()) as { items?: unknown[] };
        const items = Array.isArray(payload.items) ? payload.items : [];
        const fpmmAddresses = new Set<string>();
        for (const item of items) {
            if (typeof item !== "object" || item === null) continue;
            const r = item as Record<string, unknown>;
            if (r.token_type !== "ERC-1155") continue;
            const token = r.token as Record<string, unknown> | undefined;
            if (token?.address_hash !== CT_ADDRESS) continue;
            const from = r.from as Record<string, unknown> | undefined;
            const fromHash = typeof from?.hash === "string" ? from.hash : undefined;
            if (fromHash && isAddress(fromHash)) fpmmAddresses.add(fromHash);
        }
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

export async function fetchOnchainAmmPositions(
    walletAddress: `0x${string}`,
    markets: AmmMarketRef[]
): Promise<PortfolioPositionsSnapshot> {
    const validMarkets = markets.filter((m) => isAddress(m.contractAddress));

    if (validMarkets.length === 0) {
        return emptySnapshot(walletAddress);
    }

    const client = createViemClient();

    // Resolve position IDs for each FPMM from chain (not from API positionIds)
    const resolved = await Promise.all(
        validMarkets.map(async (m) => {
            const ids = await getFpmmPositionIds(m.contractAddress as `0x${string}`, client);
            return { market: m, ids };
        })
    );

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

    let results: Awaited<ReturnType<typeof client.multicall>>;
    try {
        results = await client.multicall({ contracts, allowFailure: true });
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

    let payoutResults: Awaited<ReturnType<typeof client.multicall>> = [];
    try {
        payoutResults = await client.multicall({ contracts: payoutContracts, allowFailure: true });
    } catch { /* non-fatal */ }

    // For resolved markets, get payout numerators for YES (index 0) and NO (index 1)
    const payoutNumeratorContracts = withIds.flatMap(({ ids }) => [
        { address: ids.ctAddress, abi: CT_ABI, functionName: "payoutNumerators" as const, args: [ids.conditionId, 0n] as const },
        { address: ids.ctAddress, abi: CT_ABI, functionName: "payoutNumerators" as const, args: [ids.conditionId, 1n] as const }
    ]);

    let numeratorResults: Awaited<ReturnType<typeof client.multicall>> = [];
    try {
        numeratorResults = await client.multicall({ contracts: payoutNumeratorContracts, allowFailure: true });
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

        const sides: Array<{ result: McEntry; side: "yes" | "no"; price: number; outcomeIndex: 0 | 1 }> = [
            { result: yesResult as McEntry, side: "yes", price: market.yesPrice, outcomeIndex: 0 },
            { result: noResult as McEntry, side: "no", price: market.noPrice, outcomeIndex: 1 }
        ];

        for (const { result, side, price, outcomeIndex } of sides) {
            if (result.status !== "success") continue;

            const balance = BigInt(String(result.result));
            if (balance <= 0n) continue;

            const shares = Number(balance) / SHARES_SCALE;

            if (isResolved) {
                // Settled market: value = tokens × (payout numerator / denominator)
                const numerator = outcomeIndex === 0 ? yesNumerator : noNumerator;
                const payoutRatio = Number(numerator) / Number(payoutDenom);
                const redeemableUsdc = formatUsdc(shares * payoutRatio);
                const isWinner = numerator > 0n;

                positions.push({
                    id: `${market.id}:${side}`,
                    marketId: market.id,
                    marketSlug: market.slug,
                    marketTitle: market.title,
                    side,
                    status: "settled",
                    costUsdc: formatUsdc(shares), // original 1:1 cost approximation
                    marketValueUsdc: redeemableUsdc,
                    unrealizedPnlUsdc: "0",
                    realizedPnlUsdc: "0",
                    claimable: isWinner,
                    tokenBalance: formatUsdc(shares),
                    currentPrice: payoutRatio
                });
            } else {
                // Active market
                const marketValueUsdc = formatUsdc(shares * price);
                positions.push({
                    id: `${market.id}:${side}`,
                    marketId: market.id,
                    marketSlug: market.slug,
                    marketTitle: market.title,
                    side,
                    status: "active",
                    costUsdc: marketValueUsdc,
                    marketValueUsdc,
                    unrealizedPnlUsdc: "0",
                    realizedPnlUsdc: "0",
                    claimable: false,
                    tokenBalance: formatUsdc(shares),
                    currentPrice: price
                });
            }
        }
    }

    const active = positions.filter((p) => p.status === "active");
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
            unrealizedPnlUsdc: "0",
            claimableUsdc: formatUsdc(totalClaimable)
        }
    };
}
