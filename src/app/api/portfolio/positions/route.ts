import {
  fetchPublicPortfolioPositions,
  type PortfolioPositionsSnapshot,
  type TrackedPosition
} from "@/lib/portfolio/limitless-portfolio";
import { MIN_VISIBLE_ACTIVE_SHARES } from "@/lib/portfolio/visible-active-positions";
import {
  fetchOnchainAmmPositions,
  type AmmMarketRef,
  type PositionCostBasisEntry
} from "@/lib/portfolio/onchain-portfolio";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getSecurityRedisClient } from "@/lib/security/redis-store";
import { isAddress } from "viem";
import * as fs from "node:fs";

export const runtime = "nodejs";
const ACTIVE_MARKET_PAGE_LIMIT = 6;
const ONCHAIN_ENRICH_TIMEOUT_MS = 20_000;
const LIGHT_ONCHAIN_ENRICH_TIMEOUT_MS = 12_000;
const HISTORY_SUMMARY_TIMEOUT_MS = 8_000;
const SNAPSHOT_CACHE_TTL_SECONDS = 300;
const FAST_SNAPSHOT_MAX_AGE_MS = 20_000;
const STALE_SNAPSHOT_MAX_AGE_MS = SNAPSHOT_CACHE_TTL_SECONDS * 1000;
const ACTIVE_SNAPSHOT_VALUE_DROP_RATIO = 0.5;
const SETTLED_SNAPSHOT_COUNT_DROP_RATIO = 0.5;

/**
 * Fetch all active AMM markets from the Limitless API and return the subset
 * that have positionIds — required for on-chain balance reading.
 */
const CT_ADDRESS = "0xC9c98965297Bc527861c898329Ee280632B76e18";
const CT_ADDRESS_LOWER = CT_ADDRESS.toLowerCase();
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ADDRESS_LOWER = USDC_ADDRESS.toLowerCase();

type PositionSide = TrackedPosition["side"];

type HistoryTransferRecord = {
  txHash: string;
  contractAddress?: string;
  tokenAmountRaw: string;
  tokenId?: string;
  timestamp?: string;
};

type HistoryMarketAction = {
  action: "sell" | "redeem";
  contractAddress: string;
  tokenId: string;
  txHash?: string;
  timestamp?: string;
  proceedsUsdc?: string;
};

type HistoricalActionState = {
  action: "sell" | "redeem";
  proceedsUsdc: string;
  timestamp?: string;
};

type TransferHistorySummary = {
  fpmmAddresses: string[];
  costBasisMap: Record<string, PositionCostBasisEntry>;
  tokenCostBasisMap: Record<string, PositionCostBasisEntry>;
  tokenSideMap: Record<string, PositionSide>;
  marketActions: HistoryMarketAction[];
  inboundPositionTokens: HistoryInboundPositionToken[];
};

type HistoryInboundPositionToken = {
  contractAddress: string;
  tokenId: string;
  timestamp?: string;
};

type RecentIncomingTransfer = {
  contractAddress: string;
  tokenAmountRaw: string;
  tokenId: string;
  txHash?: string;
  timestamp?: string;
};

type RecentOutgoingTransfer = {
  contractAddress: string;
  tokenAmountRaw: string;
  tokenId: string;
  txHash?: string;
  timestamp?: string;
  action: "sell" | "redeem";
};

type BlockscoutHistoryEvent = {
  direction: "in" | "out";
  action: "buy" | "sell" | "redeem";
  contractAddress?: string;
  tokenId: string;
  tokenAmount: string;
  txHash?: string;
  timestamp?: string;
};

function getBaseRpcUrls() {
  return [
    process.env.NEXT_PUBLIC_BASE_RPC_URL,
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://mainnet.base.org"
  ].filter((value, index, self): value is string => Boolean(value) && self.indexOf(value) === index);
}

async function callRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<T | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: 1
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { result?: T };
    return payload.result ?? null;
  } catch {
    return null;
  }
}

function normalizeRawTokenAmount(raw: unknown, decimals: number) {
  if (raw === null || raw === undefined) {
    return "0";
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw.toString();
  }

  if (typeof raw !== "string") {
    return "0";
  }

  const value = raw.trim();
  if (!value) {
    return "0";
  }

  if (!/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toString() : "0";
  }

  const unit = 10n ** BigInt(Math.max(0, decimals));
  const amount = BigInt(value);
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(Math.max(1, decimals), "0").replace(/0+$/, "");

  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function extractDecodedParameterValue(parameters: unknown, index: number) {
  if (!Array.isArray(parameters)) {
    return undefined;
  }

  const parameter = parameters[index];
  if (!parameter || typeof parameter !== "object") {
    return undefined;
  }

  const value = (parameter as Record<string, unknown>).value;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function parseOutcomeSide(raw: unknown): PositionSide | null {
  if (raw === "0" || raw === 0) {
    return "yes";
  }
  if (raw === "1" || raw === 1) {
    return "no";
  }
  return null;
}

async function fetchRecentIncomingCtTransfers(account: string): Promise<RecentIncomingTransfer[]> {
  const rpcUrls = getBaseRpcUrls();
  const TRANSFER_SINGLE_TOPIC =
    "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
  const zeroTopic = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const accountTopic = `0x${account.toLowerCase().slice(2).padStart(64, "0")}`;

  for (const rpcUrl of rpcUrls) {
    try {
      const blockNumberResponse = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1
        }),
        signal: AbortSignal.timeout(5_000)
      });

      if (!blockNumberResponse.ok) {
        continue;
      }

      const blockNumberPayload = (await blockNumberResponse.json()) as { result?: string };
      const latestBlock = blockNumberPayload.result ? Number(BigInt(blockNumberPayload.result)) : Number.NaN;
      if (!Number.isFinite(latestBlock) || latestBlock <= 0) {
        continue;
      }

      const transfers: RecentIncomingTransfer[] = [];
      const fromBlock = Math.max(0, latestBlock - 60_000);
      for (let windowEnd = latestBlock; windowEnd >= fromBlock; windowEnd -= 5_000) {
        const windowStart = Math.max(fromBlock, windowEnd - 4_999);
        const logs = await callRpc<unknown[]>(
          rpcUrl,
          "eth_getLogs",
          [{
            address: CT_ADDRESS,
            fromBlock: `0x${windowStart.toString(16)}`,
            toBlock: `0x${windowEnd.toString(16)}`,
            topics: [TRANSFER_SINGLE_TOPIC, null, null, accountTopic]
          }],
          8_000
        );

        if (!Array.isArray(logs)) {
          continue;
        }

        for (const entry of logs) {
          if (!entry || typeof entry !== "object") continue;
          const log = entry as Record<string, unknown>;
          const topics = Array.isArray(log.topics) ? log.topics : [];
          const data = typeof log.data === "string" ? log.data : "";
          if (topics.length < 4 || !data.startsWith("0x") || data.length < 130) continue;

          const operatorTopic = typeof topics[1] === "string" ? topics[1] : zeroTopic;
          const fromTopic = typeof topics[2] === "string" ? topics[2] : zeroTopic;
          const operatorAddress = `0x${operatorTopic.slice(-40)}`;
          const fromAddress = `0x${fromTopic.slice(-40)}`;
          const contractAddress = [operatorAddress, fromAddress].find((candidate) => {
            const normalized = candidate.toLowerCase();
            return normalized !== zeroAddress && normalized !== CT_ADDRESS_LOWER && isAddress(candidate);
          });

          if (!contractAddress) continue;

          try {
            const raw = data.slice(2);
            const tokenId = BigInt(`0x${raw.slice(0, 64)}`).toString();
            const tokenAmountRaw = BigInt(`0x${raw.slice(64, 128)}`).toString();
            transfers.push({
              contractAddress: contractAddress.toLowerCase(),
              tokenId,
              tokenAmountRaw,
              txHash: typeof log.transactionHash === "string" ? log.transactionHash : undefined,
              timestamp:
                typeof log.blockTimestamp === "string"
                  ? new Date(Number(BigInt(log.blockTimestamp)) * 1000).toISOString()
                  : undefined
            });
          } catch {
            continue;
          }
        }
      }

      if (transfers.length > 0) {
        return transfers;
      }
    } catch {
      continue;
    }
  }

  return [];
}

async function fetchRecentOutgoingCtTransfers(account: string): Promise<RecentOutgoingTransfer[]> {
  const rpcUrls = getBaseRpcUrls();
  const TRANSFER_SINGLE_TOPIC =
    "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
  const zeroTopic = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const accountTopic = `0x${account.toLowerCase().slice(2).padStart(64, "0")}`;

  for (const rpcUrl of rpcUrls) {
    try {
      const latestBlockHex = await callRpc<string>(rpcUrl, "eth_blockNumber", [], 5_000);
      const latestBlock = latestBlockHex ? Number(BigInt(latestBlockHex)) : Number.NaN;
      if (!Number.isFinite(latestBlock) || latestBlock <= 0) {
        continue;
      }

      const transfers: RecentOutgoingTransfer[] = [];
      const fromBlock = Math.max(0, latestBlock - 60_000);
      for (let windowEnd = latestBlock; windowEnd >= fromBlock; windowEnd -= 5_000) {
        const windowStart = Math.max(fromBlock, windowEnd - 4_999);
        const logs = await callRpc<unknown[]>(
          rpcUrl,
          "eth_getLogs",
          [{
            address: CT_ADDRESS,
            fromBlock: `0x${windowStart.toString(16)}`,
            toBlock: `0x${windowEnd.toString(16)}`,
            topics: [TRANSFER_SINGLE_TOPIC, null, accountTopic, null]
          }],
          8_000
        );

        if (!Array.isArray(logs)) {
          continue;
        }

        for (const entry of logs) {
          if (!entry || typeof entry !== "object") continue;
          const log = entry as Record<string, unknown>;
          const topics = Array.isArray(log.topics) ? log.topics : [];
          const data = typeof log.data === "string" ? log.data : "";
          if (topics.length < 4 || !data.startsWith("0x") || data.length < 130) continue;

          const operatorTopic = typeof topics[1] === "string" ? topics[1] : zeroTopic;
          const toTopic = typeof topics[3] === "string" ? topics[3] : zeroTopic;
          const operatorAddress = `0x${operatorTopic.slice(-40)}`;
          const toAddress = `0x${toTopic.slice(-40)}`;
          const contractAddress = [operatorAddress, toAddress].find((candidate) => {
            const normalized = candidate.toLowerCase();
            return normalized !== zeroAddress && normalized !== CT_ADDRESS_LOWER && isAddress(candidate);
          });

          try {
            const raw = data.slice(2);
            const tokenId = BigInt(`0x${raw.slice(0, 64)}`).toString();
            const tokenAmountRaw = BigInt(`0x${raw.slice(64, 128)}`).toString();
            transfers.push({
              action: toAddress.toLowerCase() === zeroAddress ? "redeem" : "sell",
              contractAddress: contractAddress?.toLowerCase() ?? "",
              tokenId,
              tokenAmountRaw,
              txHash: typeof log.transactionHash === "string" ? log.transactionHash : undefined,
              timestamp:
                typeof log.blockTimestamp === "string"
                  ? new Date(Number(BigInt(log.blockTimestamp)) * 1000).toISOString()
                  : undefined
            });
          } catch {
            continue;
          }
        }
      }

      if (transfers.length > 0) {
        return transfers;
      }
    } catch {
      continue;
    }
  }

  return [];
}

async function fetchRpcTransactionMeta(
  txHash: string,
  account: string
): Promise<{ contractAddress?: string; costUsdc?: string; proceedsUsdc?: string } | null> {
  const accountLower = account.toLowerCase();
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  for (const rpcUrl of getBaseRpcUrls()) {
    const [tx, receipt] = await Promise.all([
      callRpc<Record<string, unknown>>(rpcUrl, "eth_getTransactionByHash", [txHash], 5_000),
      callRpc<Record<string, unknown>>(rpcUrl, "eth_getTransactionReceipt", [txHash], 5_000)
    ]);

    if (!tx && !receipt) {
      continue;
    }

    const to = typeof tx?.to === "string" ? tx.to : undefined;
    const contractAddress = to && isAddress(to) ? to.toLowerCase() : undefined;
    const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
    let rawUsdcSpent = 0n;
    let rawUsdcReceived = 0n;

    for (const entry of logs) {
      if (!entry || typeof entry !== "object") continue;
      const log = entry as Record<string, unknown>;
      if (typeof log.address !== "string" || log.address.toLowerCase() !== USDC_ADDRESS_LOWER) {
        continue;
      }

      const topics = Array.isArray(log.topics) ? log.topics : [];
      const data = typeof log.data === "string" ? log.data : "";
      if (
        topics.length < 3 ||
        typeof topics[0] !== "string" ||
        topics[0].toLowerCase() !== transferTopic ||
        !data.startsWith("0x")
      ) {
        continue;
      }

      const fromAddress = typeof topics[1] === "string" ? `0x${topics[1].slice(-40)}`.toLowerCase() : "";
      const toAddress = typeof topics[2] === "string" ? `0x${topics[2].slice(-40)}`.toLowerCase() : "";
      const amount = BigInt(data);

      if (fromAddress === accountLower) {
        rawUsdcSpent += amount;
      }
      if (toAddress === accountLower) {
        rawUsdcReceived += amount;
      }
    }

    return {
      contractAddress,
      costUsdc: rawUsdcSpent > 0n ? normalizeRawTokenAmount(rawUsdcSpent.toString(), 6) : undefined,
      proceedsUsdc: rawUsdcReceived > 0n ? normalizeRawTokenAmount(rawUsdcReceived.toString(), 6) : undefined
    };
  }

  return null;
}

/**
 * Fetch recent ERC-1155 receipts for the wallet and derive two things:
 * 1. FPMM addresses seen in history, so we can still discover historical markets.
 * 2. Fallback cost basis for active positions by inspecting buy transactions.
 *
 * This is the critical fallback when the public portfolio API rate-limits and
 * returns no cost basis, which otherwise forces Active PNL to stay at zero.
 */
async function fetchTransferHistorySummary(account: string): Promise<TransferHistorySummary> {
  const accountLower = account.toLowerCase();
  try {
    const fpmmAddresses = new Set<string>();
    const transferRecords: HistoryTransferRecord[] = [];
    const tokenSideMap: Record<string, PositionSide> = {};
    const marketActions: HistoryMarketAction[] = [];
    const inboundPositionTokens: HistoryInboundPositionToken[] = [];
    const txHashes = new Set<string>();
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const inboundTokenKeys = new Set<string>();
    const usdcSpentByTx = new Map<string, bigint>();
    const usdcReceivedByTx = new Map<string, bigint>();

    let nextPageParams: string | null = null;
    for (let page = 0; page < 6; page++) {
      const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=to&type=ERC-1155`;
      const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          // @ts-ignore
          next: { revalidate: 0 },
          signal: AbortSignal.timeout(8000)
        });
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
          const txHash =
            (typeof r.transaction_hash === "string" ? r.transaction_hash : undefined) ??
            (typeof r.tx_hash === "string" ? r.tx_hash : undefined);
          const total = r.total as Record<string, unknown> | undefined;
          const timestamp = typeof r.timestamp === "string" ? r.timestamp : undefined;
          const tokenAmountRaw =
            typeof total?.value === "string"
              ? total.value
              : typeof total?.value === "number"
                ? String(total.value)
                : undefined;
          const tokenId =
            typeof total?.token_id === "string"
              ? total.token_id
              : typeof total?.token_id === "number"
                ? String(total.token_id)
                : undefined;

          if (fromHash && fromHash !== ZERO_ADDRESS && isAddress(fromHash)) {
            if (from?.is_contract === true && fromHash !== CT_ADDRESS_LOWER) {
              fpmmAddresses.add(fromHash);
            }
            if (txHash && tokenAmountRaw) {
              transferRecords.push({
                txHash,
                contractAddress: fromHash,
                tokenAmountRaw,
                tokenId,
                timestamp
              });
              txHashes.add(txHash);
            }
          } else if (txHash && tokenAmountRaw) {
            transferRecords.push({ txHash, tokenAmountRaw, tokenId, timestamp });
            txHashes.add(txHash);
          }
        }

        if (payload.next_page_params && typeof payload.next_page_params === "object") {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(payload.next_page_params)) {
            if (value !== null && value !== undefined) {
              params.set(key, String(value));
            }
          }
          nextPageParams = params.toString();
        } else {
          break;
        }
      } catch (e) {
        console.warn("Blockscout fetch failed:", e);
        break;
      }
    }

    nextPageParams = null;
    for (let page = 0; page < 6; page++) {
      const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=from&type=ERC-1155`;
      const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          // @ts-ignore
          next: { revalidate: 0 },
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) break;

        const payload = (await response.json()) as { items?: unknown[]; next_page_params?: Record<string, unknown> | null };
        const items = Array.isArray(payload.items) ? payload.items : [];

        for (const item of items) {
          if (typeof item !== "object" || item === null) continue;
          const r = item as Record<string, unknown>;
          if (r.token_type !== "ERC-1155") continue;

          const token = r.token as Record<string, unknown> | undefined;
          if (typeof token?.address_hash !== "string" || token.address_hash.toLowerCase() !== CT_ADDRESS_LOWER) continue;

          const to = r.to as Record<string, unknown> | undefined;
          const toHash = typeof to?.hash === "string" ? to.hash.toLowerCase() : undefined;
          const total = r.total as Record<string, unknown> | undefined;
          const timestamp = typeof r.timestamp === "string" ? r.timestamp : undefined;
          const txHash =
            (typeof r.transaction_hash === "string" ? r.transaction_hash : undefined) ??
            (typeof r.tx_hash === "string" ? r.tx_hash : undefined);
          const tokenId =
            typeof total?.token_id === "string"
              ? total.token_id
              : typeof total?.token_id === "number"
                ? String(total.token_id)
                : undefined;

          if (!tokenId) continue;

          if (toHash && toHash !== ZERO_ADDRESS && isAddress(toHash)) {
            if (txHash) {
              txHashes.add(txHash);
            }
            marketActions.push({
              action: "sell",
              contractAddress: toHash,
              tokenId,
              txHash,
              timestamp
            });
          } else if (toHash === ZERO_ADDRESS) {
            if (txHash) {
              txHashes.add(txHash);
            }
            marketActions.push({
              action: "redeem",
              contractAddress: "",
              tokenId,
              txHash,
              timestamp
            });
          }
        }

        if (payload.next_page_params && typeof payload.next_page_params === "object") {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(payload.next_page_params)) {
            if (value !== null && value !== undefined) {
              params.set(key, String(value));
            }
          }
          nextPageParams = params.toString();
        } else {
          break;
        }
    } catch (e) {
      console.warn("Blockscout outgoing fetch failed:", e);
      break;
    }
  }

    const [recentIncomingTransfers, recentOutgoingTransfers] = await Promise.all([
      fetchRecentIncomingCtTransfers(account),
      fetchRecentOutgoingCtTransfers(account)
    ]);

    for (const transfer of recentIncomingTransfers) {
      fpmmAddresses.add(transfer.contractAddress);
      if (transfer.txHash) {
        txHashes.add(transfer.txHash);
      }
      transferRecords.push({
        txHash: transfer.txHash ?? `recent-in-${transfer.contractAddress}-${transfer.tokenId}`,
        contractAddress: transfer.contractAddress,
        tokenAmountRaw: transfer.tokenAmountRaw,
        tokenId: transfer.tokenId,
        timestamp: transfer.timestamp
      });
    }

    for (const transfer of recentOutgoingTransfers) {
      if (transfer.contractAddress) {
        fpmmAddresses.add(transfer.contractAddress);
      }
      if (transfer.txHash) {
        txHashes.add(transfer.txHash);
      }
      marketActions.push({
        action: transfer.action,
        contractAddress: transfer.contractAddress,
        tokenId: transfer.tokenId,
        txHash: transfer.txHash,
        timestamp: transfer.timestamp
      });
    }

    nextPageParams = null;
    for (let page = 0; page < 6; page++) {
      const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?type=ERC-20`;
      const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          // @ts-ignore
          next: { revalidate: 0 },
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) break;

        const payload = (await response.json()) as { items?: unknown[]; next_page_params?: Record<string, unknown> | null };
        const items = Array.isArray(payload.items) ? payload.items : [];

        for (const item of items) {
          if (typeof item !== "object" || item === null) continue;
          const r = item as Record<string, unknown>;
          const txHash =
            (typeof r.transaction_hash === "string" ? r.transaction_hash : undefined) ??
            (typeof r.tx_hash === "string" ? r.tx_hash : undefined);
          if (!txHash || (txHashes.size > 0 && !txHashes.has(txHash))) {
            continue;
          }

          const token = r.token as Record<string, unknown> | undefined;
          const tokenAddress = typeof token?.address_hash === "string" ? token.address_hash.toLowerCase() : undefined;
          if (tokenAddress !== USDC_ADDRESS_LOWER) {
            continue;
          }

          const total = r.total as Record<string, unknown> | undefined;
          const rawValue =
            typeof total?.value === "string"
              ? total.value
              : typeof total?.value === "number"
                ? String(total.value)
                : undefined;
          if (!rawValue) {
            continue;
          }

          const from = r.from as Record<string, unknown> | undefined;
          const to = r.to as Record<string, unknown> | undefined;
          const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
          const toHash = typeof to?.hash === "string" ? to.hash.toLowerCase() : undefined;
          const amount = BigInt(rawValue);

          if (fromHash === accountLower) {
            usdcSpentByTx.set(txHash, (usdcSpentByTx.get(txHash) ?? 0n) + amount);
          }
          if (toHash === accountLower) {
            usdcReceivedByTx.set(txHash, (usdcReceivedByTx.get(txHash) ?? 0n) + amount);
          }
        }

        if (payload.next_page_params && typeof payload.next_page_params === "object") {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(payload.next_page_params)) {
            if (value !== null && value !== undefined) {
              params.set(key, String(value));
            }
          }
          nextPageParams = params.toString();
        } else {
          break;
        }
      } catch (e) {
        console.warn("Blockscout ERC20 fetch failed:", e);
        break;
      }
    }

    const txMetaByHash = new Map<string, {
      contractAddress?: string;
      side: PositionSide | null;
      costUsdc?: string;
      proceedsUsdc?: string;
    }>();

    await Promise.all(
      Array.from(txHashes).slice(0, 150).map(async (txHash) => {
        try {
          const txUrl = `https://base.blockscout.com/api/v2/transactions/${txHash}`;
          const txResp = await fetch(txUrl, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5000) });
          if (!txResp.ok) {
            const rpcMeta = await fetchRpcTransactionMeta(txHash, account);
            const fallbackCostRaw = usdcSpentByTx.get(txHash) ?? 0n;
            const fallbackProceedsRaw = usdcReceivedByTx.get(txHash) ?? 0n;
            if (rpcMeta?.contractAddress) {
              fpmmAddresses.add(rpcMeta.contractAddress);
            }
            if (fallbackCostRaw > 0n || fallbackProceedsRaw > 0n || rpcMeta?.costUsdc || rpcMeta?.proceedsUsdc) {
              txMetaByHash.set(txHash, {
                contractAddress: rpcMeta?.contractAddress,
                side: null,
                costUsdc:
                  fallbackCostRaw > 0n
                    ? normalizeRawTokenAmount(fallbackCostRaw.toString(), 6)
                    : rpcMeta?.costUsdc,
                proceedsUsdc:
                  fallbackProceedsRaw > 0n
                    ? normalizeRawTokenAmount(fallbackProceedsRaw.toString(), 6)
                    : rpcMeta?.proceedsUsdc
              });
            }
            return;
          }
          const tx = (await txResp.json()) as Record<string, unknown>;
          const toRecord = tx.to as Record<string, unknown> | undefined;
          const toHash = typeof toRecord?.hash === "string" ? toRecord.hash.toLowerCase() : undefined;
          const contractAddress = toHash && isAddress(toHash) ? toHash : undefined;
          if (contractAddress) {
            fpmmAddresses.add(contractAddress);
          }

          const decodedInput = tx.decoded_input as Record<string, unknown> | undefined;
          const parameters = decodedInput?.parameters;
          const side = parseOutcomeSide(extractDecodedParameterValue(parameters, 1));

          let costUsdc: string | undefined;
          const investmentAmountRaw = extractDecodedParameterValue(parameters, 0);
          if (investmentAmountRaw) {
            costUsdc = normalizeRawTokenAmount(investmentAmountRaw, 6);
          }

          const tokenTransfers = Array.isArray(tx.token_transfers) ? tx.token_transfers : [];
          let rawUsdcSpent = 0n;
          let rawUsdcReceived = 0n;
          for (const transfer of tokenTransfers) {
            if (!transfer || typeof transfer !== "object") continue;
            const record = transfer as Record<string, unknown>;
            const token = record.token as Record<string, unknown> | undefined;
            const from = record.from as Record<string, unknown> | undefined;
            const to = record.to as Record<string, unknown> | undefined;
            const total = record.total as Record<string, unknown> | undefined;
            const tokenAddress = typeof token?.address_hash === "string" ? token.address_hash.toLowerCase() : undefined;
            const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
            const toHash = typeof to?.hash === "string" ? to.hash.toLowerCase() : undefined;
            const rawValue = typeof total?.value === "string" ? total.value : undefined;

            if (tokenAddress !== USDC_ADDRESS_LOWER || !rawValue) {
              continue;
            }

            const amount = BigInt(rawValue);
            if (fromHash === accountLower && (!contractAddress || toHash === contractAddress)) {
              rawUsdcSpent += amount;
            }
            if (toHash === accountLower) {
              rawUsdcReceived += amount;
            }
          }

          const fallbackSpentRaw = usdcSpentByTx.get(txHash) ?? 0n;
          const fallbackReceivedRaw = usdcReceivedByTx.get(txHash) ?? 0n;
          const rpcMeta =
            rawUsdcSpent === 0n && rawUsdcReceived === 0n && fallbackSpentRaw === 0n && fallbackReceivedRaw === 0n
              ? await fetchRpcTransactionMeta(txHash, account)
              : null;

          if (!costUsdc && rawUsdcSpent === 0n && fallbackSpentRaw > 0n) {
            rawUsdcSpent = fallbackSpentRaw;
          }

          if (rawUsdcReceived === 0n && fallbackReceivedRaw > 0n) {
            rawUsdcReceived = fallbackReceivedRaw;
          }

          if (!costUsdc && rawUsdcSpent === 0n && rpcMeta?.costUsdc) {
            costUsdc = rpcMeta.costUsdc;
          }

          if (rawUsdcReceived === 0n && rpcMeta?.proceedsUsdc) {
            rawUsdcReceived = BigInt(Math.round(Number(rpcMeta.proceedsUsdc) * 1_000_000));
          }

          if (!costUsdc && rawUsdcSpent > 0n) {
            costUsdc = normalizeRawTokenAmount(rawUsdcSpent.toString(), 6);
          }

          const proceedsUsdc =
            rawUsdcReceived > 0n ? normalizeRawTokenAmount(rawUsdcReceived.toString(), 6) : undefined;

          txMetaByHash.set(txHash, { contractAddress, side, costUsdc, proceedsUsdc });
        } catch { /* ignored */ }
      })
    );

    const uniqueTransferRecords = Array.from(
      new Map(
        transferRecords.map((transfer) => [
          `${transfer.txHash}:${transfer.contractAddress ?? ""}:${transfer.tokenId ?? ""}:${transfer.tokenAmountRaw}`,
          transfer
        ])
      ).values()
    );

    const uniqueMarketActions = Array.from(
      new Map(
        marketActions.map((action) => [
          `${action.action}:${action.contractAddress}:${action.tokenId}:${action.txHash ?? ""}`,
          action
        ])
      ).values()
    );

    const transfersByTx = new Map<string, HistoryTransferRecord[]>();
    for (const transfer of uniqueTransferRecords) {
      const bucket = transfersByTx.get(transfer.txHash) ?? [];
      bucket.push(transfer);
      transfersByTx.set(transfer.txHash, bucket);
    }

    const costBasisMap: Record<string, PositionCostBasisEntry> = {};
    const tokenCostBasisMap: Record<string, PositionCostBasisEntry> = {};
    for (const [txHash, transfers] of transfersByTx.entries()) {
      const meta = txMetaByHash.get(txHash);
      const contractAddress =
        meta?.contractAddress ??
        transfers.find((transfer) => transfer.contractAddress && isAddress(transfer.contractAddress))?.contractAddress;

      if (!contractAddress || !isAddress(contractAddress)) {
        continue;
      }

      fpmmAddresses.add(contractAddress.toLowerCase());
      const tokenAmountsById = new Map<string, string[]>();

      for (const transfer of transfers) {
        if (transfer.tokenId) {
          const inboundKey = `${contractAddress.toLowerCase()}:${transfer.tokenId}`;
          if (!inboundTokenKeys.has(inboundKey)) {
            inboundTokenKeys.add(inboundKey);
            inboundPositionTokens.push({
              contractAddress: contractAddress.toLowerCase(),
              tokenId: transfer.tokenId,
              timestamp: transfer.timestamp
            });
          }
          if (meta?.side) {
            tokenSideMap[inboundKey] = meta.side;
          }
          const tokenAmounts = tokenAmountsById.get(transfer.tokenId) ?? [];
          tokenAmounts.push(normalizeRawTokenAmount(transfer.tokenAmountRaw, 6));
          tokenAmountsById.set(transfer.tokenId, tokenAmounts);
        }
      }

      for (const [tokenId, tokenAmounts] of tokenAmountsById.entries()) {
        const tokenKey = `${contractAddress.toLowerCase()}:${tokenId}`;
        const previous = tokenCostBasisMap[tokenKey] ?? { costUsdc: "0", tokenAmount: "0" };
        tokenCostBasisMap[tokenKey] = {
          costUsdc: sumDecimalStrings([previous.costUsdc, meta?.costUsdc ?? "0"]),
          tokenAmount: sumDecimalStrings([previous.tokenAmount ?? "0", sumDecimalStrings(tokenAmounts)])
        };
      }

      if (!meta?.side || !meta.costUsdc) {
        continue;
      }

      const tokenAmount = sumDecimalStrings(
        transfers.map((transfer) => normalizeRawTokenAmount(transfer.tokenAmountRaw, 6))
      );
      const key = `${contractAddress.toLowerCase()}:${meta.side}`;
      const previous = costBasisMap[key] ?? { costUsdc: "0", tokenAmount: "0" };

      costBasisMap[key] = {
        costUsdc: sumDecimalStrings([previous.costUsdc, meta.costUsdc]),
        tokenAmount: sumDecimalStrings([previous.tokenAmount ?? "0", tokenAmount])
      };
    }

    const enrichedMarketActions = uniqueMarketActions.map((action) => {
      if (!action.txHash) {
        return action;
      }

      const meta = txMetaByHash.get(action.txHash);
      if (!meta?.proceedsUsdc) {
        return action;
      }

      return {
        ...action,
        proceedsUsdc: meta.proceedsUsdc
      };
    });

    return {
      fpmmAddresses: Array.from(fpmmAddresses),
      costBasisMap,
      tokenCostBasisMap,
      tokenSideMap,
      marketActions: enrichedMarketActions,
      inboundPositionTokens
    };
  } catch {
    return {
      fpmmAddresses: [],
      costBasisMap: {},
      tokenCostBasisMap: {},
      tokenSideMap: {},
      marketActions: [],
      inboundPositionTokens: []
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }),
    timeoutPromise
  ]);
}

async function fetchAmmMarketsForOnchain(
  historyAddresses: string[] = [],
  includeCatalog = true
): Promise<AmmMarketRef[]> {
  const baseUrl =
    (process.env.LIMITLESS_API_BASE_URL ?? "https://api.limitless.exchange")
      .replace(/\/api-v1\/?$/, "")
      .replace(/\/$/, "");

  const limit = 25;
  const redis = includeCatalog ? await getSecurityRedisClient() : null;
  const cacheKey = "pm-miniapp:amm-markets-raw-rows";
  const fetchHeaders = {
    Accept: "application/json",
    Origin: "https://limitless.exchange",
    Referer: "https://limitless.exchange/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  };

  function flattenLimitlessRows(input: any[]): any[] {
    const output: any[] = [];
    for (const row of input) {
      if (!row) continue;
      const nested = Array.isArray(row.markets) ? row.markets : [];
      if (nested.length > 0 && !Array.isArray(row.prices)) {
        output.push(...flattenLimitlessRows(nested));
        continue;
      }
      output.push(row);
      if (nested.length > 0) {
        output.push(...flattenLimitlessRows(nested));
      }
    }
    return output;
  }

  let rows: any[] = [];
  let cachedFound = false;

  async function fetchPage(pathname: string, page: number, extraParams?: Record<string, string>): Promise<{
    rows: unknown[];
    totalMarketsCount?: number;
  }> {
    try {
      const url = new URL(pathname, baseUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("sortBy", "ending_soon");
      url.searchParams.set("tradeType", "amm");
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
      }
      const response = await fetch(url.toString(), {
        headers: fetchHeaders,
        cache: "no-store",
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) {
        return { rows: [] };
      }
      const payload = (await response.json()) as { data?: unknown[]; totalMarketsCount?: unknown };
      const totalMarketsCount =
        typeof payload.totalMarketsCount === "number"
          ? payload.totalMarketsCount
          : typeof payload.totalMarketsCount === "string"
            ? Number(payload.totalMarketsCount)
            : undefined;
      return {
        rows: Array.isArray(payload.data) ? payload.data : [],
        totalMarketsCount: Number.isFinite(totalMarketsCount) ? totalMarketsCount : undefined
      };
    } catch {
      return { rows: [] };
    }
  }

  async function fetchActiveCatalogRows(forceRefresh = false) {
    if (!forceRefresh && rows.length > 0) {
      return rows;
    }

    if (!forceRefresh && redis && !cachedFound) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          rows = JSON.parse(cached);
          cachedFound = true;
          console.log(`[Positions API] Serving ${rows.length} raw rows from Redis cache`);
          return rows;
        }
      } catch (e) {
        console.warn("[Positions API] Redis get failed for raw rows:", e);
      }
    }

    const aggregatedRows: unknown[] = [];
    let totalPages = ACTIVE_MARKET_PAGE_LIMIT;

    for (let page = 1; page <= totalPages; page++) {
      const pageResult = await fetchPage("/markets/active", page);
      aggregatedRows.push(...pageResult.rows);

      if (page === 1 && pageResult.totalMarketsCount && pageResult.totalMarketsCount > 0) {
        totalPages = Math.min(
          ACTIVE_MARKET_PAGE_LIMIT,
          Math.max(1, Math.ceil(pageResult.totalMarketsCount / limit))
        );
      }

      if (pageResult.rows.length < limit) {
        break;
      }
    }

    rows = flattenLimitlessRows(aggregatedRows);
    cachedFound = rows.length > 0;

    if (redis && rows.length > 0) {
      try {
        await redis.set(cacheKey, JSON.stringify(rows), "EX", 300);
      } catch (e) {
        console.warn("[Positions API] Redis set failed for raw rows:", e);
      }
    }

    return rows;
  }

  // Try to get raw rows from Redis when we need the active market catalog.
  if (includeCatalog && redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        rows = JSON.parse(cached);
        cachedFound = true;
        console.log(`[Positions API] Serving ${rows.length} raw rows from Redis cache`);
      }
    } catch (e) {
      console.warn("[Positions API] Redis get failed for raw rows:", e);
    }
  }

  if (includeCatalog && !cachedFound) {
    rows = await fetchActiveCatalogRows(true);
  }

  const marketsMap = new Map<string, AmmMarketRef>();

  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;

    const slug = typeof r.slug === "string" ? r.slug : undefined;
    const title = typeof r.title === "string" ? r.title : slug ?? "Unknown";

    const venue = typeof r.venue === "object" && r.venue !== null ? (r.venue as any) : undefined;
    const address = (typeof r.address === "string" && isAddress(r.address) ? r.address : undefined)
      ?? (typeof venue?.exchange === "string" && isAddress(venue.exchange) ? venue.exchange : undefined);

    const rawPositionIds = r.positionIds;
    const prices = Array.isArray(r.prices) ? r.prices : [];
    const conditionId =
      typeof r.conditionId === "string" && /^0x[0-9a-fA-F]{64}$/.test(r.conditionId)
        ? (r.conditionId as `0x${string}`)
        : undefined;

    if (!slug || !address || !Array.isArray(rawPositionIds) || rawPositionIds.length < 2) continue;

    const toDecStr = (v: unknown): string | undefined => {
      if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(Math.round(v));
      return undefined;
    };

    const yesId = toDecStr(rawPositionIds[0]);
    const noId = toDecStr(rawPositionIds[1]);
    if (!yesId || !noId) continue;

    const addrKey = address.toLowerCase();
    if (!marketsMap.has(addrKey)) {
      marketsMap.set(addrKey, {
        id: slug,
        slug,
        title: String(title),
        contractAddress: address,
        positionIds: [yesId, noId],
        ...(typeof prices[0] === "number"
          ? (() => {
            const rawYes = prices[0];
            const yesPrice = rawYes > 1 ? rawYes / 100 : rawYes;
            const rawNo = typeof prices[1] === "number" ? prices[1] : 1 - yesPrice;
            let noPrice = rawNo > 1 ? rawNo / 100 : rawNo;

            if (Math.abs(yesPrice + noPrice - 1) > 0.05) {
              noPrice = Math.max(0, 1 - yesPrice);
            }

            return { yesPrice, noPrice };
          })()
          : {}),
        status: typeof r.status === "string" ? r.status : undefined,
        expired: r.expired === true,
        winningOutcomeIndex:
          typeof r.winningOutcomeIndex === "number" && (r.winningOutcomeIndex === 0 || r.winningOutcomeIndex === 1)
            ? r.winningOutcomeIndex
            : null,
        conditionId,
        conditionalTokensContract: conditionId ? CT_ADDRESS : undefined,
        endsAt: String(
          r.endsAt ??
          r.ends_at ??
          r.expirationTimestamp ??
          r.expirationDate ??
          r.resolved_at ??
          r.closed_at ??
          r.close_date ??
          ""
        ) || undefined
      });
    }
  }

  const existingAddresses = new Set(Array.from(marketsMap.values()).map((m) => m.contractAddress.toLowerCase()));

  for (const addr of historyAddresses) {
    const addrLower = addr.toLowerCase();
    if (existingAddresses.has(addrLower)) continue;

    if (!marketsMap.has(addrLower)) {
      const shortAddr = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      marketsMap.set(addrLower, {
        id: addrLower,
        slug: addrLower,
        title: `Market ${shortAddr}`,
        contractAddress: addr,
        winningOutcomeIndex: null,
        fromHistory: true
      });
    }
  }

  const fallbackEntries = Array.from(marketsMap.entries()).filter(([_, m]) => m.fromHistory);
  if (fallbackEntries.length > 0) {
    await Promise.all(fallbackEntries.map(async ([key, m]) => {
      const applyPriceSnapshot = (row: Record<string, unknown>) => {
        const prices = Array.isArray(row.prices) ? row.prices : [];
        const rawYes = typeof prices[0] === "number" ? prices[0] : undefined;
        if (rawYes === undefined) return false;

        const yesPrice = rawYes > 1 ? rawYes / 100 : rawYes;
        const rawNo = typeof prices[1] === "number" ? prices[1] : 1 - yesPrice;
        let noPrice = rawNo > 1 ? rawNo / 100 : rawNo;
        if (Math.abs(yesPrice + noPrice - 1) > 0.05) {
          noPrice = Math.max(0, 1 - yesPrice);
        }

        m.yesPrice = yesPrice;
        m.noPrice = noPrice;
        return true;
      };

      const applyMarketSnapshot = (row: Record<string, unknown>) => {
        if (typeof row.title === "string") {
          m.title = row.title;
        }
        if (typeof row.slug === "string") {
          m.id = row.slug;
          m.slug = row.slug;
        }
        if (row.endsAt || row.ends_at) {
          m.endsAt = String(row.endsAt ?? row.ends_at);
        }
        if (typeof row.status === "string") {
          m.status = row.status;
        }
        if (row.expired === true) {
          m.expired = true;
        }
        if (row.winningOutcomeIndex === 0 || row.winningOutcomeIndex === 1) {
          m.winningOutcomeIndex = row.winningOutcomeIndex;
        }
        if (typeof row.conditionId === "string" && /^0x[0-9a-fA-F]{64}$/.test(row.conditionId)) {
          m.conditionId = row.conditionId as `0x${string}`;
          m.conditionalTokensContract = CT_ADDRESS;
        }
        if (Array.isArray(row.positionIds) && row.positionIds.length >= 2) {
          const yes = String(row.positionIds[0] ?? "").trim();
          const no = String(row.positionIds[1] ?? "").trim();
          if (yes && no) {
            m.positionIds = [yes, no];
          }
        }
        applyPriceSnapshot(row);
      };

      const endpoints = [
        `${baseUrl}/markets/${m.contractAddress}`,
        `${baseUrl}/markets/${m.contractAddress.toLowerCase()}`,
      ];
      for (const endpoint of endpoints) {
        try {
          const resp = await fetch(endpoint, {
            headers: fetchHeaders,
            cache: "no-store",
            signal: AbortSignal.timeout(3000)
          });
          if (!resp.ok) continue;
          const data = await resp.json() as any;
          const market = Array.isArray(data?.data) ? data.data[0] : (data?.title ? data : null);
          if (market && typeof market.title === "string") {
            applyMarketSnapshot(market);
            break;
          }
        } catch { /* ignored */ }
      }
    }));

    const unresolvedEntries = fallbackEntries.filter(([_, m]) =>
      isGenericHistoryTitle(m.title) || !hasVerifiedAmmPrice(m.yesPrice) || !hasVerifiedAmmPrice(m.noPrice)
    );

    if (unresolvedEntries.length > 0) {
      const catalogRows = await fetchActiveCatalogRows();
      for (const [_, m] of unresolvedEntries) {
        const match = catalogRows.find((row) => {
          if (!row || typeof row !== "object") return false;
          const record = row as Record<string, unknown>;
          const venue = typeof record.venue === "object" && record.venue !== null
            ? record.venue as Record<string, unknown>
            : undefined;
          const address = (
            (typeof record.address === "string" ? record.address : undefined) ??
            (typeof venue?.exchange === "string" ? venue.exchange : undefined) ??
            ""
          ).toLowerCase();
          const slug = typeof record.slug === "string" ? record.slug.toLowerCase() : "";
          const id = typeof record.id === "string" || typeof record.id === "number"
            ? String(record.id).toLowerCase()
            : "";

          return (
            address === m.contractAddress.toLowerCase() ||
            slug === m.slug.toLowerCase() ||
            id === m.id.toLowerCase()
          );
        });

        if (!match || typeof match !== "object") {
          continue;
        }

        const record = match as Record<string, unknown>;
        if (typeof record.title === "string") {
          m.title = record.title;
        }
        if (typeof record.slug === "string") {
          m.id = record.slug;
          m.slug = record.slug;
        }
        if (record.endsAt || record.ends_at) {
          m.endsAt = String(record.endsAt ?? record.ends_at);
        }
        if (typeof record.status === "string") {
          m.status = record.status;
        }
        if (record.expired === true) {
          m.expired = true;
        }
        if (record.winningOutcomeIndex === 0 || record.winningOutcomeIndex === 1) {
          m.winningOutcomeIndex = record.winningOutcomeIndex;
        }
        if (Array.isArray(record.positionIds) && record.positionIds.length >= 2) {
          const yes = String(record.positionIds[0] ?? "").trim();
          const no = String(record.positionIds[1] ?? "").trim();
          if (yes && no) {
            m.positionIds = [yes, no];
          }
        }
        const prices = Array.isArray(record.prices) ? record.prices : [];
        const rawYes = typeof prices[0] === "number" ? prices[0] : undefined;
        if (rawYes === undefined) {
          continue;
        }
        const yesPrice = rawYes > 1 ? rawYes / 100 : rawYes;
        const rawNo = typeof prices[1] === "number" ? prices[1] : 1 - yesPrice;
        let noPrice = rawNo > 1 ? rawNo / 100 : rawNo;
        if (Math.abs(yesPrice + noPrice - 1) > 0.05) {
          noPrice = Math.max(0, 1 - yesPrice);
        }
        m.yesPrice = yesPrice;
        m.noPrice = noPrice;
      }
    }
  }

  return Array.from(marketsMap.values());
}

function sumDecimalStrings(values: string[]) {
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isFinite(total)) {
    return "0";
  }
  return total.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function hasPositiveDecimal(value: string | undefined) {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0;
}

function hasNonZeroDecimal(value: string | undefined) {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed !== 0;
}

function hasVerifiedAmmPrice(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isGenericHistoryTitle(title: string | undefined) {
  if (!title) {
    return true;
  }

  return /^Market 0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/i.test(title.trim());
}

function isAddressLikeMarketId(value: string | undefined) {
  return !!value && /^0x[a-f0-9]{40}$/i.test(value.trim());
}

function mergeHistoricalActionState(
  existing: HistoricalActionState | undefined,
  incoming: HistoricalActionState
): HistoricalActionState {
  const proceedsUsdc = sumDecimalStrings([existing?.proceedsUsdc ?? "0", incoming.proceedsUsdc]);

  if (!existing) {
    return {
      ...incoming,
      proceedsUsdc
    };
  }

  const existingTime = existing.timestamp ? Date.parse(existing.timestamp) : Number.NaN;
  const incomingTime = incoming.timestamp ? Date.parse(incoming.timestamp) : Number.NaN;
  const keepExistingAction =
    (Number.isFinite(existingTime) && Number.isFinite(incomingTime) && existingTime > incomingTime) ||
    (!!existing.timestamp && !incoming.timestamp);

  return {
    action: keepExistingAction ? existing.action : incoming.action,
    proceedsUsdc,
    timestamp: keepExistingAction ? existing.timestamp : incoming.timestamp ?? existing.timestamp
  };
}

function mergeCostBasisEntries(
  existing: PositionCostBasisEntry | undefined,
  incoming: PositionCostBasisEntry
): PositionCostBasisEntry {
  if (!existing) {
    return incoming;
  }

  return {
    costUsdc: sumDecimalStrings([existing.costUsdc, incoming.costUsdc]),
    tokenAmount: sumDecimalStrings([existing.tokenAmount ?? "0", incoming.tokenAmount ?? "0"])
  };
}

function augmentHistorySummaryWithTokenCostBasis(
  historySummary: TransferHistorySummary,
  ammMarkets: AmmMarketRef[]
): TransferHistorySummary {
  if (Object.keys(historySummary.tokenCostBasisMap).length === 0) {
    return historySummary;
  }

  const marketByAddress = new Map<string, AmmMarketRef>();
  for (const market of ammMarkets) {
    marketByAddress.set(market.contractAddress.toLowerCase(), market);
  }

  const costBasisMap = { ...historySummary.costBasisMap };
  for (const [tokenKey, entry] of Object.entries(historySummary.tokenCostBasisMap)) {
    const separator = tokenKey.lastIndexOf(":");
    if (separator <= 0) {
      continue;
    }

    const contractAddress = tokenKey.slice(0, separator);
    const tokenId = tokenKey.slice(separator + 1);
    const market = marketByAddress.get(contractAddress);
    const side = resolveMarketSideFromTokenId(market, tokenId, historySummary.tokenSideMap);
    if (!side) {
      continue;
    }

    const sideKey = `${contractAddress}:${side}`;
    if (!costBasisMap[sideKey] || !hasPositiveDecimal(costBasisMap[sideKey].costUsdc)) {
      costBasisMap[sideKey] = entry;
    }
  }

  return {
    ...historySummary,
    costBasisMap
  };
}

function mergeHistoricalSettledPosition(existing: TrackedPosition, historical: TrackedPosition): TrackedPosition {
  return {
    ...existing,
    status: "settled",
    costUsdc: hasPositiveDecimal(historical.costUsdc) ? historical.costUsdc : existing.costUsdc,
    marketValueUsdc: hasPositiveDecimal(historical.marketValueUsdc) ? historical.marketValueUsdc : existing.marketValueUsdc,
    realizedPnlUsdc: hasNonZeroDecimal(historical.realizedPnlUsdc) ? historical.realizedPnlUsdc : existing.realizedPnlUsdc,
    currentPrice: historical.currentPrice ?? existing.currentPrice,
    endsAt: historical.endsAt ?? existing.endsAt,
    claimable: existing.claimable || historical.claimable,
    tokenBalance: hasPositiveDecimal(historical.tokenBalance) ? historical.tokenBalance : existing.tokenBalance,
    ...((historical as any).isSold ? { isSold: true } : {}),
    ...((historical as any).isRedeemed ? { isRedeemed: true } : {})
  };
}

function mergeCachedSettledPosition(current: TrackedPosition, cached: TrackedPosition): TrackedPosition {
  return {
    ...cached,
    ...current,
    status: "settled",
    marketId: !isAddressLikeMarketId(current.marketId) ? current.marketId : cached.marketId,
    marketSlug: !isAddressLikeMarketId(current.marketSlug) ? current.marketSlug : cached.marketSlug,
    marketTitle: !isGenericHistoryTitle(current.marketTitle) ? current.marketTitle : cached.marketTitle,
    costUsdc: hasPositiveDecimal(current.costUsdc) ? current.costUsdc : cached.costUsdc,
    marketValueUsdc: hasPositiveDecimal(current.marketValueUsdc) ? current.marketValueUsdc : cached.marketValueUsdc,
    realizedPnlUsdc: hasNonZeroDecimal(current.realizedPnlUsdc) ? current.realizedPnlUsdc : cached.realizedPnlUsdc,
    currentPrice: current.currentPrice ?? cached.currentPrice,
    endsAt: current.endsAt ?? cached.endsAt,
    claimable: current.claimable || cached.claimable,
    tokenBalance: hasPositiveDecimal(current.tokenBalance) ? current.tokenBalance : cached.tokenBalance,
    ...((current as any).isSold || (cached as any).isSold ? { isSold: true } : {}),
    ...((current as any).isRedeemed || (cached as any).isRedeemed ? { isRedeemed: true } : {})
  };
}

function isMeaningfulActivePrice(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function mergeCachedActivePosition(current: TrackedPosition, cached: TrackedPosition): TrackedPosition {
  const currentHasValue = hasPositiveDecimal(current.marketValueUsdc);
  const currentHasBalance = hasPositiveDecimal(current.tokenBalance);
  const currentHasVerifiedPricing = current.hasVerifiedPricing === true;
  const cachedHasVerifiedPricing = cached.hasVerifiedPricing === true;

  return {
    ...cached,
    ...current,
    status: "active",
    marketId: !isAddressLikeMarketId(current.marketId) ? current.marketId : cached.marketId,
    marketSlug: !isAddressLikeMarketId(current.marketSlug) ? current.marketSlug : cached.marketSlug,
    marketTitle: !isGenericHistoryTitle(current.marketTitle) ? current.marketTitle : cached.marketTitle,
    costUsdc: hasPositiveDecimal(current.costUsdc) ? current.costUsdc : cached.costUsdc,
    tokenBalance: currentHasBalance ? current.tokenBalance : cached.tokenBalance,
    marketValueUsdc:
      currentHasVerifiedPricing && currentHasValue
        ? current.marketValueUsdc
        : (cachedHasVerifiedPricing ? cached.marketValueUsdc : current.marketValueUsdc),
    unrealizedPnlUsdc:
      currentHasVerifiedPricing && currentHasValue
        ? current.unrealizedPnlUsdc
        : (cachedHasVerifiedPricing ? cached.unrealizedPnlUsdc : current.unrealizedPnlUsdc),
    currentPrice:
      currentHasVerifiedPricing && isMeaningfulActivePrice(current.currentPrice)
        ? current.currentPrice
        : (cachedHasVerifiedPricing && isMeaningfulActivePrice(cached.currentPrice) ? cached.currentPrice : current.currentPrice),
    hasVerifiedPricing: currentHasVerifiedPricing || cachedHasVerifiedPricing,
    endsAt: current.endsAt ?? cached.endsAt
  };
}

function shouldHydrateCachedActiveSnapshot(
  snapshot: PortfolioPositionsSnapshot,
  cachedSnapshot: PortfolioPositionsSnapshot
) {
  const currentActiveCount = snapshot.active.length;
  const cachedActiveCount = cachedSnapshot.active.length;
  if (cachedActiveCount === 0) {
    return false;
  }

  if (currentActiveCount === 0) {
    return true;
  }

  const currentValue = Number(snapshot.totals.activeMarketValueUsdc);
  const cachedValue = Number(cachedSnapshot.totals.activeMarketValueUsdc);
  if (!Number.isFinite(currentValue) || !Number.isFinite(cachedValue) || cachedValue <= 0) {
    return false;
  }

  return currentActiveCount < cachedActiveCount && currentValue < cachedValue * ACTIVE_SNAPSHOT_VALUE_DROP_RATIO;
}

function shouldRefreshSnapshotCache(
  snapshot: PortfolioPositionsSnapshot,
  cachedSnapshot: PortfolioPositionsSnapshot | null
) {
  if (!cachedSnapshot) {
    return true;
  }

  const currentActiveValue = Number(snapshot.totals.activeMarketValueUsdc);
  const cachedActiveValue = Number(cachedSnapshot.totals.activeMarketValueUsdc);

  if (snapshot.active.length === 0 && cachedSnapshot.active.length > 0) {
    return false;
  }

  if (
    snapshot.active.length < cachedSnapshot.active.length &&
    Number.isFinite(currentActiveValue) &&
    Number.isFinite(cachedActiveValue) &&
    cachedActiveValue > 0 &&
    currentActiveValue < cachedActiveValue * ACTIVE_SNAPSHOT_VALUE_DROP_RATIO
  ) {
    return false;
  }

  if (
    snapshot.settled.length < cachedSnapshot.settled.length &&
    cachedSnapshot.settled.length > 0 &&
    snapshot.settled.length <= Math.floor(cachedSnapshot.settled.length * SETTLED_SNAPSHOT_COUNT_DROP_RATIO)
  ) {
    return false;
  }

  return true;
}

type SnapshotCacheRecord = {
  snapshot: PortfolioPositionsSnapshot;
  expiresAt: number;
};

function getSnapshotMemoryCache() {
  const globalState = globalThis as typeof globalThis & {
    __pmMiniappPositionsSnapshotCache?: Map<string, SnapshotCacheRecord>;
  };

  if (!globalState.__pmMiniappPositionsSnapshotCache) {
    globalState.__pmMiniappPositionsSnapshotCache = new Map();
  }

  return globalState.__pmMiniappPositionsSnapshotCache;
}

async function readCachedPositionsSnapshot(
  account: string,
  redis: Awaited<ReturnType<typeof getSecurityRedisClient>> | null
) {
  const normalizedAccount = account.toLowerCase();
  const cacheKey = `pm-miniapp:positions-snapshot:${normalizedAccount}`;

  if (redis) {
    try {
      const raw = await redis.get(cacheKey);
      if (raw) {
        return JSON.parse(raw) as PortfolioPositionsSnapshot;
      }
    } catch (error) {
      console.warn("[Positions API] Snapshot cache read failed:", error);
    }
  }

  const memoryCache = getSnapshotMemoryCache();
  const record = memoryCache.get(cacheKey);
  if (!record) {
    return null;
  }

  if (record.expiresAt <= Date.now()) {
    memoryCache.delete(cacheKey);
    return null;
  }

  return record.snapshot;
}

async function writeCachedPositionsSnapshot(
  account: string,
  snapshot: PortfolioPositionsSnapshot,
  redis: Awaited<ReturnType<typeof getSecurityRedisClient>> | null
) {
  const normalizedAccount = account.toLowerCase();
  const cacheKey = `pm-miniapp:positions-snapshot:${normalizedAccount}`;

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(snapshot), "EX", SNAPSHOT_CACHE_TTL_SECONDS);
    } catch (error) {
      console.warn("[Positions API] Snapshot cache write failed:", error);
    }
  }

  getSnapshotMemoryCache().set(cacheKey, {
    snapshot,
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_SECONDS * 1000
  });
}

function stabilizeSnapshotWithCache(
  snapshot: PortfolioPositionsSnapshot,
  cachedSnapshot: PortfolioPositionsSnapshot | null
) {
  if (!cachedSnapshot) {
    return snapshot;
  }

  const active = [...snapshot.active];
  const activeIndexByKey = new Map<string, number>();
  active.forEach((position, index) => {
    for (const key of buildPositionLookupKeys(position)) {
      activeIndexByKey.set(key, index);
    }
  });

  const shouldHydrateCachedActive = shouldHydrateCachedActiveSnapshot(snapshot, cachedSnapshot);
  const activeKeys = new Set<string>();
  active.forEach((position) => {
    for (const key of buildPositionLookupKeys(position)) {
      activeKeys.add(key);
    }
  });

  const settled = [...snapshot.settled];
  const settledIndexByKey = new Map<string, number>();
  settled.forEach((position, index) => {
    for (const key of buildSettledLookupKeys(position)) {
      settledIndexByKey.set(key, index);
    }
  });

  for (const cachedPosition of cachedSnapshot.active) {
    const keys = buildPositionLookupKeys(cachedPosition);
    if (keys.some((key) => settledIndexByKey.has(key))) {
      continue;
    }

    const existingKey = keys.find((key) => activeIndexByKey.has(key));
    if (existingKey) {
      const index = activeIndexByKey.get(existingKey)!;
      active[index] = mergeCachedActivePosition(active[index], cachedPosition);
      for (const mergedKey of buildPositionLookupKeys(active[index])) {
        activeIndexByKey.set(mergedKey, index);
        activeKeys.add(mergedKey);
      }
      continue;
    }

    if (!shouldHydrateCachedActive) {
      continue;
    }

    const index = active.push(cachedPosition) - 1;
    keys.forEach((key) => {
      activeIndexByKey.set(key, index);
      activeKeys.add(key);
    });
  }

  for (const cachedPosition of cachedSnapshot.settled) {
    const baseKeys = buildPositionLookupKeys(cachedPosition);
    const keys = buildSettledLookupKeys(cachedPosition);
    if (baseKeys.some((key) => activeKeys.has(key))) {
      continue;
    }

    const existingKey = keys.find((key) => settledIndexByKey.has(key));
    if (existingKey) {
      const index = settledIndexByKey.get(existingKey)!;
      settled[index] = mergeCachedSettledPosition(settled[index], cachedPosition);
      for (const mergedKey of buildSettledLookupKeys(settled[index])) {
        settledIndexByKey.set(mergedKey, index);
      }
      continue;
    }

    const index = settled.push(cachedPosition) - 1;
    keys.forEach((key) => settledIndexByKey.set(key, index));
  }

  const prunedSettled = prunePlaceholderSettledPositions(settled);
  return {
    ...snapshot,
    active,
    settled: prunedSettled,
    totals: recomputeTotals(active, prunedSettled)
  };
}

function getSnapshotAgeMs(snapshot: PortfolioPositionsSnapshot | null) {
  if (!snapshot?.fetchedAt) {
    return Number.POSITIVE_INFINITY;
  }

  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Date.now() - fetchedAt);
}

function emptyTransferHistorySummary(): TransferHistorySummary {
  return {
    fpmmAddresses: [],
    costBasisMap: {},
    tokenCostBasisMap: {},
    tokenSideMap: {},
    marketActions: [],
    inboundPositionTokens: []
  };
}

function parseTimestampMs(value?: string) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchBlockscoutHistorySnapshot(account: `0x${string}`): Promise<PortfolioPositionsSnapshot> {
  const accountLower = account.toLowerCase();
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const historyEvents: BlockscoutHistoryEvent[] = [];
  const usdcSpentByTx = new Map<string, bigint>();
  const usdcReceivedByTx = new Map<string, bigint>();

  const fetchCtTransfers = async (direction: "in" | "out") => {
    let nextPageParams: string | null = null;

    for (let page = 0; page < 6; page++) {
      const filter = direction === "in" ? "to" : "from";
      const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=${filter}&type=ERC-1155`;
      const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        // @ts-ignore
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000)
      });

      if (!response.ok) {
        break;
      }

      const payload = (await response.json()) as {
        items?: unknown[];
        next_page_params?: Record<string, unknown> | null;
      };
      const items = Array.isArray(payload.items) ? payload.items : [];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record.token_type !== "ERC-1155") continue;

        const token = record.token as Record<string, unknown> | undefined;
        if (typeof token?.address_hash !== "string" || token.address_hash.toLowerCase() !== CT_ADDRESS_LOWER) {
          continue;
        }

        const total = record.total as Record<string, unknown> | undefined;
        const tokenId =
          typeof total?.token_id === "string"
            ? total.token_id
            : typeof total?.token_id === "number"
              ? String(total.token_id)
              : "";
        const rawValue =
          typeof total?.value === "string"
            ? total.value
            : typeof total?.value === "number"
              ? String(total.value)
              : "";

        if (!tokenId || !rawValue) {
          continue;
        }

        const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
        const txHash =
          (typeof record.transaction_hash === "string" ? record.transaction_hash : undefined) ??
          (typeof record.tx_hash === "string" ? record.tx_hash : undefined);

        const from = record.from as Record<string, unknown> | undefined;
        const to = record.to as Record<string, unknown> | undefined;
        const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
        const toHash = typeof to?.hash === "string" ? to.hash.toLowerCase() : undefined;

        let contractAddress: string | undefined;
        let action: BlockscoutHistoryEvent["action"];

        if (direction === "in") {
          contractAddress =
            fromHash && fromHash !== ZERO_ADDRESS && isAddress(fromHash) ? fromHash : undefined;
          action = "buy";
        } else if (toHash === ZERO_ADDRESS) {
          action = "redeem";
        } else {
          action = "sell";
          contractAddress =
            toHash && toHash !== ZERO_ADDRESS && isAddress(toHash) ? toHash : undefined;
        }

        historyEvents.push({
          direction,
          action,
          contractAddress,
          tokenId,
          tokenAmount: normalizeRawTokenAmount(rawValue, 6),
          txHash,
          timestamp
        });
      }

      if (payload.next_page_params && typeof payload.next_page_params === "object") {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(payload.next_page_params)) {
          if (value !== null && value !== undefined) {
            params.set(key, String(value));
          }
        }
        nextPageParams = params.toString();
      } else {
        break;
      }
    }
  };

  const fetchUsdcTransfers = async () => {
    let nextPageParams: string | null = null;

    for (let page = 0; page < 6; page++) {
      const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?type=ERC-20`;
      const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        // @ts-ignore
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000)
      });

      if (!response.ok) {
        break;
      }

      const payload = (await response.json()) as {
        items?: unknown[];
        next_page_params?: Record<string, unknown> | null;
      };
      const items = Array.isArray(payload.items) ? payload.items : [];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const token = record.token as Record<string, unknown> | undefined;
        const tokenAddress = typeof token?.address_hash === "string" ? token.address_hash.toLowerCase() : undefined;
        if (tokenAddress !== USDC_ADDRESS_LOWER) {
          continue;
        }

        const txHash =
          (typeof record.transaction_hash === "string" ? record.transaction_hash : undefined) ??
          (typeof record.tx_hash === "string" ? record.tx_hash : undefined);
        if (!txHash) {
          continue;
        }

        const total = record.total as Record<string, unknown> | undefined;
        const rawValue =
          typeof total?.value === "string"
            ? total.value
            : typeof total?.value === "number"
              ? String(total.value)
              : undefined;
        if (!rawValue) {
          continue;
        }

        const from = record.from as Record<string, unknown> | undefined;
        const to = record.to as Record<string, unknown> | undefined;
        const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
        const toHash = typeof to?.hash === "string" ? to.hash.toLowerCase() : undefined;
        const amount = BigInt(rawValue);

        if (fromHash === accountLower) {
          usdcSpentByTx.set(txHash, (usdcSpentByTx.get(txHash) ?? 0n) + amount);
        }
        if (toHash === accountLower) {
          usdcReceivedByTx.set(txHash, (usdcReceivedByTx.get(txHash) ?? 0n) + amount);
        }
      }

      if (payload.next_page_params && typeof payload.next_page_params === "object") {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(payload.next_page_params)) {
          if (value !== null && value !== undefined) {
            params.set(key, String(value));
          }
        }
        nextPageParams = params.toString();
      } else {
        break;
      }
    }
  };

  await Promise.all([
    fetchCtTransfers("in"),
    fetchCtTransfers("out"),
    fetchUsdcTransfers()
  ]);

  const historyAddresses = Array.from(
    new Set(
      historyEvents
        .map((event) => event.contractAddress?.toLowerCase())
        .filter((value): value is string => Boolean(value))
    )
  );

  if (historyEvents.length === 0 || historyAddresses.length === 0) {
    return createPortfolioSnapshot(account);
  }

  const ammMarkets = await fetchAmmMarketsForOnchain(historyAddresses, false);
  const marketByAddress = new Map<string, AmmMarketRef>();
  for (const market of ammMarkets) {
    marketByAddress.set(market.contractAddress.toLowerCase(), market);
  }

  const resolveMarketForEvent = (event: BlockscoutHistoryEvent) => {
    if (event.contractAddress) {
      const direct = marketByAddress.get(event.contractAddress.toLowerCase());
      if (direct) {
        return direct;
      }
    }

    return (
      ammMarkets.find((market) => resolveMarketSideFromTokenId(market, event.tokenId) !== null) ??
      null
    );
  };

  const buckets = new Map<string, {
    market: AmmMarketRef;
    side: PositionSide;
    boughtShares: number;
    currentShares: number;
    soldShares: number;
    costUsdc: number;
    proceedsUsdc: number;
    hadSell: boolean;
    hadRedeem: boolean;
    latestTimestamp?: string;
    latestTimestampMs: number;
  }>();

  const countedBuyTxKeys = new Set<string>();
  const countedExitTxKeys = new Set<string>();

  const orderedEvents = [...historyEvents].sort(
    (left, right) => parseTimestampMs(left.timestamp) - parseTimestampMs(right.timestamp)
  );

  for (const event of orderedEvents) {
    const market = resolveMarketForEvent(event);
    if (!market) {
      continue;
    }

    const side = resolveMarketSideFromTokenId(market, event.tokenId);
    if (!side) {
      continue;
    }

    const key = `${market.contractAddress.toLowerCase()}:${side}`;
    const bucket = buckets.get(key) ?? {
      market,
      side,
      boughtShares: 0,
      currentShares: 0,
      soldShares: 0,
      costUsdc: 0,
      proceedsUsdc: 0,
      hadSell: false,
      hadRedeem: false,
      latestTimestampMs: 0
    };

    const amount = Number(event.tokenAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    bucket.market = market;
    const eventTimestampMs = parseTimestampMs(event.timestamp);
    if (eventTimestampMs >= bucket.latestTimestampMs) {
      bucket.latestTimestampMs = eventTimestampMs;
      bucket.latestTimestamp = event.timestamp;
    }

    if (event.direction === "in") {
      bucket.boughtShares += amount;
      bucket.currentShares += amount;
      if (event.txHash) {
        const txKey = `${key}:${event.txHash}`;
        if (!countedBuyTxKeys.has(txKey)) {
          countedBuyTxKeys.add(txKey);
          const cost = usdcSpentByTx.get(event.txHash);
          if (cost && cost > 0n) {
            bucket.costUsdc += Number(normalizeRawTokenAmount(cost.toString(), 6));
          }
        }
      }
    } else {
      bucket.currentShares = Math.max(0, bucket.currentShares - amount);
      bucket.soldShares += amount;
      bucket.hadSell = bucket.hadSell || event.action === "sell";
      bucket.hadRedeem = bucket.hadRedeem || event.action === "redeem";
      if (event.txHash) {
        const txKey = `${key}:${event.txHash}`;
        if (!countedExitTxKeys.has(txKey)) {
          countedExitTxKeys.add(txKey);
          const proceeds = usdcReceivedByTx.get(event.txHash);
          if (proceeds && proceeds > 0n) {
            bucket.proceedsUsdc += Number(normalizeRawTokenAmount(proceeds.toString(), 6));
          }
        }
      }
    }

    buckets.set(key, bucket);
  }

  const active: TrackedPosition[] = [];
  const settled: TrackedPosition[] = [];

  for (const bucket of buckets.values()) {
    const totalShares = bucket.boughtShares;
    const remainingShares = Math.max(0, bucket.currentShares);
    const totalCost = Math.max(0, bucket.costUsdc);
    const remainingRatio = totalShares > 0 ? Math.min(Math.max(remainingShares / totalShares, 0), 1) : 0;
    const remainingCost = totalCost * remainingRatio;
    const exitedCost = Math.max(0, totalCost - remainingCost);

    const market = bucket.market;
    const currentPrice = bucket.side === "yes" ? market.yesPrice : market.noPrice;
    const statusRaw = market.status?.toLowerCase() ?? "";
    const isResolved = market.expired === true || statusRaw.includes("resolved") || statusRaw.includes("closed");
    const winningSide =
      market.winningOutcomeIndex === 0 ? "yes" :
      market.winningOutcomeIndex === 1 ? "no" :
      null;
    const isWinner = winningSide === bucket.side;

    if (remainingShares > 0 && !isResolved) {
      const hasVerifiedPricing = hasVerifiedAmmPrice(currentPrice);
      const marketValue = hasVerifiedPricing ? remainingShares * currentPrice : 0;
      const unrealized = hasVerifiedPricing ? marketValue - remainingCost : 0;

      active.push({
        id: `${market.contractAddress}:${bucket.side}`,
        marketId: market.contractAddress,
        marketSlug: market.slug,
        marketTitle: market.title,
        side: bucket.side,
        status: "active",
        costUsdc: formatDecimalString(remainingCost),
        marketValueUsdc: hasVerifiedPricing ? formatDecimalString(marketValue) : "0",
        unrealizedPnlUsdc: hasVerifiedPricing ? formatDecimalString(unrealized) : "0",
        realizedPnlUsdc: "0",
        claimable: false,
        tokenBalance: formatDecimalString(remainingShares),
        currentPrice: hasVerifiedPricing ? currentPrice : undefined,
        hasVerifiedPricing,
        conditionId: market.conditionId,
        conditionalTokensContract: market.conditionalTokensContract,
        endsAt: market.endsAt
      });
    }

    if (remainingShares > 0 && isResolved) {
      const redeemableUsdc = isWinner ? remainingShares : 0;
      settled.push({
        id: `${market.contractAddress}:${bucket.side}`,
        marketId: market.contractAddress,
        marketSlug: market.slug,
        marketTitle: market.title,
        side: bucket.side,
        status: "settled",
        costUsdc: formatDecimalString(remainingCost),
        marketValueUsdc: formatDecimalString(redeemableUsdc),
        unrealizedPnlUsdc: "0",
        realizedPnlUsdc: isWinner ? "0" : formatDecimalString(-remainingCost),
        claimable: isWinner,
        tokenBalance: formatDecimalString(remainingShares),
        currentPrice: isWinner ? 1 : 0,
        hasVerifiedPricing: true,
        conditionId: isWinner ? market.conditionId : undefined,
        conditionalTokensContract: isWinner ? market.conditionalTokensContract : undefined,
        endsAt: market.endsAt
      });
    }

    const shouldAddExitHistory =
      (bucket.hadSell || bucket.hadRedeem) &&
      (remainingShares === 0 || remainingShares < MIN_VISIBLE_ACTIVE_SHARES || bucket.hadRedeem);

    if (shouldAddExitHistory) {
      const exitCost = bucket.hadRedeem && remainingShares === 0 ? totalCost : exitedCost;
      const realizedPnl = bucket.proceedsUsdc - exitCost;

      settled.push({
        id: `${market.contractAddress}:${bucket.side}:exit`,
        marketId: market.contractAddress,
        marketSlug: market.slug,
        marketTitle: market.title,
        side: bucket.side,
        status: "settled",
        costUsdc: formatDecimalString(exitCost),
        marketValueUsdc: formatDecimalString(bucket.proceedsUsdc),
        unrealizedPnlUsdc: "0",
        realizedPnlUsdc: formatDecimalString(realizedPnl),
        claimable: false,
        tokenBalance: "0",
        currentPrice: hasVerifiedAmmPrice(currentPrice) ? currentPrice : undefined,
        hasVerifiedPricing: hasVerifiedAmmPrice(currentPrice),
        endsAt: market.endsAt,
        isSold: bucket.hadSell,
        isRedeemed: bucket.hadRedeem
      });
    }
  }

  active.sort((left, right) => parseTimestampMs(right.endsAt) - parseTimestampMs(left.endsAt));
  settled.sort((left, right) => parseTimestampMs(right.endsAt) - parseTimestampMs(left.endsAt));

  return {
    ...createPortfolioSnapshot(account, active, prunePlaceholderSettledPositions(settled)),
    fetchedAt: new Date().toISOString()
  };
}

function formatDecimalString(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function buildPositionLookupKeys(position: Pick<TrackedPosition, "marketId" | "marketSlug" | "side">) {
  const keys = new Set<string>();
  const side = position.side.toLowerCase();

  const marketId = position.marketId.trim().toLowerCase();
  if (marketId.length > 0) {
    keys.add(`${marketId}:${side}`);
  }

  const marketSlug = position.marketSlug.trim().toLowerCase();
  if (marketSlug.length > 0) {
    keys.add(`${marketSlug}:${side}`);
  }

  return Array.from(keys);
}

function isClosedSettledHistoryPosition(
  position: Pick<TrackedPosition, "claimable" | "tokenBalance"> & { isSold?: boolean }
) {
  if (position.claimable) {
    return false;
  }

  return position.isSold === true || !hasPositiveDecimal(position.tokenBalance);
}

function buildSettledLookupKeys(
  position: Pick<TrackedPosition, "marketId" | "marketSlug" | "side" | "claimable" | "tokenBalance"> & { isSold?: boolean }
) {
  const stateKey = position.claimable
    ? "claimable"
    : isClosedSettledHistoryPosition(position)
      ? "closed"
      : "settled";

  return buildPositionLookupKeys(position).map((key) => `${key}:${stateKey}`);
}

function recomputeTotals(
  active: TrackedPosition[],
  settled: TrackedPosition[]
): PortfolioPositionsSnapshot["totals"] {
  return {
    activeMarketValueUsdc: sumDecimalStrings(active.map((item) => item.marketValueUsdc)),
    unrealizedPnlUsdc: sumDecimalStrings(active.map((item) => item.unrealizedPnlUsdc)),
    claimableUsdc: sumDecimalStrings(settled.filter((item) => item.claimable).map((item) => item.marketValueUsdc))
  };
}

function createPortfolioSnapshot(
  account: `0x${string}`,
  active: TrackedPosition[] = [],
  settled: TrackedPosition[] = []
): PortfolioPositionsSnapshot {
  return {
    account,
    fetchedAt: new Date().toISOString(),
    active,
    settled,
    totals: recomputeTotals(active, settled)
  };
}

function prunePlaceholderSettledPositions(settled: TrackedPosition[]) {
  return settled.filter((position) => {
    if (position.claimable) {
      return true;
    }

    const cost = Number(position.costUsdc);
    const value = Number(position.marketValueUsdc);
    const balance = Number(position.tokenBalance);
    const realized = Number(position.realizedPnlUsdc);
    const unrealized = Number(position.unrealizedPnlUsdc);

    return !(cost === 0 && value === 0 && balance === 0 && realized === 0 && unrealized === 0);
  });
}

function recordLatestActivity(
  activityByKey: Map<string, number>,
  market: AmmMarketRef,
  side: PositionSide,
  timestamp?: string
) {
  if (!timestamp) {
    return;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return;
  }

  const keys = [
    `${market.contractAddress.toLowerCase()}:${side}`,
    `${market.id.toLowerCase()}:${side}`,
    `${market.slug.toLowerCase()}:${side}`
  ];

  for (const key of keys) {
    const existing = activityByKey.get(key) ?? 0;
    if (parsed > existing) {
      activityByKey.set(key, parsed);
    }
  }
}

function buildLatestActivityByKey(
  historySummary: TransferHistorySummary,
  ammMarkets: AmmMarketRef[]
) {
  const marketByAddress = new Map<string, AmmMarketRef>();
  for (const market of ammMarkets) {
    marketByAddress.set(market.contractAddress.toLowerCase(), market);
  }

  const activityByKey = new Map<string, number>();

  for (const token of historySummary.inboundPositionTokens) {
    const market = marketByAddress.get(token.contractAddress.toLowerCase());
    if (!market) continue;

    const side = resolveMarketSideFromTokenId(market, token.tokenId, historySummary.tokenSideMap);
    if (!side) continue;

    recordLatestActivity(activityByKey, market, side, token.timestamp);
  }

  for (const action of historySummary.marketActions) {
    const contractAddress = action.contractAddress.trim().toLowerCase();

    if (contractAddress) {
      const market = marketByAddress.get(contractAddress);
      if (!market) continue;

      const side = resolveMarketSideFromTokenId(market, action.tokenId, historySummary.tokenSideMap);
      if (!side) continue;

      recordLatestActivity(activityByKey, market, side, action.timestamp);
      continue;
    }

    for (const market of marketByAddress.values()) {
      const side = resolveMarketSideFromTokenId(market, action.tokenId, historySummary.tokenSideMap);
      if (!side) continue;

      recordLatestActivity(activityByKey, market, side, action.timestamp);
      break;
    }
  }

  return activityByKey;
}

function sortSnapshotActivePositions(
  snapshot: PortfolioPositionsSnapshot,
  historySummary: TransferHistorySummary,
  ammMarkets: AmmMarketRef[]
) {
  if (snapshot.active.length <= 1) {
    return snapshot;
  }

  const activityByKey = buildLatestActivityByKey(historySummary, ammMarkets);
  const active = snapshot.active
    .map((position, index) => {
      const latestActivity = buildPositionLookupKeys(position)
        .map((key) => activityByKey.get(key) ?? 0)
        .reduce((max, value) => Math.max(max, value), 0);

      return { position, index, latestActivity };
    })
    .sort((left, right) => {
      if (right.latestActivity !== left.latestActivity) {
        return right.latestActivity - left.latestActivity;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.position);

  return {
    ...snapshot,
    active
  };
}

function resolveMarketSideFromTokenId(
  market: AmmMarketRef | undefined,
  tokenId: string,
  tokenSideMap?: Record<string, PositionSide>
) {
  const contractAddress = market?.contractAddress?.toLowerCase();
  if (contractAddress && tokenSideMap) {
    const mappedSide = tokenSideMap[`${contractAddress}:${tokenId}`];
    if (mappedSide === "yes" || mappedSide === "no") {
      return mappedSide;
    }
  }

  if (!market?.positionIds) {
    return null;
  }

  if (market.positionIds[0] === tokenId) {
    return "yes" as const;
  }
  if (market.positionIds[1] === tokenId) {
    return "no" as const;
  }

  return null;
}

function buildHistoricalSettledPositions(
  historySummary: TransferHistorySummary,
  ammMarkets: AmmMarketRef[],
  existingSnapshot: PortfolioPositionsSnapshot | null
) {
  const marketByAddress = new Map<string, AmmMarketRef>();
  for (const market of ammMarkets) {
    marketByAddress.set(market.contractAddress.toLowerCase(), market);
  }

  const existingActiveKeys = new Set<string>();
  const activePositionByKey = new Map<string, TrackedPosition>();
  for (const position of existingSnapshot?.active ?? []) {
    for (const key of buildPositionLookupKeys(position)) {
      existingActiveKeys.add(key);
      activePositionByKey.set(key, position);
    }
  }

  const actionsByKey = new Map<string, HistoricalActionState>();
  for (const action of historySummary.marketActions) {
    const contractAddress = action.contractAddress.trim().toLowerCase();
    const incomingAction: HistoricalActionState = {
      action: action.action,
      proceedsUsdc: action.proceedsUsdc ?? "0",
      timestamp: action.timestamp
    };

    if (contractAddress) {
      const market = marketByAddress.get(contractAddress);
      const side = resolveMarketSideFromTokenId(market, action.tokenId, historySummary.tokenSideMap);
      if (side) {
        const key = `${contractAddress}:${side}`;
        actionsByKey.set(key, mergeHistoricalActionState(actionsByKey.get(key), incomingAction));
      }
      continue;
    }

    for (const [marketAddress, market] of marketByAddress.entries()) {
      const side = resolveMarketSideFromTokenId(market, action.tokenId, historySummary.tokenSideMap);
      if (side) {
        const key = `${marketAddress}:${side}`;
        actionsByKey.set(key, mergeHistoricalActionState(actionsByKey.get(key), incomingAction));
        break;
      }
    }
  }

  const keys = new Set<string>([
    ...Object.keys(historySummary.costBasisMap),
    ...actionsByKey.keys()
  ]);

  for (const token of historySummary.inboundPositionTokens) {
    const market = marketByAddress.get(token.contractAddress);
    const side = resolveMarketSideFromTokenId(market, token.tokenId, historySummary.tokenSideMap);
    if (side) {
      keys.add(`${token.contractAddress}:${side}`);
    }
  }

  const positions = new Map<string, TrackedPosition>();

  for (const key of keys) {
    const separator = key.lastIndexOf(":");
    if (separator <= 0) continue;

    const contractAddress = key.slice(0, separator);
    const side = key.slice(separator + 1) as PositionSide;
    if (side !== "yes" && side !== "no") continue;

    const market = marketByAddress.get(contractAddress);
    if (!market) continue;

    const existingLookupKeys = [
      `${contractAddress}:${side}`,
      `${market.id.toLowerCase()}:${side}`,
      `${market.slug.toLowerCase()}:${side}`
    ];
    const actionMeta = actionsByKey.get(`${contractAddress}:${side}`);
    const action = actionMeta?.action;
    const proceedsUsdc = actionMeta?.proceedsUsdc ?? "0";
    const costBasis = historySummary.costBasisMap[key];
    const costUsdc = costBasis?.costUsdc ?? "0";
    const shares = costBasis?.tokenAmount ?? "0";
    const activePosition = existingLookupKeys
      .map((lookupKey) => activePositionByKey.get(lookupKey))
      .find((position): position is TrackedPosition => Boolean(position));
    const remainingShares = Number(activePosition?.tokenBalance ?? "0");
    const totalShares = Number(shares);
    const isPartialSoldDustPosition =
      action === "sell" &&
      Number.isFinite(remainingShares) &&
      remainingShares > 0 &&
      remainingShares < MIN_VISIBLE_ACTIVE_SHARES;

    if (existingLookupKeys.some((lookupKey) => existingActiveKeys.has(lookupKey)) && !isPartialSoldDustPosition) {
      continue;
    }

    const isResolved = market.expired === true || market.status?.toLowerCase().includes("resolved") === true;
    const isClosedHistoryCandidate = isResolved || action === "sell" || action === "redeem";
    if (!isClosedHistoryCandidate) {
      continue;
    }

    const winningSide =
      market.winningOutcomeIndex === 0 ? "yes" :
      market.winningOutcomeIndex === 1 ? "no" :
      null;
    const isWinner = winningSide === side;
    const isRedeemed = action === "redeem" && isResolved && isWinner;
    const isSold = action === "sell";

    let currentPrice: number | undefined;
    let marketValueUsdc = "0";
    let realizedPnlUsdc = "0";
    let historyTokenBalance = "0";

    if (isRedeemed) {
      currentPrice = 1;
      marketValueUsdc = hasPositiveDecimal(proceedsUsdc) ? proceedsUsdc : shares;
      if (hasPositiveDecimal(costUsdc) && hasPositiveDecimal(marketValueUsdc)) {
        realizedPnlUsdc = formatDecimalString(Number(marketValueUsdc) - Number(costUsdc));
      }
    } else if (isResolved && winningSide) {
      currentPrice = isWinner ? 1 : 0;
      if (isWinner && hasPositiveDecimal(proceedsUsdc) && hasPositiveDecimal(costUsdc)) {
        marketValueUsdc = proceedsUsdc;
        realizedPnlUsdc = formatDecimalString(Number(proceedsUsdc) - Number(costUsdc));
      }
      if (!isWinner && Number(costUsdc) > 0) {
        realizedPnlUsdc = formatDecimalString(-Number(costUsdc));
      }
    } else if (isSold) {
      currentPrice = side === "yes" ? market.yesPrice : market.noPrice;
      const soldShares =
        Number.isFinite(totalShares) && totalShares > 0
          ? Math.max(0, totalShares - Math.max(0, remainingShares))
          : 0;
      historyTokenBalance = soldShares > 0 ? formatDecimalString(soldShares) : "0";
      if (hasPositiveDecimal(proceedsUsdc)) {
        marketValueUsdc = proceedsUsdc;
        if (hasPositiveDecimal(costUsdc)) {
          const soldCostUsdc =
            Number.isFinite(totalShares) && totalShares > 0 && soldShares > 0
              ? Number(costUsdc) * Math.min(1, soldShares / totalShares)
              : Number(costUsdc);
          realizedPnlUsdc = formatDecimalString(Number(proceedsUsdc) - soldCostUsdc);
        }
      }
    }

    const positionId = `${market.id}:${side}`;
    if (!positions.has(positionId)) {
      positions.set(positionId, {
        id: positionId,
        marketId: market.id,
        marketSlug: market.slug,
        marketTitle: market.title,
        side,
        status: "settled",
        costUsdc,
        marketValueUsdc,
        unrealizedPnlUsdc: "0",
        realizedPnlUsdc,
        claimable: false,
        tokenBalance: historyTokenBalance,
        currentPrice,
        endsAt: market.endsAt,
        isSold,
        isRedeemed
      });
    }
  }

  return Array.from(positions.values());
}

function mergeHistoricalSettledPositions(
  snapshot: PortfolioPositionsSnapshot | null,
  account: `0x${string}`,
  historicalSettled: TrackedPosition[]
) {
  const baseSnapshot = snapshot ?? createPortfolioSnapshot(account);

  if (historicalSettled.length === 0) {
    return baseSnapshot;
  }

  const active = baseSnapshot.active;
  const settled = [...baseSnapshot.settled];
  const activeKeys = new Set<string>();
  const activePositionByKey = new Map<string, TrackedPosition>();
  const settledIndexByKey = new Map<string, number>();

  active.forEach((position) => {
    for (const key of buildPositionLookupKeys(position)) {
      activeKeys.add(key);
      activePositionByKey.set(key, position);
    }
  });

  settled.forEach((position, index) => {
    for (const key of buildSettledLookupKeys(position)) {
      settledIndexByKey.set(key, index);
    }
  });

  for (const position of historicalSettled) {
    const positionKeys = buildPositionLookupKeys(position);
    const keys = buildSettledLookupKeys(position);
    const activePosition = positionKeys
      .map((key) => activePositionByKey.get(key))
      .find((entry): entry is TrackedPosition => Boolean(entry));
    const activeTokenBalance = Number(activePosition?.tokenBalance ?? "0");
    const allowSoldDustHistory =
      position.isSold === true &&
      Number.isFinite(activeTokenBalance) &&
      activeTokenBalance > 0 &&
      activeTokenBalance < MIN_VISIBLE_ACTIVE_SHARES;

    if (positionKeys.some((key) => activeKeys.has(key)) && !allowSoldDustHistory) {
      continue;
    }

    const existingSettledKey = keys.find((key) => settledIndexByKey.has(key));
    if (existingSettledKey) {
      const index = settledIndexByKey.get(existingSettledKey)!;
      settled[index] = mergeHistoricalSettledPosition(settled[index], position);
      for (const mergedKey of buildSettledLookupKeys(settled[index])) {
        settledIndexByKey.set(mergedKey, index);
      }
      continue;
    }

    const index = settled.push(position) - 1;
    keys.forEach((key) => settledIndexByKey.set(key, index));
  }

  const prunedSettled = prunePlaceholderSettledPositions(settled);

  return {
    account: baseSnapshot.account ?? account,
    fetchedAt: new Date().toISOString(),
    active,
    settled: prunedSettled,
    totals: recomputeTotals(active, prunedSettled)
  };
}

function mergePosition(primary: TrackedPosition, fallback: TrackedPosition): TrackedPosition {
  return {
    ...fallback,
    ...primary,
    currentPrice: primary.currentPrice ?? fallback.currentPrice
  };
}

function enrichPublicPortfolioSnapshotWithMarketPrices(
  publicPortfolio: PortfolioPositionsSnapshot | null,
  ammMarkets: AmmMarketRef[]
): PortfolioPositionsSnapshot | null {
  if (!publicPortfolio) {
    return null;
  }

  const marketByKey = new Map<string, AmmMarketRef>();
  for (const market of ammMarkets) {
    marketByKey.set(market.contractAddress.toLowerCase(), market);
    marketByKey.set(market.slug.toLowerCase(), market);
    marketByKey.set(market.id.toLowerCase(), market);
  }

  const enrichPosition = (position: TrackedPosition): TrackedPosition => {
    if (position.status !== "active") {
      return position;
    }

    const market =
      marketByKey.get(position.marketId.toLowerCase()) ??
      marketByKey.get(position.marketSlug.toLowerCase());

    if (!market) {
      return position;
    }

    const shares = Number(position.tokenBalance);
    const cost = Number(position.costUsdc);
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost)) {
      return position;
    }

    const currentPrice = position.side === "yes" ? market.yesPrice : market.noPrice;
    if (!hasVerifiedAmmPrice(currentPrice)) {
      return position;
    }
    const marketValue = shares * currentPrice;
    const pnl = marketValue - cost;

    return {
      ...position,
      marketId: position.marketId || market.contractAddress,
      marketSlug: position.marketSlug || market.slug,
      marketTitle: position.marketTitle || market.title,
      marketValueUsdc: formatDecimalString(marketValue),
      unrealizedPnlUsdc: formatDecimalString(pnl),
      currentPrice,
      hasVerifiedPricing: true
    };
  };

  const active = publicPortfolio.active.map(enrichPosition);
  const settled = publicPortfolio.settled;

  return {
    ...publicPortfolio,
    active,
    settled,
    totals: recomputeTotals(active, settled)
  };
}

function mergePortfolioSnapshots(
  account: `0x${string}`,
  publicPortfolio: PortfolioPositionsSnapshot | null,
  onchainSnapshot: PortfolioPositionsSnapshot
): PortfolioPositionsSnapshot {
  if (!publicPortfolio) {
    return onchainSnapshot;
  }

  const active = [...publicPortfolio.active];
  const settled = [...publicPortfolio.settled];

  const activeIndexByKey = new Map<string, number>();
  const settledIndexByKey = new Map<string, number>();

  const register = (indexMap: Map<string, number>, position: TrackedPosition, index: number) => {
    for (const key of buildPositionLookupKeys(position)) {
      indexMap.set(key, index);
    }
  };

  active.forEach((position, index) => register(activeIndexByKey, position, index));
  settled.forEach((position, index) => register(settledIndexByKey, position, index));

  for (const onchainPosition of [...onchainSnapshot.active, ...onchainSnapshot.settled]) {
    const lookupKeys = buildPositionLookupKeys(onchainPosition);

    const activeMatchKey = lookupKeys.find((key) => activeIndexByKey.has(key));
    if (activeMatchKey) {
      const index = activeIndexByKey.get(activeMatchKey)!;
      active[index] = mergePosition(onchainPosition, active[index]);
      register(activeIndexByKey, active[index], index);
      continue;
    }

    const settledMatchKey = lookupKeys.find((key) => settledIndexByKey.has(key));
    if (settledMatchKey) {
      const index = settledIndexByKey.get(settledMatchKey)!;
      settled[index] = mergePosition(onchainPosition, settled[index]);
      register(settledIndexByKey, settled[index], index);
      continue;
    }

    if (onchainPosition.status === "active") {
      const index = active.push(onchainPosition) - 1;
      register(activeIndexByKey, onchainPosition, index);
    } else {
      const index = settled.push(onchainPosition) - 1;
      register(settledIndexByKey, onchainPosition, index);
    }
  }

  const prunedSettled = prunePlaceholderSettledPositions(settled);

  return {
    account: publicPortfolio.account ?? onchainSnapshot.account ?? account,
    fetchedAt: new Date().toISOString(),
    active,
    settled: prunedSettled,
    totals: recomputeTotals(active, prunedSettled)
  };
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);

  const rate = await checkRateLimit({
    bucket: "portfolio-positions",
    request,
    limit: 120,
    windowMs: 60_000
  });
  const headers = new Headers(rateLimitHeaders(rate));
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);

  if (!rate.ok) {
    return Response.json(
      { error: "Too many requests", requestId },
      { status: 429, headers }
    );
  }

  const url = new URL(request.url);
  const account = url.searchParams.get("account")?.trim() ?? "";
  const forceFresh = url.searchParams.get("fresh") === "1";

  if (!isAddress(account)) {
    return Response.json(
      { error: "account query param must be a valid EVM address", requestId },
      { status: 400, headers }
    );
  }

  let snapshotCacheClient: Awaited<ReturnType<typeof getSecurityRedisClient>> | null = null;
  try {
    snapshotCacheClient = await getSecurityRedisClient();
  } catch (error) {
    console.warn("[Positions API] Snapshot cache client init failed:", error);
  }

  const cachedSnapshot = await readCachedPositionsSnapshot(account, snapshotCacheClient);
  const cachedSnapshotAgeMs = getSnapshotAgeMs(cachedSnapshot);

  if (!forceFresh && cachedSnapshot && cachedSnapshotAgeMs <= STALE_SNAPSHOT_MAX_AGE_MS) {
    headers.set(
      "X-Positions-Cache",
      cachedSnapshotAgeMs <= FAST_SNAPSHOT_MAX_AGE_MS ? "fast-hit" : "stale-hit"
    );
    return Response.json(cachedSnapshot, { headers });
  }

  const respondWithSnapshot = async (snapshot: PortfolioPositionsSnapshot) => {
    const stabilizedSnapshot = stabilizeSnapshotWithCache(snapshot, cachedSnapshot);
    if (shouldRefreshSnapshotCache(snapshot, cachedSnapshot)) {
      await writeCachedPositionsSnapshot(account, stabilizedSnapshot, snapshotCacheClient);
    }
    return Response.json(stabilizedSnapshot, { headers });
  };

  try {
    const authHeaders: Record<string, string> = {};
    const auth = request.headers.get("Authorization");
    const deviceId = request.headers.get("limitless-device-id");
    if (auth) authHeaders["Authorization"] = auth;
    if (deviceId) authHeaders["limitless-device-id"] = deviceId;

    // 1. Fetch the public portfolio first. It already contains active positions,
    // settled positions, market values and cost basis. That is sufficient for
    // the initial profile render, so we should not block on transfer-history
    // reconstruction unless the caller explicitly asked for a fresh deep sync or
    // the public snapshot is empty/degraded.
    const publicPortfolioPromise = fetchPublicPortfolioPositions(account, authHeaders).catch(err => {
      console.warn(`[Positions API] Failed to fetch public portfolio for cost basis:`, err);
      return null;
    });
    const rawPublicPortfolio = await publicPortfolioPromise;
    const hasPublicPositions =
      rawPublicPortfolio !== null &&
      (rawPublicPortfolio.active.length > 0 || rawPublicPortfolio.settled.length > 0);

    if (!forceFresh && rawPublicPortfolio && hasPublicPositions) {
      headers.set("X-Positions-Source", "public-fast-path");
      return respondWithSnapshot(rawPublicPortfolio);
    }

    if (!hasPublicPositions) {
      try {
        const historySnapshot = await withTimeout(
          fetchBlockscoutHistorySnapshot(account as `0x${string}`),
          12_000,
          "Blockscout history snapshot"
        );

        if (historySnapshot.active.length > 0 || historySnapshot.settled.length > 0) {
          headers.set("X-Positions-Source", "blockscout-history");
          return respondWithSnapshot(historySnapshot);
        }
      } catch (error) {
        console.warn("[Positions API] Blockscout history snapshot failed:", error);
      }
    }

    if (!forceFresh && !hasPublicPositions) {
      try {
        const lightSnapshot = await withTimeout(
          (async () => {
            const lightMarkets = await fetchAmmMarketsForOnchain([], true);
            return fetchOnchainAmmPositions(account as `0x${string}`, lightMarkets, {});
          })(),
          LIGHT_ONCHAIN_ENRICH_TIMEOUT_MS,
          "Light on-chain portfolio scan"
        );

        if (lightSnapshot.active.length > 0) {
          headers.set("X-Positions-Source", "onchain-light");
          return respondWithSnapshot(lightSnapshot);
        }
      } catch (error) {
        console.warn("[Positions API] Light on-chain scan failed:", error);
      }
    }

    // 2. Only fall back to the heavier history + on-chain reconstruction when
    // the public snapshot is empty or the client explicitly requested a fresh
    // deep sync.
    const rawHistorySummary = await withTimeout(
      fetchTransferHistorySummary(account),
      HISTORY_SUMMARY_TIMEOUT_MS,
      "Transfer history summary"
    ).catch((error) => {
      console.warn("[Positions API] Transfer history summary failed:", error);
      return emptyTransferHistorySummary();
    });

    const shouldFetchOnchain = !hasPublicPositions || rawHistorySummary.fpmmAddresses.length > 0;
    const shouldIncludeCatalog = !hasPublicPositions && rawHistorySummary.fpmmAddresses.length === 0;
    const ammMarkets = shouldFetchOnchain
      ? await fetchAmmMarketsForOnchain(rawHistorySummary.fpmmAddresses, shouldIncludeCatalog)
      : [];
    const historySummary = augmentHistorySummaryWithTokenCostBasis(rawHistorySummary, ammMarkets);
    const publicPortfolio = enrichPublicPortfolioSnapshotWithMarketPrices(rawPublicPortfolio, ammMarkets);
    const historicalSettled = buildHistoricalSettledPositions(historySummary, ammMarkets, publicPortfolio);

    // 3. Create cost basis map keyed as `${marketId}:${side}`.
    // Public portfolio data is exact and should win; history-derived cost is fallback.
    const costBasisMap: Record<string, PositionCostBasisEntry> = {};
    if (publicPortfolio) {
      for (const pos of [...publicPortfolio.active, ...publicPortfolio.settled]) {
        // Limitless API often uses the lowercased address or slug as marketId
        // we'll store multiple variations to maximize match rate
        // ONLY use the API cost if it's valid and non-zero. 
        // If it's zero, we want the blockchain history to provide the true cost.
        if (Number(pos.costUsdc) <= 0) continue;

        const entry = {
          costUsdc: pos.costUsdc,
          tokenAmount: pos.status === "active" ? pos.tokenBalance : undefined
        };
        costBasisMap[`${pos.marketId.toLowerCase()}:${pos.side}`] = entry;
        costBasisMap[`${pos.marketSlug.toLowerCase()}:${pos.side}`] = entry;

        // ALSO map by contract address if we can find it in the markets map
        const match = ammMarkets.find(m =>
          m.id.toLowerCase() === pos.marketId.toLowerCase() ||
          m.slug.toLowerCase() === pos.marketSlug.toLowerCase()
        );
        if (match) {
          costBasisMap[`${match.contractAddress.toLowerCase()}:${pos.side}`] = entry;
        }
      }
    }

    for (const [key, entry] of Object.entries(historySummary.costBasisMap)) {
      if (!costBasisMap[key]) {
        costBasisMap[key] = entry;
      }
    }

    console.log(`[Positions API] Public portfolio: ${publicPortfolio ? `${publicPortfolio.active.length} active, ${publicPortfolio.settled.length} settled` : 'FAILED/NULL'}`);
    console.log(`[Positions API] History cost basis keys:`, Object.keys(historySummary.costBasisMap).slice(0, 10));
    console.log(`[Positions API] Cost basis keys:`, Object.keys(costBasisMap).slice(0, 10));
    console.log(`[Positions API] Cost basis sample:`, JSON.stringify(Object.entries(costBasisMap).slice(0, 5)));

    if (!shouldFetchOnchain) {
      const snapshot = sortSnapshotActivePositions(
        mergeHistoricalSettledPositions(publicPortfolio, account as `0x${string}`, historicalSettled),
        historySummary,
        ammMarkets
      );
      return respondWithSnapshot(snapshot);
    }

    let onchainSnapshot: PortfolioPositionsSnapshot | null = null;
    try {
      // 4. Read ERC-1155 balances directly from Base, passing in the cost map.
      // This layer is best-effort; if Base RPC stalls we still want to return the
      // public Limitless portfolio instead of leaving the profile page empty.
      onchainSnapshot = await withTimeout(
        fetchOnchainAmmPositions(
          account as `0x${string}`,
          ammMarkets,
          costBasisMap
        ),
        ONCHAIN_ENRICH_TIMEOUT_MS,
        "On-chain portfolio enrichment"
      );
    } catch (error) {
      console.warn("[Positions API] On-chain enrichment failed:", error);
      if (publicPortfolio) {
        const snapshot = sortSnapshotActivePositions(
          mergeHistoricalSettledPositions(publicPortfolio, account as `0x${string}`, historicalSettled),
          historySummary,
          ammMarkets
        );
        return respondWithSnapshot(snapshot);
      }
      const fallbackSnapshot = sortSnapshotActivePositions(
        mergeHistoricalSettledPositions(null, account as `0x${string}`, historicalSettled),
        historySummary,
        ammMarkets
      );
      return respondWithSnapshot(fallbackSnapshot);
    }

    console.log(`[Positions API] Discovered ${ammMarkets.length} candidate markets. Found ${onchainSnapshot.active.length} active and ${onchainSnapshot.settled.length} settled positions for ${account}`);
    // Debug: show PNL values
    for (const pos of onchainSnapshot.active) {
      console.log(`[PNL Debug] Active: ${pos.marketTitle?.slice(0, 40)} | cost=${pos.costUsdc} val=${pos.marketValueUsdc} uPNL=${pos.unrealizedPnlUsdc}`);
    }

    const mergedSnapshot = mergePortfolioSnapshots(
      account as `0x${string}`,
      publicPortfolio,
      onchainSnapshot
    );
    const finalSnapshot = sortSnapshotActivePositions(
      mergeHistoricalSettledPositions(
        mergedSnapshot,
        account as `0x${string}`,
        historicalSettled
      ),
      historySummary,
      ammMarkets
    );

    console.log(`[Positions API] Returning ${finalSnapshot?.active.length ?? 0} active and ${finalSnapshot?.settled.length ?? 0} settled positions for ${account}`);

    return respondWithSnapshot(finalSnapshot);
  } catch (error) {
    if (cachedSnapshot) {
      return Response.json(cachedSnapshot, { headers });
    }
    const message =
      error instanceof Error ? error.message : "Portfolio positions lookup failed";
    return Response.json(
      { error: message, requestId },
      { status: 502, headers }
    );
  }
}

declare global {
  var __positionsRouteTestHelpers:
    | {
        stabilizeSnapshotWithCache: typeof stabilizeSnapshotWithCache;
        mergeHistoricalSettledPositions: typeof mergeHistoricalSettledPositions;
      }
    | undefined;
}

if (process.env.NODE_ENV === "test") {
  globalThis.__positionsRouteTestHelpers = {
    stabilizeSnapshotWithCache,
    mergeHistoricalSettledPositions
  };
}
