"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSendCalls,
  useSendTransaction,
  useWaitForCallsStatus
} from "wagmi";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import { TradeIntentResponse, TradeIntentSuccess, TradeSide } from "@/lib/trade/trade-types";

type TradeExecutionStatus =
  | "idle"
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed";

type TradeState = {
  status: TradeExecutionStatus;
  error: string | null;
  batchId: string | null;
  txHashes: `0x${string}`[];
  pendingTrade: ConfirmedTrade | null;
  lastConfirmedTrade: ConfirmedTrade | null;
};

type ExecuteTradeParams = {
  marketId: string;
  side: TradeSide;
  amountUsdc: string;
  expectedPrice?: number;
  maxSlippageBps?: number;
};

type ConfirmedTrade = {
  marketId: string;
  side: TradeSide;
  amountUsdc: string;
  executionPrice?: number;
  confirmedAt: string;
};

function errorToMessage(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.shortMessage === "string") {
      return record.shortMessage;
    }

    if (typeof record.message === "string") {
      return record.message;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown trade error";
}

function notifyPositionsRefresh() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent("positions:refresh"));
}

export function useTradeExecutor() {
  const { address, isConnected } = useAccount();
  const { user, getAuthHeaders } = useMiniAppAuth();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId });

  const tradeAddress = user?.address ?? address;

  const { sendCallsAsync, isPending: isBatchSending } = useSendCalls();
  const { sendTransactionAsync, isPending: isTxSending } = useSendTransaction();

  const [state, setState] = useState<TradeState>({
    status: "idle",
    error: null,
    batchId: null,
    txHashes: [],
    pendingTrade: null,
    lastConfirmedTrade: null
  });

  const callsStatus = useWaitForCallsStatus({
    id: state.batchId ?? undefined,
    pollingInterval: 1000,
    retryCount: 90,
    timeout: 180_000,
    query: {
      enabled: Boolean(state.batchId)
    }
  });

  useEffect(() => {
    const status = callsStatus.data?.status;
    if (!status) {
      return;
    }

    if (status === "pending") {
      setState((current) =>
        current.status === "submitted" ? current : { ...current, status: "submitted", error: null }
      );
      return;
    }

    if (status === "success") {
      setState((current) => ({
        ...current,
        status: "confirmed",
        error: null,
        lastConfirmedTrade: current.pendingTrade
          ? {
              ...current.pendingTrade,
              confirmedAt: new Date().toISOString()
            }
          : current.lastConfirmedTrade,
        pendingTrade: null
      }));
      notifyPositionsRefresh();
      return;
    }

    if (status === "failure") {
      setState((current) => ({
        ...current,
        status: "failed",
        error: "Batch transaction failed",
        pendingTrade: null
      }));
    }
  }, [callsStatus.data?.status]);

  const executeTrade = useCallback(
    async (params: ExecuteTradeParams) => {
      if (!isConnected || !address) {
        throw new Error("Wallet must be connected before trading");
      }

      if (user && address.toLowerCase() !== user.address.toLowerCase()) {
        throw new Error(
          "Wallet mismatch. Please connect with your authenticated wallet to trade."
        );
      }

      const walletForTrade = tradeAddress ?? address;
      if (!walletForTrade) {
        throw new Error("Wallet must be connected before trading");
      }

      setState((current) => ({
        ...current,
        status: "preparing",
        error: null,
        batchId: null,
        txHashes: [],
        pendingTrade: null
      }));

      try {
        const response = await fetch("/api/trade/intent", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders()
          },
          body: JSON.stringify({
            marketId: params.marketId,
            side: params.side,
            amountUsdc: params.amountUsdc,
            walletAddress: walletForTrade,
            expectedPrice: params.expectedPrice,
            maxSlippageBps: params.maxSlippageBps
          })
        });

        const body = (await response.json()) as
          | TradeIntentResponse
          | {
              error?: string;
              guard?: {
                expectedPrice?: number;
                executionPrice?: number;
                slippageBps?: number;
                maxSlippageBps?: number;
              };
            };

        if (!response.ok) {
          const guardMessage =
            "guard" in body && body.guard
              ? ` Expected ${Number(body.guard.expectedPrice ?? 0).toFixed(3)}, current ${Number(
                  body.guard.executionPrice ?? 0
                ).toFixed(3)}, slippage ${body.guard.slippageBps ?? "-"}bps (max ${body.guard.maxSlippageBps ?? "-"}bps).`
              : "";
          throw new Error(
            (("error" in body && body.error) || `Trade intent failed with ${response.status}`) + guardMessage
          );
        }

        if (!("mode" in body) || body.mode !== "onchain") {
          const reason = "mode" in body ? body.reason : "Trade mode is disabled";
          throw new Error(reason);
        }

        const calls = body.calls.map((call) => ({
          to: call.to,
          data: call.data,
          value: call.value ? BigInt(call.value) : 0n
        }));
        const intentMeta = (body as TradeIntentSuccess).meta;
        const pendingTrade: ConfirmedTrade = {
          marketId: params.marketId,
          side: params.side,
          amountUsdc: params.amountUsdc,
          executionPrice: intentMeta.executionPrice,
          confirmedAt: new Date().toISOString()
        };

        setState((current) => ({ ...current, status: "awaiting_signature", error: null }));

        try {
          const batch = await sendCallsAsync({
            account: address,
            chainId,
            calls,
            forceAtomic: true
          });

          setState((current) => ({
            ...current,
            status: "submitted",
            error: null,
            batchId: batch.id,
            txHashes: [],
            pendingTrade
          }));
          return;
        } catch {
          // Fallback for wallets without EIP-5792 support: send sequential transactions.
          const txHashes: `0x${string}`[] = [];

          for (const call of calls) {
            const hash = await sendTransactionAsync({
              account: address,
              chainId,
              to: call.to,
              data: call.data,
              value: call.value
            });

            txHashes.push(hash);
            setState((current) => ({
              ...current,
              status: "submitted",
              batchId: null,
              txHashes: [...txHashes]
            }));

            if (publicClient) {
              await publicClient.waitForTransactionReceipt({ hash });
            }
          }

          setState((current) => ({
            ...current,
            status: "confirmed",
            error: null,
            batchId: null,
            txHashes,
            pendingTrade: null,
            lastConfirmedTrade: {
              ...pendingTrade,
              confirmedAt: new Date().toISOString()
            }
          }));
          notifyPositionsRefresh();
        }
      } catch (error) {
        setState((current) => ({
          ...current,
          status: "failed",
          error: errorToMessage(error),
          batchId: null,
          txHashes: [],
          pendingTrade: null
        }));
      }
    },
    [address, chainId, isConnected, publicClient, sendCallsAsync, sendTransactionAsync, tradeAddress, user, getAuthHeaders]
  );

  const isBusy =
    state.status === "preparing" ||
    state.status === "awaiting_signature" ||
    state.status === "submitted" ||
    isBatchSending ||
    isTxSending;

  const statusLabel = useMemo(() => {
    if (state.status === "idle") {
      return "Ready";
    }

    if (state.status === "preparing") {
      return "Preparing trade...";
    }

    if (state.status === "awaiting_signature") {
      return "Waiting for signature...";
    }

    if (state.status === "submitted") {
      return state.batchId ? "Batch submitted on Base" : "Transaction submitted";
    }

    if (state.status === "confirmed") {
      return "Trade confirmed";
    }

    return state.error ?? "Trade failed";
  }, [state.batchId, state.error, state.status]);

  return {
    executeTrade,
    state,
    lastConfirmedTrade: state.lastConfirmedTrade,
    isBusy,
    isConnected,
    statusLabel,
    isBatchWaiting: callsStatus.isFetching
  };
}
